-- 新 Worker 的公平领取只 JOIN registry，不再在领取路径扫描全部在途轮次。滚动发布期间
-- 旧 API Pod 仍可能使用没有 registry CTE 的 PREPARE，因此注册必须是数据库永久不变量，
-- 不能依赖某一应用版本。触发器与轮次写入同事务提交或回滚。
CREATE FUNCTION rgs_register_wallet_recovery_operator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    INSERT INTO public.rgs_wallet_recovery_operators (operator_id)
    VALUES (NEW.operator_id)
    ON CONFLICT (operator_id) DO NOTHING;
    RETURN NEW;
END
$function$;

-- 触发器函数只由迁移器绑定；PostgreSQL 在 CREATE TRIGGER 时核验 EXECUTE，运行时不
-- 需要把函数暴露给 runtime 或 PUBLIC。函数仍以调用者权限写 registry，避免提权边界。
REVOKE ALL ON FUNCTION public.rgs_register_wallet_recovery_operator() FROM PUBLIC;

-- 迁移器持有写互斥锁：先补齐 0008 后由旧 Pod 新增的在途轮次，再安装触发器，
-- 提交后才允许被阻塞的旧写入继续。这样 backfill 与触发器之间没有漏写窗口。
LOCK TABLE rgs_rounds IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO rgs_wallet_recovery_operators (operator_id)
SELECT DISTINCT operator_id
FROM rgs_rounds
WHERE status IN ('PREPARED', 'WALLET_PENDING')
  AND wallet_phase IN ('APPLY', 'LOOKUP')
ON CONFLICT (operator_id) DO NOTHING;

CREATE TRIGGER rgs_register_wallet_recovery_operator_insert
AFTER INSERT ON rgs_rounds
FOR EACH ROW
WHEN (
    NEW.status IN ('PREPARED', 'WALLET_PENDING')
    AND NEW.wallet_phase IN ('APPLY', 'LOOKUP')
)
EXECUTE FUNCTION rgs_register_wallet_recovery_operator();

-- 兼容状态或 phase 从不可领取变为可领取的旧 UPDATE；正常 PREPARED/APPLY ->
-- WALLET_PENDING/LOOKUP 两侧都可领取，因此不会重复探测 registry 主键。
CREATE TRIGGER rgs_register_wallet_recovery_operator_recovery_update
AFTER UPDATE OF status, wallet_phase ON rgs_rounds
FOR EACH ROW
WHEN (
    NEW.status IN ('PREPARED', 'WALLET_PENDING')
    AND NEW.wallet_phase IN ('APPLY', 'LOOKUP')
    AND (
        OLD.status NOT IN ('PREPARED', 'WALLET_PENDING')
        OR OLD.wallet_phase NOT IN ('APPLY', 'LOOKUP')
    )
)
EXECUTE FUNCTION rgs_register_wallet_recovery_operator();

-- readiness 与 migrator verify 会动态回读函数及两个触发器；PREPARE 仍保留有界主键
-- 冲突写作为探针摘流前的短窗口保险。后续迁移不得无等价替代地删除本数据库不变量。

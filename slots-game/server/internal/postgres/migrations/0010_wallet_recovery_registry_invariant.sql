-- 新 Worker 的公平领取只 JOIN registry，不再在领取路径扫描全部在途轮次。滚动发布期间
-- 旧 API Pod 仍可能使用没有 registry CTE 的 PREPARE，因此注册必须是数据库永久不变量，
-- 不能依赖某一应用版本。触发器与轮次写入同事务提交或回滚。
-- English: The fair collection of new workers is only JOIN registry, and no longer scans all in-transit rounds
-- in the collection path. rolling release period Old API Pods may still use PREPARE without a registry CTE, so
-- the registration must be a database persistent, You cannot rely on a certain application version. Triggers
-- and write rounds are the same as transaction commit or rollback.
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
-- English: Trigger functions are only bound by the migrator; PostgreSQL checks EXECUTE when CREATE TRIGGER, not
-- at runtime. Functions need to be exposed to runtime or PUBLIC. The function still writes to the registry with
-- the caller's permissions, avoiding privilege escalation boundaries.
REVOKE ALL ON FUNCTION public.rgs_register_wallet_recovery_operator() FROM PUBLIC;

-- 迁移器持有写互斥锁：先补齐 0008 后由旧 Pod 新增的在途轮次，再安装触发器，
-- 提交后才允许被阻塞的旧写入继续。这样 backfill 与触发器之间没有漏写窗口。
-- English: The migrator holds a write mutex: first fill in the in-transit rounds added by the old Pod after
-- 0008, and then install the trigger. Old blocked writes are allowed to continue only after committing. This
-- way there is no missed write window between the backfill and the trigger.
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
-- English: Old UPDATE when compatibility status or phase changes from unclaimable to claimable; normal
-- PREPARED/APPLY -> WALLET_PENDING/LOOKUP can be collected on both sides, so the registry primary key will not
-- be detected repeatedly.
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
-- English: readiness and migrator verify will dynamically read-back the function and two triggers; PREPARE
-- still retains the bounded primary key Conflict writing serves as a short window of insurance before probe
-- removal. Subsequent migrations must not delete this database invariant without equivalent replacement.

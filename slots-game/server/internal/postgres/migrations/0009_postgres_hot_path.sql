-- PostgreSQL 不会为外键子列自动建索引。钱包领取在任何外呼前都必须按逻辑轮次
-- 锁定并核验全部账本行；缺少本索引会使流水表增长后退化为全表扫描。
CREATE INDEX rgs_wallet_transactions_round_claim
    ON rgs_wallet_transactions (operator_id, session_id, round_id, transaction_id);

-- 0008 的精确到期索引已经接管自动恢复；0001 的宽状态索引没有生产查询消费者，
-- 却会在 PREPARED -> WALLET_PENDING -> 终态的每次转换中产生额外索引写入。
DROP INDEX IF EXISTS rgs_rounds_recovery;

-- 0002 的领取索引已取代 0001 旧索引。按真实 ORDER BY 重建最小键，避免
-- lease_until 夹在 available_at 与 id 之间导致候选集额外排序；不改变 Outbox 的
-- 至少一次与同聚合有序语义。
DROP INDEX IF EXISTS rgs_outbox_dispatch;
DROP INDEX IF EXISTS rgs_outbox_claim;
CREATE INDEX rgs_outbox_claim
    ON rgs_outbox (available_at, id)
    WHERE published_at IS NULL;

-- Backlog readiness 只需定位最老未发布事件。精确部分索引避免每次健康检查扫描
-- 整张审计表；发布后记录自动退出索引，历史审计行仍完整保留。
CREATE INDEX rgs_outbox_unpublished_age
    ON rgs_outbox (created_at, id)
    WHERE published_at IS NULL;

-- 启动记录在短期兑换窗口关闭后仍作为幂等墓碑保留。原有部分索引排除了已消费记录，
-- 无法支持对最常见情形执行有界保留期清理。
-- English: Launch records remain as idempotent tombstones after the short-term redemption window closes. The
-- original partial index excluded consumed records. There is no support for bounded retention cleanup for the
-- most common scenarios.
DROP INDEX IF EXISTS rgs_launch_codes_expiry;

CREATE INDEX IF NOT EXISTS rgs_launch_codes_retention_expiry
    ON rgs_launch_codes (expires_at, code_hash);

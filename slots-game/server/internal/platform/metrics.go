package platform

import (
	"database/sql"
	"fmt"
	"io"
	"sync/atomic"
	"time"

	"slots-game/server/internal/outbox"
	"slots-game/server/internal/rgs"
)

const requestLatencyBucketCount = 11

var requestLatencyBoundaries = [...]time.Duration{
	5 * time.Millisecond,
	10 * time.Millisecond,
	25 * time.Millisecond,
	50 * time.Millisecond,
	100 * time.Millisecond,
	250 * time.Millisecond,
	500 * time.Millisecond,
	time.Second,
	2500 * time.Millisecond,
	5 * time.Second,
	10 * time.Second,
}

// Metrics 只暴露有界基数的计数器、仪表盘和固定桶直方图。运营商、玩家、会话、
// 轮次和交易标识绝不能成为标签，避免不可信输入耗尽监控系统的索引空间。
type Metrics struct {
	HTTPRequests atomic.Uint64
	// HTTPFailures 保留全部 4xx/5xx 供诊断；HTTPServerFailures 只计 5xx，
	// 供可用性告警使用，避免认证攻击或客户端输入错误制造服务故障噪声。
	HTTPFailures           atomic.Uint64
	HTTPServerFailures     atomic.Uint64
	AuthFailures           atomic.Uint64
	AuthReplays            atomic.Uint64
	RateLimited            atomic.Uint64
	AccessLogsEmitted      atomic.Uint64
	AccessLogsDropped      atomic.Uint64
	SharedAdmissionAllowed atomic.Uint64
	SharedAdmissionLimited atomic.Uint64
	SharedAdmissionErrors  atomic.Uint64
	// CapacityRejected 只计进程级公网并发硬闸门拒绝；不得与租户/速率限流混用，
	// 以便值班人员区分资源饱和与攻击或调用方超额。
	CapacityRejected   atomic.Uint64
	HTTPActiveRequests atomic.Int64
	// HTTPActiveConnections 覆盖公网监听器从 Accept 到 Close 或 Hijack 的完整生命周期，
	// 包括尚未进入处理器的慢请求头、未读正文回收和空闲长连接。
	HTTPActiveConnections       atomic.Int64
	HTTPConnectionLimit         atomic.Int64
	HTTPRequestDurations        [requestLatencyBucketCount]atomic.Uint64
	HTTPRequestDurationCount    atomic.Uint64
	HTTPRequestDurationNanos    atomic.Uint64
	RoundsPrepared              atomic.Uint64
	RoundsCommitted             atomic.Uint64
	RoundReplays                atomic.Uint64
	IdempotencyConflicts        atomic.Uint64
	WalletCalls                 atomic.Uint64
	WalletUnknownOutcomes       atomic.Uint64
	Reconciliations             atomic.Uint64
	RoundsManualReview          atomic.Uint64
	RoundIntegrityQuarantines   atomic.Uint64
	SessionIntegrityQuarantines atomic.Uint64
	OutboxClaimed               atomic.Uint64
	OutboxPublished             atomic.Uint64
	OutboxDeferred              atomic.Uint64
	OutboxLeaseLost             atomic.Uint64
	databasePool                atomic.Pointer[sql.DB]
}

func (m *Metrics) WritePrometheus(w io.Writer) error {
	if m == nil {
		return nil
	}
	values := []struct {
		name  string
		help  string
		value uint64
	}{
		{"rgs_http_requests_total", "Accepted HTTP requests.", m.HTTPRequests.Load()},
		{"rgs_http_failures_total", "HTTP requests ending in a client or server error.", m.HTTPFailures.Load()},
		{"rgs_http_server_failures_total", "HTTP requests ending in a server error.", m.HTTPServerFailures.Load()},
		{"rgs_auth_failures_total", "Rejected authentication attempts.", m.AuthFailures.Load()},
		{"rgs_auth_replays_total", "Rejected operator authentication nonce replays.", m.AuthReplays.Load()},
		{"rgs_rate_limited_total", "Requests rejected by local admission control.", m.RateLimited.Load()},
		{"rgs_access_logs_emitted_total", "Access log records emitted after severity and sampling decisions.", m.AccessLogsEmitted.Load()},
		{"rgs_access_logs_dropped_total", "Successful access log records omitted by deterministic sampling.", m.AccessLogsDropped.Load()},
		{"rgs_shared_admission_allowed_total", "Verified-identity requests allowed by shared admission control.", m.SharedAdmissionAllowed.Load()},
		{"rgs_shared_admission_limited_total", "Verified-identity requests rejected by shared admission control.", m.SharedAdmissionLimited.Load()},
		{"rgs_shared_admission_errors_total", "Shared admission backend or protocol failures.", m.SharedAdmissionErrors.Load()},
		{"rgs_capacity_rejected_total", "Public requests rejected by the process-wide in-flight capacity gate.", m.CapacityRejected.Load()},
		{"rgs_rounds_prepared_total", "Durably prepared game rounds.", m.RoundsPrepared.Load()},
		{"rgs_rounds_committed_total", "Wallet-confirmed committed rounds.", m.RoundsCommitted.Load()},
		{"rgs_round_replays_total", "Idempotent committed round replays.", m.RoundReplays.Load()},
		{"rgs_idempotency_conflicts_total", "Conflicting idempotency keys.", m.IdempotencyConflicts.Load()},
		{"rgs_wallet_calls_total", "Outbound wallet calls.", m.WalletCalls.Load()},
		{"rgs_wallet_unknown_outcomes_total", "Wallet calls requiring status reconciliation.", m.WalletUnknownOutcomes.Load()},
		{"rgs_reconciliations_total", "Recovery reconciliation attempts.", m.Reconciliations.Load()},
		{"rgs_rounds_manual_review_total", "Rounds durably transitioned to manual review.", m.RoundsManualReview.Load()},
		{"rgs_round_integrity_quarantines_total", "Rounds receiving their first durable integrity quarantine marker.", m.RoundIntegrityQuarantines.Load()},
		{"rgs_session_integrity_quarantines_total", "Sessions receiving their first durable integrity quarantine marker.", m.SessionIntegrityQuarantines.Load()},
		{"rgs_outbox_claimed_total", "Outbox delivery attempts claimed under a lease.", m.OutboxClaimed.Load()},
		{"rgs_outbox_published_total", "Outbox publications durably acknowledged by the store.", m.OutboxPublished.Load()},
		{"rgs_outbox_deferred_total", "Outbox publication failures durably deferred for retry.", m.OutboxDeferred.Load()},
		{"rgs_outbox_lease_lost_total", "Outbox completions rejected by lease fencing.", m.OutboxLeaseLost.Load()},
	}
	for _, item := range values {
		if _, err := fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", item.name, item.help, item.name, item.name, item.value); err != nil {
			return err
		}
	}
	if err := m.writeRequestLatencyHistogram(w); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(
		w,
		"# HELP rgs_http_active_requests Requests currently executing on the public RGS listener.\n"+
			"# TYPE rgs_http_active_requests gauge\n"+
			"rgs_http_active_requests %d\n",
		m.HTTPActiveRequests.Load(),
	); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(
		w,
		"# HELP rgs_http_active_connections Accepted connections currently open on the public RGS listener.\n"+
			"# TYPE rgs_http_active_connections gauge\n"+
			"rgs_http_active_connections %d\n"+
			"# HELP rgs_http_connection_limit Configured accepted-connection hard limit for one RGS listener.\n"+
			"# TYPE rgs_http_connection_limit gauge\n"+
			"rgs_http_connection_limit %d\n",
		m.HTTPActiveConnections.Load(),
		m.HTTPConnectionLimit.Load(),
	); err != nil {
		return err
	}
	if database := m.databasePool.Load(); database != nil {
		if err := writeDatabasePoolMetrics(w, database.Stats()); err != nil {
			return err
		}
	}
	return nil
}

// NonceReplay 记录已经由签名验证链路确认的随机数重放，不携带任何请求派生标签。
func (m *Metrics) NonceReplay() {
	if m != nil {
		m.AuthReplays.Add(1)
	}
}

func (m *Metrics) writeRequestLatencyHistogram(w io.Writer) error {
	if _, err := fmt.Fprint(
		w,
		"# HELP rgs_http_request_duration_seconds Public RGS request duration in seconds.\n"+
			"# TYPE rgs_http_request_duration_seconds histogram\n",
	); err != nil {
		return err
	}
	for index, boundary := range requestLatencyBoundaries {
		if _, err := fmt.Fprintf(
			w,
			"rgs_http_request_duration_seconds_bucket{le=\"%s\"} %d\n",
			formatPrometheusSeconds(boundary), m.HTTPRequestDurations[index].Load(),
		); err != nil {
			return err
		}
	}
	count := m.HTTPRequestDurationCount.Load()
	if _, err := fmt.Fprintf(
		w,
		"rgs_http_request_duration_seconds_bucket{le=\"+Inf\"} %d\n"+
			"rgs_http_request_duration_seconds_sum %.9f\n"+
			"rgs_http_request_duration_seconds_count %d\n",
		count,
		float64(m.HTTPRequestDurationNanos.Load())/float64(time.Second),
		count,
	); err != nil {
		return err
	}
	return nil
}

func writeDatabasePoolMetrics(w io.Writer, stats sql.DBStats) error {
	for _, item := range []struct {
		name  string
		help  string
		value int
	}{
		{"rgs_db_pool_open_connections", "Open PostgreSQL connections in the runtime pool.", stats.OpenConnections},
		{"rgs_db_pool_in_use_connections", "PostgreSQL connections currently in use.", stats.InUse},
		{"rgs_db_pool_idle_connections", "Idle PostgreSQL connections in the runtime pool.", stats.Idle},
		{"rgs_db_pool_max_open_connections", "Configured maximum PostgreSQL connections for the runtime pool.", stats.MaxOpenConnections},
	} {
		if _, err := fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %d\n", item.name, item.help, item.name, item.name, item.value); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(
		w,
		"# HELP rgs_db_pool_wait_count_total Database connection waits caused by a saturated runtime pool.\n"+
			"# TYPE rgs_db_pool_wait_count_total counter\n"+
			"rgs_db_pool_wait_count_total %d\n"+
			"# HELP rgs_db_pool_wait_duration_seconds_total Total time spent waiting for a runtime database connection.\n"+
			"# TYPE rgs_db_pool_wait_duration_seconds_total counter\n"+
			"rgs_db_pool_wait_duration_seconds_total %.9f\n",
		stats.WaitCount,
		stats.WaitDuration.Seconds(),
	); err != nil {
		return err
	}
	return nil
}

func formatPrometheusSeconds(duration time.Duration) string {
	return fmt.Sprintf("%.3f", duration.Seconds())
}

// SetDatabasePool 绑定 rgs-server 唯一的进程内 SQL 连接池。仅在抓取时读取其
// 快照，因此数据库仪表盘不会引入租户或请求派生的高基数标签。
func (m *Metrics) SetDatabasePool(database *sql.DB) {
	if m != nil {
		m.databasePool.Store(database)
	}
}

// BeginHTTPRequest 和 EndHTTPRequest 仅跟踪公网 RGS 工作。它们使用固定桶而非
// 请求派生标签，保证恶意请求也不能无限扩展监控时序。
func (m *Metrics) BeginHTTPRequest() {
	if m != nil {
		m.HTTPActiveRequests.Add(1)
	}
}

func (m *Metrics) EndHTTPRequest(duration time.Duration) {
	if m == nil {
		return
	}
	m.HTTPActiveRequests.Add(-1)
	if duration < 0 {
		duration = 0
	}
	m.HTTPRequestDurationCount.Add(1)
	m.HTTPRequestDurationNanos.Add(uint64(duration))
	for index, boundary := range requestLatencyBoundaries {
		if duration <= boundary {
			m.HTTPRequestDurations[index].Add(1)
		}
	}
}

// AccessLogEmitted 与 AccessLogDropped 只累计两个无标签总量；访问日志中的
// 路由和请求标识绝不能进入指标标签，以免形成高基数时序。
func (m *Metrics) AccessLogEmitted() {
	if m != nil {
		m.AccessLogsEmitted.Add(1)
	}
}

func (m *Metrics) AccessLogDropped() {
	if m != nil {
		m.AccessLogsDropped.Add(1)
	}
}

func (m *Metrics) RoundPrepared() {
	if m != nil {
		m.RoundsPrepared.Add(1)
	}
}

func (m *Metrics) RoundCommitted() {
	if m != nil {
		m.RoundsCommitted.Add(1)
	}
}

func (m *Metrics) RoundReplayed() {
	if m != nil {
		m.RoundReplays.Add(1)
	}
}

func (m *Metrics) IdempotencyConflict() {
	if m != nil {
		m.IdempotencyConflicts.Add(1)
	}
}

func (m *Metrics) RoundManualReview() {
	if m != nil {
		m.RoundsManualReview.Add(1)
	}
}

func (m *Metrics) RoundIntegrityQuarantined() {
	if m != nil {
		m.RoundIntegrityQuarantines.Add(1)
	}
}

func (m *Metrics) SessionIntegrityQuarantined() {
	if m != nil {
		m.SessionIntegrityQuarantines.Add(1)
	}
}

func (m *Metrics) WalletCall() {
	if m != nil {
		m.WalletCalls.Add(1)
	}
}

func (m *Metrics) WalletUnknownOutcome() {
	if m != nil {
		m.WalletUnknownOutcomes.Add(1)
	}
}

func (m *Metrics) ObserveOutboxDispatch(result outbox.BatchResult) {
	if m == nil {
		return
	}
	if result.Claimed > 0 {
		m.OutboxClaimed.Add(uint64(result.Claimed))
	}
	if result.Published > 0 {
		m.OutboxPublished.Add(uint64(result.Published))
	}
	if result.Failed > 0 {
		m.OutboxDeferred.Add(uint64(result.Failed))
	}
	if result.LeaseLost > 0 {
		m.OutboxLeaseLost.Add(uint64(result.LeaseLost))
	}
}

var _ rgs.RoundObserver = (*Metrics)(nil)
var _ rgs.WalletObserver = (*Metrics)(nil)
var _ rgs.IntegrityObserver = (*Metrics)(nil)
var _ outbox.Observer = (*Metrics)(nil)

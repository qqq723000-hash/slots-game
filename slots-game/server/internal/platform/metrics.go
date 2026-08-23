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

const (
	requestLatencyBucketCount = 11
	walletMethodCount         = 3
	walletOutcomeCount        = 10
	walletRejectionCount      = 3
	walletBreakerMethodCount  = 4
	walletBreakerStateCount   = 3
)

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

var (
	walletMetricMethods    = [...]string{"apply", "lookup", "rollback"}
	walletMetricOutcomes   = [...]string{"success", "pending", "rejected", "not_found", "not_sent", "conflict", "invalid", "response_auth_invalid", "unknown", "isolated"}
	walletRejectionReasons = [...]string{"backend_bulkhead", "operator_bulkhead", "circuit"}
	walletBreakerMethods   = [...]string{"apply", "lookup", "operator_apply", "operator_lookup"}
	walletBreakerStates    = [...]string{"closed", "open", "half_open"}
)

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
	CapacityRejected atomic.Uint64
	// NewIntentCapacityRejected 只计为 PostgreSQL 关键读取、结果恢复和 ACK 预留连接
	// 而被非阻塞拒绝的新 launch/spin；不能与公网总 in-flight 闸门混用。
	NewIntentCapacityRejected atomic.Uint64
	HTTPActiveRequests        atomic.Int64
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
	WalletActiveRequests        [walletMethodCount]atomic.Int64
	WalletRequestDurations      [walletMethodCount][walletOutcomeCount][requestLatencyBucketCount]atomic.Uint64
	WalletRequestDurationCount  [walletMethodCount][walletOutcomeCount]atomic.Uint64
	WalletRequestDurationNanos  [walletMethodCount][walletOutcomeCount]atomic.Uint64
	WalletIsolationRejections   [walletMethodCount][walletRejectionCount]atomic.Uint64
	WalletBreakers              [walletBreakerMethodCount][walletBreakerStateCount]atomic.Int64
	Reconciliations             atomic.Uint64
	RecoveryLoopLastSuccessUnix atomic.Int64
	RecoveryLoopFailures        atomic.Uint64
	RecoverySnapshotFailures    atomic.Uint64
	recoveryMetricsEnabled      atomic.Bool
	recoverySnapshot            atomic.Pointer[recoveryMetricSnapshot]
	RoundsManualReview          atomic.Uint64
	RoundIntegrityQuarantines   atomic.Uint64
	SessionIntegrityQuarantines atomic.Uint64
	OutboxClaimed               atomic.Uint64
	OutboxPublished             atomic.Uint64
	OutboxDeferred              atomic.Uint64
	OutboxLeaseLost             atomic.Uint64
	databasePool                atomic.Pointer[sql.DB]
}

type recoveryMetricSnapshot struct {
	backlog           int64
	oldestDueAgeNanos int64
	observedUnix      int64
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
		{"rgs_new_intent_capacity_rejected_total", "New launch or spin intents rejected to preserve PostgreSQL critical result capacity.", m.NewIntentCapacityRejected.Load()},
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
	if err := m.writeWalletIsolationMetrics(w); err != nil {
		return err
	}
	if m.recoveryMetricsEnabled.Load() {
		if err := m.writeRecoveryMetrics(w); err != nil {
			return err
		}
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

func (m *Metrics) writeRecoveryMetrics(w io.Writer) error {
	snapshot := m.recoverySnapshot.Load()
	var backlog, oldestDueAgeNanos, snapshotObservedUnix int64
	if snapshot != nil {
		backlog, oldestDueAgeNanos, snapshotObservedUnix =
			snapshot.backlog, snapshot.oldestDueAgeNanos, snapshot.observedUnix
	}
	_, err := fmt.Fprintf(
		w,
		"# HELP rgs_recovery_backlog Capped database-global lower-bound of durably scheduled wallet recovery rows; 501 means at least 501 and is duplicated on every Worker target.\n"+
			"# TYPE rgs_recovery_backlog gauge\n"+
			"rgs_recovery_backlog %d\n"+
			"# HELP rgs_recovery_oldest_due_age_seconds Database-clock age past the oldest durably scheduled wallet recovery row; zero when none is overdue.\n"+
			"# TYPE rgs_recovery_oldest_due_age_seconds gauge\n"+
			"rgs_recovery_oldest_due_age_seconds %.9f\n"+
			"# HELP rgs_recovery_snapshot_last_success_timestamp_seconds Database Unix timestamp of the last successful durable recovery backlog snapshot.\n"+
			"# TYPE rgs_recovery_snapshot_last_success_timestamp_seconds gauge\n"+
			"rgs_recovery_snapshot_last_success_timestamp_seconds %d\n"+
			"# HELP rgs_recovery_snapshot_failures_total Durable recovery backlog snapshot attempts that failed or returned an invalid value.\n"+
			"# TYPE rgs_recovery_snapshot_failures_total counter\n"+
			"rgs_recovery_snapshot_failures_total %d\n"+
			"# HELP rgs_recovery_loop_last_success_timestamp_seconds Unix timestamp of the last successfully completed wallet recovery pass.\n"+
			"# TYPE rgs_recovery_loop_last_success_timestamp_seconds gauge\n"+
			"rgs_recovery_loop_last_success_timestamp_seconds %d\n"+
			"# HELP rgs_recovery_loop_failures_total Wallet recovery passes that did not complete successfully.\n"+
			"# TYPE rgs_recovery_loop_failures_total counter\n"+
			"rgs_recovery_loop_failures_total %d\n",
		backlog,
		float64(oldestDueAgeNanos)/float64(time.Second),
		snapshotObservedUnix,
		m.RecoverySnapshotFailures.Load(),
		m.RecoveryLoopLastSuccessUnix.Load(),
		m.RecoveryLoopFailures.Load(),
	)
	return err
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

func (m *Metrics) writeWalletIsolationMetrics(w io.Writer) error {
	if _, err := fmt.Fprint(
		w,
		"# HELP rgs_wallet_inflight Wallet requests currently executing beyond the isolation gates.\n"+
			"# TYPE rgs_wallet_inflight gauge\n",
	); err != nil {
		return err
	}
	for methodIndex, method := range walletMetricMethods {
		if _, err := fmt.Fprintf(
			w, "rgs_wallet_inflight{method=\"%s\"} %d\n",
			method, m.WalletActiveRequests[methodIndex].Load(),
		); err != nil {
			return err
		}
	}

	if _, err := fmt.Fprint(
		w,
		"# HELP rgs_wallet_isolation_rejected_total Wallet requests rejected without waiting by a bounded isolation gate.\n"+
			"# TYPE rgs_wallet_isolation_rejected_total counter\n",
	); err != nil {
		return err
	}
	for methodIndex, method := range walletMetricMethods {
		for reasonIndex, reason := range walletRejectionReasons {
			if _, err := fmt.Fprintf(
				w, "rgs_wallet_isolation_rejected_total{method=\"%s\",reason=\"%s\"} %d\n",
				method, reason, m.WalletIsolationRejections[methodIndex][reasonIndex].Load(),
			); err != nil {
				return err
			}
		}
	}

	if _, err := fmt.Fprint(
		w,
		"# HELP rgs_wallet_breakers Wallet circuit breakers in each bounded state.\n"+
			"# TYPE rgs_wallet_breakers gauge\n",
	); err != nil {
		return err
	}
	for methodIndex, method := range walletBreakerMethods {
		for stateIndex, state := range walletBreakerStates {
			if _, err := fmt.Fprintf(
				w, "rgs_wallet_breakers{method=\"%s\",state=\"%s\"} %d\n",
				method, state, m.WalletBreakers[methodIndex][stateIndex].Load(),
			); err != nil {
				return err
			}
		}
	}

	if _, err := fmt.Fprint(
		w,
		"# HELP rgs_wallet_request_duration_seconds Wallet request duration after isolation admission in seconds.\n"+
			"# TYPE rgs_wallet_request_duration_seconds histogram\n",
	); err != nil {
		return err
	}
	for methodIndex, method := range walletMetricMethods {
		for outcomeIndex, outcome := range walletMetricOutcomes {
			for bucketIndex, boundary := range requestLatencyBoundaries {
				if _, err := fmt.Fprintf(
					w,
					"rgs_wallet_request_duration_seconds_bucket{method=\"%s\",outcome=\"%s\",le=\"%s\"} %d\n",
					method, outcome, formatPrometheusSeconds(boundary),
					m.WalletRequestDurations[methodIndex][outcomeIndex][bucketIndex].Load(),
				); err != nil {
					return err
				}
			}
			count := m.WalletRequestDurationCount[methodIndex][outcomeIndex].Load()
			if _, err := fmt.Fprintf(
				w,
				"rgs_wallet_request_duration_seconds_bucket{method=\"%s\",outcome=\"%s\",le=\"+Inf\"} %d\n"+
					"rgs_wallet_request_duration_seconds_sum{method=\"%s\",outcome=\"%s\"} %.9f\n"+
					"rgs_wallet_request_duration_seconds_count{method=\"%s\",outcome=\"%s\"} %d\n",
				method, outcome, count,
				method, outcome, float64(m.WalletRequestDurationNanos[methodIndex][outcomeIndex].Load())/float64(time.Second),
				method, outcome, count,
			); err != nil {
				return err
			}
		}
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

// ObserveRecoveryBacklog 接收存储适配器用权威存储时钟生成的全局有界下界快照。
// 它没有运营商、会话、轮次或 Worker 标签；副本身份只来自受控 scrape 标签。
func (m *Metrics) ObserveRecoveryBacklog(
	backlog int64,
	oldestDueAge time.Duration,
	observedAt time.Time,
) {
	if m == nil || backlog < 0 || backlog > rgs.RecoverySnapshotBacklogLimit || oldestDueAge < 0 ||
		(backlog == 0 && oldestDueAge != 0) || observedAt.IsZero() || observedAt.Unix() <= 0 {
		return
	}
	m.recoveryMetricsEnabled.Store(true)
	m.recoverySnapshot.Store(&recoveryMetricSnapshot{
		backlog: backlog, oldestDueAgeNanos: int64(oldestDueAge),
		observedUnix: observedAt.UTC().Unix(),
	})
}

// EnableRecoveryMetrics 只由实际运行恢复循环的 worker/combined 角色调用，避免
// API-only Pod 暴露看似健康、实为从未采集的零积压与零新鲜度。
func (m *Metrics) EnableRecoveryMetrics() {
	if m != nil {
		m.recoveryMetricsEnabled.Store(true)
	}
}

func (m *Metrics) RecoveryLoopSucceeded(completedAt time.Time) {
	if m == nil || completedAt.IsZero() || completedAt.Unix() <= 0 {
		return
	}
	m.recoveryMetricsEnabled.Store(true)
	m.RecoveryLoopLastSuccessUnix.Store(completedAt.UTC().Unix())
}

func (m *Metrics) RecoveryLoopFailed() {
	if m != nil {
		m.recoveryMetricsEnabled.Store(true)
		m.RecoveryLoopFailures.Add(1)
	}
}

func (m *Metrics) RecoverySnapshotFailed() {
	if m != nil {
		m.recoveryMetricsEnabled.Store(true)
		m.RecoverySnapshotFailures.Add(1)
	}
}

// ObserveWalletRequest 仅接受 wallet 隔离层提供的固定 method/outcome，
// 通过固定数组避免任何请求派生标签或动态映射。
func (m *Metrics) ObserveWalletRequest(method, outcome string, duration time.Duration) {
	if m == nil {
		return
	}
	methodIndex, methodOK := walletMethodIndex(method)
	outcomeIndex, outcomeOK := walletOutcomeIndex(outcome)
	if !methodOK || !outcomeOK {
		return
	}
	if duration < 0 {
		duration = 0
	}
	m.WalletRequestDurationCount[methodIndex][outcomeIndex].Add(1)
	m.WalletRequestDurationNanos[methodIndex][outcomeIndex].Add(uint64(duration))
	for bucketIndex, boundary := range requestLatencyBoundaries {
		if duration <= boundary {
			m.WalletRequestDurations[methodIndex][outcomeIndex][bucketIndex].Add(1)
		}
	}
}

func (m *Metrics) WalletInFlight(method string, delta int64) {
	if m == nil {
		return
	}
	if methodIndex, ok := walletMethodIndex(method); ok {
		m.WalletActiveRequests[methodIndex].Add(delta)
	}
}

func (m *Metrics) WalletIsolationRejected(method, reason string) {
	if m == nil {
		return
	}
	methodIndex, methodOK := walletMethodIndex(method)
	reasonIndex, reasonOK := walletRejectionIndex(reason)
	if methodOK && reasonOK {
		m.WalletIsolationRejections[methodIndex][reasonIndex].Add(1)
	}
}

func (m *Metrics) WalletBreakerStateChanged(method, previous, current string) {
	if m == nil {
		return
	}
	methodIndex, ok := walletBreakerMethodIndex(method)
	if !ok {
		return
	}
	if previousIndex, previousOK := walletBreakerStateIndex(previous); previousOK {
		m.WalletBreakers[methodIndex][previousIndex].Add(-1)
	}
	if currentIndex, currentOK := walletBreakerStateIndex(current); currentOK {
		m.WalletBreakers[methodIndex][currentIndex].Add(1)
	}
}

func walletMethodIndex(method string) (int, bool) {
	for index, candidate := range walletMetricMethods {
		if method == candidate {
			return index, true
		}
	}
	return 0, false
}

func walletOutcomeIndex(outcome string) (int, bool) {
	for index, candidate := range walletMetricOutcomes {
		if outcome == candidate {
			return index, true
		}
	}
	return 0, false
}

func walletRejectionIndex(reason string) (int, bool) {
	for index, candidate := range walletRejectionReasons {
		if reason == candidate {
			return index, true
		}
	}
	return 0, false
}

func walletBreakerMethodIndex(method string) (int, bool) {
	for index, candidate := range walletBreakerMethods {
		if method == candidate {
			return index, true
		}
	}
	return 0, false
}

func walletBreakerStateIndex(state string) (int, bool) {
	for index, candidate := range walletBreakerStates {
		if state == candidate {
			return index, true
		}
	}
	return 0, false
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

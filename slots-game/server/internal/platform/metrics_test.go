package platform

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"slots-game/server/internal/outbox"
	"slots-game/server/internal/rgs"
)

type metricsReadinessCheck struct {
	check func(context.Context) error
}

func (metricsReadinessCheck) Name() string { return "dependency" }

func (check metricsReadinessCheck) Check(ctx context.Context) error {
	return check.check(ctx)
}

func TestMetricsHaveNoHighCardinalityLabels(t *testing.T) {
	metrics := &Metrics{}
	metrics.RoundsCommitted.Add(2)
	metrics.HTTPServerFailures.Add(3)
	metrics.CapacityRejected.Add(4)
	metrics.NewIntentCapacityRejected.Add(5)
	metrics.PreAuthCapacityRejected.Add(6)
	metrics.CryptographicCapacityRejected.Add(8)
	metrics.NonceReplay()
	metrics.AccessLogEmitted()
	metrics.AccessLogDropped()
	metrics.SecurityLogDropped()
	metrics.TraceExportFailure()
	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if !strings.Contains(text, "rgs_rounds_committed_total 2") {
		t.Fatalf("unexpected metrics output: %s", text)
	}
	if !strings.Contains(text, "rgs_http_server_failures_total 3") {
		t.Fatalf("unexpected metrics output: %s", text)
	}
	if !strings.Contains(text, "# HELP rgs_capacity_rejected_total Public requests rejected by the process-wide in-flight capacity gate.") ||
		!strings.Contains(text, "# TYPE rgs_capacity_rejected_total counter") ||
		!strings.Contains(text, "rgs_capacity_rejected_total 4") {
		t.Fatalf("capacity rejection counter missing from output: %s", text)
	}
	if !strings.Contains(text, "# TYPE rgs_new_intent_capacity_rejected_total counter") ||
		!strings.Contains(text, "rgs_new_intent_capacity_rejected_total 5") {
		t.Fatalf("new-intent capacity rejection counter missing from output: %s", text)
	}
	for _, metric := range []string{
		"rgs_preauth_capacity_rejected_total 6",
		"rgs_cryptographic_capacity_rejected_total 8",
	} {
		if !strings.Contains(text, metric) {
			t.Fatalf("bounded capacity metric %q missing from output: %s", metric, text)
		}
	}
	for _, forbidden := range []string{
		"rgs_http_priority_capacity_rejected_total",
		"rgs_cryptographic_recovery_capacity_rejected_total",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("metric %q trusts an unauthenticated recovery path: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, "rgs_access_logs_emitted_total 1") ||
		!strings.Contains(text, "rgs_access_logs_dropped_total 1") ||
		!strings.Contains(text, "rgs_security_logs_dropped_total 1") ||
		!strings.Contains(text, "rgs_trace_export_failures_total 1") {
		t.Fatalf("access log counters missing from output: %s", text)
	}
	if !strings.Contains(text, "# TYPE rgs_auth_replays_total counter") ||
		!strings.Contains(text, "rgs_auth_replays_total 1") {
		t.Fatalf("认证重放计数器未输出: %s", text)
	}
	assertNoHighCardinalityMetricLabels(t, text)
}

func TestMetricsImplementBoundedBusinessObservers(t *testing.T) {
	metrics := &Metrics{}
	metrics.RoundPrepared()
	metrics.NonceReplay()
	metrics.RoundCommitted()
	metrics.RoundReplayed()
	metrics.IdempotencyConflict()
	metrics.RoundManualReview()
	metrics.RoundIntegrityQuarantined()
	metrics.SessionIntegrityQuarantined()
	metrics.WalletCall()
	metrics.WalletUnknownOutcome()
	metrics.ObserveOutboxDispatch(outbox.BatchResult{
		Claimed: 5, Published: 2, Failed: 2, LeaseLost: 1,
	})

	if metrics.AuthReplays.Load() != 1 || metrics.RoundsPrepared.Load() != 1 || metrics.RoundsCommitted.Load() != 1 ||
		metrics.RoundReplays.Load() != 1 || metrics.IdempotencyConflicts.Load() != 1 ||
		metrics.RoundsManualReview.Load() != 1 || metrics.WalletCalls.Load() != 1 ||
		metrics.RoundIntegrityQuarantines.Load() != 1 ||
		metrics.SessionIntegrityQuarantines.Load() != 1 ||
		metrics.WalletUnknownOutcomes.Load() != 1 || metrics.OutboxClaimed.Load() != 5 ||
		metrics.OutboxPublished.Load() != 2 || metrics.OutboxDeferred.Load() != 2 ||
		metrics.OutboxLeaseLost.Load() != 1 {
		t.Fatalf("business metrics were not observed exactly: %+v", metrics)
	}

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, metric := range []string{
		"rgs_rounds_manual_review_total 1",
		"rgs_round_integrity_quarantines_total 1",
		"rgs_session_integrity_quarantines_total 1",
		"rgs_outbox_claimed_total 5",
		"rgs_outbox_published_total 2",
		"rgs_outbox_deferred_total 2",
		"rgs_outbox_lease_lost_total 1",
	} {
		if !strings.Contains(text, metric) {
			t.Fatalf("metrics output does not contain %q:\n%s", metric, text)
		}
	}
	assertNoHighCardinalityMetricLabels(t, text)
}

func TestRequestTelemetryUsesFixedCumulativeBuckets(t *testing.T) {
	metrics := &Metrics{}
	metrics.HTTPActiveConnections.Store(7)
	metrics.HTTPConnectionLimit.Store(1_024)
	metrics.BeginHTTPRequest()
	metrics.EndHTTPRequest(7 * time.Millisecond)
	metrics.BeginHTTPRequest()
	metrics.EndHTTPRequest(2 * time.Second)

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, metric := range []string{
		"rgs_http_active_requests 0",
		"rgs_http_active_connections 7",
		"rgs_http_connection_limit 1024",
		`rgs_http_request_duration_seconds_bucket{le="0.005"} 0`,
		`rgs_http_request_duration_seconds_bucket{le="0.010"} 1`,
		`rgs_http_request_duration_seconds_bucket{le="1.000"} 1`,
		`rgs_http_request_duration_seconds_bucket{le="2.500"} 2`,
		`rgs_http_request_duration_seconds_bucket{le="+Inf"} 2`,
		"rgs_http_request_duration_seconds_count 2",
	} {
		if !strings.Contains(text, metric) {
			t.Fatalf("metrics output does not contain %q:\n%s", metric, text)
		}
	}
	assertNoHighCardinalityMetricLabels(t, text)
}

func TestWalletIsolationTelemetryUsesOnlyBoundedLabels(t *testing.T) {
	metrics := &Metrics{}
	metrics.WalletBreakerStateChanged("apply", "", "closed")
	metrics.WalletBreakerStateChanged("apply", "closed", "open")
	metrics.WalletBreakerStateChanged("lookup", "", "closed")
	metrics.WalletBreakerStateChanged("operator_lookup", "", "closed")
	metrics.WalletInFlight("lookup", 1)
	metrics.ObserveWalletRequest("lookup", "pending", 7*time.Millisecond)
	metrics.ObserveWalletRequest("lookup", "response_auth_invalid", 8*time.Millisecond)
	metrics.WalletIsolationRejected("apply", "backend_bulkhead")
	metrics.ObserveWalletRequest("apply", "isolated", time.Millisecond)

	// 非法值模拟请求派生输入；实现必须静默丢弃，绝不能生成新时序。
	// Invalid values model request-derived input; the implementation must silently drop them and must never create a new time series.
	metrics.WalletInFlight("operator-secret", 1)
	metrics.ObserveWalletRequest("apply", "player-secret", time.Second)
	metrics.WalletIsolationRejected("apply", "round-secret")
	metrics.WalletBreakerStateChanged("operator-secret", "", "open")

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, metric := range []string{
		`rgs_wallet_inflight{method="lookup"} 1`,
		`rgs_wallet_isolation_rejected_total{method="apply",reason="backend_bulkhead"} 1`,
		`rgs_wallet_breakers{method="apply",state="closed"} 0`,
		`rgs_wallet_breakers{method="apply",state="open"} 1`,
		`rgs_wallet_breakers{method="lookup",state="closed"} 1`,
		`rgs_wallet_breakers{method="operator_lookup",state="closed"} 1`,
		`rgs_wallet_request_duration_seconds_bucket{method="lookup",outcome="pending",le="0.010"} 1`,
		`rgs_wallet_request_duration_seconds_count{method="lookup",outcome="pending"} 1`,
		`rgs_wallet_request_duration_seconds_count{method="lookup",outcome="response_auth_invalid"} 1`,
		`rgs_wallet_request_duration_seconds_count{method="apply",outcome="isolated"} 1`,
	} {
		if !strings.Contains(text, metric) {
			t.Fatalf("metrics output does not contain %q:\n%s", metric, text)
		}
	}
	for _, leaked := range []string{"operator-secret", "player-secret", "round-secret"} {
		if strings.Contains(text, leaked) {
			t.Fatalf("wallet metrics leaked unbounded value %q:\n%s", leaked, text)
		}
	}
	assertNoHighCardinalityMetricLabels(t, text)
}

func TestRecoveryTelemetryUsesOnlyGlobalUnlabelledSnapshots(t *testing.T) {
	metrics := &Metrics{}
	metrics.ObserveRecoveryBacklog(7, 3250*time.Millisecond, time.Unix(1_699_999_990, 0))
	metrics.RecoveryLoopSucceeded(time.Unix(1_700_000_000, 0))
	metrics.RecoveryLoopFailed()
	metrics.RecoverySnapshotFailed()

	// 非法快照和零时间不能覆盖最后一份可信观测。
	// Invalid snapshots and zero times must not overwrite the last trusted observation.
	metrics.ObserveRecoveryBacklog(-1, -time.Second, time.Time{})
	metrics.ObserveRecoveryBacklog(
		rgs.RecoverySnapshotBacklogLimit+1, time.Second, time.Unix(1_700_000_100, 0),
	)
	metrics.RecoveryLoopSucceeded(time.Time{})

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, metric := range []string{
		"Capped database-global lower-bound of durably scheduled wallet recovery rows; 501 means at least 501",
		"rgs_recovery_backlog 7",
		"rgs_recovery_oldest_due_age_seconds 3.250000000",
		"rgs_recovery_snapshot_last_success_timestamp_seconds 1699999990",
		"rgs_recovery_snapshot_failures_total 1",
		"rgs_recovery_loop_last_success_timestamp_seconds 1700000000",
		"rgs_recovery_loop_failures_total 1",
	} {
		if !strings.Contains(text, metric) {
			t.Fatalf("metrics output does not contain %q:\n%s", metric, text)
		}
	}
	assertNoHighCardinalityMetricLabels(t, text)
}

func TestAPIOnlyMetricsDoNotExposeSyntheticRecoveryZeros(t *testing.T) {
	var output bytes.Buffer
	if err := (&Metrics{}).WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "rgs_recovery_") {
		t.Fatalf("API-only metrics exposed synthetic recovery state:\n%s", output.String())
	}
}

func TestMetricsWithoutConfiguredAdmissionDoNotExposeSyntheticEconomicHealth(t *testing.T) {
	var output bytes.Buffer
	if err := (&Metrics{}).WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "rgs_economic_admission_ready") ||
		strings.Contains(output.String(), "rgs_economic_admission_last_success_") {
		t.Fatalf("worker metrics exposed synthetic economic admission health:\n%s", output.String())
	}
}

func TestEconomicAdmissionHealthRequiresBothComponentsAndPreservesLastSuccess(t *testing.T) {
	metrics := &Metrics{}
	metrics.EnableEconomicAdmissionHealthMetrics()
	writeAt := func(observedAt time.Time) string {
		t.Helper()
		var output bytes.Buffer
		if err := metrics.writeEconomicAdmissionHealthMetrics(&output, observedAt); err != nil {
			t.Fatal(err)
		}
		assertNoHighCardinalityMetricLabels(t, output.String())
		return output.String()
	}
	assertContains := func(text string, expected ...string) {
		t.Helper()
		for _, item := range expected {
			if !strings.Contains(text, item) {
				t.Fatalf("economic admission metrics missing %q:\n%s", item, text)
			}
		}
	}

	text := writeAt(time.Unix(1_700_000_000, 0))
	assertContains(text,
		"rgs_economic_admission_ready 0",
		"rgs_economic_admission_last_success_timestamp_seconds 0",
		"rgs_economic_admission_last_success_age_seconds -1",
	)

	metrics.ObserveSharedAdmissionHealth(true, time.Unix(1_699_999_990, 0))
	text = writeAt(time.Unix(1_700_000_000, 0))
	assertContains(text,
		"rgs_economic_admission_ready 0",
		"rgs_economic_admission_last_success_timestamp_seconds 0",
	)

	metrics.ObserveEconomicAdmissionHealth(true, time.Unix(1_699_999_995, 0))
	text = writeAt(time.Unix(1_700_000_000, 0))
	assertContains(text,
		"rgs_economic_admission_ready 1",
		"rgs_economic_admission_last_success_timestamp_seconds 1699999990",
		"rgs_economic_admission_last_success_age_seconds 10",
	)
	// 只有一条路径产生新观测时，不能掩盖另一条路径已经陈旧的成功证据。
	// A fresh observation from only one path must not conceal stale success evidence from the other path.
	metrics.ObserveEconomicAdmissionHealth(true, time.Unix(1_700_000_001, 0))
	text = writeAt(time.Unix(1_700_000_002, 0))
	assertContains(text,
		"rgs_economic_admission_last_success_timestamp_seconds 1699999990",
		"rgs_economic_admission_last_success_age_seconds 12",
	)

	metrics.ObserveEconomicAdmissionHealth(false, time.Time{})
	text = writeAt(time.Unix(1_700_000_005, 0))
	assertContains(text,
		"rgs_economic_admission_ready 0",
		"rgs_economic_admission_last_success_timestamp_seconds 1699999990",
		"rgs_economic_admission_last_success_age_seconds 15",
	)

	metrics.ObserveEconomicAdmissionHealth(true, time.Unix(1_700_000_010, 0))
	metrics.ObserveSharedAdmissionHealth(true, time.Unix(1_700_000_011, 0))
	metrics.ObserveSharedAdmissionHealth(true, time.Time{})
	text = writeAt(time.Unix(1_700_000_012, 0))
	assertContains(text,
		"rgs_economic_admission_ready 0",
		"rgs_economic_admission_last_success_timestamp_seconds 1700000010",
		"rgs_economic_admission_last_success_age_seconds 2",
	)
}

func TestMetricsExposeAttachedDatabasePoolGauges(t *testing.T) {
	metrics := &Metrics{}
	metrics.SetDatabasePool(&sql.DB{})

	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, metric := range []string{
		"rgs_db_pool_open_connections 0",
		"rgs_db_pool_in_use_connections 0",
		"rgs_db_pool_idle_connections 0",
		"rgs_db_pool_max_open_connections 0",
		"rgs_db_pool_wait_count_total 0",
		"rgs_db_pool_wait_duration_seconds_total 0.000000000",
	} {
		if !strings.Contains(text, metric) {
			t.Fatalf("metrics output does not contain %q:\n%s", metric, text)
		}
	}
}

func TestMetricsEndpointReportsBoundedReadinessWithoutChangingHTTPStatus(t *testing.T) {
	for _, test := range []struct {
		name      string
		check     func(context.Context) error
		wantReady string
	}{
		{
			name:      "ready",
			check:     func(context.Context) error { return nil },
			wantReady: "rgs_ready 1",
		},
		{
			name:      "dependency failure",
			check:     func(context.Context) error { return errors.New("secret database detail") },
			wantReady: "rgs_ready 0",
		},
		{
			name: "total deadline",
			check: func(ctx context.Context) error {
				<-ctx.Done()
				return ctx.Err()
			},
			wantReady: "rgs_ready 0",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			endpoint := MetricsEndpoint{
				Metrics: &Metrics{},
				Readiness: Readiness{
					Checks: []DependencyCheck{metricsReadinessCheck{check: func(ctx context.Context) error {
						calls++
						return test.check(ctx)
					}}},
					Timeout: 20 * time.Millisecond,
				},
			}
			recorder := httptest.NewRecorder()
			started := time.Now()
			endpoint.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
			elapsed := time.Since(started)

			if recorder.Code != http.StatusOK {
				t.Fatalf("metrics status = %d, want 200", recorder.Code)
			}
			if calls != 1 {
				t.Fatalf("readiness calls = %d, want 1 per scrape", calls)
			}
			if body := recorder.Body.String(); !strings.Contains(body, test.wantReady) ||
				strings.Contains(body, "secret database detail") ||
				strings.Contains(body, "rgs_ready{") {
				t.Fatalf("unsafe or incorrect readiness metric:\n%s", body)
			}
			if elapsed > 250*time.Millisecond {
				t.Fatalf("readiness metric exceeded bounded scrape time: %s", elapsed)
			}
		})
	}
}

func assertNoHighCardinalityMetricLabels(t *testing.T, text string) {
	t.Helper()
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, "{") {
			continue
		}
		switch {
		case strings.HasPrefix(line, `rgs_http_request_duration_seconds_bucket{le="`):
		case strings.HasPrefix(line, `rgs_wallet_inflight{method="`):
			assertContainsOneLabelValue(t, line, "method", walletMetricMethods[:])
		case strings.HasPrefix(line, `rgs_wallet_isolation_rejected_total{method="`):
			assertContainsOneLabelValue(t, line, "method", walletMetricMethods[:])
			assertContainsOneLabelValue(t, line, "reason", walletRejectionReasons[:])
		case strings.HasPrefix(line, `rgs_wallet_breakers{method="`):
			assertContainsOneLabelValue(t, line, "method", walletBreakerMethods[:])
			assertContainsOneLabelValue(t, line, "state", walletBreakerStates[:])
		case strings.HasPrefix(line, `rgs_wallet_request_duration_seconds_`):
			assertContainsOneLabelValue(t, line, "method", walletMetricMethods[:])
			assertContainsOneLabelValue(t, line, "outcome", walletMetricOutcomes[:])
		default:
			t.Fatalf("unexpected metric label set: %s", line)
		}
	}
	for _, forbidden := range []string{"operator", "player", "session", "round", "transaction", "request_id"} {
		if strings.Contains(text, forbidden+"=") {
			t.Fatalf("high-cardinality label %q is exposed:\n%s", forbidden, text)
		}
	}
}

func assertContainsOneLabelValue(t *testing.T, line, label string, allowed []string) {
	t.Helper()
	matches := 0
	for _, value := range allowed {
		if strings.Contains(line, label+`="`+value+`"`) {
			matches++
		}
	}
	if matches != 1 {
		t.Fatalf("metric label %q is not a single bounded value: %s", label, line)
	}
}

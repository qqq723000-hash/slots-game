package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"slots-game/server/internal/platform"
)

func TestSecurityEventObserverEmitsBoundedNonceReplaySignal(t *testing.T) {
	var output bytes.Buffer
	metrics := &platform.Metrics{}
	observer := newSecurityEventObserver(
		slog.New(slog.NewJSONHandler(&output, nil)),
		metrics,
	)

	observer.NonceReplay()

	if metrics.AuthReplays.Load() != 1 {
		t.Fatalf("认证重放指标 = %d，期望 1", metrics.AuthReplays.Load())
	}
	var record map[string]any
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatalf("解析安全日志失败: %v", err)
	}
	if record["level"] != "WARN" || record["msg"] != "检测到认证随机数重放" ||
		record["security_event"] != "nonce_replay" {
		t.Fatalf("安全日志分类错误: %#v", record)
	}
	for key := range record {
		switch key {
		case "time", "level", "msg", "security_event":
		default:
			t.Fatalf("安全日志包含非固定字段 %q: %#v", key, record)
		}
	}
}

func TestSecurityEventObserverBoundsNonceReplayLogsWithoutSamplingMetric(t *testing.T) {
	const events = 1_000
	var output bytes.Buffer
	metrics := &platform.Metrics{}
	observer := newSecurityEventObserver(
		slog.New(slog.NewJSONHandler(&output, nil)),
		metrics,
	)

	for range events {
		observer.NonceReplay()
	}

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) >= events/2 {
		t.Fatalf("nonce-replay security log was not bounded: lines=%d events=%d", len(lines), events)
	}
	if metrics.AuthReplays.Load() != events {
		t.Fatalf("bounded security log sampled the full replay metric: got=%d want=%d",
			metrics.AuthReplays.Load(), events)
	}
	if metrics.SecurityLogsDropped.Load() != uint64(events-len(lines)) {
		t.Fatalf("security log drops=%d, want %d",
			metrics.SecurityLogsDropped.Load(), events-len(lines))
	}
}

func TestSecurityEventObserverDoesNotBlockOnSaturatedLogWriter(t *testing.T) {
	const expectedMaximumWrites = 2
	started := make(chan struct{}, expectedMaximumWrites+1)
	release := make(chan struct{})
	metrics := &platform.Metrics{}
	observer := newSecurityEventObserver(
		slog.New(blockingAccessLogHandler{started: started, release: release}),
		metrics,
	)

	var admitted sync.WaitGroup
	for range expectedMaximumWrites {
		admitted.Add(1)
		go func() {
			defer admitted.Done()
			observer.NonceReplay()
		}()
	}
	for range expectedMaximumWrites {
		<-started
	}

	overflowDone := make(chan struct{})
	go func() {
		defer close(overflowDone)
		observer.NonceReplay()
	}()
	select {
	case <-overflowDone:
		close(release)
		admitted.Wait()
	case <-time.After(250 * time.Millisecond):
		close(release)
		admitted.Wait()
		<-overflowDone
		t.Fatal("security-log overflow blocked nonce replay observation")
	}
	if metrics.AuthReplays.Load() != expectedMaximumWrites+1 {
		t.Fatalf("security log bulkhead sampled replay metric: got=%d want=%d",
			metrics.AuthReplays.Load(), expectedMaximumWrites+1)
	}
	if metrics.SecurityLogsDropped.Load() != 1 {
		t.Fatalf("security log drop metric=%d, want 1", metrics.SecurityLogsDropped.Load())
	}
}

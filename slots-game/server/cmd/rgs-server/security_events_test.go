package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

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

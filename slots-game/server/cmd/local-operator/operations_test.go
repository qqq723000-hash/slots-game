package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackupStatusMetricsFailClosedAndRecover(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup-status.json")
	metrics := localOperationsMetrics{BackupStatusFile: path}
	missing := strings.Join(metrics.PrometheusLines(), "\n")
	if !strings.Contains(missing, "local_production_backup_status_file_readable 0") ||
		!strings.Contains(missing, "local_production_backup_last_success_timestamp_seconds 0") {
		t.Fatalf("missing status did not fail closed: %s", missing)
	}

	valid := `{"schema":"local-production-backup-status-v1","lastAttemptUnix":1700000000,"lastSuccessUnix":1699999000,"failuresTotal":3,"consecutiveFailures":1,"lastOutcome":"failure"}`
	if err := os.WriteFile(path, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	rendered := strings.Join(metrics.PrometheusLines(), "\n")
	for _, expected := range []string{
		"local_production_backup_status_file_readable 1",
		"local_production_backup_last_attempt_timestamp_seconds 1700000000",
		"local_production_backup_last_success_timestamp_seconds 1699999000",
		"local_production_backup_failures_total 3",
		"local_production_backup_consecutive_failures 1",
		"local_production_backup_last_attempt_success 0",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("missing %q in %s", expected, rendered)
		}
	}
}

func TestBackupStatusRejectsFutureTimestamp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup-status.json")
	future := time.Now().UTC().Add(10 * time.Minute).Unix()
	encoded := fmt.Sprintf(`{"schema":"local-production-backup-status-v1","lastAttemptUnix":%d,"lastSuccessUnix":%d,"failuresTotal":0,"consecutiveFailures":0,"lastOutcome":"success"}`, future, future)
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBackupStatus(path); err == nil {
		t.Fatal("future backup status was accepted")
	}
}

func TestBackupStatusRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "real-status.json")
	path := filepath.Join(directory, "backup-status.json")
	valid := `{"schema":"local-production-backup-status-v1","lastAttemptUnix":1700000000,"lastSuccessUnix":1700000000,"failuresTotal":0,"consecutiveFailures":0,"lastOutcome":"success"}`
	if err := os.WriteFile(target, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if _, err := readBackupStatus(path); err == nil {
		t.Fatal("symlinked backup status was accepted")
	}
}

func TestBackupStatusRejectsInconsistentSuccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup-status.json")
	invalid := `{"schema":"local-production-backup-status-v1","lastAttemptUnix":1800000000,"lastSuccessUnix":1799999000,"failuresTotal":0,"consecutiveFailures":0,"lastOutcome":"success"}`
	if err := os.WriteFile(path, []byte(invalid), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBackupStatus(path); err == nil {
		t.Fatal("inconsistent successful backup status was accepted")
	}
}

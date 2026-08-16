package main

import (
	"errors"
	"io"
	"os"
	"strconv"
	"time"
)

const backupStatusSchema = "local-production-backup-status-v1"

type backupStatusDocument struct {
	Schema              string `json:"schema"`
	LastAttemptUnix     int64  `json:"lastAttemptUnix"`
	LastSuccessUnix     int64  `json:"lastSuccessUnix"`
	FailuresTotal       uint64 `json:"failuresTotal"`
	ConsecutiveFailures uint64 `json:"consecutiveFailures"`
	LastOutcome         string `json:"lastOutcome"`
}

type localOperationsMetrics struct {
	Audit            *auditJSONLStore
	Logs             *appendStore
	Alerts           *appendStore
	BackupStatusFile string
}

func (m localOperationsMetrics) PrometheusLines() []string {
	lines := make([]string, 0, 52)
	lines = appendStoreMetrics(lines, "audit", auditStats(m.Audit))
	lines = appendStoreMetrics(lines, "log", appendStats(m.Logs))
	lines = appendStoreMetrics(lines, "alert", appendStats(m.Alerts))
	status, err := readBackupStatus(m.BackupStatusFile)
	readable := "0"
	if err == nil {
		readable = "1"
	}
	lastAttemptSuccess := "0"
	if status.LastOutcome == "success" {
		lastAttemptSuccess = "1"
	}
	lines = append(lines,
		"# HELP local_production_backup_status_file_readable Whether the atomic backup status file is valid.",
		"# TYPE local_production_backup_status_file_readable gauge",
		"local_production_backup_status_file_readable "+readable,
		"# TYPE local_production_backup_last_attempt_timestamp_seconds gauge",
		"local_production_backup_last_attempt_timestamp_seconds "+strconv.FormatInt(status.LastAttemptUnix, 10),
		"# TYPE local_production_backup_last_success_timestamp_seconds gauge",
		"local_production_backup_last_success_timestamp_seconds "+strconv.FormatInt(status.LastSuccessUnix, 10),
		"# TYPE local_production_backup_failures_total counter",
		"local_production_backup_failures_total "+strconv.FormatUint(status.FailuresTotal, 10),
		"# TYPE local_production_backup_consecutive_failures gauge",
		"local_production_backup_consecutive_failures "+strconv.FormatUint(status.ConsecutiveFailures, 10),
		"# TYPE local_production_backup_last_attempt_success gauge",
		"local_production_backup_last_attempt_success "+lastAttemptSuccess,
	)
	return lines
}

func appendStoreMetrics(lines []string, name string, stats sinkStoreStats) []string {
	writable := "0"
	if stats.Writable {
		writable = "1"
	}
	prefix := "local_operator_" + name + "_store_"
	return append(lines,
		"# TYPE "+prefix+"bytes gauge",
		prefix+"bytes "+strconv.FormatInt(stats.Bytes, 10),
		"# TYPE "+prefix+"capacity_bytes gauge",
		prefix+"capacity_bytes "+strconv.FormatInt(stats.Capacity, 10),
		"# TYPE "+prefix+"writable gauge",
		prefix+"writable "+writable,
		"# TYPE "+prefix+"segments gauge",
		prefix+"segments "+strconv.Itoa(stats.Segments),
	)
}

func auditStats(store *auditJSONLStore) sinkStoreStats {
	if store == nil {
		return sinkStoreStats{}
	}
	return store.Stats()
}

func appendStats(store *appendStore) sinkStoreStats {
	if store == nil {
		return sinkStoreStats{}
	}
	return store.Stats()
}

func readBackupStatus(path string) (backupStatusDocument, error) {
	if path == "" {
		return backupStatusDocument{}, errors.New("backup status path is empty")
	}
	pathInfo, err := os.Lstat(path)
	if err != nil || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return backupStatusDocument{}, errors.New("backup status file is unavailable")
	}
	file, err := os.Open(path)
	if err != nil {
		return backupStatusDocument{}, errors.New("backup status file is unavailable")
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openedInfo) {
		return backupStatusDocument{}, errors.New("backup status file is unavailable")
	}
	encoded, err := io.ReadAll(io.LimitReader(file, (16<<10)+1))
	if err != nil || len(encoded) == 0 || len(encoded) > 16<<10 {
		return backupStatusDocument{}, errors.New("backup status file is unavailable")
	}
	var status backupStatusDocument
	if err := decodeStrictJSON(encoded, &status); err != nil || status.Schema != backupStatusSchema ||
		status.LastAttemptUnix <= 0 || status.LastSuccessUnix < 0 ||
		status.LastAttemptUnix > time.Now().UTC().Add(5*time.Minute).Unix() ||
		status.LastSuccessUnix > status.LastAttemptUnix ||
		(status.LastOutcome != "success" && status.LastOutcome != "failure") ||
		(status.LastOutcome == "success" &&
			(status.LastSuccessUnix != status.LastAttemptUnix || status.ConsecutiveFailures != 0)) ||
		(status.LastOutcome == "failure" && status.ConsecutiveFailures == 0) {
		return backupStatusDocument{}, errors.New("backup status file is invalid")
	}
	return status, nil
}

package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"slots-game/server/internal/mathreport"
)

func TestExecuteFailsClosedWithoutExplicitRTPPolicy(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := execute([]string{"-paid-spins", "1"}, &stdout, &stderr)
	if exitCode != 2 {
		t.Fatalf("exit code = %d, want 2; stderr=%s", exitCode, stderr.String())
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "requires both -rtp-min and -rtp-max") {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestExecuteEmitsEvidenceAndRejectsUnsafeDemoRTP(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := execute([]string{
		"-paid-spins", "10000", "-bet-minor", "1000", "-seed", "7",
		"-rtp-min", "0.94", "-rtp-max", "0.98",
	}, &stdout, &stderr)
	if exitCode != 1 {
		t.Fatalf("exit code = %d, want 1; stderr=%s", exitCode, stderr.String())
	}
	var report mathreport.Report
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, stdout.String())
	}
	if report.RTPAcceptance.Passed || report.RTPAcceptance.Minimum != "0.94" || report.RTPAcceptance.Maximum != "0.98" {
		t.Fatalf("unexpected acceptance result: %+v", report.RTPAcceptance)
	}
	if report.SchemaVersion != mathreport.ReportSchemaVersion ||
		report.EngineRulesSchemaVersion != mathreport.EngineRulesSchemaVersion ||
		report.RNG.Algorithm != simulationRNGAlgorithmVersion || report.RNG.Seed != "7" ||
		len(report.ConfigurationSHA256) != 64 {
		t.Fatalf("missing report identity: %+v", report)
	}
	if !strings.Contains(stderr.String(), "RTP acceptance failed") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestExecuteReturnsZeroInsideExplicitWideAcceptance(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := execute([]string{
		"-paid-spins", "100", "-bet-minor", "100", "-seed", "11",
		"-rtp-min", "0", "-rtp-max", "1000",
	}, &stdout, &stderr)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, want 0; stderr=%s", exitCode, stderr.String())
	}
	var report mathreport.Report
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if !report.RTPAcceptance.Passed || report.ObservedMaximum.CycleWinMinor < report.ObservedMaximum.SpinWinMinor {
		t.Fatalf("unexpected report: %+v", report)
	}
}

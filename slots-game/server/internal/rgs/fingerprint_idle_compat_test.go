package rgs

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestIdleDeadlineDoesNotChangeLegacyEconomicHashesOrJSON(t *testing.T) {
	legacy := SpinResult{
		OperatorID: "operator-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "iron-colossus-demo", DefinitionVersion: "definition-v1",
		DefinitionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Currency:       "EUR", RoundKind: RoundKindBase,
		ServerTransactionID: "server-transaction-a",
		StartRevision:       7, EndRevision: 8, Sequence: 9,
		BetMinor: 100, ChargedBetMinor: 100, BalanceMinor: 9900,
	}
	legacyOutcomeHash, err := OutcomeHashFor(legacy)
	if err != nil {
		t.Fatal(err)
	}
	legacyCommittedHash, err := CommittedResultHashFor(legacy)
	if err != nil {
		t.Fatal(err)
	}

	hydrated := legacy
	hydrated.IdleDisconnectAt = time.Date(2026, 8, 25, 1, 2, 3, 0, time.UTC)
	hydratedOutcomeHash, err := OutcomeHashFor(hydrated)
	if err != nil {
		t.Fatal(err)
	}
	hydratedCommittedHash, err := CommittedResultHashFor(hydrated)
	if err != nil {
		t.Fatal(err)
	}
	if hydratedOutcomeHash != legacyOutcomeHash || hydratedCommittedHash != legacyCommittedHash {
		t.Fatalf(
			"transport hydration changed economic hashes: outcome %q/%q committed %q/%q",
			legacyOutcomeHash, hydratedOutcomeHash, legacyCommittedHash, hydratedCommittedHash,
		)
	}
	encoded, err := json.Marshal(hydrated)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("IdleDisconnect")) || bytes.Contains(encoded, []byte("idleDisconnect")) {
		t.Fatalf("transport deadline leaked into legacy result_json: %s", encoded)
	}
}

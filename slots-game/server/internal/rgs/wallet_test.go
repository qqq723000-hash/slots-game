package rgs

import (
	"strings"
	"testing"
	"time"
)

func TestWalletCommandDigestBindsCompleteEconomicInstruction(t *testing.T) {
	command := WalletRound{
		OperationID: "operation-1", Fingerprint: "rgs-fp-v2:" + strings.Repeat("a", 64),
		OperatorID: "operator-a", PlayerID: "player-a", WalletAccountID: "wallet-a",
		WalletSessionRef: "wallet-session-a", SessionID: "session-a", RoundID: "round-a",
		GameID: "game-a", DefinitionVersion: "math-v1", DefinitionHash: strings.Repeat("b", 64),
		RoundKind: RoundKindBase, Currency: "USD", DebitMinor: 100, CreditMinor: 250,
	}
	command.CommandDigest = CommandDigestFor(command)
	if len(command.CommandDigest) != len("rgs-wallet-cmd-v1:")+64 {
		t.Fatalf("command digest = %q", command.CommandDigest)
	}
	if err := ValidateWalletCommand(command); err != nil {
		t.Fatalf("ValidateWalletCommand() error = %v", err)
	}

	mutations := map[string]func(*WalletRound){
		"wallet-session": func(value *WalletRound) { value.WalletSessionRef = "wallet-session-b" },
		"account":        func(value *WalletRound) { value.WalletAccountID = "wallet-b" },
		"debit":          func(value *WalletRound) { value.DebitMinor++ },
		"credit":         func(value *WalletRound) { value.CreditMinor++ },
		"definition":     func(value *WalletRound) { value.DefinitionHash = strings.Repeat("c", 64) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			changed := command
			mutate(&changed)
			if CommandDigestFor(changed) == command.CommandDigest {
				t.Fatal("mutation did not change command digest")
			}
			if err := ValidateWalletCommand(changed); err == nil {
				t.Fatal("stale command digest was accepted")
			}
		})
	}
}

func TestOperationRefRoundTripPreservesCommandBinding(t *testing.T) {
	command := WalletRound{
		OperationID: "operation-1", Fingerprint: "fingerprint-1", OperatorID: "operator-a",
		PlayerID: "player-a", WalletAccountID: "wallet-a", WalletSessionRef: "wallet-session-a",
		SessionID: "session-a", RoundID: "round-a", GameID: "game-a",
		DefinitionVersion: "math-v1", DefinitionHash: strings.Repeat("a", 64),
		RoundKind: RoundKindFreeSpin, Currency: "EUR", DebitMinor: 0, CreditMinor: 125,
	}
	command.CommandDigest = CommandDigestFor(command)
	if restored := OperationRefFor(command).WalletRound(); restored != command {
		t.Fatalf("operation reference round trip = %+v, want %+v", restored, command)
	}
}

func TestAtomicHTTPProfilePinsNotFoundReapplyPolicy(t *testing.T) {
	profile := AtomicHTTPProfile(WalletRouteBindingIDForCanonicalTarget("https://wallet.test.invalid/ledger-a"))
	if err := ValidateProfile(profile); err != nil {
		t.Fatalf("ValidateProfile() error = %v", err)
	}
	capabilities := profile.Capabilities
	if !capabilities.AtomicRound || !capabilities.LookupByOperation ||
		!capabilities.ReapplySameOperationAfterNotFound ||
		capabilities.NotFoundConsistencyWindow != time.Second ||
		!capabilities.RequiresWalletSessionRef || !capabilities.RequiresCommandDigest {
		t.Fatalf("atomic HTTP capabilities = %+v", capabilities)
	}

	profile.Capabilities.LookupByOperation = false
	if err := ValidateProfile(profile); err == nil {
		t.Fatal("profile allowed NOT_FOUND reapply without lookup capability")
	}
}

func TestSupportedSettlementProfileRejectsSemanticDowngrade(t *testing.T) {
	base := AtomicHTTPProfile(WalletRouteBindingIDForCanonicalTarget(
		"https://wallet.test.invalid/ledger-a",
	))
	longerWindow := base
	longerWindow.Capabilities.NotFoundConsistencyWindow = 2 * time.Second
	if !SupportedSettlementProfile(longerWindow) {
		t.Fatal("supported v2 profile rejected a persisted, bounded consistency window")
	}

	for _, test := range []struct {
		name   string
		mutate func(*Profile)
	}{
		{name: "contract", mutate: func(profile *Profile) { profile.ContractVersion = "v3" }},
		{name: "profile", mutate: func(profile *Profile) { profile.ProfileID = "transfer-v1" }},
		{name: "atomic", mutate: func(profile *Profile) { profile.Capabilities.AtomicRound = false }},
		{name: "lookup", mutate: func(profile *Profile) { profile.Capabilities.LookupByOperation = false }},
		{name: "reapply", mutate: func(profile *Profile) {
			profile.Capabilities.ReapplySameOperationAfterNotFound = false
			profile.Capabilities.NotFoundConsistencyWindow = 0
		}},
		{name: "uncertified rollback", mutate: func(profile *Profile) { profile.Capabilities.ExplicitRollback = true }},
		{name: "session reference", mutate: func(profile *Profile) { profile.Capabilities.RequiresWalletSessionRef = false }},
		{name: "command digest", mutate: func(profile *Profile) { profile.Capabilities.RequiresCommandDigest = false }},
		{name: "authoritative balance", mutate: func(profile *Profile) { profile.Capabilities.ReturnsAuthoritativeBalance = false }},
		{name: "window below certified floor", mutate: func(profile *Profile) {
			profile.Capabilities.NotFoundConsistencyWindow = AtomicHTTPNotFoundConsistencyWindow - time.Nanosecond
		}},
		{name: "window too long", mutate: func(profile *Profile) {
			profile.Capabilities.NotFoundConsistencyWindow = MaximumNotFoundConsistencyWindow + time.Nanosecond
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := base
			test.mutate(&profile)
			if SupportedSettlementProfile(profile) {
				t.Fatalf("semantic downgrade was accepted: %+v", profile)
			}
		})
	}
}

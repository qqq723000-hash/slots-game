package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestWalletV2BindingMigrationRejectsSQLNullHalfBindings(t *testing.T) {
	contents, err := localOperatorMigrations.ReadFile("migrations/0002_wallet_v2_binding.sql")
	if err != nil {
		t.Fatal(err)
	}
	strongBranch := `wallet_session_ref IS NOT NULL
            AND command_digest IS NOT NULL
            AND wallet_session_ref ~`
	if count := strings.Count(string(contents), strongBranch); count != 2 {
		t.Fatalf("0002 strong v2 binding branches = %d, want 2", count)
	}
	digest := sha256.Sum256(contents)
	if got, want := hex.EncodeToString(digest[:]),
		"c556f1a89fce2ab43b0bf4cd106daddeb41991545212d18db4d8165eaedea5ff"; got != want {
		t.Fatalf("0002 migration manifest checksum = %s, want %s", got, want)
	}
	if !acceptedLocalOperatorMigrationChecksum(
		"0002_wallet_v2_binding.sql",
		"a1fb48dfa1a2a8a5ca508d0995f31b1ecfbf0a864d92a6ee607af6e2f73be71c",
	) || acceptedLocalOperatorMigrationChecksum("0002_wallet_v2_binding.sql", strings.Repeat("f", 64)) {
		t.Fatal("0002 migration manifest upgrade allowlist is not exact")
	}
}

func TestWalletV2NullHardeningMigrationCoversExistingTables(t *testing.T) {
	contents, err := localOperatorMigrations.ReadFile(
		"migrations/0003_wallet_v2_binding_null_hardening.sql",
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"local_operator_wallet_rejections",
		"local_operator_wallet_operations",
		"wallet_session_ref IS NOT NULL",
		"command_digest IS NOT NULL",
	} {
		if !strings.Contains(string(contents), required) {
			t.Fatalf("0003 migration is missing %q", required)
		}
	}
}

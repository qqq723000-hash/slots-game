package main

import "testing"

func TestProductionDatabaseURLRequiresVerifyFullAndRootCA(t *testing.T) {
	valid := "postgres://runtime:secret@postgres.local:5432/rgs?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Fpostgres-ca.pem"
	if err := validateProductionDatabaseURL(valid); err != nil {
		t.Fatalf("valid production database URL: %v", err)
	}
	for _, invalid := range []string{
		"postgres://runtime:secret@postgres.local:5432/rgs?sslmode=disable&sslrootcert=%2Frun%2Fca.pem",
		"postgres://runtime:secret@postgres.local:5432/rgs?sslmode=verify-full",
		"postgres://postgres.local:5432/rgs?sslmode=verify-full&sslrootcert=%2Frun%2Fca.pem",
	} {
		if err := validateProductionDatabaseURL(invalid); err == nil {
			t.Fatalf("unsafe database URL accepted: %s", invalid)
		}
	}
}

func TestLegacyWalletCompatibilityFlagIsStrictAndDefaultsOff(t *testing.T) {
	if value, err := parseStrictBool("", false); err != nil || value {
		t.Fatalf("default legacy flag = %t, %v", value, err)
	}
	if value, err := parseStrictBool("true", false); err != nil || !value {
		t.Fatalf("enabled legacy flag = %t, %v", value, err)
	}
	for _, invalid := range []string{"TRUE", "1", "yes", " false "} {
		if _, err := parseStrictBool(invalid, false); err == nil {
			t.Fatalf("invalid legacy flag accepted: %q", invalid)
		}
	}
}

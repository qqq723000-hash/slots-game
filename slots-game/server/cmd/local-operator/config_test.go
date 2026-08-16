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

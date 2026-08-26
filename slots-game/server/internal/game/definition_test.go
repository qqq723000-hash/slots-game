package game

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

func TestDefinitionDigestIsStableAndEconomicallySensitive(t *testing.T) {
	config := DemoConfig()
	first, err := DefinitionDigest(config)
	if err != nil {
		t.Fatalf("DefinitionDigest returned error: %v", err)
	}
	second, err := DefinitionDigest(config)
	if err != nil || second != first {
		t.Fatalf("stable digest = %q, %v; want %q", second, err, first)
	}

	changed := config
	changed.Paytable = make(map[Symbol]int64, len(config.Paytable))
	for symbol, value := range config.Paytable {
		changed.Paytable[symbol] = value
	}
	changed.Paytable[SymbolOrbit]++
	different, err := DefinitionDigest(changed)
	if err != nil {
		t.Fatalf("changed DefinitionDigest returned error: %v", err)
	}
	if different == first {
		t.Fatal("economic change did not change definition digest")
	}
	changed = config
	changed.MaxWinMultiplier--
	if _, err = DefinitionDigest(changed); err == nil {
		t.Fatal("foreign max-win contract unexpectedly produced an approved-engine digest")
	}
}

func TestDefinitionApprovalFailsClosed(t *testing.T) {
	config := DemoConfig()
	digest, err := DefinitionDigest(config)
	if err != nil {
		t.Fatal(err)
	}
	approval := DefinitionApproval{
		GameID: config.GameID, Version: config.DefinitionVersion,
		SHA256: digest, Status: "APPROVED", ApprovalRef: "lab-report-123",
	}
	if err := VerifyDefinitionApproval(config, approval); err != nil {
		t.Fatalf("valid approval rejected: %v", err)
	}
	approval.SHA256 = "00" + digest[2:]
	if err := VerifyDefinitionApproval(config, approval); err == nil {
		t.Fatal("tampered approval unexpectedly accepted")
	}
	approval.SHA256 = digest
	approval.Status = "DRAFT"
	if err := VerifyDefinitionApproval(config, approval); err == nil {
		t.Fatal("draft approval unexpectedly accepted")
	}
}

func TestDefinitionApprovalRejectsAConfigForForeignEngineRules(t *testing.T) {
	config := DemoConfig()
	digest, err := DefinitionDigest(config)
	if err != nil {
		t.Fatal(err)
	}
	approval := DefinitionApproval{
		GameID: config.GameID, Version: config.DefinitionVersion,
		SHA256: digest, Status: "APPROVED", ApprovalRef: "lab-report-123",
	}
	config.EngineRulesVersion = "slots-game-ways3-features-v999"
	if err := VerifyDefinitionApproval(config, approval); err == nil {
		t.Fatal("approval accepted a definition for foreign engine rules")
	}
}

func TestSignedDefinitionApprovalBindsTrustedKeyAndManifest(t *testing.T) {
	config := DemoConfig()
	digest, err := DefinitionDigest(config)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	approval := DefinitionApproval{
		GameID: config.GameID, Version: config.DefinitionVersion,
		SHA256: digest, Status: "APPROVED", ApprovalRef: "release-123",
	}
	envelope, err := SignDefinitionApproval(approval, "release-key-1", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifySignedDefinitionApproval(config, envelope, publicKey); err != nil {
		t.Fatalf("valid signed approval rejected: %v", err)
	}

	tampered := envelope
	tampered.Approval.SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := VerifySignedDefinitionApproval(config, tampered, publicKey); err == nil {
		t.Fatal("tampered approval unexpectedly accepted")
	}
	otherPublic, _, _ := ed25519.GenerateKey(rand.Reader)
	if err := VerifySignedDefinitionApproval(config, envelope, otherPublic); err == nil {
		t.Fatal("untrusted approval key unexpectedly accepted")
	}
}

func TestProductionDefinitionApprovalRequiresExactSignedEvidenceProfile(t *testing.T) {
	config := DemoConfig()
	config.GameID = "iron-colossus"
	config.DefinitionVersion = "math-2026-08-13.1"
	digest, err := DefinitionDigest(config)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	approval := DefinitionApproval{
		GameID: config.GameID, Version: config.DefinitionVersion,
		SHA256: digest, Status: "APPROVED", ApprovalRef: "release-record:placeholder",
		ProductionEvidence: &DefinitionApprovalEvidence{
			MathReportRefs: []string{"math-report:placeholder"},
			RNGReportRefs:  []string{"rng-report:placeholder"},
			JurisdictionApprovals: []DefinitionJurisdictionEvidence{
				{Jurisdiction: "TEST-REGION", ApprovalRef: "approval:placeholder"},
			},
		},
	}
	envelope, err := SignProductionDefinitionApproval(approval, "release-key-2", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifySignedDefinitionApproval(config, envelope, publicKey); err != nil {
		t.Fatalf("valid signed production profile rejected: %v", err)
	}

	t.Run("missing math evidence", func(t *testing.T) {
		changed := approval
		changed.ProductionEvidence = &DefinitionApprovalEvidence{
			RNGReportRefs:         changed.ProductionEvidence.RNGReportRefs,
			JurisdictionApprovals: changed.ProductionEvidence.JurisdictionApprovals,
		}
		signed, signErr := SignProductionDefinitionApproval(changed, "release-key-2", privateKey)
		if signErr != nil {
			t.Fatal(signErr)
		}
		if verifyErr := VerifySignedDefinitionApproval(config, signed, publicKey); verifyErr == nil {
			t.Fatal("production approval without math evidence unexpectedly accepted")
		}
	})

	t.Run("tampered signed evidence", func(t *testing.T) {
		changed := envelope
		changed.Approval.ProductionEvidence = &DefinitionApprovalEvidence{
			MathReportRefs: append([]string(nil), envelope.Approval.ProductionEvidence.MathReportRefs...),
			RNGReportRefs:  append([]string(nil), envelope.Approval.ProductionEvidence.RNGReportRefs...),
			JurisdictionApprovals: append(
				[]DefinitionJurisdictionEvidence(nil),
				envelope.Approval.ProductionEvidence.JurisdictionApprovals...,
			),
		}
		changed.Approval.ProductionEvidence.MathReportRefs[0] = "math-report:tampered"
		if verifyErr := VerifySignedDefinitionApproval(config, changed, publicKey); verifyErr == nil {
			t.Fatal("tampered production evidence unexpectedly accepted")
		}
	})

	t.Run("different definition digest", func(t *testing.T) {
		changed := config
		changed.Feature.SurgeOneChanceBP++
		if verifyErr := VerifySignedDefinitionApproval(changed, envelope, publicKey); verifyErr == nil {
			t.Fatal("production approval unexpectedly accepted a different definition digest")
		}
	})

	t.Run("untrusted key", func(t *testing.T) {
		otherPublic, _, keyErr := ed25519.GenerateKey(rand.Reader)
		if keyErr != nil {
			t.Fatal(keyErr)
		}
		if verifyErr := VerifySignedDefinitionApproval(config, envelope, otherPublic); verifyErr == nil {
			t.Fatal("production approval signed by an untrusted key unexpectedly accepted")
		}
	})

	t.Run("demo identity", func(t *testing.T) {
		demo := DemoConfig()
		demoDigest, digestErr := DefinitionDigest(demo)
		if digestErr != nil {
			t.Fatal(digestErr)
		}
		demoApproval := approval
		demoApproval.GameID = demo.GameID
		demoApproval.Version = demo.DefinitionVersion
		demoApproval.SHA256 = demoDigest
		signed, signErr := SignProductionDefinitionApproval(demoApproval, "release-key-2", privateKey)
		if signErr != nil {
			t.Fatal(signErr)
		}
		if verifyErr := VerifySignedDefinitionApproval(demo, signed, publicKey); verifyErr == nil {
			t.Fatal("demo definition unexpectedly accepted by production profile")
		}
	})
}

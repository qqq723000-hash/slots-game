package operator

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestAccessTokenRoundTripBindsAllClaims(t *testing.T) {
	now := fixedTestTime()
	signing, verification := testKeyPair(t, "token-key-1", "operator-a", KeyPurposeAccessToken, now)
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	issuer := testTokenIssuer(t, signing, now, "rgs-prod", "rgs-game-client")
	verifier := testTokenVerifier(t, ring, now, "rgs-prod", "rgs-game-client")
	subject := testAccessSubject("operator-a")

	token, issued, err := issuer.Issue(subject, 5*time.Minute)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	claims, err := verifier.Verify(context.Background(), token, "operator-a")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if claims != issued {
		t.Fatalf("verified claims = %+v, issued = %+v", claims, issued)
	}
	if claims.OperatorID != subject.OperatorID || claims.PlayerID != subject.PlayerID ||
		claims.WalletSessionID != subject.WalletSessionID || claims.SessionID != subject.SessionID ||
		claims.GameID != subject.GameID || claims.GameDefinitionVersion != subject.GameDefinitionVersion ||
		claims.GameDefinitionHash != subject.GameDefinitionHash ||
		claims.Currency != subject.Currency || claims.CurrencyExponent != subject.CurrencyExponent ||
		claims.Jurisdiction != subject.Jurisdiction || claims.TokenID == "" {
		t.Fatalf("claims did not bind the complete subject: %+v", claims)
	}
}

func TestAccessTokenIssueAtUsesAuthoritativeTimeInsteadOfPodClock(t *testing.T) {
	authoritativeNow := fixedTestTime().Add(875 * time.Millisecond)
	signing, verification := testKeyPair(
		t, "token-key-authority", "operator-a", KeyPurposeAccessToken, authoritativeNow,
	)
	issuer, err := NewAccessTokenIssuer(signing, AccessTokenIssuerOptions{
		Issuer: "rgs-prod", Audience: "rgs-game-client",
		Now: func() time.Time {
			t.Fatal("IssueAt consulted the Pod clock")
			return time.Time{}
		},
		MaxLifetime: DefaultAccessTokenLifetime,
	})
	if err != nil {
		t.Fatalf("NewAccessTokenIssuer: %v", err)
	}
	token, claims, err := issuer.IssueAt(
		testAccessSubject("operator-a"), 5*time.Minute, authoritativeNow,
	)
	if err != nil {
		t.Fatalf("IssueAt: %v", err)
	}
	wantIssuedAt := authoritativeNow.Truncate(time.Second)
	if claims.IssuedAt != wantIssuedAt.Unix() ||
		claims.ExpiresAt != wantIssuedAt.Add(5*time.Minute).Unix() {
		t.Fatalf("IssueAt claims = %+v, want iat=%v exp=%v", claims, wantIssuedAt, wantIssuedAt.Add(5*time.Minute))
	}
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	verifier := testTokenVerifier(t, ring, wantIssuedAt, "rgs-prod", "rgs-game-client")
	if _, err := verifier.Verify(context.Background(), token, "operator-a"); err != nil {
		t.Fatalf("Verify authoritative token: %v", err)
	}
	if _, _, err := issuer.IssueAt(
		testAccessSubject("operator-a"), time.Minute, time.Time{},
	); !errors.Is(err, ErrMalformed) {
		t.Fatalf("IssueAt zero authority error = %v, want ErrMalformed", err)
	}
}

func TestAccessTokenRejectsTamperingAndNonProfileShapes(t *testing.T) {
	now := fixedTestTime()
	signing, verification := testKeyPair(t, "token-key-1", "operator-a", KeyPurposeAccessToken, now)
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	issuer := testTokenIssuer(t, signing, now, "rgs-prod", "rgs-game-client")
	verifier := testTokenVerifier(t, ring, now, "rgs-prod", "rgs-game-client")
	token, claims, err := issuer.Issue(testAccessSubject("operator-a"), 5*time.Minute)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	parts := strings.Split(token, ".")

	tests := []struct {
		name  string
		token string
	}{
		{name: "header", token: mutateCompactPart(parts, 0)},
		{name: "payload", token: mutateCompactPart(parts, 1)},
		{name: "signature", token: mutateCompactPart(parts, 2)},
		{name: "extra segment", token: token + ".extra"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := verifier.Verify(context.Background(), test.token, "operator-a"); err == nil {
				t.Fatal("tampered token unexpectedly verified")
			}
		})
	}

	// 即使令牌签名正确，只要载荷包含重复成员也必须失效即关闭；本包刻意不实现宽松的 JWT 解析器。
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	duplicate := strings.Replace(string(payload), `"operator_id":"operator-a"`, `"operator_id":"operator-a","operator_id":"operator-a"`, 1)
	duplicateToken := signCompactTestToken(t, signing, []byte(duplicate))
	if _, err := verifier.Verify(context.Background(), duplicateToken, "operator-a"); !errors.Is(err, ErrMalformed) {
		t.Fatalf("duplicate claim error = %v, want ErrMalformed", err)
	}
}

func TestAccessTokenRejectsExpiryFutureAudienceIssuerAndTenant(t *testing.T) {
	now := fixedTestTime()
	signing, verification := testKeyPair(t, "token-key-1", "operator-a", KeyPurposeAccessToken, now)
	ring, err := NewMemoryKeyRing(verification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	subject := testAccessSubject("operator-a")

	t.Run("expired", func(t *testing.T) {
		issuer := testTokenIssuer(t, signing, now, "rgs-prod", "rgs-game-client")
		token, _, err := issuer.Issue(subject, time.Minute)
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		verifier := testTokenVerifier(t, ring, now.Add(2*time.Minute), "rgs-prod", "rgs-game-client")
		if _, err := verifier.Verify(context.Background(), token, "operator-a"); !errors.Is(err, ErrExpired) {
			t.Fatalf("expired error = %v, want ErrExpired", err)
		}
	})

	t.Run("future", func(t *testing.T) {
		issuer := testTokenIssuer(t, signing, now.Add(2*time.Minute), "rgs-prod", "rgs-game-client")
		token, _, err := issuer.Issue(subject, time.Minute)
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		verifier := testTokenVerifier(t, ring, now, "rgs-prod", "rgs-game-client")
		if _, err := verifier.Verify(context.Background(), token, "operator-a"); !errors.Is(err, ErrNotYetValid) {
			t.Fatalf("future error = %v, want ErrNotYetValid", err)
		}
	})

	t.Run("audience", func(t *testing.T) {
		issuer := testTokenIssuer(t, signing, now, "rgs-prod", "other-audience")
		token, _, err := issuer.Issue(subject, time.Minute)
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		verifier := testTokenVerifier(t, ring, now, "rgs-prod", "rgs-game-client")
		if _, err := verifier.Verify(context.Background(), token, "operator-a"); !errors.Is(err, ErrAudienceMismatch) {
			t.Fatalf("audience error = %v, want ErrAudienceMismatch", err)
		}
	})

	t.Run("issuer", func(t *testing.T) {
		issuer := testTokenIssuer(t, signing, now, "other-rgs", "rgs-game-client")
		token, _, err := issuer.Issue(subject, time.Minute)
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		verifier := testTokenVerifier(t, ring, now, "rgs-prod", "rgs-game-client")
		if _, err := verifier.Verify(context.Background(), token, "operator-a"); !errors.Is(err, ErrIssuerMismatch) {
			t.Fatalf("issuer error = %v, want ErrIssuerMismatch", err)
		}
	})

	t.Run("expected tenant", func(t *testing.T) {
		issuer := testTokenIssuer(t, signing, now, "rgs-prod", "rgs-game-client")
		token, _, err := issuer.Issue(subject, time.Minute)
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		verifier := testTokenVerifier(t, ring, now, "rgs-prod", "rgs-game-client")
		if _, err := verifier.Verify(context.Background(), token, "operator-b"); !errors.Is(err, ErrTenantMismatch) {
			t.Fatalf("tenant error = %v, want ErrTenantMismatch", err)
		}
	})

	t.Run("claim tenant versus verified key", func(t *testing.T) {
		claims := AccessTokenClaims{
			Issuer: "rgs-prod", Audience: "rgs-game-client",
			OperatorID: "operator-b", PlayerID: "player-1", WalletSessionID: "wallet-session-1",
			SessionID: "session-1", GameID: "iron-colossus", GameDefinitionVersion: "math-v1",
			GameDefinitionHash: strings.Repeat("a", 64),
			Currency:           "EUR", CurrencyExponent: 2, Jurisdiction: "DE",
			TransportGeneration: 1,
			IssuedAt:            now.Unix(), ExpiresAt: now.Add(time.Minute).Unix(), TokenID: "at-forged",
		}
		payload, err := json.Marshal(claims)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}
		token := signCompactTestToken(t, signing, payload)
		verifier := testTokenVerifier(t, ring, now, "rgs-prod", "rgs-game-client")
		if _, err := verifier.Verify(context.Background(), token, "operator-b"); !errors.Is(err, ErrTenantMismatch) {
			t.Fatalf("key tenant error = %v, want ErrTenantMismatch", err)
		}
	})
}

func TestAccessTokenKeyRotation(t *testing.T) {
	now := fixedTestTime()
	oldSigning, oldVerification := testKeyPair(t, "token-old", "operator-a", KeyPurposeAccessToken, now)
	newSigning, newVerification := testKeyPair(t, "token-new", "operator-a", KeyPurposeAccessToken, now)
	ring, err := NewMemoryKeyRing(oldVerification, newVerification)
	if err != nil {
		t.Fatalf("NewMemoryKeyRing: %v", err)
	}
	oldIssuer := testTokenIssuer(t, oldSigning, now, "rgs-prod", "rgs-game-client")
	newIssuer := testTokenIssuer(t, newSigning, now, "rgs-prod", "rgs-game-client")
	oldToken, _, err := oldIssuer.Issue(testAccessSubject("operator-a"), time.Minute)
	if err != nil {
		t.Fatalf("old Issue: %v", err)
	}
	newToken, _, err := newIssuer.Issue(testAccessSubject("operator-a"), time.Minute)
	if err != nil {
		t.Fatalf("new Issue: %v", err)
	}
	verifier := testTokenVerifier(t, ring, now, "rgs-prod", "rgs-game-client")
	if _, err := verifier.Verify(context.Background(), oldToken, "operator-a"); err != nil {
		t.Fatalf("old key during overlap: %v", err)
	}
	if _, err := verifier.Verify(context.Background(), newToken, "operator-a"); err != nil {
		t.Fatalf("new key during overlap: %v", err)
	}
	ring.Remove(KeyPurposeAccessToken, oldSigning.KeyID)
	if _, err := verifier.Verify(context.Background(), oldToken, "operator-a"); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("retired key error = %v, want ErrUnknownKey", err)
	}
	if _, err := verifier.Verify(context.Background(), newToken, "operator-a"); err != nil {
		t.Fatalf("new key after rotation: %v", err)
	}
}

func TestAccessTokenKeyRingRejectsDuplicatePurposeKeyIDAcrossTenants(t *testing.T) {
	now := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	_, first := testKeyPair(t, "access-duplicate", "operator-a", KeyPurposeAccessToken, now)
	_, second := testKeyPair(t, "access-duplicate", "operator-b", KeyPurposeAccessToken, now)
	if _, err := NewMemoryKeyRing(first, second); !errors.Is(err, ErrMalformed) {
		t.Fatalf("duplicate access-token kid error = %v, want ErrMalformed", err)
	}
}

func testAccessSubject(operatorID string) AccessTokenSubject {
	return AccessTokenSubject{
		OperatorID: operatorID, PlayerID: "player-1", WalletSessionID: "wallet-session-1",
		SessionID: "session-1", GameID: "iron-colossus", GameDefinitionVersion: "math-v1",
		GameDefinitionHash: strings.Repeat("a", 64),
		Currency:           "EUR", CurrencyExponent: 2, Jurisdiction: "DE",
		TransportGeneration: 1,
	}
}

func testTokenIssuer(t *testing.T, key SigningKey, now time.Time, issuer, audience string) *AccessTokenIssuer {
	t.Helper()
	result, err := NewAccessTokenIssuer(key, AccessTokenIssuerOptions{
		Issuer: issuer, Audience: audience, Now: func() time.Time { return now },
		MaxLifetime: DefaultAccessTokenLifetime,
	})
	if err != nil {
		t.Fatalf("NewAccessTokenIssuer: %v", err)
	}
	return result
}

func testTokenVerifier(t *testing.T, keys KeyResolver, now time.Time, issuer, audience string) *AccessTokenVerifier {
	t.Helper()
	result, err := NewAccessTokenVerifier(keys, AccessTokenVerifierOptions{
		ExpectedIssuer: issuer, ExpectedAudience: audience,
		Now: func() time.Time { return now }, MaxLifetime: DefaultAccessTokenLifetime,
	})
	if err != nil {
		t.Fatalf("NewAccessTokenVerifier: %v", err)
	}
	return result
}

func mutateCompactPart(parts []string, index int) string {
	copyParts := append([]string(nil), parts...)
	value := []byte(copyParts[index])
	if value[0] == 'A' {
		value[0] = 'B'
	} else {
		value[0] = 'A'
	}
	copyParts[index] = string(value)
	return strings.Join(copyParts, ".")
}

func signCompactTestToken(t *testing.T, key SigningKey, payload []byte) string {
	t.Helper()
	header, err := json.Marshal(compactTokenHeader{
		Algorithm: AccessTokenAlgorithm, Type: AccessTokenType,
		KeyID: key.KeyID, Version: AccessTokenVersion,
	})
	if err != nil {
		t.Fatalf("Marshal header: %v", err)
	}
	headerPart := base64.RawURLEncoding.EncodeToString(header)
	payloadPart := base64.RawURLEncoding.EncodeToString(payload)
	input := headerPart + "." + payloadPart
	signature := ed25519.Sign(key.PrivateKey, []byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

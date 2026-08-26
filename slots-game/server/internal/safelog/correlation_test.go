package safelog

import (
	"strings"
	"testing"
)

func TestCorrelationIDDigestIsStableSHA256AndDoesNotExposeInput(t *testing.T) {
	t.Parallel()
	const value = "req_safe-1"
	const want = "sha256:295c30089dbcb988c0988e4ac2ababa72182e0cc2c81d9d6e5b426e98d7d48ee"
	first := CorrelationIDDigest(value)
	second := CorrelationIDDigest(value)
	if first != want || second != want || strings.Contains(first, value) {
		t.Fatalf("CorrelationIDDigest() = first:%q second:%q want:%q", first, second, want)
	}
}

func TestCorrelationIDDigestPreservesEmptyAndHidesTokenLikeValue(t *testing.T) {
	t.Parallel()
	if got := CorrelationIDDigest(""); got != "" {
		t.Fatalf("empty CorrelationIDDigest() = %q", got)
	}
	const secret = "token-like-request-id.secret-123"
	got := CorrelationIDDigest(secret)
	if got != "sha256:bd2bfa32306e81593a668a64f19a2406032a406bef0bc2e70e498d2ff03bfd26" ||
		strings.Contains(got, secret) || strings.Contains(got, "token-like") {
		t.Fatalf("secret CorrelationIDDigest() = %q", got)
	}
}

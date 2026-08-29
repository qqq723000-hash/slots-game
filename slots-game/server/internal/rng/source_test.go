package rng

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestCryptoSourceRejectsBiasedPrefix(t *testing.T) {
	var entropy [16]byte
	// 当 n=3 时拒绝阈值为 1。必须丢弃零，下一个 uint64 值 4 会得到结果 1。
	// English: The rejection threshold is 1 when n=3. Zeros must be discarded, and the next uint64 value 4 will result
	// in 1.
	binary.BigEndian.PutUint64(entropy[0:8], 0)
	binary.BigEndian.PutUint64(entropy[8:16], 4)
	source := &CryptoSource{Reader: bytes.NewReader(entropy[:])}

	got, err := source.Intn(3)
	if err != nil {
		t.Fatalf("Intn returned error: %v", err)
	}
	if got != 1 {
		t.Fatalf("Intn = %d, want 1", got)
	}
}

func TestCryptoSourceValidationAndEntropyError(t *testing.T) {
	if _, err := NewCryptoSource().Intn(0); err == nil {
		t.Fatal("Intn(0) unexpectedly succeeded")
	}
	source := &CryptoSource{Reader: bytes.NewReader(nil)}
	if _, err := source.Intn(2); err == nil {
		t.Fatal("entropy exhaustion unexpectedly succeeded")
	}
}

func TestSequenceSourceIsDeterministicAndFailsOnExhaustion(t *testing.T) {
	source := NewSequenceSource(7, 10)
	first, err := source.Intn(5)
	if err != nil || first != 2 {
		t.Fatalf("first Intn = %d, %v; want 2, nil", first, err)
	}
	second, err := source.Intn(4)
	if err != nil || second != 2 {
		t.Fatalf("second Intn = %d, %v; want 2, nil", second, err)
	}
	if _, err := source.Intn(1); err == nil {
		t.Fatal("exhausted sequence unexpectedly succeeded")
	}
	if source.Consumed() != 2 {
		t.Fatalf("Consumed = %d, want 2", source.Consumed())
	}
}

package wallet

import (
	"testing"
	"time"
)

func TestCircuitBreakerUsesHysteresisAndOneHalfOpenProbe(t *testing.T) {
	now := time.Unix(100, 0)
	transitions := make([]string, 0, 3)
	breaker := newCircuitBreaker(circuitConfig{
		FailureThreshold: 2, SuccessThreshold: 2,
		OpenDuration: time.Second, HalfOpenMaxInFlight: 1,
	}, func() time.Time { return now }, func(previous, current circuitState) {
		transitions = append(transitions, previous.String()+"->"+current.String())
	})

	first, ok := breaker.acquire()
	if !ok {
		t.Fatal("first closed request was rejected")
	}
	first.complete(false)
	second, ok := breaker.acquire()
	if !ok {
		t.Fatal("second closed request was rejected before threshold")
	}
	second.complete(false)
	if _, ok := breaker.acquire(); ok {
		t.Fatal("open circuit accepted request before cooling interval")
	}

	now = now.Add(time.Second)
	probe, ok := breaker.acquire()
	if !ok {
		t.Fatal("cooled circuit did not allow half-open probe")
	}
	if _, ok := breaker.acquire(); ok {
		t.Fatal("half-open circuit exceeded probe capacity")
	}
	probe.complete(true)
	secondProbe, ok := breaker.acquire()
	if !ok {
		t.Fatal("half-open circuit did not allow sequential success probe")
	}
	secondProbe.complete(true)
	if _, ok := breaker.acquire(); !ok {
		t.Fatal("circuit did not close after the success threshold")
	}

	want := []string{"closed->open", "open->half_open", "half_open->closed"}
	if len(transitions) != len(want) {
		t.Fatalf("transitions = %v, want %v", transitions, want)
	}
	for index := range want {
		if transitions[index] != want[index] {
			t.Fatalf("transitions = %v, want %v", transitions, want)
		}
	}
}

func TestCircuitBreakerIgnoresStaleCompletions(t *testing.T) {
	now := time.Unix(200, 0)
	breaker := newCircuitBreaker(circuitConfig{
		FailureThreshold: 1, SuccessThreshold: 1,
		OpenDuration: time.Minute, HalfOpenMaxInFlight: 1,
	}, func() time.Time { return now }, nil)

	failing, _ := breaker.acquire()
	staleSuccess, _ := breaker.acquire()
	failing.complete(false)
	staleSuccess.complete(true)
	if _, ok := breaker.acquire(); ok {
		t.Fatal("stale success closed a newer open generation")
	}
}

func TestCancelledHalfOpenPermitDoesNotRecordFailure(t *testing.T) {
	now := time.Unix(300, 0)
	breaker := newCircuitBreaker(circuitConfig{
		FailureThreshold: 1, SuccessThreshold: 1,
		OpenDuration: time.Second, HalfOpenMaxInFlight: 1,
	}, func() time.Time { return now }, nil)
	permit, _ := breaker.acquire()
	permit.complete(false)
	now = now.Add(time.Second)
	probe, ok := breaker.acquire()
	if !ok {
		t.Fatal("half-open probe was not admitted")
	}
	probe.cancel()
	if _, ok := breaker.acquire(); !ok {
		t.Fatal("cancelled local admission consumed the half-open probe")
	}
}

package rgs

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"slots-game/server/internal/game"
)

func TestCommittedResultDeliveryBlocksOnlyNewRoundsUntilIdempotentAcknowledgement(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	spinner := &countingSpinner{spin: func(game.SpinInput) (game.SpinOutcome, error) {
		return payableOutcome(game.EmptyFeatureState()), nil
	}}
	coordinator := newTestCoordinator(t, repository, newTestWallet(10_000), spinner, time.Second)
	firstRequest := baseRequest("round-delivery-one", 100, 0)
	firstResult, err := coordinator.Spin(context.Background(), firstRequest)
	if err != nil {
		t.Fatal(err)
	}

	// 发现操作以会话为范围：重新连接无需依赖浏览器保存 roundId，
	// 即可恢复唯一权威的已提交载荷。
	delivery, err := coordinator.GetPendingResultDelivery(
		context.Background(), firstRequest.OperatorID, firstRequest.SessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if delivery.RoundID != firstResult.RoundID || delivery.Sequence != firstResult.Sequence ||
		!reflect.DeepEqual(delivery.Result, firstResult) {
		t.Fatalf("pending delivery = %+v, result = %+v", delivery, firstResult)
	}
	if !reflect.DeepEqual(delivery.OriginFeatureState, baseSession().Feature) {
		t.Fatalf("pending origin feature = %+v, want %+v", delivery.OriginFeatureState, baseSession().Feature)
	}
	wantHash, err := CommittedResultHashFor(firstResult)
	if err != nil || delivery.ResultHash != wantHash {
		t.Fatalf("result hash = %q, want %q (error %v)", delivery.ResultHash, wantHash, err)
	}

	// 在拒绝创建不同轮次的同时，仍允许精确重放。
	replay, err := coordinator.Spin(context.Background(), firstRequest)
	if err != nil || !reflect.DeepEqual(replay, firstResult) {
		t.Fatalf("exact replay = %+v, error %v", replay, err)
	}
	_, err = coordinator.Spin(context.Background(), baseRequest("round-delivery-two", 100, 1))
	if !errors.Is(err, ErrResultDeliveryPending) {
		t.Fatalf("next Spin error = %v, want ErrResultDeliveryPending", err)
	}

	wrong := ResultDeliveryAcknowledgement{
		OperatorID: delivery.OperatorID, SessionID: delivery.SessionID,
		RoundID: delivery.RoundID, Sequence: delivery.Sequence,
		ResultHash:          "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		TransportGeneration: 1,
	}
	if _, _, err := coordinator.AcknowledgeResultDelivery(context.Background(), wrong); !errors.Is(err, ErrResultDeliveryMismatch) {
		t.Fatalf("wrong hash ACK error = %v", err)
	}
	receipt := ResultDeliveryAcknowledgement{
		OperatorID: delivery.OperatorID, SessionID: delivery.SessionID,
		RoundID: delivery.RoundID, Sequence: delivery.Sequence, ResultHash: delivery.ResultHash,
		TransportGeneration: 1,
	}
	acknowledged, changed, err := coordinator.AcknowledgeResultDelivery(context.Background(), receipt)
	if err != nil || !changed || acknowledged.AcknowledgedAt.IsZero() {
		t.Fatalf("first ACK = %+v changed=%v error=%v", acknowledged, changed, err)
	}
	acknowledgedAgain, changed, err := coordinator.AcknowledgeResultDelivery(context.Background(), receipt)
	if err != nil || changed || !acknowledgedAgain.AcknowledgedAt.Equal(acknowledged.AcknowledgedAt) {
		t.Fatalf("idempotent ACK = %+v changed=%v error=%v", acknowledgedAgain, changed, err)
	}
	if _, err := coordinator.GetPendingResultDelivery(context.Background(), firstRequest.OperatorID, firstRequest.SessionID); !errors.Is(err, ErrResultDeliveryNotFound) {
		t.Fatalf("pending after ACK error = %v", err)
	}
	if _, err := coordinator.Spin(context.Background(), baseRequest("round-delivery-two", 100, 1)); err != nil {
		t.Fatalf("next Spin after ACK error = %v", err)
	}
	if spinner.calls.Load() != 2 {
		t.Fatalf("engine calls = %d, want 2", spinner.calls.Load())
	}
}

func TestConcurrentAcknowledgementsChangeDeliveryCursorExactlyOnce(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	coordinator := newTestCoordinator(t, repository, newTestWallet(10_000), &countingSpinner{
		spin: func(game.SpinInput) (game.SpinOutcome, error) {
			return payableOutcome(game.EmptyFeatureState()), nil
		},
	}, time.Second)
	if _, err := coordinator.Spin(context.Background(), baseRequest("round-concurrent-ack", 100, 0)); err != nil {
		t.Fatal(err)
	}
	delivery, err := coordinator.GetPendingResultDelivery(context.Background(), "operator-a", "session-a")
	if err != nil {
		t.Fatal(err)
	}
	receipt := ResultDeliveryAcknowledgement{
		OperatorID: delivery.OperatorID, SessionID: delivery.SessionID,
		RoundID: delivery.RoundID, Sequence: delivery.Sequence, ResultHash: delivery.ResultHash,
		TransportGeneration: 1,
	}
	const callers = 32
	var group sync.WaitGroup
	var changes atomic.Int64
	group.Add(callers)
	for range callers {
		go func() {
			defer group.Done()
			_, changed, err := coordinator.AcknowledgeResultDelivery(context.Background(), receipt)
			if err != nil {
				t.Errorf("ACK error = %v", err)
				return
			}
			if changed {
				changes.Add(1)
			}
		}()
	}
	group.Wait()
	if changes.Load() != 1 {
		t.Fatalf("durable ACK transitions = %d, want 1", changes.Load())
	}
}

func TestRelaunchFencesAuthorizedOldGenerationAcknowledgement(t *testing.T) {
	repository := NewMemoryRepository()
	createTestSession(t, repository, baseSession())
	coordinator := newTestCoordinator(t, repository, newTestWallet(10_000), &countingSpinner{
		spin: func(game.SpinInput) (game.SpinOutcome, error) {
			return payableOutcome(game.EmptyFeatureState()), nil
		},
	}, time.Second)
	if _, err := coordinator.Spin(context.Background(), baseRequest("round-generation-ack", 100, 0)); err != nil {
		t.Fatal(err)
	}
	delivery, err := coordinator.GetPendingResultDelivery(context.Background(), "operator-a", "session-a")
	if err != nil {
		t.Fatal(err)
	}
	oldReceipt := ResultDeliveryAcknowledgement{
		OperatorID: delivery.OperatorID, SessionID: delivery.SessionID,
		RoundID: delivery.RoundID, Sequence: delivery.Sequence, ResultHash: delivery.ResultHash,
		TransportGeneration: 1,
	}
	reset, err := repository.ResetSessionTransport(
		context.Background(), delivery.OperatorID, delivery.SessionID, 20*time.Minute,
	)
	if err != nil || reset.TransportGeneration != 2 {
		t.Fatalf("relaunch reset = %+v error=%v", reset, err)
	}
	if _, changed, err := coordinator.AcknowledgeResultDelivery(context.Background(), oldReceipt); !errors.Is(err, ErrSessionTimeout) || changed {
		t.Fatalf("old-generation ACK changed=%t error=%v", changed, err)
	}
	stillPending, err := coordinator.GetPendingResultDelivery(
		context.Background(), delivery.OperatorID, delivery.SessionID,
	)
	if err != nil || stillPending.ResultHash != delivery.ResultHash || !stillPending.AcknowledgedAt.IsZero() {
		t.Fatalf("pending result was lost after fenced ACK: %+v error=%v", stillPending, err)
	}
	currentReceipt := oldReceipt
	currentReceipt.TransportGeneration = reset.TransportGeneration
	acknowledged, changed, err := coordinator.AcknowledgeResultDelivery(context.Background(), currentReceipt)
	if err != nil || !changed || acknowledged.AcknowledgedAt.IsZero() {
		t.Fatalf("current-generation ACK = %+v changed=%t error=%v", acknowledged, changed, err)
	}
}

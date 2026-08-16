package rgs

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// MemoryRepository 是正确处理并发的 Repository 契约参考实现。锁按会话划分，
// 使无关玩家可并发推进。它用于测试及适配器一致性验证，不作为生产持久化存储。
type MemoryRepository struct {
	mu       sync.RWMutex
	sessions map[string]*memorySession
}

type memorySession struct {
	mu         sync.Mutex
	session    Session
	rounds     map[string]RoundRecord
	deliveries map[string]ResultDelivery
}

func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{sessions: make(map[string]*memorySession)}
}

func (r *MemoryRepository) CreateSession(ctx context.Context, session Session) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateSession(session); err != nil {
		return err
	}
	if session.PendingRoundID != "" {
		return fmt.Errorf("%w: a new session cannot have a pending round", ErrInvalidRequest)
	}
	key := sessionKey(session.OperatorID, session.SessionID)
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.sessions[key]; exists {
		return ErrSessionExists
	}
	r.sessions[key] = &memorySession{
		session: session, rounds: make(map[string]RoundRecord),
		deliveries: make(map[string]ResultDelivery),
	}
	return nil
}

func (r *MemoryRepository) GetSession(ctx context.Context, operatorID, sessionID string) (Session, error) {
	entry, err := r.lookupSession(ctx, operatorID, sessionID)
	if err != nil {
		return Session{}, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	return entry.session, nil
}

func (r *MemoryRepository) GetRound(ctx context.Context, key RoundKey) (RoundRecord, error) {
	entry, err := r.lookupSession(ctx, key.OperatorID, key.SessionID)
	if err != nil {
		return RoundRecord{}, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return RoundRecord{}, err
	}
	record, exists := entry.rounds[key.RoundID]
	if !exists {
		return RoundRecord{}, ErrRoundNotFound
	}
	return cloneRound(record), nil
}

func (r *MemoryRepository) GetPendingResultDelivery(
	ctx context.Context,
	operatorID string,
	sessionID string,
) (ResultDelivery, error) {
	entry, err := r.lookupSession(ctx, operatorID, sessionID)
	if err != nil {
		return ResultDelivery{}, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return ResultDelivery{}, err
	}
	var pending ResultDelivery
	for _, delivery := range entry.deliveries {
		if delivery.AcknowledgedAt.IsZero() {
			if pending.RoundID != "" {
				return ResultDelivery{}, ErrManualReview
			}
			pending = cloneResultDelivery(delivery)
		}
	}
	if pending.RoundID == "" {
		return ResultDelivery{}, ErrResultDeliveryNotFound
	}
	return pending, nil
}

func (r *MemoryRepository) AcknowledgeResultDelivery(
	ctx context.Context,
	receipt ResultDeliveryAcknowledgement,
) (ResultDelivery, bool, error) {
	if err := ValidateResultDeliveryAcknowledgement(receipt); err != nil {
		return ResultDelivery{}, false, err
	}
	entry, err := r.lookupSession(ctx, receipt.OperatorID, receipt.SessionID)
	if err != nil {
		return ResultDelivery{}, false, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return ResultDelivery{}, false, err
	}
	delivery, exists := entry.deliveries[receipt.RoundID]
	if !exists {
		return ResultDelivery{}, false, ErrResultDeliveryNotFound
	}
	if delivery.Sequence != receipt.Sequence || delivery.ResultHash != receipt.ResultHash {
		return ResultDelivery{}, false, ErrResultDeliveryMismatch
	}
	if !delivery.AcknowledgedAt.IsZero() {
		return cloneResultDelivery(delivery), false, nil
	}
	delivery.AcknowledgedAt = time.Now().UTC()
	entry.deliveries[receipt.RoundID] = cloneResultDelivery(delivery)
	return cloneResultDelivery(delivery), true, nil
}

func (r *MemoryRepository) PrepareRound(
	ctx context.Context,
	request SpinRequest,
	fingerprint string,
	prepare PrepareOutcome,
) (RoundRecord, bool, error) {
	if prepare == nil {
		return RoundRecord{}, false, fmt.Errorf("%w: prepare callback is required", ErrInvalidRequest)
	}
	if err := validateSpinRequest(request); err != nil {
		return RoundRecord{}, false, err
	}
	if fingerprint != FingerprintFor(request) {
		return RoundRecord{}, false, fmt.Errorf("%w: non-canonical fingerprint", ErrInvalidRequest)
	}
	entry, err := r.lookupSession(ctx, request.OperatorID, request.SessionID)
	if err != nil {
		return RoundRecord{}, false, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return RoundRecord{}, false, err
	}

	if existing, exists := entry.rounds[request.RoundID]; exists {
		if existing.Fingerprint != fingerprint {
			return RoundRecord{}, false, ErrIdempotencyConflict
		}
		return cloneRound(existing), false, nil
	}
	for _, delivery := range entry.deliveries {
		if delivery.AcknowledgedAt.IsZero() {
			return RoundRecord{}, false, fmt.Errorf("%w: %s", ErrResultDeliveryPending, delivery.RoundID)
		}
	}
	if entry.session.PendingRoundID != "" {
		return RoundRecord{}, false, fmt.Errorf("%w: %s", ErrRoundPending, entry.session.PendingRoundID)
	}
	if err := validateSessionBinding(entry.session, request); err != nil {
		return RoundRecord{}, false, err
	}
	if entry.session.Sequence >= MaxClientSequence {
		return RoundRecord{}, false, fmt.Errorf("%w: sequence exhausted", ErrInvalidRequest)
	}

	result, err := prepare(entry.session)
	if err != nil {
		return RoundRecord{}, false, err
	}
	if err := validatePreparedResult(entry.session, request, result); err != nil {
		return RoundRecord{}, false, err
	}
	result = cloneSpinResult(result)
	outcomeHash, err := PreparedOutcomeHashFor(result)
	if err != nil {
		return RoundRecord{}, false, err
	}
	now := time.Now().UTC()
	record := RoundRecord{
		Key:               request.Key(),
		Fingerprint:       fingerprint,
		Request:           request,
		Status:            RoundPrepared,
		Result:            result,
		InputFeatureState: entry.session.Feature,
		OutcomeHash:       outcomeHash,
		WalletCommand: WalletRound{
			OperationID: walletOperationID(request), Fingerprint: fingerprint,
			OperatorID: request.OperatorID, PlayerID: entry.session.PlayerID,
			WalletAccountID: entry.session.WalletAccountID,
			SessionID:       request.SessionID, RoundID: request.RoundID,
			GameID: request.GameID, DefinitionVersion: request.DefinitionVersion,
			DefinitionHash: request.DefinitionHash, RoundKind: request.RoundKind,
			Currency: request.Currency, DebitMinor: result.ChargedBetMinor,
			CreditMinor: result.TotalWinMinor,
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	entry.session.PendingRoundID = request.RoundID
	entry.rounds[request.RoundID] = cloneRound(record)
	return cloneRound(record), true, nil
}

func (r *MemoryRepository) ClaimWallet(
	ctx context.Context,
	key RoundKey,
	now time.Time,
	leaseUntil time.Time,
) (RoundRecord, bool, error) {
	if !leaseUntil.After(now) {
		return RoundRecord{}, false, fmt.Errorf("%w: wallet lease must be in the future", ErrInvalidRequest)
	}
	entry, err := r.lookupSession(ctx, key.OperatorID, key.SessionID)
	if err != nil {
		return RoundRecord{}, false, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return RoundRecord{}, false, err
	}
	record, exists := entry.rounds[key.RoundID]
	if !exists {
		return RoundRecord{}, false, ErrRoundNotFound
	}
	claimable := record.Status == RoundPrepared ||
		(record.Status == RoundWalletPending && !record.WalletLeaseUntil.After(now))
	if !claimable {
		return cloneRound(record), false, nil
	}
	if entry.session.PendingRoundID != key.RoundID || entry.session.Revision != record.Request.StartRevision {
		return RoundRecord{}, false, fmt.Errorf("%w: pending round/session state mismatch", ErrManualReview)
	}
	record.Status = RoundWalletPending
	record.WalletLeaseUntil = leaseUntil.UTC()
	record.RetryCount++
	record.UpdatedAt = now.UTC()
	entry.rounds[key.RoundID] = cloneRound(record)
	return cloneRound(record), true, nil
}

func (r *MemoryRepository) CommitRound(ctx context.Context, key RoundKey, receipt WalletReceipt) (RoundRecord, bool, error) {
	entry, err := r.lookupSession(ctx, key.OperatorID, key.SessionID)
	if err != nil {
		return RoundRecord{}, false, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return RoundRecord{}, false, err
	}
	record, exists := entry.rounds[key.RoundID]
	if !exists {
		return RoundRecord{}, false, ErrRoundNotFound
	}
	if record.Status == RoundCommitted {
		if record.WalletReceipt == nil || !sameWalletReceipt(*record.WalletReceipt, receipt) {
			return RoundRecord{}, false, ErrWalletReceiptInvalid
		}
		return cloneRound(record), false, nil
	}
	if record.Status == RoundRejected {
		return RoundRecord{}, false, ErrRoundRejected
	}
	if record.Status == RoundManualReview {
		return RoundRecord{}, false, ErrManualReview
	}
	if record.Status != RoundWalletPending {
		return RoundRecord{}, false, fmt.Errorf("%w: round is not wallet-pending", ErrWalletPending)
	}
	if err := validateWalletReceipt(record.WalletCommand, receipt); err != nil {
		return RoundRecord{}, false, err
	}
	if entry.session.PendingRoundID != key.RoundID || entry.session.Revision != record.Request.StartRevision {
		return RoundRecord{}, false, fmt.Errorf("%w: commit revision mismatch", ErrManualReview)
	}
	if record.Request.StartRevision >= MaxStateRevision {
		return RoundRecord{}, false, fmt.Errorf("%w: revision exhausted", ErrManualReview)
	}

	record.Status = RoundCommitted
	record.Result.BalanceMinor = receipt.BalanceMinor
	record.Result.WalletTransactionID = receipt.TransactionID
	record.Result.EndRevision = record.Request.StartRevision + 1
	record.WalletReceipt = cloneWalletReceipt(receipt)
	record.WalletLeaseUntil = time.Time{}
	record.UpdatedAt = time.Now().UTC()
	resultHash, err := CommittedResultHashFor(record.Result)
	if err != nil {
		return RoundRecord{}, false, err
	}
	entry.session.BalanceMinor = receipt.BalanceMinor
	entry.session.Revision = record.Result.EndRevision
	entry.session.Sequence = record.Result.Sequence
	entry.session.Feature = record.Result.FeatureState
	entry.session.PendingRoundID = ""
	entry.rounds[key.RoundID] = cloneRound(record)
	entry.deliveries[key.RoundID] = ResultDelivery{
		OperatorID: key.OperatorID, SessionID: key.SessionID, RoundID: key.RoundID,
		Sequence: record.Result.Sequence, ResultHash: resultHash,
		Result: cloneSpinResult(record.Result), OriginFeatureState: record.InputFeatureState,
	}
	return cloneRound(record), true, nil
}

func cloneResultDelivery(delivery ResultDelivery) ResultDelivery {
	delivery.Result = cloneSpinResult(delivery.Result)
	return delivery
}

func (r *MemoryRepository) RejectRound(ctx context.Context, key RoundKey, reason string) (RoundRecord, bool, error) {
	entry, err := r.lookupSession(ctx, key.OperatorID, key.SessionID)
	if err != nil {
		return RoundRecord{}, false, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return RoundRecord{}, false, err
	}
	record, exists := entry.rounds[key.RoundID]
	if !exists {
		return RoundRecord{}, false, ErrRoundNotFound
	}
	switch record.Status {
	case RoundRejected:
		return cloneRound(record), false, nil
	case RoundCommitted:
		return RoundRecord{}, false, fmt.Errorf("%w: committed round cannot be rejected", ErrManualReview)
	case RoundManualReview:
		return RoundRecord{}, false, ErrManualReview
	}
	record.Status = RoundRejected
	record.FailureReason = boundedReason(reason)
	record.WalletLeaseUntil = time.Time{}
	record.UpdatedAt = time.Now().UTC()
	if entry.session.PendingRoundID == key.RoundID {
		entry.session.PendingRoundID = ""
	}
	entry.rounds[key.RoundID] = cloneRound(record)
	return cloneRound(record), true, nil
}

func (r *MemoryRepository) MarkManualReview(ctx context.Context, key RoundKey, reason string) (RoundRecord, bool, error) {
	entry, err := r.lookupSession(ctx, key.OperatorID, key.SessionID)
	if err != nil {
		return RoundRecord{}, false, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return RoundRecord{}, false, err
	}
	record, exists := entry.rounds[key.RoundID]
	if !exists {
		return RoundRecord{}, false, ErrRoundNotFound
	}
	if record.Status == RoundCommitted {
		return RoundRecord{}, false, fmt.Errorf("%w: committed round cannot enter review", ErrManualReview)
	}
	if record.Status == RoundManualReview {
		return cloneRound(record), false, nil
	}
	record.Status = RoundManualReview
	record.FailureReason = boundedReason(reason)
	record.WalletLeaseUntil = time.Time{}
	record.UpdatedAt = time.Now().UTC()
	entry.session.Status = SessionBlocked
	entry.session.PendingRoundID = key.RoundID
	entry.rounds[key.RoundID] = cloneRound(record)
	return cloneRound(record), true, nil
}

func (r *MemoryRepository) ListRecoverableRounds(
	ctx context.Context,
	olderThan time.Time,
	limit int,
) ([]RoundKey, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 10_000 || olderThan.IsZero() {
		return nil, ErrInvalidRequest
	}
	r.mu.RLock()
	entries := make([]*memorySession, 0, len(r.sessions))
	for _, entry := range r.sessions {
		entries = append(entries, entry)
	}
	r.mu.RUnlock()

	keys := make([]RoundKey, 0, limit)
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		entry.mu.Lock()
		for _, record := range entry.rounds {
			if (record.Status == RoundPrepared || record.Status == RoundWalletPending) &&
				!record.UpdatedAt.After(olderThan) {
				keys = append(keys, record.Key)
				if len(keys) == limit {
					entry.mu.Unlock()
					return keys, nil
				}
			}
		}
		entry.mu.Unlock()
	}
	return keys, nil
}

func (r *MemoryRepository) lookupSession(ctx context.Context, operatorID, sessionID string) (*memorySession, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r.mu.RLock()
	entry := r.sessions[sessionKey(operatorID, sessionID)]
	r.mu.RUnlock()
	if entry == nil {
		return nil, ErrSessionNotFound
	}
	return entry, nil
}

func sessionKey(operatorID, sessionID string) string {
	return operatorID + "\x00" + sessionID
}

func validatePreparedResult(session Session, request SpinRequest, result SpinResult) error {
	if result.OperatorID != request.OperatorID || result.SessionID != request.SessionID ||
		result.RoundID != request.RoundID || result.GameID != request.GameID ||
		result.DefinitionVersion != request.DefinitionVersion || result.DefinitionHash != request.DefinitionHash ||
		result.Currency != request.Currency || result.RoundKind != request.RoundKind ||
		result.ServerTransactionID != walletOperationID(request) {
		return fmt.Errorf("%w: prepared result identity mismatch", ErrInvalidRequest)
	}
	if result.StartRevision != request.StartRevision || result.EndRevision != 0 {
		return fmt.Errorf("%w: invalid prepared result revision", ErrInvalidRequest)
	}
	if result.Sequence != session.Sequence+1 || result.BetMinor != request.BetMinor {
		return fmt.Errorf("%w: invalid prepared result sequence or bet", ErrInvalidRequest)
	}
	if result.ChargedBetMinor < 0 || result.TotalWinMinor < 0 || result.BalanceMinor != 0 {
		return fmt.Errorf("%w: invalid prepared result money", ErrInvalidRequest)
	}
	return nil
}

func validateWalletReceipt(command WalletRound, receipt WalletReceipt) error {
	if receipt.OperationID != command.OperationID || receipt.Fingerprint != command.Fingerprint ||
		receipt.OperatorID != command.OperatorID || receipt.Currency != command.Currency ||
		receipt.DebitMinor != command.DebitMinor || receipt.CreditMinor != command.CreditMinor ||
		!identifierPattern.MatchString(receipt.TransactionID) || receipt.BalanceMinor < 0 {
		return ErrWalletReceiptInvalid
	}
	return nil
}

// ValidateWalletReceipt 验证钱包响应是否为先前已持久化命令的确切经济确认。
func ValidateWalletReceipt(command WalletRound, receipt WalletReceipt) error {
	return validateWalletReceipt(command, receipt)
}

func sameWalletReceipt(left, right WalletReceipt) bool {
	return left == right
}

func cloneWalletReceipt(receipt WalletReceipt) *WalletReceipt {
	copyReceipt := receipt
	return &copyReceipt
}

func boundedReason(reason string) string {
	const maximum = 512
	if len(reason) > maximum {
		return reason[:maximum]
	}
	return reason
}

var _ Repository = (*MemoryRepository)(nil)
var _ RecoveryRepository = (*MemoryRepository)(nil)

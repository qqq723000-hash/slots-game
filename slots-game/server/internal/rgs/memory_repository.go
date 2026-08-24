package rgs

import (
	"context"
	"fmt"
	"sort"
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
	mu                 sync.Mutex
	session            Session
	rounds             map[string]RoundRecord
	walletTransactions map[string]memoryWalletTransaction
	deliveries         map[string]ResultDelivery
}

type memoryWalletTransaction struct {
	Command WalletRound
	Kind    string
	Status  string
}

const (
	memoryWalletKindPlay      = "PLAY"
	memoryWalletStatusPending = "PENDING"
	memoryWalletStatusUnknown = "UNKNOWN"
	memoryWalletStatusSuccess = "SUCCEEDED"
	memoryWalletStatusFailed  = "FAILED"
)

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
		walletTransactions: make(map[string]memoryWalletTransaction),
		deliveries:         make(map[string]ResultDelivery),
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

func (r *MemoryRepository) ResetSessionTransport(
	ctx context.Context,
	operatorID, sessionID string,
	idleDisconnect time.Duration,
) (Session, error) {
	if idleDisconnect < time.Second || idleDisconnect > 24*time.Hour {
		return Session{}, ErrInvalidRequest
	}
	entry, err := r.lookupSession(ctx, operatorID, sessionID)
	if err != nil {
		return Session{}, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	now := time.Now().UTC()
	if entry.session.Status == SessionBlocked {
		return Session{}, ErrManualReview
	}
	if entry.session.Status != SessionActive || !entry.session.ExpiresAt.After(now) {
		return Session{}, ErrSessionExpired
	}
	if entry.session.TransportGeneration >= MaxStateRevision {
		return Session{}, ErrInvalidRequest
	}
	entry.session.TransportGeneration++
	entry.session.IdleDisconnect = idleDisconnect
	entry.session.IdleDisconnectAt = now.Add(idleDisconnect)
	if entry.session.IdleDisconnectAt.After(entry.session.ExpiresAt) {
		entry.session.IdleDisconnectAt = entry.session.ExpiresAt
	}
	entry.session.ServerTime = now
	return entry.session, nil
}

func (r *MemoryRepository) AuthorizeSessionTransport(
	ctx context.Context,
	operatorID, sessionID string,
	transportGeneration uint64,
	allowIdleRecovery bool,
) (Session, error) {
	entry, err := r.lookupSession(ctx, operatorID, sessionID)
	if err != nil {
		return Session{}, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	if transportGeneration == 0 || transportGeneration != entry.session.TransportGeneration {
		return Session{}, ErrSessionTimeout
	}
	now := time.Now().UTC()
	if entry.session.Status == SessionBlocked {
		return Session{}, ErrManualReview
	}
	if entry.session.Status != SessionActive || !entry.session.ExpiresAt.After(now) {
		return Session{}, ErrSessionExpired
	}
	if !allowIdleRecovery && !entry.session.IdleDisconnectAt.After(now) {
		return Session{}, ErrSessionTimeout
	}
	entry.session.ServerTime = now
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
	if receipt.TransportGeneration != entry.session.TransportGeneration {
		return ResultDelivery{}, false, ErrSessionTimeout
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
	walletProfile Profile,
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
	if !SupportedSettlementProfile(walletProfile) {
		return RoundRecord{}, false, fmt.Errorf("%w: unsupported wallet settlement profile", ErrInvalidRequest)
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
	if request.TransportGeneration != entry.session.TransportGeneration ||
		!entry.session.IdleDisconnectAt.After(time.Now()) {
		return RoundRecord{}, false, ErrSessionTimeout
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
	now := time.Now().UTC()
	result.IdleDisconnectAt = now.Add(entry.session.IdleDisconnect)
	if result.IdleDisconnectAt.After(entry.session.ExpiresAt) {
		result.IdleDisconnectAt = entry.session.ExpiresAt
	}
	outcomeHash, err := PreparedOutcomeHashFor(result)
	if err != nil {
		return RoundRecord{}, false, err
	}
	walletCommand := WalletRound{
		OperationID: walletOperationID(request), Fingerprint: fingerprint,
		OperatorID: request.OperatorID, PlayerID: entry.session.PlayerID,
		WalletAccountID:  entry.session.WalletAccountID,
		WalletSessionRef: entry.session.WalletSessionID,
		SessionID:        request.SessionID, RoundID: request.RoundID,
		GameID: request.GameID, DefinitionVersion: request.DefinitionVersion,
		DefinitionHash: request.DefinitionHash, RoundKind: request.RoundKind,
		Currency: request.Currency, DebitMinor: result.ChargedBetMinor,
		CreditMinor: result.TotalWinMinor,
	}
	walletCommand.CommandDigest = CommandDigestFor(walletCommand)
	record := RoundRecord{
		Key:               request.Key(),
		Fingerprint:       fingerprint,
		Request:           request,
		Status:            RoundPrepared,
		Result:            result,
		InputFeatureState: entry.session.Feature,
		OutcomeHash:       outcomeHash,
		WalletCommand:     walletCommand,
		WalletProfile:     walletProfile,
		WalletPhase:       WalletRecoveryApply,
		NextAttemptAt:     now,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	entry.session.PendingRoundID = request.RoundID
	entry.session.IdleDisconnectAt = now.Add(entry.session.IdleDisconnect)
	if entry.session.IdleDisconnectAt.After(entry.session.ExpiresAt) {
		entry.session.IdleDisconnectAt = entry.session.ExpiresAt
	}
	entry.rounds[request.RoundID] = cloneRound(record)
	entry.walletTransactions[walletCommand.OperationID] = memoryWalletTransaction{
		Command: walletCommand, Kind: memoryWalletKindPlay, Status: memoryWalletStatusPending,
	}
	return cloneRound(record), true, nil
}

func (r *MemoryRepository) ClaimWallet(
	ctx context.Context,
	key RoundKey,
	leaseDuration time.Duration,
) (WalletRecoveryClaim, bool, error) {
	if leaseDuration <= 0 || leaseDuration > 24*time.Hour {
		return WalletRecoveryClaim{}, false, fmt.Errorf("%w: wallet lease duration must be positive", ErrInvalidRequest)
	}
	entry, err := r.lookupSession(ctx, key.OperatorID, key.SessionID)
	if err != nil {
		return WalletRecoveryClaim{}, false, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return WalletRecoveryClaim{}, false, err
	}
	record, exists := entry.rounds[key.RoundID]
	if !exists {
		return WalletRecoveryClaim{}, false, ErrRoundNotFound
	}
	if (record.Status == RoundPrepared || record.Status == RoundWalletPending) &&
		(validateWalletRecoveryMemoryBinding(entry, record) != nil) {
		quarantineMemoryWalletClaim(entry, key.RoundID, "persisted wallet ledger integrity validation failed")
		return WalletRecoveryClaim{}, false, ErrManualReview
	}
	claim, claimed, err := claimMemoryWallet(record, entry.session, time.Now().UTC(), leaseDuration)
	if err != nil || !claimed {
		claim.Record = cloneRound(record)
		return claim, false, err
	}
	entry.rounds[key.RoundID] = cloneRound(claim.Record)
	return claim, true, nil
}

func (r *MemoryRepository) CommitClaim(ctx context.Context, claim WalletRecoveryClaim, receipt WalletReceipt) (RoundRecord, bool, error) {
	key := claim.Record.Key
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
	if !ownsWalletClaim(record, claim) {
		return RoundRecord{}, false, ErrStaleWalletClaim
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
	record.WalletPhase = ""
	record.NextAttemptAt = time.Time{}
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
	walletTransaction := entry.walletTransactions[record.WalletCommand.OperationID]
	walletTransaction.Status = memoryWalletStatusSuccess
	entry.walletTransactions[record.WalletCommand.OperationID] = walletTransaction
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

func (r *MemoryRepository) RejectClaim(ctx context.Context, claim WalletRecoveryClaim, reason string) (RoundRecord, bool, error) {
	return r.transitionClaimFailure(ctx, claim, RoundRejected, reason, true)
}

func (r *MemoryRepository) MarkClaimManualReview(ctx context.Context, claim WalletRecoveryClaim, reason string) (RoundRecord, bool, error) {
	return r.transitionClaimFailure(ctx, claim, RoundManualReview, reason, false)
}

func (r *MemoryRepository) transitionClaimFailure(
	ctx context.Context,
	claim WalletRecoveryClaim,
	target RoundStatus,
	reason string,
	clearPending bool,
) (RoundRecord, bool, error) {
	key := claim.Record.Key
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
	if !ownsWalletClaim(record, claim) {
		return RoundRecord{}, false, ErrStaleWalletClaim
	}
	record.Status = target
	record.FailureReason = boundedReason(reason)
	record.WalletPhase = ""
	record.NextAttemptAt = time.Time{}
	record.WalletLeaseUntil = time.Time{}
	record.UpdatedAt = time.Now().UTC()
	if clearPending && entry.session.PendingRoundID == key.RoundID {
		entry.session.PendingRoundID = ""
	} else if !clearPending {
		entry.session.Status = SessionBlocked
		entry.session.PendingRoundID = key.RoundID
	}
	entry.rounds[key.RoundID] = cloneRound(record)
	walletTransaction := entry.walletTransactions[record.WalletCommand.OperationID]
	if target == RoundManualReview {
		walletTransaction.Status = memoryWalletStatusUnknown
	} else {
		walletTransaction.Status = memoryWalletStatusFailed
	}
	entry.walletTransactions[record.WalletCommand.OperationID] = walletTransaction
	return cloneRound(record), true, nil
}

func ownsWalletClaim(record RoundRecord, claim WalletRecoveryClaim) bool {
	return (record.Status == RoundPrepared || record.Status == RoundWalletPending) &&
		!claim.LeaseUntil.IsZero() && record.WalletLeaseUntil.Equal(claim.LeaseUntil)
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
	record.WalletPhase = ""
	record.NextAttemptAt = time.Time{}
	record.WalletLeaseUntil = time.Time{}
	record.UpdatedAt = time.Now().UTC()
	entry.session.Status = SessionBlocked
	entry.session.PendingRoundID = key.RoundID
	entry.rounds[key.RoundID] = cloneRound(record)
	for operationID, walletTransaction := range entry.walletTransactions {
		if walletTransaction.Command.RoundID == key.RoundID {
			if walletTransaction.Status == memoryWalletStatusPending {
				walletTransaction.Status = memoryWalletStatusUnknown
			}
			entry.walletTransactions[operationID] = walletTransaction
		}
	}
	return cloneRound(record), true, nil
}

func (r *MemoryRepository) ClaimRecoverableRounds(
	ctx context.Context,
	limit int,
	leaseDuration time.Duration,
) ([]WalletRecoveryClaim, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit < 1 || limit > MaxWalletRecoveryClaimBatch ||
		leaseDuration <= 0 || leaseDuration > 24*time.Hour {
		return nil, ErrInvalidRequest
	}
	r.mu.RLock()
	type namedSession struct {
		key   string
		entry *memorySession
	}
	entries := make([]namedSession, 0, len(r.sessions))
	for key, entry := range r.sessions {
		entries = append(entries, namedSession{key: key, entry: entry})
	}
	r.mu.RUnlock()
	sort.Slice(entries, func(i, j int) bool { return entries[i].key < entries[j].key })
	for _, item := range entries {
		item.entry.mu.Lock()
	}
	defer func() {
		for index := len(entries) - 1; index >= 0; index-- {
			entries[index].entry.mu.Unlock()
		}
	}()

	now := time.Now().UTC()
	type candidate struct {
		entry  *memorySession
		record RoundRecord
		rank   int
	}
	byOperator := make(map[string][]candidate)
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for _, record := range entry.entry.rounds {
			normalizeLegacyRecoveryState(&record)
			if recoveryRecordDue(record, entry.entry.session, now) {
				byOperator[record.Key.OperatorID] = append(
					byOperator[record.Key.OperatorID],
					candidate{entry: entry.entry, record: record},
				)
			}
		}
	}
	var candidates []candidate
	for operatorID := range byOperator {
		items := byOperator[operatorID]
		sort.Slice(items, func(i, j int) bool {
			if !items[i].record.NextAttemptAt.Equal(items[j].record.NextAttemptAt) {
				return items[i].record.NextAttemptAt.Before(items[j].record.NextAttemptAt)
			}
			if !items[i].record.UpdatedAt.Equal(items[j].record.UpdatedAt) {
				return items[i].record.UpdatedAt.Before(items[j].record.UpdatedAt)
			}
			if items[i].record.Key.SessionID != items[j].record.Key.SessionID {
				return items[i].record.Key.SessionID < items[j].record.Key.SessionID
			}
			return items[i].record.Key.RoundID < items[j].record.Key.RoundID
		})
		for index := range items {
			items[index].rank = index + 1
		}
		candidates = append(candidates, items...)
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].rank != candidates[j].rank {
			return candidates[i].rank < candidates[j].rank
		}
		if !candidates[i].record.NextAttemptAt.Equal(candidates[j].record.NextAttemptAt) {
			return candidates[i].record.NextAttemptAt.Before(candidates[j].record.NextAttemptAt)
		}
		return candidates[i].record.Key.OperatorID < candidates[j].record.Key.OperatorID
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	for _, candidate := range candidates {
		if err := validateWalletRecoveryMemoryBinding(candidate.entry, candidate.record); err != nil {
			quarantineMemoryWalletClaim(
				candidate.entry, candidate.record.Key.RoundID,
				"persisted wallet ledger integrity validation failed",
			)
			return nil, ErrManualReview
		}
	}
	claims := make([]WalletRecoveryClaim, 0, len(candidates))
	for _, candidate := range candidates {
		claim, claimed, err := claimMemoryWallet(
			candidate.record, candidate.entry.session, now, leaseDuration,
		)
		if err != nil {
			return nil, err
		}
		if !claimed {
			continue
		}
		candidate.entry.rounds[claim.Record.Key.RoundID] = cloneRound(claim.Record)
		claims = append(claims, claim)
	}
	return claims, nil
}

// RecoverySnapshot 为内存契约适配器提供与 PostgreSQL 相同的数据库全局有界下界语义。
// 它只用于测试和一致性验证；生产指标仍由 PostgreSQL 存储时钟生成。
func (r *MemoryRepository) RecoverySnapshot(ctx context.Context) (RecoverySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return RecoverySnapshot{}, err
	}
	r.mu.RLock()
	type namedSnapshotSession struct {
		key   string
		entry *memorySession
	}
	entries := make([]namedSnapshotSession, 0, len(r.sessions))
	for key, entry := range r.sessions {
		entries = append(entries, namedSnapshotSession{key: key, entry: entry})
	}
	r.mu.RUnlock()
	sort.Slice(entries, func(i, j int) bool { return entries[i].key < entries[j].key })
	for _, item := range entries {
		item.entry.mu.Lock()
	}
	defer func() {
		for index := len(entries) - 1; index >= 0; index-- {
			entries[index].entry.mu.Unlock()
		}
	}()

	now := time.Now().UTC()
	snapshot := RecoverySnapshot{ObservedAt: now}
	for _, item := range entries {
		if err := ctx.Err(); err != nil {
			return RecoverySnapshot{}, err
		}
		for _, stored := range item.entry.rounds {
			record := cloneRound(stored)
			normalizeLegacyRecoveryState(&record)
			if !recoveryRecordScheduledForObservation(record) {
				continue
			}
			if snapshot.Backlog < RecoverySnapshotBacklogLimit {
				snapshot.Backlog++
			}
			if age := now.Sub(record.NextAttemptAt); age > snapshot.OldestDueAge {
				snapshot.OldestDueAge = age
			}
		}
	}
	return snapshot, nil
}

func (r *MemoryRepository) ScheduleWalletRecovery(
	ctx context.Context,
	claim WalletRecoveryClaim,
	disposition WalletRecoveryDisposition,
	jitterDelay time.Duration,
) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if disposition.Terminal || ValidateWalletRecoveryDisposition(disposition) != nil ||
		jitterDelay < 0 || jitterDelay > 24*time.Hour || claim.LeaseUntil.IsZero() ||
		(disposition.ApplyNotSent &&
			(claim.Action != WalletRecoveryApply || claim.Record.WalletApplyAttempts < 1)) {
		return false, ErrInvalidRequest
	}
	entry, err := r.lookupSession(ctx, claim.Record.Key.OperatorID, claim.Record.Key.SessionID)
	if err != nil {
		return false, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	record, exists := entry.rounds[claim.Record.Key.RoundID]
	if !exists {
		return false, ErrRoundNotFound
	}
	if (record.Status != RoundPrepared && record.Status != RoundWalletPending) ||
		!record.WalletLeaseUntil.Equal(claim.LeaseUntil) {
		return false, nil
	}
	now := time.Now().UTC()
	effectiveDelay := jitterDelay
	if disposition.MinimumDelay > effectiveDelay {
		effectiveDelay = disposition.MinimumDelay
	}
	nextAttemptAt := now.Add(effectiveDelay)
	if disposition.NextAttemptAt.After(nextAttemptAt) {
		nextAttemptAt = disposition.NextAttemptAt.UTC()
	}
	record.WalletPhase = disposition.NextAction
	if disposition.ApplyNotSent {
		if record.WalletApplyAttempts < 1 {
			return false, ErrManualReview
		}
		// 只归还能够证明未越过发送边界的经济 APPLY 预算。RetryCount 是持久调度
		// 压力计数，必须保留来扩大退避，否则持续熔断会退化为固定短周期热循环。
		record.WalletApplyAttempts--
	}
	record.NextAttemptAt = nextAttemptAt
	record.WalletLeaseUntil = time.Time{}
	record.UpdatedAt = now
	entry.rounds[record.Key.RoundID] = cloneRound(record)
	return true, nil
}

func claimMemoryWallet(
	record RoundRecord,
	session Session,
	now time.Time,
	leaseDuration time.Duration,
) (WalletRecoveryClaim, bool, error) {
	normalizeLegacyRecoveryState(&record)
	if !recoveryRecordDue(record, session, now) {
		return WalletRecoveryClaim{Record: cloneRound(record)}, false, nil
	}
	if session.PendingRoundID != record.Key.RoundID || session.Revision != record.Request.StartRevision {
		return WalletRecoveryClaim{}, false, fmt.Errorf("%w: pending round/session state mismatch", ErrManualReview)
	}
	action := record.WalletPhase
	record.Status = RoundWalletPending
	record.WalletLeaseUntil = now.Add(leaseDuration)
	record.NextAttemptAt = record.WalletLeaseUntil
	if action == WalletRecoveryApply {
		// APPLY 的持久后继必须先变为 LOOKUP，再把执行权交给外部调用者。
		record.WalletPhase = WalletRecoveryLookup
		record.WalletApplyAttempts++
		record.RetryCount++
	} else {
		record.WalletLookupAttempts++
	}
	record.UpdatedAt = now
	return WalletRecoveryClaim{
		Record: cloneRound(record), Action: action, LeaseUntil: record.WalletLeaseUntil,
	}, true, nil
}

func validateWalletRecoveryMemoryBinding(entry *memorySession, record RoundRecord) error {
	if err := ValidateWalletRecoveryRecord(entry.session, record); err != nil {
		return err
	}
	matching := 0
	for operationID, walletTransaction := range entry.walletTransactions {
		if walletTransaction.Command.RoundID != record.Key.RoundID {
			continue
		}
		matching++
		if operationID != record.WalletCommand.OperationID ||
			walletTransaction.Command != record.WalletCommand ||
			walletTransaction.Kind != memoryWalletKindPlay ||
			(walletTransaction.Status != memoryWalletStatusPending &&
				walletTransaction.Status != memoryWalletStatusUnknown) {
			return ErrManualReview
		}
	}
	if matching != 1 {
		return ErrManualReview
	}
	return nil
}

func quarantineMemoryWalletClaim(entry *memorySession, roundID, reason string) {
	record, exists := entry.rounds[roundID]
	if !exists {
		return
	}
	now := time.Now().UTC()
	record.Status = RoundManualReview
	record.FailureReason = boundedReason(reason)
	record.WalletPhase = ""
	record.NextAttemptAt = time.Time{}
	record.WalletLeaseUntil = time.Time{}
	record.UpdatedAt = now
	entry.rounds[roundID] = cloneRound(record)
	entry.session.Status = SessionBlocked
	entry.session.PendingRoundID = roundID
	for operationID, walletTransaction := range entry.walletTransactions {
		if walletTransaction.Command.RoundID != roundID {
			continue
		}
		if walletTransaction.Status == memoryWalletStatusPending {
			walletTransaction.Status = memoryWalletStatusUnknown
		}
		entry.walletTransactions[operationID] = walletTransaction
	}
}

func normalizeLegacyRecoveryState(record *RoundRecord) {
	if record.WalletPhase.Valid() {
		return
	}
	switch record.Status {
	case RoundPrepared:
		record.WalletPhase = WalletRecoveryApply
	case RoundWalletPending:
		record.WalletPhase = WalletRecoveryLookup
	default:
		return
	}
	if record.NextAttemptAt.IsZero() {
		record.NextAttemptAt = record.UpdatedAt
		if record.WalletLeaseUntil.After(record.NextAttemptAt) {
			record.NextAttemptAt = record.WalletLeaseUntil
		}
	}
	if record.WalletApplyAttempts == 0 && record.RetryCount > 0 {
		record.WalletApplyAttempts = record.RetryCount
	}
}

func recoveryRecordDue(record RoundRecord, session Session, now time.Time) bool {
	return recoveryRecordScheduled(record, session) && !record.NextAttemptAt.After(now) &&
		!record.WalletLeaseUntil.After(now)
}

func recoveryRecordScheduled(record RoundRecord, session Session) bool {
	return recoveryRecordScheduledForObservation(record) &&
		session.Status == SessionActive && session.PendingRoundID == record.Key.RoundID &&
		session.Revision == record.Request.StartRevision
}

func recoveryRecordScheduledForObservation(record RoundRecord) bool {
	return (record.Status == RoundPrepared || record.Status == RoundWalletPending) &&
		record.WalletPhase.Valid() && !record.NextAttemptAt.IsZero()
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

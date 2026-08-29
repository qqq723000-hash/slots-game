package rgs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// RiskExpiryPolicy 是高额派奖在审批窗口结束后的持久终态策略。
// English: RiskExpiryPolicy is a persistent end-state policy for high-stakes payouts after the approval window
// ends.
type RiskExpiryPolicy string

const (
	RiskExpiryReject       RiskExpiryPolicy = "REJECT"
	RiskExpiryManualReview RiskExpiryPolicy = "MANUAL_REVIEW"
)

func (policy RiskExpiryPolicy) Valid() bool {
	return policy == RiskExpiryReject || policy == RiskExpiryManualReview
}

// HighValueRiskPolicy 只在显式启用时拦截达到阈值的候选派奖。阈值使用轮次币种的
// 最小货币单位；策略版本和到期策略会随候选结果一同持久化，禁止事后重解释。
// English: HighValueRiskPolicy only intercepts candidate bids that reach the threshold when explicitly enabled.
// The threshold uses the smallest currency unit of the round currency; the strategy version and expiration
// strategy will be persisted together with the candidate results, and subsequent reinterpretation is prohibited.
type HighValueRiskPolicy struct {
	Enabled        bool
	ThresholdMinor int64
	PolicyVersion  string
	ReviewTTL      time.Duration
	ExpiryPolicy   RiskExpiryPolicy
}

func (policy HighValueRiskPolicy) Validate() error {
	if !policy.Enabled {
		if policy.ThresholdMinor != 0 || policy.PolicyVersion != "" ||
			policy.ReviewTTL != 0 || policy.ExpiryPolicy != "" {
			return errors.New("rgs: disabled risk policy cannot contain active settings")
		}
		return nil
	}
	if policy.ThresholdMinor <= 0 || !identifierPattern.MatchString(policy.PolicyVersion) ||
		policy.ReviewTTL < time.Minute || policy.ReviewTTL > 72*time.Hour ||
		!policy.ExpiryPolicy.Valid() {
		return errors.New("rgs: invalid high-value risk policy")
	}
	return nil
}

// RiskAssessment 是与首次候选结果同事务持久化的低敏决策摘要；不包含玩家、会话、
// 棋盘、中奖线或自由文本。
// English: RiskAssessment is a low-sensitivity decision summary persisted in the same transaction as the first
// candidate result; it does not contain players, sessions, boards, paylines, or free text.
type RiskAssessment struct {
	PolicyVersion  string
	ThresholdMinor int64
	PayoutMinor    int64
	ExpiresAt      time.Time
	ExpiryPolicy   RiskExpiryPolicy
	SummaryHash    string
}

func (policy HighValueRiskPolicy) Assess(result SpinResult, now time.Time) (*RiskAssessment, error) {
	if err := policy.Validate(); err != nil {
		return nil, err
	}
	if result.TotalWinMinor < 0 {
		return nil, ErrInvalidRequest
	}
	if !policy.Enabled || result.TotalWinMinor < policy.ThresholdMinor {
		return nil, nil
	}
	if now.IsZero() {
		return nil, ErrInvalidRequest
	}
	expiresAt := now.UTC().Add(policy.ReviewTTL)
	assessment := RiskAssessment{
		PolicyVersion: policy.PolicyVersion, ThresholdMinor: policy.ThresholdMinor,
		PayoutMinor: result.TotalWinMinor, ExpiresAt: expiresAt,
		ExpiryPolicy: policy.ExpiryPolicy,
	}
	summaryHash, err := RiskAssessmentSummaryHash(result, assessment)
	if err != nil {
		return nil, err
	}
	assessment.SummaryHash = summaryHash
	return &assessment, nil
}

func RiskAssessmentSummaryHash(result SpinResult, assessment RiskAssessment) (string, error) {
	if !identifierPattern.MatchString(assessment.PolicyVersion) || assessment.ThresholdMinor <= 0 ||
		assessment.PayoutMinor != result.TotalWinMinor ||
		assessment.PayoutMinor < assessment.ThresholdMinor || assessment.ExpiresAt.IsZero() ||
		!assessment.ExpiryPolicy.Valid() {
		return "", ErrInvalidRequest
	}
	summary := struct {
		PolicyVersion  string `json:"policyVersion"`
		ThresholdMinor int64  `json:"thresholdMinor"`
		PayoutMinor    int64  `json:"payoutMinor"`
		Currency       string `json:"currency"`
		OutcomeHash    string `json:"outcomeHash"`
		ExpiryPolicy   string `json:"expiryPolicy"`
		ExpiresAt      string `json:"expiresAt"`
	}{
		PolicyVersion: assessment.PolicyVersion, ThresholdMinor: assessment.ThresholdMinor,
		PayoutMinor: assessment.PayoutMinor, Currency: result.Currency,
		ExpiryPolicy: string(assessment.ExpiryPolicy),
		ExpiresAt:    assessment.ExpiresAt.UTC().Format(time.RFC3339Nano),
	}
	outcomeHash, err := PreparedOutcomeHashFor(result)
	if err != nil {
		return "", err
	}
	summary.OutcomeHash = outcomeHash
	encoded, err := json.Marshal(summary)
	if err != nil {
		return "", fmt.Errorf("rgs: encode risk assessment: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

type RiskDecision string

const (
	RiskDecisionApprove RiskDecision = "APPROVE"
	RiskDecisionReject  RiskDecision = "REJECT"

	RiskReasonApproved         = "RISK_APPROVED"
	RiskReasonPolicyRejected   = "RISK_POLICY_REJECTED"
	RiskReasonFraudSuspected   = "RISK_FRAUD_SUSPECTED"
	RiskReasonOperatorRejected = "RISK_OPERATOR_REJECTED"
)

// RiskDecisionCommand 绑定签名运营商请求和固定原因码；不接收自由文本。
// English: RiskDecisionCommand binds signed operator requests and fixed reason codes; does not receive free text.
type RiskDecisionCommand struct {
	RoundKey        RoundKey
	RequestID       string
	IdempotencyKey  string
	CredentialKeyID string
	Decision        RiskDecision
	ReasonCode      string
}

func ValidateRiskDecisionCommand(command RiskDecisionCommand) error {
	if !identifierPattern.MatchString(command.RoundKey.OperatorID) ||
		!identifierPattern.MatchString(command.RoundKey.SessionID) ||
		!identifierPattern.MatchString(command.RoundKey.RoundID) ||
		!identifierPattern.MatchString(command.RequestID) ||
		!identifierPattern.MatchString(command.IdempotencyKey) ||
		!identifierPattern.MatchString(command.CredentialKeyID) ||
		!validRiskDecisionReason(command.Decision, command.ReasonCode) {
		return ErrInvalidRequest
	}
	return nil
}

func validRiskDecisionReason(decision RiskDecision, reason string) bool {
	if decision == RiskDecisionApprove {
		return reason == RiskReasonApproved
	}
	if decision != RiskDecisionReject {
		return false
	}
	return reason == RiskReasonPolicyRejected || reason == RiskReasonFraudSuspected ||
		reason == RiskReasonOperatorRejected
}

func RiskDecisionFingerprint(command RiskDecisionCommand) (string, error) {
	if err := ValidateRiskDecisionCommand(command); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(struct {
		OperatorID string       `json:"operatorId"`
		SessionID  string       `json:"sessionId"`
		RoundID    string       `json:"roundId"`
		Decision   RiskDecision `json:"decision"`
		ReasonCode string       `json:"reasonCode"`
	}{
		OperatorID: command.RoundKey.OperatorID, SessionID: command.RoundKey.SessionID,
		RoundID: command.RoundKey.RoundID, Decision: command.Decision,
		ReasonCode: command.ReasonCode,
	})
	if err != nil {
		return "", fmt.Errorf("rgs: encode risk decision: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

type RiskDecisionResult struct {
	RoundKey  RoundKey
	Decision  RiskDecision
	Status    RoundStatus
	DecidedAt time.Time
	Replayed  bool
}

type RiskDecisionService interface {
	DecideRisk(context.Context, RiskDecisionCommand) (RiskDecisionResult, error)
}

// RiskExpiryRepository 由后台 Worker 调用；实现必须使用持久存储时钟、行锁重检和有界批次。
// English: RiskExpiryRepository is called by a background worker; implementations must use persistent storage
// clocks, row lock rechecks, and bounded batches.
type RiskExpiryRepository interface {
	ExpireRiskReviews(context.Context, int) (int, error)
}

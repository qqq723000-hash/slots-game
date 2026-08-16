package operator

import "errors"

var (
	ErrMalformed        = errors.New("operator security input is malformed")
	ErrUnknownKey       = errors.New("operator verification key is unknown")
	ErrKeyInactive      = errors.New("operator verification key is inactive")
	ErrSignatureInvalid = errors.New("operator signature is invalid")
	ErrContentDigest    = errors.New("operator content digest is invalid")
	ErrExpired          = errors.New("operator credential is expired")
	ErrNotYetValid      = errors.New("operator credential is not yet valid")
	ErrReplay           = errors.New("operator request was replayed")
	ErrTenantMismatch   = errors.New("operator tenant does not match verified key")
	ErrAudienceMismatch = errors.New("operator token audience does not match")
	ErrIssuerMismatch   = errors.New("operator token issuer does not match")
	ErrNonceStore       = errors.New("operator nonce store failed")
)

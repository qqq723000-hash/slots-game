package operator

import (
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const fixedResponseComponentSet = `("@status" "content-digest" "content-type" "x-request-id")`

var responseSignatureInputPattern = regexp.MustCompile(`^sig1=\("@status" "content-digest" "content-type" "x-request-id"\);created=(0|[1-9][0-9]{0,18});expires=(0|[1-9][0-9]{0,18});keyid="([A-Za-z0-9][A-Za-z0-9._:-]{0,127})";alg="ed25519"$`)

type ResponseSignatureParams struct {
	RequestID string
	Created   time.Time
	Expires   time.Time
}

type ResponseVerifier struct {
	keys        KeyResolver
	now         func() time.Time
	clockSkew   time.Duration
	maxLifetime time.Duration
}

func NewResponseVerifier(keys KeyResolver, options RequestVerifierOptions) (*ResponseVerifier, error) {
	if keys == nil || options.ClockSkew < 0 || options.MaxLifetime < 0 {
		return nil, fmt.Errorf("%w: invalid response verifier options", ErrMalformed)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.MaxLifetime == 0 {
		options.MaxLifetime = DefaultSignatureLifetime
	}
	return &ResponseVerifier{
		keys: keys, now: options.Now, clockSkew: options.ClockSkew,
		maxLifetime: options.MaxLifetime,
	}, nil
}

func SignResponse(response *http.Response, body []byte, key SigningKey, params ResponseSignatureParams) error {
	if response == nil || len(body) > MaximumSignedRequestBody || !validIdentifier(params.RequestID) {
		return fmt.Errorf("%w: invalid signed response", ErrMalformed)
	}
	if err := validateSigningKey(key); err != nil {
		return err
	}
	if key.Purpose != KeyPurposeHTTPResponse {
		return fmt.Errorf("%w: signing key has wrong purpose", ErrMalformed)
	}
	created, expires := params.Created.Truncate(time.Second), params.Expires.Truncate(time.Second)
	if created.IsZero() || !expires.After(created) || expires.Sub(created) > DefaultSignatureLifetime ||
		created.Before(key.NotBefore) || expires.After(key.NotAfter) {
		return fmt.Errorf("%w: invalid response signature window", ErrMalformed)
	}
	if response.Header == nil {
		response.Header = make(http.Header)
	}
	response.Header.Set("Content-Type", SignedContentType)
	response.Header.Set(HeaderContentDigest, makeContentDigest(body))
	response.Header.Set(HeaderRequestID, params.RequestID)
	input := formatResponseSignatureInput(created.Unix(), expires.Unix(), key.KeyID)
	response.Header.Set(HeaderSignatureInput, input)
	canonical, err := canonicalResponse(response, input)
	if err != nil {
		return err
	}
	signature := ed25519.Sign(key.PrivateKey, []byte(canonical))
	response.Header.Set(HeaderSignature, "sig1=:"+base64.StdEncoding.EncodeToString(signature)+":")
	return nil
}

func (v *ResponseVerifier) Verify(
	ctx context.Context,
	response *http.Response,
	body []byte,
	expectedOperatorID, expectedRequestID string,
) error {
	if response == nil || len(body) > MaximumSignedRequestBody ||
		!validIdentifier(expectedOperatorID) || !validIdentifier(expectedRequestID) {
		return fmt.Errorf("%w: invalid signed response", ErrMalformed)
	}
	input, err := singleHeader(response.Header, HeaderSignatureInput)
	if err != nil {
		return err
	}
	createdUnix, expiresUnix, keyID, err := parseResponseSignatureInput(input)
	if err != nil {
		return err
	}
	key, found, err := v.keys.ResolveKey(ctx, KeyPurposeHTTPResponse, keyID)
	if err != nil {
		return err
	}
	if !found || validateVerificationKey(key) != nil {
		return ErrUnknownKey
	}
	if subtle.ConstantTimeCompare([]byte(key.OperatorID), []byte(expectedOperatorID)) != 1 {
		return ErrTenantMismatch
	}
	created, expires := time.Unix(createdUnix, 0), time.Unix(expiresUnix, 0)
	now := v.now()
	if !expires.After(created) || expires.Sub(created) > v.maxLifetime {
		return fmt.Errorf("%w: invalid response signature window", ErrMalformed)
	}
	if created.After(now.Add(v.clockSkew)) {
		return ErrNotYetValid
	}
	if !expires.After(now.Add(-v.clockSkew)) {
		return ErrExpired
	}
	if created.Before(key.NotBefore.Add(-v.clockSkew)) || expires.After(key.NotAfter.Add(v.clockSkew)) {
		return ErrKeyInactive
	}
	requestID, err := singleHeader(response.Header, HeaderRequestID)
	if err != nil || subtle.ConstantTimeCompare([]byte(requestID), []byte(expectedRequestID)) != 1 {
		return ErrSignatureInvalid
	}
	digestHeader, err := singleHeader(response.Header, HeaderContentDigest)
	if err != nil {
		return err
	}
	digest, err := decodeFixedBase64(contentDigestPattern, digestHeader, 32)
	if err != nil {
		return ErrContentDigest
	}
	want := makeContentDigest(body)
	wantDigest, _ := decodeFixedBase64(contentDigestPattern, want, 32)
	if subtle.ConstantTimeCompare(digest, wantDigest) != 1 {
		return ErrContentDigest
	}
	canonical, err := canonicalResponse(response, input)
	if err != nil {
		return err
	}
	signatureHeader, err := singleHeader(response.Header, HeaderSignature)
	if err != nil {
		return err
	}
	signature, err := decodeFixedBase64(signaturePattern, signatureHeader, ed25519.SignatureSize)
	if err != nil || !ed25519.Verify(key.PublicKey, []byte(canonical), signature) {
		return ErrSignatureInvalid
	}
	return nil
}

func canonicalResponse(response *http.Response, signatureInput string) (string, error) {
	if response.StatusCode < 100 || response.StatusCode > 599 {
		return "", fmt.Errorf("%w: invalid response status", ErrMalformed)
	}
	contentType, err := singleHeader(response.Header, "Content-Type")
	if err != nil || contentType != SignedContentType {
		return "", fmt.Errorf("%w: invalid response content type", ErrMalformed)
	}
	digest, err := singleHeader(response.Header, HeaderContentDigest)
	if err != nil {
		return "", err
	}
	requestID, err := singleHeader(response.Header, HeaderRequestID)
	if err != nil {
		return "", err
	}
	return strings.Join([]string{
		`"@status": ` + strconv.Itoa(response.StatusCode),
		`"content-digest": ` + digest,
		`"content-type": ` + contentType,
		`"x-request-id": ` + requestID,
		`"@signature-params": ` + strings.TrimPrefix(signatureInput, "sig1="),
	}, "\n"), nil
}

func formatResponseSignatureInput(created, expires int64, keyID string) string {
	return "sig1=" + fixedResponseComponentSet + ";created=" + strconv.FormatInt(created, 10) +
		";expires=" + strconv.FormatInt(expires, 10) + ";keyid=\"" + keyID + "\";alg=\"ed25519\""
}

func parseResponseSignatureInput(value string) (int64, int64, string, error) {
	matches := responseSignatureInputPattern.FindStringSubmatch(value)
	if matches == nil {
		return 0, 0, "", fmt.Errorf("%w: response signature input does not match the fixed profile", ErrMalformed)
	}
	created, err := strconv.ParseInt(matches[1], 10, 64)
	if err != nil {
		return 0, 0, "", ErrMalformed
	}
	expires, err := strconv.ParseInt(matches[2], 10, 64)
	if err != nil {
		return 0, 0, "", ErrMalformed
	}
	return created, expires, matches[3], nil
}

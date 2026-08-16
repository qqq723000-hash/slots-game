package operator

import (
	"encoding/base64"
	"regexp"
	"strings"
)

var (
	identifierPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	authorityPattern    = regexp.MustCompile(`^[A-Za-z0-9.\-:\[\]]{1,255}$`)
	currencyPattern     = regexp.MustCompile(`^[A-Z]{3}$`)
	digestPattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	jurisdictionPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{1,15}$`)
)

func validIdentifier(value string) bool {
	return identifierPattern.MatchString(value)
}

func validTextClaim(value string, max int) bool {
	if value == "" || len(value) > max {
		return false
	}
	for _, character := range value {
		if character <= 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func validNonce(value string) bool {
	if value == "" || strings.Contains(value, "=") {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) < 16 || len(decoded) > 64 {
		return false
	}
	return base64.RawURLEncoding.EncodeToString(decoded) == value
}

package safelog

import (
	"crypto/sha256"
	"encoding/hex"
)

const correlationIDDigestPrefix = "sha256:"

// CorrelationIDDigest 将外部可控的关联标识转换为稳定的 SHA-256 单向摘要。空值保持为空，
// 便于调用方区分“没有标识”和“已有标识”；返回值只能用于日志关联，不能写回协议响应。
func CorrelationIDDigest(value string) string {
	if value == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(value))
	return correlationIDDigestPrefix + hex.EncodeToString(digest[:])
}

package bootstrap

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
)

// LoadLaunchHMACKey 加载采用规范 Base64 编码的 256 位密钥。该密钥用于派生可重放但
// 不可猜测的一次性启动码；所有副本必须共享它，并且只能在启动码最大生存期结束后轮换。
func LoadLaunchHMACKey(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New("launch HMAC key path is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open launch HMAC key: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat launch HMAC key: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("launch HMAC key must be a regular file")
	}
	if permission := info.Mode().Perm(); permission&0o137 != 0 {
		return nil, fmt.Errorf("launch HMAC key permissions %04o are too broad", permission)
	}
	encoded, err := io.ReadAll(io.LimitReader(file, 128))
	if err != nil {
		return nil, fmt.Errorf("read launch HMAC key: %w", err)
	}
	defer clear(encoded)
	encoded = bytes.TrimSuffix(encoded, []byte("\n"))
	if bytes.ContainsAny(encoded, " \t\r\n") {
		return nil, errors.New("launch HMAC key contains whitespace")
	}
	decoded, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil || len(decoded) != 32 ||
		base64.StdEncoding.EncodeToString(decoded) != string(encoded) {
		clear(decoded)
		return nil, errors.New("launch HMAC key must be canonical base64 for exactly 32 bytes")
	}
	return decoded, nil
}

package bootstrap

import (
	"bytes"
	"crypto/ed25519"
	"crypto/subtle"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
)

func loadEd25519PublicKey(path string) (ed25519.PublicKey, error) {
	data, err := readLimitedFile(path, maximumPEMBytes)
	if err != nil {
		return nil, err
	}
	block, rest := pem.Decode(data)
	if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("public key must contain exactly one unencrypted PKIX PUBLIC KEY PEM block")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, errors.New("parse PKIX public key")
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("public key must be Ed25519")
	}
	return append(ed25519.PublicKey(nil), key...), nil
}

func loadEd25519PrivateKey(path string) (ed25519.PrivateKey, error) {
	if path == "" {
		return nil, errors.New("private key path is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open private key: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat private key: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("private key must be a regular file")
	}
	// 使用专用密钥组的部署允许组读取；执行位、组写入及任何其他用户权限均被拒绝。
	// Deployments using a dedicated key group may permit group read; execute bits, group write, and all permissions for other users are rejected.
	if permission := info.Mode().Perm(); permission&0o137 != 0 {
		return nil, fmt.Errorf("private key permissions %04o are too broad", permission)
	}
	data, err := io.ReadAll(io.LimitReader(file, maximumPEMBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read private key: %w", err)
	}
	defer clear(data)
	if int64(len(data)) > maximumPEMBytes {
		return nil, fmt.Errorf("private key exceeds %d-byte limit", maximumPEMBytes)
	}
	block, rest := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("private key must contain exactly one unencrypted PKCS8 PRIVATE KEY PEM block")
	}
	defer clear(block.Bytes)
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("parse PKCS8 private key")
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("private key must be Ed25519")
	}
	return append(ed25519.PrivateKey(nil), key...), nil
}

func loadMatchingEd25519KeyPair(privatePath, publicPath string) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	privateKey, err := loadEd25519PrivateKey(privatePath)
	if err != nil {
		return nil, nil, err
	}
	publicKey, err := loadEd25519PublicKey(publicPath)
	if err != nil {
		clear(privateKey)
		return nil, nil, err
	}
	derived, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok || subtle.ConstantTimeCompare(derived, publicKey) != 1 {
		clear(privateKey)
		return nil, nil, errors.New("Ed25519 public and private keys do not match")
	}
	return privateKey, publicKey, nil
}

// Command secret-env 从受限文件加载单个环境变量，再用原进程替换自身。
// 它避免把 PostgreSQL DSN 写入镜像或容器的静态配置。
package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const maximumSecretEnvironmentBytes = 16 << 10

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 3 {
		return errors.New("usage: secret-env ENVIRONMENT_NAME COMMAND [ARG...]")
	}
	name := os.Args[1]
	if name == "" || strings.IndexFunc(name, func(character rune) bool {
		return !(character == '_' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9')
	}) >= 0 {
		return errors.New("secret-env: invalid environment variable name")
	}
	path := os.Getenv(name + "_FILE")
	if path == "" || !filepath.IsAbs(path) {
		return errors.New("secret-env: absolute secret file path is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("secret-env: open secret: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o137 != 0 {
		return errors.New("secret-env: secret must be a regular file with restricted permissions")
	}
	encoded, err := io.ReadAll(io.LimitReader(file, maximumSecretEnvironmentBytes+1))
	if err != nil || len(encoded) > maximumSecretEnvironmentBytes {
		return errors.New("secret-env: secret cannot be read or exceeds the size limit")
	}
	defer clear(encoded)
	value := bytes.TrimSuffix(encoded, []byte("\n"))
	if len(value) == 0 || bytes.ContainsAny(value, "\x00\r\n") {
		return errors.New("secret-env: secret must contain exactly one non-empty line")
	}
	if err := os.Setenv(name, string(value)); err != nil {
		return errors.New("secret-env: cannot set target environment")
	}
	executable, err := filepath.Abs(os.Args[2])
	if err != nil || !filepath.IsAbs(executable) {
		return errors.New("secret-env: command must be absolute")
	}
	return syscall.Exec(executable, os.Args[2:], os.Environ())
}

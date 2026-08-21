// Command secret-materializer 把只读编排 Secret 复制到进程所属的内存卷，
// 使业务进程最终只从 0400 的绝对路径读取凭据。
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const maximumSecretBytes = 1 << 20

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 || len(arguments)%2 != 0 {
		return errors.New("secret-materializer: source/destination pairs are required")
	}
	for index := 0; index < len(arguments); index += 2 {
		if err := copySecret(arguments[index], arguments[index+1]); err != nil {
			return err
		}
	}
	return nil
}

func copySecret(sourcePath, destinationPath string) error {
	if !filepath.IsAbs(sourcePath) || !filepath.IsAbs(destinationPath) {
		return errors.New("secret-materializer: paths must be absolute")
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("secret-materializer: open source: %w", err)
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maximumSecretBytes {
		return errors.New("secret-materializer: source must be a bounded regular file")
	}
	destination, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		return fmt.Errorf("secret-materializer: create destination: %w", err)
	}
	succeeded := false
	defer func() {
		_ = destination.Close()
		if !succeeded {
			_ = os.Remove(destinationPath)
		}
	}()
	written, err := io.Copy(destination, io.LimitReader(source, maximumSecretBytes+1))
	if err != nil || written != info.Size() || written > maximumSecretBytes {
		return errors.New("secret-materializer: incomplete or oversized copy")
	}
	if err := destination.Sync(); err != nil {
		return fmt.Errorf("secret-materializer: sync destination: %w", err)
	}
	if err := destination.Close(); err != nil {
		return fmt.Errorf("secret-materializer: close destination: %w", err)
	}
	succeeded = true
	return nil
}

// Command service-probe 为无 shell 运行时提供小型 HTTP(S) 健康检查。
// English: Command service-probe provides small HTTP(S) health checks for shellless runtimes.
package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	if err := probe(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func probe() error {
	target := os.Getenv("PROBE_URL")
	if target == "" {
		return errors.New("service-probe: PROBE_URL is required")
	}
	tlsConfiguration := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: os.Getenv("PROBE_SERVER_NAME")}
	if path := os.Getenv("PROBE_ROOT_CA_FILE"); path != "" {
		encoded, err := os.ReadFile(path)
		if err != nil {
			return errors.New("service-probe: cannot read root CA")
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(encoded) {
			return errors.New("service-probe: root CA is invalid")
		}
		tlsConfiguration.RootCAs = roots
	}
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return errors.New("service-probe: target URL is invalid")
	}
	if path := os.Getenv("PROBE_BEARER_FILE"); path != "" {
		encoded, err := os.ReadFile(path)
		if err != nil {
			return errors.New("service-probe: cannot read bearer token")
		}
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(encoded)))
	}
	client := &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: tlsConfiguration, DisableCompression: true,
			ResponseHeaderTimeout: 2 * time.Second, MaxResponseHeaderBytes: 16 << 10,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect rejected") },
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("service-probe: request failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("service-probe: unexpected HTTP status %d", response.StatusCode)
	}
	return nil
}

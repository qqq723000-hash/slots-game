package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"slots-game/server/internal/platform"
)

func TestDDoSTransportRejectsSlowRequestHeadersBeforeHandler(t *testing.T) {
	var handlerCalls atomic.Int64
	address, closeServer := startDDoSTransportServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		handlerCalls.Add(1)
	}), platform.Config{
		ReadHeaderTimeout: 40 * time.Millisecond,
		ReadTimeout:       100 * time.Millisecond,
		WriteTimeout:      200 * time.Millisecond,
		IdleTimeout:       100 * time.Millisecond,
	})
	defer closeServer()

	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, "POST /client/v1/spins HTTP/1.1\r\nHost: example.test\r\nX-Slow:"); err != nil {
		t.Fatal(err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1)
	_, readErr := connection.Read(buffer)
	if timeout, ok := readErr.(net.Error); ok && timeout.Timeout() {
		t.Fatal("慢请求头连接没有在 ReadHeaderTimeout 内关闭")
	}
	if handlerCalls.Load() != 0 {
		t.Fatalf("慢请求头进入了业务 handler：calls=%d", handlerCalls.Load())
	}
}

func TestDDoSTransportRejectsOversizedHeadersBeforeHandler(t *testing.T) {
	var handlerCalls atomic.Int64
	address, closeServer := startDDoSTransportServer(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		handlerCalls.Add(1)
	}), platform.Config{
		ReadHeaderTimeout: time.Second,
		ReadTimeout:       2 * time.Second,
		WriteTimeout:      3 * time.Second,
		IdleTimeout:       time.Second,
	})
	defer closeServer()

	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	request := "POST /client/v1/spins HTTP/1.1\r\nHost: example.test\r\nX-Oversized: " + strings.Repeat("a", 64<<10) + "\r\n\r\n"
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatal(err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	statusLine, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil {
		t.Fatalf("读取超大请求头响应：%v", err)
	}
	if !strings.Contains(statusLine, " 431 ") {
		t.Fatalf("超大请求头状态行 = %q，期望 431", statusLine)
	}
	if handlerCalls.Load() != 0 {
		t.Fatalf("超大请求头进入了业务 handler：calls=%d", handlerCalls.Load())
	}
}

func TestDDoSTransportBoundsSlowRequestBody(t *testing.T) {
	bodyRead := make(chan error, 1)
	address, closeServer := startDDoSTransportServer(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, err := io.Copy(io.Discard, request.Body)
		bodyRead <- err
		writer.WriteHeader(http.StatusNoContent)
	}), platform.Config{
		ReadHeaderTimeout: 30 * time.Millisecond,
		ReadTimeout:       80 * time.Millisecond,
		WriteTimeout:      200 * time.Millisecond,
		IdleTimeout:       100 * time.Millisecond,
	})
	defer closeServer()

	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection,
		"POST /client/v1/spins HTTP/1.1\r\nHost: example.test\r\nContent-Length: 64\r\nContent-Type: application/json\r\n\r\n{"); err != nil {
		t.Fatal(err)
	}
	select {
	case readErr := <-bodyRead:
		if readErr == nil {
			t.Fatal("未完成的慢请求正文没有触发读取超时")
		}
	case <-time.After(time.Second):
		t.Fatal("慢请求正文超过 ReadTimeout 后仍占用 handler")
	}
}

func startDDoSTransportServer(
	t *testing.T,
	handler http.Handler,
	config platform.Config,
) (string, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := newHTTPServer(listener.Addr().String(), handler, config)
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	return listener.Addr().String(), func() {
		_ = server.Close()
		select {
		case <-serveDone:
		case <-time.After(time.Second):
			t.Error("HTTP server did not stop")
		}
	}
}

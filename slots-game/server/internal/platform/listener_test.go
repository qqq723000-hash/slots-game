package platform

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestLimitListenerBlocksUnderlyingAcceptUntilConnectionCloses(t *testing.T) {
	underlying := newScriptedListener()
	listener, err := LimitListener(underlying, 1)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	firstServer, firstClient := net.Pipe()
	t.Cleanup(func() { _ = firstClient.Close() })
	underlying.connections <- firstServer
	first, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}

	accepted := make(chan net.Conn, 1)
	errorsSeen := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			errorsSeen <- acceptErr
			return
		}
		accepted <- connection
	}()
	time.Sleep(20 * time.Millisecond)
	if calls := underlying.acceptCalls.Load(); calls != 1 {
		t.Fatalf("underlying Accept calls while full = %d, want 1", calls)
	}

	secondServer, secondClient := net.Pipe()
	t.Cleanup(func() { _ = secondClient.Close() })
	underlying.connections <- secondServer
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	select {
	case second := <-accepted:
		if calls := underlying.acceptCalls.Load(); calls != 2 {
			t.Fatalf("underlying Accept calls after release = %d, want 2", calls)
		}
		if err := second.Close(); err != nil {
			t.Fatal(err)
		}
	case err := <-errorsSeen:
		t.Fatalf("second Accept returned error: %v", err)
	case <-time.After(time.Second):
		t.Fatal("second Accept did not resume after the first connection closed")
	}
}

func TestLimitListenerRejectsInvalidConfiguration(t *testing.T) {
	if _, err := LimitListener(nil, 1); err == nil {
		t.Fatal("nil listener unexpectedly accepted")
	}
	listener := newScriptedListener()
	defer listener.Close()
	if _, err := LimitListener(listener, 0); err == nil {
		t.Fatal("zero connection limit unexpectedly accepted")
	}
}

func TestLimitListenerCloseUnblocksAcceptWaitingForCapacity(t *testing.T) {
	underlying := newScriptedListener()
	listener, err := LimitListener(underlying, 1)
	if err != nil {
		t.Fatal(err)
	}
	firstServer, firstClient := net.Pipe()
	defer firstClient.Close()
	underlying.connections <- firstServer
	first, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()

	errorsSeen := make(chan error, 1)
	go func() {
		_, acceptErr := listener.Accept()
		errorsSeen <- acceptErr
	}()
	time.Sleep(20 * time.Millisecond)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case acceptErr := <-errorsSeen:
		if !errors.Is(acceptErr, net.ErrClosed) {
			t.Fatalf("blocked Accept error = %v, want net.ErrClosed", acceptErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not unblock Accept waiting for connection capacity")
	}
}

func TestLimitListenerLetsHTTPShutdownHonorDeadlineWhenCapacityIsFull(t *testing.T) {
	underlying, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := LimitListener(underlying, 1)
	if err != nil {
		t.Fatal(err)
	}
	connectionStarted := make(chan struct{}, 1)
	server := &http.Server{
		Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}),
		ConnState: func(_ net.Conn, state http.ConnState) {
			if state == http.StateNew {
				select {
				case connectionStarted <- struct{}{}:
				default:
				}
			}
		},
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	client, err := net.Dial("tcp", underlying.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	select {
	case <-connectionStarted:
	case <-time.After(time.Second):
		t.Fatal("server did not accept the first connection")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	started := time.Now()
	shutdownErr := server.Shutdown(ctx)
	if !errors.Is(shutdownErr, context.DeadlineExceeded) {
		t.Fatalf("Shutdown error = %v, want deadline exceeded for open connection", shutdownErr)
	}
	if elapsed := time.Since(started); elapsed > 300*time.Millisecond {
		t.Fatalf("Shutdown ignored its deadline while Accept waited for capacity: %s", elapsed)
	}
	_ = server.Close()
	select {
	case serveErr := <-serveDone:
		if !errors.Is(serveErr, http.ErrServerClosed) {
			t.Fatalf("Serve error = %v, want http.ErrServerClosed", serveErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve did not exit after listener shutdown")
	}
}

type scriptedListener struct {
	connections chan net.Conn
	closed      chan struct{}
	closeOnce   sync.Once
	acceptCalls atomic.Int64
}

func newScriptedListener() *scriptedListener {
	return &scriptedListener{
		connections: make(chan net.Conn, 2),
		closed:      make(chan struct{}),
	}
}

func (listener *scriptedListener) Accept() (net.Conn, error) {
	listener.acceptCalls.Add(1)
	select {
	case connection := <-listener.connections:
		return connection, nil
	case <-listener.closed:
		return nil, net.ErrClosed
	}
}

func (listener *scriptedListener) Close() error {
	listener.closeOnce.Do(func() { close(listener.closed) })
	return nil
}

func (*scriptedListener) Addr() net.Addr { return scriptedAddress("scripted") }

type scriptedAddress string

func (address scriptedAddress) Network() string { return "test" }
func (address scriptedAddress) String() string  { return string(address) }

var _ net.Listener = (*scriptedListener)(nil)

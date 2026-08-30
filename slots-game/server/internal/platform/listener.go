package platform

import (
	"errors"
	"net"
	"sync"
)

// LimitListener 给一个监听器设置进程内已接受连接硬上限。它在调用底层 Accept
// 之前取得名额，因此慢请求头、未读请求正文、TLS 握手和空闲长连接都受同一
// 文件描述符预算约束；连接关闭时只释放一次，避免重复调用 Close 扩大容量。
// English: LimitListener sets an in-process hard limit for accepted connections for a listener. It obtains the
// quota before calling the underlying Accept, so slow request headers, unread request bodies, TLS handshakes and
// idle long connections are all subject to the same file descriptor budget; it is only released once when the
// connection is closed to avoid repeated calls to Close to expand capacity.
func LimitListener(listener net.Listener, maximum int) (net.Listener, error) {
	if listener == nil {
		return nil, errors.New("listener is required")
	}
	if maximum < 1 {
		return nil, errors.New("listener connection limit must be positive")
	}
	return &limitedListener{
		Listener:  listener,
		semaphore: make(chan struct{}, maximum),
		done:      make(chan struct{}),
	}, nil
}

type limitedListener struct {
	net.Listener
	semaphore chan struct{}
	done      chan struct{}
	closeOnce sync.Once
	closeErr  error
}

func (listener *limitedListener) Accept() (net.Conn, error) {
	select {
	case listener.semaphore <- struct{}{}:
	case <-listener.done:
		return nil, net.ErrClosed
	}
	connection, err := listener.Listener.Accept()
	if err != nil {
		<-listener.semaphore
		return nil, err
	}
	return &limitedConnection{
		Conn: connection,
		release: func() {
			<-listener.semaphore
		},
	}, nil
}

// Close 必须同时唤醒尚未进入底层 Accept、正等待容量名额的协程；否则
// http.Server.Shutdown 会先等待 Serve 及 Accept 退出，连关闭上下文都无法生效。
// English: Close must also wake up the coroutine that has not yet entered the underlying Accept and is waiting for
// capacity quota; otherwise http.Server.Shutdown will first wait for Serve and Accept to exit, and even closing
// the context will not take effect.
func (listener *limitedListener) Close() error {
	listener.closeOnce.Do(func() {
		close(listener.done)
		listener.closeErr = listener.Listener.Close()
	})
	return listener.closeErr
}

type limitedConnection struct {
	net.Conn
	release     func()
	releaseOnce sync.Once
}

func (connection *limitedConnection) Close() error {
	err := connection.Conn.Close()
	connection.releaseOnce.Do(connection.release)
	return err
}

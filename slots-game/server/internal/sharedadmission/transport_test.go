package sharedadmission

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	valkey "github.com/valkey-io/valkey-go"
)

// TestBoundedValkeyTransportReturnsAfterBlackholeSaturation 刻意使用真实 TCP 故障，
// 而不是 scriptExecutor fake。valkey-go v1.0.67 的自动管线环有 1024 个槽位，
// 饱和后的 PutOne 路径不响应 context；因此向完成握手但永不回复的 peer 同时发送
// 超过 1024 条命令，可精确阻断会卡住 PostgreSQL 会话事务的生产故障。
// English: TestBoundedValkeyTransportReturnsAfterBlackholeSaturation intentionally uses real TCP faults instead of
// scriptExecutor fakes. The automatic pipeline ring of valkey-go v1.0.67 has 1024 slots, and the saturated PutOne
// path does not respond to the context; therefore, more than 1024 commands are simultaneously sent to the peer
// that completes the handshake but never replies, which can accurately block production failures that will block
// PostgreSQL session transactions.
func TestBoundedValkeyTransportReturnsAfterBlackholeSaturation(t *testing.T) {
	baselineGoroutines := runtime.NumGoroutine()
	peer := newBlackholeValkeyPeer(t)
	options := boundedValkeyClientOptions(250 * time.Millisecond)
	options.InitAddress = []string{peer.address()}
	client, err := valkey.NewClient(options)
	if err != nil {
		peer.close()
		t.Fatalf("construct blackhole Valkey client: %v", err)
	}

	const requests = 1_100 // deliberately exceeds valkey-go's default 2^10 ring
	start := make(chan struct{})
	var ready sync.WaitGroup
	var complete sync.WaitGroup
	var deadline time.Time
	var deadlineErrors atomic.Int64
	ready.Add(requests)
	complete.Add(requests)
	executor := newValkeyExecutor(client)
	for range requests {
		go func() {
			defer complete.Done()
			ready.Done()
			<-start
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			defer cancel()
			_, evaluateErr := executor.EvaluateEconomic(ctx,
				[]string{
					"rgs:shared-admission:v2:{rgs-economic:test}:operator:test",
					"rgs:shared-admission:v2:{rgs-economic:test}:backend",
				},
				[]string{"1000", "1000", "1000", "1000", "1", "1000"},
			)
			if errors.Is(evaluateErr, context.DeadlineExceeded) {
				deadlineErrors.Add(1)
			}
		}()
	}
	ready.Wait()
	started := time.Now()
	deadline = started.Add(250 * time.Millisecond)
	close(start)
	done := make(chan struct{})
	go func() {
		complete.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		client.Close()
		peer.close()
		t.Fatal("blackhole commands remained blocked after their shared deadline")
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("blackhole saturation returned in %s, want <= deadline + 250ms", elapsed)
	}
	if got := deadlineErrors.Load(); got != requests {
		t.Fatalf("deadline errors = %d, want %d", got, requests)
	}
	if hits := peer.blackholedCommands.Load(); hits != synchronousValkeyPoolSize {
		t.Fatalf("blackholed in-flight commands = %d, want %d", hits, synchronousValkeyPoolSize)
	}
	if maximum := peer.maximumConnections.Load(); maximum != maximumValkeyConnectionsPerPod {
		t.Fatalf("maximum simultaneous TCP connections = %d, want %d", maximum, maximumValkeyConnectionsPerPod)
	}

	// 四条故障 socket 必须被丢弃并归还池许可，随后新命令必须能建立新连接。
	// English: The four failed sockets must be discarded and the pool permission returned, and new commands must
	// subsequently establish new connections.
	peer.blackhole.Store(false)
	recoveryCtx, recoveryCancel := context.WithTimeout(context.Background(), time.Second)
	defer recoveryCancel()
	if err := client.Do(recoveryCtx, client.B().Ping().Build()).Error(); err != nil {
		client.Close()
		peer.close()
		t.Fatalf("bounded pool did not recover after blackhole deadlines: %v", err)
	}
	client.Close()
	peer.close()

	// 完成后，应用许可等待者和四个依赖/socket 操作必须全部消失，不能为每个请求遗留 goroutine。
	// English: Once complete, the application permission waiter and four dependencies/socket operations must all be
	// gone, no goroutine is left behind for each request.
	limit := baselineGoroutines + 24
	for until := time.Now().Add(2 * time.Second); runtime.NumGoroutine() > limit && time.Now().Before(until); {
		runtime.GC()
		time.Sleep(10 * time.Millisecond)
	}
	if got := runtime.NumGoroutine(); got > limit {
		t.Fatalf("goroutines after blackhole cleanup = %d, baseline=%d limit=%d", got, baselineGoroutines, limit)
	}
}

func TestLimiterStartupCanaryUsesDirectEvalThenCachedEvalSHAOnWire(t *testing.T) {
	peer := newBlackholeValkeyPeer(t)
	peer.blackhole.Store(false)
	defer peer.close()
	options := boundedValkeyClientOptions(250 * time.Millisecond)
	options.InitAddress = []string{peer.address()}
	client, err := valkey.NewClient(options)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := newLimiter(newValkeyExecutor(client), Config{
		Timeout: 250 * time.Millisecond, Rate: 10, Burst: 10,
	}, []byte("01234567890123456789012345678901"), nil)
	if err != nil {
		client.Close()
		t.Fatal(err)
	}
	defer limiter.Close()

	if err := limiter.Check(context.Background()); err != nil {
		t.Fatalf("startup canary: %v", err)
	}
	commands := peer.scriptCommands()
	if len(commands) != 2 || len(commands[0]) != 6 || len(commands[1]) != 6 {
		t.Fatalf("startup script wire commands = %#v", commands)
	}
	if commands[0][0] != "EVAL" || commands[0][1] != tokenBucketScriptBody || commands[0][2] != "1" ||
		commands[1][0] != "EVALSHA" || commands[1][1] != tokenBucketScriptSHA1 || commands[1][2] != "1" {
		t.Fatalf("startup script command contract = %#v", commands)
	}
	if commands[0][3] != commands[1][3] ||
		!strings.HasPrefix(commands[0][3], keyPrefix+"startup-canary:") ||
		commands[0][4] != strconv.FormatInt(basicCanaryCapacityMilli, 10) ||
		commands[0][5] != strconv.FormatInt(basicCanaryRateMilliPerSecond, 10) ||
		commands[0][4] != commands[1][4] || commands[0][5] != commands[1][5] {
		t.Fatalf("startup script key/arguments drifted = %#v", commands)
	}
}

func TestDirectStartupEvalDoesNotRegressConcurrentNoScriptReload(t *testing.T) {
	peer := newBlackholeValkeyPeer(t)
	peer.blackhole.Store(false)
	defer peer.close()
	options := boundedValkeyClientOptions(500 * time.Millisecond)
	options.InitAddress = []string{peer.address()}
	client, err := valkey.NewClient(options)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	executor := newValkeyExecutor(client)
	arguments := []string{"2000", "2000000"}
	if result, directErr := executor.EvaluateDirect(
		context.Background(), keyPrefix+"startup-canary:concurrency}", arguments,
	); directErr != nil || len(result) != 2 || result[0] != 1 || result[1] != 0 {
		t.Fatalf("direct startup EVAL = %v, %v", result, directErr)
	}
	peer.evictScript()

	const workers = 32
	start := make(chan struct{})
	errorsSeen := make(chan error, workers)
	var ready sync.WaitGroup
	var complete sync.WaitGroup
	ready.Add(workers)
	complete.Add(workers)
	for index := range workers {
		go func() {
			defer complete.Done()
			ready.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			result, evaluateErr := executor.Evaluate(
				ctx, fmt.Sprintf("%sconcurrent:%d}", keyPrefix, index), arguments,
			)
			if evaluateErr != nil || len(result) != 2 || result[0] != 1 || result[1] != 0 {
				errorsSeen <- fmt.Errorf("result=%v error=%w", result, evaluateErr)
			}
		}()
	}
	ready.Wait()
	close(start)
	complete.Wait()
	close(errorsSeen)
	for evaluateErr := range errorsSeen {
		t.Error(evaluateErr)
	}

	evalCalls := 0
	evalSHACalls := 0
	for _, command := range peer.scriptCommands() {
		switch command[0] {
		case "EVAL":
			evalCalls++
		case "EVALSHA":
			evalSHACalls++
		}
	}
	if evalCalls != 2 || evalSHACalls < workers || executor.noScriptMisses.Load() == 0 {
		t.Fatalf("direct/reload EVAL=%d EVALSHA=%d NOSCRIPT=%d, want 2/>=%d/>0",
			evalCalls, evalSHACalls, executor.noScriptMisses.Load(), workers)
	}
}

type blackholeValkeyPeer struct {
	listener             net.Listener
	blackhole            atomic.Bool
	blackholedCommands   atomic.Int64
	activeConnections    atomic.Int64
	maximumConnections   atomic.Int64
	scriptLoaded         atomic.Bool
	connectionsMu        sync.Mutex
	connections          map[net.Conn]struct{}
	commandsMu           sync.Mutex
	commands             [][]string
	connectionGoroutines sync.WaitGroup
	closeOnce            sync.Once
}

func newBlackholeValkeyPeer(t *testing.T) *blackholeValkeyPeer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	peer := &blackholeValkeyPeer{listener: listener, connections: make(map[net.Conn]struct{})}
	peer.blackhole.Store(true)
	peer.connectionGoroutines.Add(1)
	go peer.accept()
	return peer
}

func (peer *blackholeValkeyPeer) address() string { return peer.listener.Addr().String() }

func (peer *blackholeValkeyPeer) accept() {
	defer peer.connectionGoroutines.Done()
	for {
		connection, err := peer.listener.Accept()
		if err != nil {
			return
		}
		peer.connectionsMu.Lock()
		peer.connections[connection] = struct{}{}
		peer.connectionsMu.Unlock()
		active := peer.activeConnections.Add(1)
		for maximum := peer.maximumConnections.Load(); active > maximum; maximum = peer.maximumConnections.Load() {
			if peer.maximumConnections.CompareAndSwap(maximum, active) {
				break
			}
		}
		peer.connectionGoroutines.Add(1)
		go peer.serve(connection)
	}
}

func (peer *blackholeValkeyPeer) serve(connection net.Conn) {
	defer peer.connectionGoroutines.Done()
	defer func() {
		peer.connectionsMu.Lock()
		delete(peer.connections, connection)
		peer.connectionsMu.Unlock()
		peer.activeConnections.Add(-1)
		_ = connection.Close()
	}()
	reader := bufio.NewReader(connection)
	for {
		command, err := readRESPCommand(reader)
		if err != nil {
			return
		}
		peer.recordCommand(command)
		switch strings.ToUpper(command[0]) {
		case "HELLO":
			_, err = io.WriteString(connection, "%2\r\n+version\r\n+7.2.0\r\n+proto\r\n:3\r\n")
		case "CLIENT":
			// 较旧 Valkey 版本会合理拒绝可选的 CLIENT SETINFO。
			// English: Older Valkey versions would reasonably reject the optional CLIENT SETINFO.
			_, err = io.WriteString(connection, "-ERR unknown command 'CLIENT SETINFO'\r\n")
		case "PING":
			if peer.blackhole.Load() {
				peer.blackholedCommands.Add(1)
				_, _ = io.Copy(io.Discard, reader)
				return
			}
			_, err = io.WriteString(connection, "+PONG\r\n")
		case "EVAL":
			if peer.blackhole.Load() {
				peer.blackholedCommands.Add(1)
				_, _ = io.Copy(io.Discard, reader)
				return
			}
			peer.scriptLoaded.Store(true)
			_, err = io.WriteString(connection, "*2\r\n:1\r\n:0\r\n")
		case "EVALSHA":
			if peer.blackhole.Load() {
				peer.blackholedCommands.Add(1)
				_, _ = io.Copy(io.Discard, reader)
				return
			}
			if !peer.scriptLoaded.Load() {
				_, err = io.WriteString(connection, "-NOSCRIPT No matching script. Please use EVAL.\r\n")
			} else {
				_, err = io.WriteString(connection, "*2\r\n:1\r\n:0\r\n")
			}
		default:
			_, err = fmt.Fprintf(connection, "-ERR unexpected command %s\r\n", command[0])
		}
		if err != nil {
			return
		}
	}
}

func (peer *blackholeValkeyPeer) recordCommand(command []string) {
	peer.commandsMu.Lock()
	peer.commands = append(peer.commands, append([]string(nil), command...))
	peer.commandsMu.Unlock()
}

func (peer *blackholeValkeyPeer) scriptCommands() [][]string {
	peer.commandsMu.Lock()
	defer peer.commandsMu.Unlock()
	commands := make([][]string, 0, len(peer.commands))
	for _, command := range peer.commands {
		if len(command) != 0 && (strings.EqualFold(command[0], "EVAL") || strings.EqualFold(command[0], "EVALSHA")) {
			commands = append(commands, append([]string(nil), command...))
		}
	}
	return commands
}

func (peer *blackholeValkeyPeer) evictScript() { peer.scriptLoaded.Store(false) }

func (peer *blackholeValkeyPeer) close() {
	peer.closeOnce.Do(func() {
		_ = peer.listener.Close()
		peer.connectionsMu.Lock()
		for connection := range peer.connections {
			_ = connection.Close()
		}
		peer.connectionsMu.Unlock()
		peer.connectionGoroutines.Wait()
	})
}

func readRESPCommand(reader *bufio.Reader) ([]string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if len(line) < 4 || line[0] != '*' {
		return nil, fmt.Errorf("invalid RESP array header %q", line)
	}
	count, err := strconv.Atoi(strings.TrimSpace(line[1:]))
	if err != nil || count < 1 {
		return nil, fmt.Errorf("invalid RESP array length %q", line)
	}
	command := make([]string, count)
	for index := range command {
		lengthLine, readErr := reader.ReadString('\n')
		if readErr != nil {
			return nil, readErr
		}
		if len(lengthLine) < 4 || lengthLine[0] != '$' {
			return nil, fmt.Errorf("invalid RESP bulk header %q", lengthLine)
		}
		length, parseErr := strconv.Atoi(strings.TrimSpace(lengthLine[1:]))
		if parseErr != nil || length < 0 {
			return nil, fmt.Errorf("invalid RESP bulk length %q", lengthLine)
		}
		payload := make([]byte, length+2)
		if _, readErr = io.ReadFull(reader, payload); readErr != nil {
			return nil, readErr
		}
		if payload[length] != '\r' || payload[length+1] != '\n' {
			return nil, errors.New("invalid RESP bulk terminator")
		}
		command[index] = string(payload[:length])
	}
	return command, nil
}

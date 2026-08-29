package platform

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"sync/atomic"
	"time"
)

type DependencyCheck interface {
	Name() string
	Check(context.Context) error
}

type Readiness struct {
	Checks  []DependencyCheck
	Timeout time.Duration
}

// LifecycleReadiness 表示当前副本是否仍可接收新流量。BeginDrain 一旦调用便不可逆，
// 从而保证终止期间的后续探针不会把正在排空的副本重新加入负载均衡。
// English: LifecycleReadiness indicates whether the current replica can still receive new traffic. BeginDrain is
// irreversible once called, ensuring that subsequent probes during termination will not rejoin the draining
// replica to the load balancer.
type LifecycleReadiness struct {
	draining atomic.Bool
}

func (*LifecycleReadiness) Name() string { return "lifecycle" }

func (lifecycle *LifecycleReadiness) Check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if lifecycle == nil || lifecycle.draining.Load() {
		return errors.New("runtime lifecycle is draining")
	}
	return nil
}

func (lifecycle *LifecycleReadiness) BeginDrain() {
	if lifecycle != nil {
		lifecycle.draining.Store(true)
	}
}

func LivenessHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if rejectUnexpectedBody(w, r) {
		return
	}
	writeHealthJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (ready Readiness) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if rejectUnexpectedBody(w, r) {
		return
	}
	timeout := ready.boundedTimeout()
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	type status struct {
		Name string `json:"name"`
		OK   bool   `json:"ok"`
	}
	statuses := make([]status, 0, len(ready.Checks))
	allReady := true
	for _, check := range ready.Checks {
		if check == nil {
			allReady = false
			statuses = append(statuses, status{Name: "invalid", OK: false})
			continue
		}
		err := check.Check(ctx)
		statuses = append(statuses, status{Name: check.Name(), OK: err == nil})
		allReady = allReady && err == nil
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].Name < statuses[j].Name })
	code, state := http.StatusOK, "ready"
	if !allReady {
		code, state = http.StatusServiceUnavailable, "not_ready"
	}
	writeHealthJSON(w, code, map[string]any{"status": state, "checks": statuses})
}

// rejectUnexpectedBody 让只读运维端点拒绝任何声明或分块传输的正文。响应完成后
// 立即让该连接的读取失效，避免 net/http 为复用连接而等待攻击者迟迟不发送的正文；
// Connection: close 同时禁止把异常连接放回长连接池。
// English: rejectUnexpectedBody causes the read-only operations endpoint to reject the body of any claim or
// chunked transfer. After the response is completed, immediately invalidate the reading of the connection to
// prevent net/http from waiting for the attacker's delayed text in order to reuse the connection; Connection:
// close also prohibits returning the abnormal connection to the long connection pool.
func rejectUnexpectedBody(w http.ResponseWriter, r *http.Request) bool {
	if r == nil || (r.ContentLength == 0 && len(r.TransferEncoding) == 0) {
		return false
	}
	w.Header().Set("Connection", "close")
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "request body is not allowed", http.StatusBadRequest)
	_ = http.NewResponseController(w).SetReadDeadline(time.Now())
	return true
}

// IsReady 为指标抓取复用与 /readyz 完全相同的依赖集合和总超时预算。
// 它只返回一个布尔值，不暴露检查名称或内部错误，避免监控面泄漏运行细节。
// English: IsReady reuses the exact same set of dependencies and total timeout budget as /readyz for metric
// scraping. It only returns a Boolean value and does not expose the check name or internal errors, preventing the
// monitoring surface from leaking running details.
func (ready Readiness) IsReady(parent context.Context) bool {
	ctx, cancel := context.WithTimeout(parent, ready.boundedTimeout())
	defer cancel()
	for _, check := range ready.Checks {
		if check == nil || check.Check(ctx) != nil || ctx.Err() != nil {
			return false
		}
	}
	return ctx.Err() == nil
}

func (ready Readiness) boundedTimeout() time.Duration {
	timeout := ready.Timeout
	if timeout <= 0 || timeout > 10*time.Second {
		return 2 * time.Second
	}
	return timeout
}

func writeHealthJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

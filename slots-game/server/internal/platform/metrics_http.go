package platform

import (
	"fmt"
	"net/http"
)

// MetricsEndpoint 在每次抓取时计算同一组运行时就绪检查。rgs_ready 表示服务能否
// 接收业务流量，而抓取本身始终返回 200，让 Prometheus 的 up 只表示传输可达性。
// 指标无标签且不包含依赖名称或错误文本，避免泄漏内部拓扑与扩大时序基数。
type MetricsEndpoint struct {
	Metrics   *Metrics
	Readiness Readiness
}

func (endpoint MetricsEndpoint) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", http.MethodGet)
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if rejectUnexpectedBody(writer, request) {
		return
	}
	ready := endpoint.Readiness.IsReady(request.Context())
	writeMetricsResponse(writer, endpoint.Metrics, &ready)
}

func (m *Metrics) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", http.MethodGet)
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if rejectUnexpectedBody(writer, request) {
		return
	}
	writeMetricsResponse(writer, m, nil)
}

func writeMetricsResponse(writer http.ResponseWriter, metrics *Metrics, ready *bool) {
	writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	if err := metrics.WritePrometheus(writer); err != nil {
		return
	}
	if ready == nil {
		return
	}
	value := 0
	if *ready {
		value = 1
	}
	_, _ = fmt.Fprintf(
		writer,
		"# HELP rgs_ready Whether all runtime readiness checks passed during this scrape.\n"+
			"# TYPE rgs_ready gauge\n"+
			"rgs_ready %d\n",
		value,
	)
}

package platform

import (
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type Middleware struct {
	Logger          *slog.Logger
	Metrics         *Metrics
	Limiter         *Limiter
	MaxRequestBytes int64
	AllowedOrigins  map[string]struct{}
}

func (m Middleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		requestID := safeRequestID(r.Header.Get("X-Request-Id"))
		if requestID == "" {
			requestID = randomRequestID()
		}
		w.Header().Set("X-Request-Id", requestID)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Cache-Control", "no-store")
		m.applyCORS(w, r)
		if r.Method == http.MethodOptions {
			closeUnreadBody(r)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if m.Metrics != nil {
			m.Metrics.HTTPRequests.Add(1)
		}
		// 预认证阶段没有可信网络或租户身份。只使用一个固定进程桶：RemoteAddr 在
		// ALB 后代表代理节点，X-Forwarded-For 可伪造，二者都会制造错误共享或键轮换。
		if m.Limiter != nil && !m.Limiter.Allow("public-preauth", started) {
			closeUnreadBody(r)
			if m.Metrics != nil {
				m.Metrics.PreAuthCapacityRejected.Add(1)
				m.Metrics.HTTPFailures.Add(1)
				m.Metrics.HTTPServerFailures.Add(1)
			}
			w.Header().Set("Retry-After", "1")
			writeMiddlewareError(w, requestID, http.StatusServiceUnavailable, "CAPACITY_UNAVAILABLE", "service capacity is temporarily unavailable")
			return
		}
		if m.MaxRequestBytes > 0 && r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, m.MaxRequestBytes)
		}
		// Middleware 可被 rgs-server 以外的入口复用；日志只保留安全的 request_id 字段、
		// 固定方法类别和耗时，绝不记录攻击者可控的原始路径、查询串或网络地址。
		logMethod := normalizedLogMethod(r.Method)
		defer func() {
			durationMilliseconds := time.Since(started).Milliseconds()
			if recovered := recover(); recovered != nil {
				if m.Metrics != nil {
					m.Metrics.HTTPFailures.Add(1)
					m.Metrics.HTTPServerFailures.Add(1)
				}
				if m.Logger != nil {
					m.Logger.Error("http panic recovered", "request_id", requestID, "method", logMethod, "duration_ms", durationMilliseconds)
				}
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
			if m.Logger != nil {
				m.Logger.Info("http request", "request_id", requestID, "method", logMethod, "duration_ms", durationMilliseconds)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func closeUnreadBody(request *http.Request) {
	if request != nil && request.Body != nil && request.Body != http.NoBody {
		// 在限流/预检短路前正文尚未读取。HTTP/1 失败响应必须关闭该连接，避免
		// net/http 为复用而替攻击者继续排空正文；HTTP/2 会在流级停止传输。
		request.Close = true
	}
}

func writeMiddlewareError(writer http.ResponseWriter, requestID string, status int, code, message string) {
	payload := struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		RequestID string `json:"requestId"`
	}{RequestID: requestID}
	payload.Error.Code = code
	payload.Error.Message = message
	encoded, err := json.Marshal(payload)
	if err != nil {
		encoded = []byte(`{"error":{"code":"INTERNAL_ERROR","message":"internal server error"},"requestId":"unavailable"}`)
		status = http.StatusInternalServerError
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_, _ = writer.Write(append(encoded, '\n'))
}

func (m Middleware) applyCORS(w http.ResponseWriter, r *http.Request) {
	ApplyCORSHeaders(w, r, m.AllowedOrigins)
}

// ApplyCORSHeaders 统一公开 API 与最外层容量闸门的浏览器响应策略。调用方只能传
// 启动时已校验的精确来源白名单，绝不能回显任意 Origin 或开启凭据共享。
func ApplyCORSHeaders(w http.ResponseWriter, r *http.Request, allowedOrigins map[string]struct{}) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	if _, allowed := allowedOrigins[origin]; !allowed {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Expose-Headers", "Retry-After")
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Content-Digest, Idempotency-Key, X-Operator-Id, X-Request-Id, X-Nonce, Signature, Signature-Input")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
}

func safeRequestID(value string) string {
	if len(value) < 1 || len(value) > 128 {
		return ""
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && !strings.ContainsRune("._:-", character) {
			return ""
		}
	}
	return value
}

func normalizedLogMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

func randomRequestID() string {
	var raw [16]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "unavailable"
	}
	return "req_" + hex.EncodeToString(raw[:])
}

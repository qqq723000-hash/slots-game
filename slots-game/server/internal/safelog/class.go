// Package safelog 将任意错误链转换为固定、低基数的安全分类，供长期生产日志使用。
package safelog

import (
	"context"
	"errors"
	"net"
)

const (
	ClassNone             = "none"
	ClassCanceled         = "canceled"
	ClassDeadlineExceeded = "deadline_exceeded"
	ClassDatabase         = "database"
	ClassNetworkTimeout   = "network_timeout"
	ClassNetwork          = "network"
	ClassInternal         = "internal"
)

type sqlStateError interface {
	SQLState() string
}

// ErrorClass 绝不返回 err.Error()。数据库诊断可能包含 SQL、绑定值或拓扑，网络错误
// 可能包含 URL、代理地址或证书名，联合领域错误可能包含租户或轮次标识。调用方应单独
// 记录固定操作名；完整细节只能进入具备明确脱敏契约和访问控制的追踪或事件工具。
func ErrorClass(err error) string {
	if err == nil {
		return ClassNone
	}
	if errors.Is(err, context.Canceled) {
		return ClassCanceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ClassDeadlineExceeded
	}
	var databaseError sqlStateError
	if errors.As(err, &databaseError) {
		return ClassDatabase
	}
	var networkError net.Error
	if errors.As(err, &networkError) {
		if networkError.Timeout() {
			return ClassNetworkTimeout
		}
		return ClassNetwork
	}
	return ClassInternal
}

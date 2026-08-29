package launch

import "errors"

var (
	// ErrInvalidInput 表示启动数据未通过固定协议校验。
	// English: ErrInvalidInput indicates that the startup data does not pass the fixed protocol verification.
	ErrInvalidInput = errors.New("launch: invalid input")
	// ErrCodeUnavailable 刻意统一表示未知、过期、已消费或绑定不匹配的启动码，
	// 防止调用方暴露凭据判定接口。
	// English: ErrCodeUnavailable deliberately and uniformly represents unknown, expired, consumed or unmatched
	// binding activation codes to prevent the caller from exposing the credential determination interface.
	ErrCodeUnavailable = errors.New("launch: code unavailable")
	// ErrDigestExists 表示 Store.Create 发现生成的摘要已被占用。Service 会使用新的
	// 密码学熵重试。
	// English: ErrDigestExists indicates that Store.Create found that the digest generated was already occupied. The
	// Service will try again with new cryptographic entropy.
	ErrDigestExists = errors.New("launch: code digest already exists")
	// ErrEntropy 表示安全启动码生成失败。
	// English: ErrEntropy indicates that secure boot code generation failed.
	ErrEntropy = errors.New("launch: secure entropy unavailable")
	// ErrStoreInvariant 表示 Store 返回了与原子消费请求不匹配的记录。此时服务失效即关闭。
	// English: ErrStoreInvariant indicates that the Store returned records that do not match the atomic consumption
	// request. At this time, the service fails and is shut down.
	ErrStoreInvariant = errors.New("launch: store invariant violated")
)

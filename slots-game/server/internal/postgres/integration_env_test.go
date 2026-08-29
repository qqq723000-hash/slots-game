package postgres

import (
	"os"
	"strings"
	"testing"
)

type postgresTestURLs struct {
	runtime  string
	migrator string
}

// requirePostgresTestURLs 保持普通开发测试套件可选，同时要求发布一致性路径只有在两套
// 隔离凭据均可用时才能运行，否则失效即关闭。
// English: requirePostgresTestURLs keeps the normal development test suite optional, while requiring that the
// release consistency path can only be run when both sets of isolation credentials are available, otherwise it
// will be shut down if it fails.
func requirePostgresTestURLs(t *testing.T) postgresTestURLs {
	t.Helper()

	urls := postgresTestURLs{
		runtime:  strings.TrimSpace(os.Getenv("RGS_POSTGRES_TEST_URL")),
		migrator: strings.TrimSpace(os.Getenv("RGS_POSTGRES_MIGRATOR_TEST_URL")),
	}
	if urls.runtime != "" && urls.migrator != "" {
		return urls
	}
	if os.Getenv("RGS_REQUIRE_POSTGRES_TESTS") == "1" {
		t.Fatal("RGS_POSTGRES_TEST_URL and RGS_POSTGRES_MIGRATOR_TEST_URL are required when RGS_REQUIRE_POSTGRES_TESTS=1")
	}

	t.Skip("isolated PostgreSQL runtime and migrator test URLs are not configured")
	return postgresTestURLs{}
}

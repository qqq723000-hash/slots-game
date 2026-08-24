package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

const migrationAdvisoryLock int64 = 8_704_761_337_153

const migratorRoleCheckSQL = `
SELECT COALESCE((
    SELECT NOT rolsuper
       AND NOT rolcreatedb
       AND NOT rolcreaterole
       AND NOT rolreplication
       AND NOT rolbypassrls
       AND rolname = 'rgs_migrator'
       AND NOT rolinherit
       AND NOT EXISTS (
           SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid
       )
       AND NOT has_database_privilege(rolname, current_database(), 'CREATE')
       AND NOT has_database_privilege(rolname, current_database(), 'TEMPORARY')
       AND has_schema_privilege(rolname, 'public', 'USAGE')
       AND has_schema_privilege(rolname, 'public', 'CREATE')
    FROM pg_roles
    WHERE rolname = current_user
), false) AS policy_ok`

type migration struct {
	version  string
	contents string
	checksum string
}

type localizedHistoricalMigration struct {
	ledgerChecksum   string
	executableSHA256 string
}

// localizedHistoricalMigrations 是历史迁移注释汉化的唯一兼容边界。数据库账本继续使用
// 原始发布校验值；每次加载都必须先逐字节核验剔除整行 SQL 注释后的可执行内容。
// 任何可执行 SQL 令牌、顺序或空白漂移都会失败即关闭，绝不能借注释本地化绕过迁移冻结策略。
var localizedHistoricalMigrations = map[string]localizedHistoricalMigration{
	"0002_outbox_delivery": {
		ledgerChecksum:   "c3d9062080aaaee42c5bf3afe17561b2ab4063b88c76f3151d2f1fd359e2ca51",
		executableSHA256: "d351f6f658db91fadd617a97abb4c97eb02959f14623284d018042280590c502",
	},
	"0003_launch_idempotency_retention": {
		ledgerChecksum:   "1c1cd26a8fb7c9714fdbec757a3e677f8c125a6f6f727b706cec48728226094b",
		executableSHA256: "128a10791efe7ba2f2b2b178b59f421990a48a23cd4437de96475504d4c28f60",
	},
	"0006_round_input_feature_state": {
		ledgerChecksum:   "e533823abbc3512577bdcd473771e26ae106954091916302a4ebf428d476254a",
		executableSHA256: "ef371e2bbf8c1186fe43df83cd67329d69df7daf945545ad106b6a363fd18f71",
	},
	"0007_result_delivery_cursor": {
		ledgerChecksum:   "2dffbfb97d2cf2c8e1bfd9c93348c1e63237e29e417340d31e0200b3e7316586",
		executableSHA256: "92e8af3a60e6fe5cb2d34b8f2fcb7cfe640f31472a4fff5e84b8d1522dacf2fe",
	},
}

type MigrationReport struct {
	SchemaVersion   string   `json:"schemaVersion"`
	ManifestSHA256  string   `json:"schemaManifestSha256"`
	Applied         []string `json:"applied"`
	RuntimeRole     string   `json:"runtimeRole"`
	PrivilegePolicy string   `json:"privilegePolicy"`
}

// MigrateAndReconcile 在同一个咨询锁事务内按顺序执行待补迁移并精确配置运行时权限；
// 对外提供服务的进程禁止调用它，避免请求路径隐式修改数据库模式或权限。
func MigrateAndReconcile(
	ctx context.Context,
	db *sql.DB,
	runtimeRole string,
) (MigrationReport, error) {
	if db == nil {
		return MigrationReport{}, fmt.Errorf("%w: database is required", ErrDatabaseUnavailable)
	}
	if runtimeRole != CanonicalRuntimeRole {
		return MigrationReport{}, fmt.Errorf("%w: unsupported runtime role", ErrRuntimePrivileges)
	}
	migrations, err := loadMigrations()
	if err != nil {
		return MigrationReport{}, errors.Join(ErrSchemaState, err)
	}
	manifest, err := ExpectedSchemaManifest()
	if err != nil {
		return MigrationReport{}, err
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		return MigrationReport{}, fmt.Errorf("%w: begin migration transaction", ErrDatabaseUnavailable)
	}
	defer tx.Rollback()
	if err := verifyMigratorRole(ctx, tx); err != nil {
		return MigrationReport{}, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationAdvisoryLock); err != nil {
		return MigrationReport{}, operationFailure(ctx, err, ErrDatabaseUnavailable, "acquire migration lock")
	}
	if _, err := tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS rgs_schema_migrations (
			version text PRIMARY KEY,
			checksum char(64) NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return MigrationReport{}, operationFailure(ctx, err, ErrSchemaState, "create migration ledger")
	}
	actual, err := readSchemaLedger(ctx, tx)
	if err != nil {
		return MigrationReport{}, err
	}
	if err := validateSchemaLedger(manifest, actual, true); err != nil {
		return MigrationReport{}, err
	}
	applied := make([]string, 0, len(migrations)-len(actual))
	for _, item := range migrations[len(actual):] {
		if _, err := tx.ExecContext(ctx, item.contents); err != nil {
			return MigrationReport{}, operationFailure(ctx, err, ErrSchemaState, "apply "+item.version)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO rgs_schema_migrations (version, checksum) VALUES ($1, $2)`,
			item.version, item.checksum,
		); err != nil {
			return MigrationReport{}, operationFailure(ctx, err, ErrSchemaState, "record "+item.version)
		}
		applied = append(applied, item.version)
	}
	if err := reconcileRuntimePrivileges(ctx, tx, runtimeRole); err != nil {
		return MigrationReport{}, err
	}
	actual, err = readSchemaLedger(ctx, tx)
	if err != nil {
		return MigrationReport{}, err
	}
	if err := validateSchemaLedger(manifest, actual, false); err != nil {
		return MigrationReport{}, err
	}
	if err := verifyWalletRecoveryRegistryInvariant(ctx, tx); err != nil {
		return MigrationReport{}, err
	}
	if err := verifySessionIdleTransportInvariant(ctx, tx); err != nil {
		return MigrationReport{}, err
	}
	if err := verifyRuntimePrivileges(ctx, tx, runtimeRole, false); err != nil {
		return MigrationReport{}, err
	}
	if err := tx.Commit(); err != nil {
		return MigrationReport{}, operationFailure(ctx, err, ErrDatabaseUnavailable, "commit migration transaction")
	}
	return MigrationReport{
		SchemaVersion: manifest.Version, ManifestSHA256: manifest.SHA256,
		Applied: applied, RuntimeRole: runtimeRole,
		PrivilegePolicy: RuntimePrivilegePolicyVersion,
	}, nil
}

func VerifyMigratedSchema(
	ctx context.Context,
	db *sql.DB,
	runtimeRole string,
) (MigrationReport, error) {
	if db == nil {
		return MigrationReport{}, fmt.Errorf("%w: database is required", ErrDatabaseUnavailable)
	}
	if runtimeRole != CanonicalRuntimeRole {
		return MigrationReport{}, fmt.Errorf("%w: unsupported runtime role", ErrRuntimePrivileges)
	}
	if err := verifyMigratorRole(ctx, db); err != nil {
		return MigrationReport{}, err
	}
	manifest, err := ExpectedSchemaManifest()
	if err != nil {
		return MigrationReport{}, err
	}
	actual, err := readSchemaLedger(ctx, db)
	if err != nil {
		return MigrationReport{}, err
	}
	if err := validateSchemaLedger(manifest, actual, false); err != nil {
		return MigrationReport{}, err
	}
	if err := verifyWalletRecoveryRegistryInvariant(ctx, db); err != nil {
		return MigrationReport{}, err
	}
	if err := verifySessionIdleTransportInvariant(ctx, db); err != nil {
		return MigrationReport{}, err
	}
	if err := verifyRuntimePrivileges(ctx, db, runtimeRole, false); err != nil {
		return MigrationReport{}, err
	}
	return MigrationReport{
		SchemaVersion: manifest.Version, ManifestSHA256: manifest.SHA256,
		Applied: []string{}, RuntimeRole: runtimeRole,
		PrivilegePolicy: RuntimePrivilegePolicyVersion,
	}, nil
}

func verifyMigratorRole(ctx context.Context, queryer privilegeQueryer) error {
	var policyOK bool
	if err := queryer.QueryRowContext(ctx, migratorRoleCheckSQL).Scan(&policyOK); err != nil {
		return operationFailure(ctx, err, ErrRuntimePrivileges, "check migrator role")
	}
	if !policyOK {
		return fmt.Errorf("%w: migrator role policy mismatch", ErrRuntimePrivileges)
	}
	return nil
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return nil, fmt.Errorf("postgres migrate: list embedded migrations: %w", err)
	}
	items := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		contents, err := fs.ReadFile(migrationFiles, "migrations/"+entry.Name())
		if err != nil {
			return nil, fmt.Errorf("postgres migrate: read %s: %w", entry.Name(), err)
		}
		checksum, err := migrationChecksum(strings.TrimSuffix(entry.Name(), ".sql"), contents)
		if err != nil {
			return nil, err
		}
		items = append(items, migration{
			version:  strings.TrimSuffix(entry.Name(), ".sql"),
			contents: string(contents), checksum: checksum,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].version < items[j].version })
	if len(items) == 0 {
		return nil, fmt.Errorf("postgres migrate: no migrations embedded")
	}
	return items, nil
}

func migrationChecksum(version string, contents []byte) (string, error) {
	policy, localized := localizedHistoricalMigrations[version]
	if !localized {
		digest := sha256.Sum256(contents)
		return hex.EncodeToString(digest[:]), nil
	}
	executable := executableSQLWithoutStandaloneComments(contents)
	digest := sha256.Sum256(executable)
	if hex.EncodeToString(digest[:]) != policy.executableSHA256 {
		return "", fmt.Errorf("postgres migrate: executable SQL changed for localized historical migration %s", version)
	}
	return policy.ledgerChecksum, nil
}

func executableSQLWithoutStandaloneComments(contents []byte) []byte {
	result := make([]byte, 0, len(contents))
	for _, line := range bytes.SplitAfter(contents, []byte{'\n'}) {
		if bytes.HasPrefix(bytes.TrimLeft(line, " \t"), []byte("--")) {
			continue
		}
		result = append(result, line...)
	}
	return result
}

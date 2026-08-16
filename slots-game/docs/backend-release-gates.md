# 后端发布门禁

本项目的后端发布验证必须在干净的 PostgreSQL 实例上、使用 DBA、migrator、runtime
三套隔离身份执行四项真实数据库并发与
恢复测试。普通 `go test ./...` 在开发机未配置数据库时仍允许跳过这些集成测试；
发布入口 `make test-postgres` 和 `make verify-backend` 则失败即拒绝，不能把
`SKIP`、缺失测试或无数据库当作通过。

## 本地 PostgreSQL conformance

仓库提供的 Compose 文件只用于开发和 conformance，不是生产部署拓扑。数据库
端口默认仅绑定 `127.0.0.1`；专用宿主访问网络关闭 IP masquerade，数据库内部数据网络仍为
`internal`。下列密码为每次运行临时生成的 URL-safe 值，不要将
环境变量、完整 DSN 或生成证据提交到仓库：

```sh
cd /path/to/slots-game
POSTGRES_PASSWORD=$(openssl rand -hex 24)
RGS_MIGRATOR_PASSWORD=$(openssl rand -hex 24)
RGS_RUNTIME_PASSWORD=$(openssl rand -hex 24)
export POSTGRES_PASSWORD RGS_MIGRATOR_PASSWORD RGS_RUNTIME_PASSWORD
docker compose -f deploy/docker-compose.postgres.yml up -d --wait

export RGS_POSTGRES_MIGRATOR_TEST_URL="postgres://rgs_migrator:${RGS_MIGRATOR_PASSWORD}@127.0.0.1:5432/rgs?sslmode=disable"
export RGS_POSTGRES_TEST_URL="postgres://rgs_runtime:${RGS_RUNTIME_PASSWORD}@127.0.0.1:5432/rgs?sslmode=disable"
make test-postgres
```

Compose 的角色初始化只在全新 volume 上执行。严格脚本缺少任一 DSN 会立即失败；
它先运行一次 fresh `up`、两个并发幂等 `up` 和 `verify`，再用 runtime DSN 执行业务
路径，并证明 runtime 拒绝 DDL、TRUNCATE、migration ledger 写和经济/审计表 DELETE。

严格脚本会强制 `RGS_REQUIRE_POSTGRES_TESTS=1`，只运行以下四项精确测试，并用
Go JSON 事件验证每项恰好出现一次根测试 `run` 和一次根测试 `pass`：

- `TestPostgresProductionRoundAndCredentialConcurrency`
- `TestPostgresFeatureRoundInputStateRecovery`
- `TestPostgresOutboxConcurrentClaimsOrderingAndFencing`
- `TestPostgresConcurrentSessionIntegrityQuarantinePreservesEconomicEvidence`

任何 `fail`、`skip`、缺失或重复证据都会使命令返回非零。默认证据文件为：

```text
.artifacts/postgres-conformance/postgres-conformance.jsonl
```

可通过 `RGS_CONFORMANCE_ARTIFACT_DIR` 将证据写到 CI 的受控制品目录。证据可能
包含测试失败上下文，应按发布记录的访问控制和保留策略管理；脚本本身不会输出
DSN、密码、token 或密钥。

## 完整后端门禁

配置好干净数据库后，从仓库根目录运行：

```sh
make verify-backend
```

命令先验证供应链与可观测性契约，再执行严格 PostgreSQL conformance：在全新数据库上
依次完成 `up`、两个并发幂等 `up`、`verify` 和四项真实集成测试。模式就绪后才会继续
执行完整 Go 单测、race、vet 和 build，避免自动发现数据库凭据的测试在空模式上运行。
未设置 DSN 时，命令必须在 PostgreSQL 门禁失败。
GitHub Actions 使用一次性 runner 凭据和隔离的 PostgreSQL service 执行同一入口，
并上传 JSONL 证据；这些凭据不得用于任何生产系统。

## 清理

完成后清除环境变量并销毁 conformance 数据卷：

```sh
unset RGS_POSTGRES_TEST_URL
unset RGS_POSTGRES_MIGRATOR_TEST_URL
docker compose -f deploy/docker-compose.postgres.yml down -v
unset POSTGRES_PASSWORD RGS_MIGRATOR_PASSWORD RGS_RUNTIME_PASSWORD
```

`down -v` 会删除该 Compose 项目的本地 conformance 数据卷。Docker daemon 不可用、
数据库不健康或无法运行四项测试时属于真实发布阻塞；不得用 mock、跳过或手工伪造
PASS 证据替代。

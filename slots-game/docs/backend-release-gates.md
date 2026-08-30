# 后端发布门禁 / Backend release gates

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## English summary / 英文摘要

This document defines the fail-closed backend release gates, including the real PostgreSQL conformance path and its required evidence.
A clean database and isolated DBA, migrator, and runtime identities must execute all fifteen concurrency and recovery tests; `make test-postgres` and `make verify-backend` must reject missing database URLs, skipped tests, or incomplete evidence.
Passing repository gates does not certify a production topology or external wallet, operator, cluster, capacity, disaster-recovery, or regulatory readiness, all of which require separate environment evidence and approval.

本项目的后端发布验证必须在干净的 PostgreSQL 实例上、使用 DBA、migrator、runtime
三套隔离身份执行十五项真实数据库并发与
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

严格脚本会强制 `RGS_REQUIRE_POSTGRES_TESTS=1`，只运行以下十五项精确测试，并用
Go JSON 事件验证每项恰好出现一次根测试 `run` 和一次根测试 `pass`：

- `TestPostgresProductionRoundAndCredentialConcurrency`
- `TestPostgresFeatureRoundInputStateRecovery`
- `TestPostgresOutboxConcurrentClaimsOrderingAndFencing`
- `TestPostgresConcurrentSessionIntegrityQuarantinePreservesEconomicEvidence`
- `TestPostgresRecoveryFairnessPersistsAcrossClaimWaves`
- `TestPostgresRollingOldPrepareIsRecoverableByNewWorker`
- `TestPostgresWalletRecoveryRegistryMigrationFencesRollingWriters`
- `TestPostgresWalletRecoveryRegistrySchemaInvariantFailsClosed`
- `TestPostgresRecoveryQuarantinesPoisonBeforeNextClaim`
- `TestPostgresRecoverySkipsSessionLockedByBusinessTransaction`
- `TestPostgresWorkerLookupLimitFencesAcrossPasses`
- `TestPostgresWalletClaimsQuarantineLedgerAndCommandIntegrityFailures`
- `TestPostgresPendingRoundRequiresImmutableCommandDigest`
- `TestPostgresNotSentApplyReturnsReservedAttemptBudget`
- `TestPostgresIntegrityQuarantinePreservesSucceededWalletEvidence`

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
依次完成 `up`、两个并发幂等 `up`、`verify` 和十五项真实集成测试。模式就绪后才会继续
执行完整 Go 单测、race、vet 和 build，避免自动发现数据库凭据的测试在空模式上运行。
未设置 DSN 时，命令必须在 PostgreSQL 门禁失败。
GitHub Actions 使用一次性 runner 凭据和隔离的 PostgreSQL service 执行同一入口，
并上传 JSONL 证据；两个证据上传都使用 `if-no-files-found: error`，因此成功 job 不允许缺失证据。
这些凭据不得用于任何生产系统。

## 容量压测证据边界

上述十五项 PostgreSQL conformance、race、runtime smoke 和单元 benchmark 证明正确性与回归边界，
不等于生产容量认证。开发机、GitHub-hosted runner、一次性本地 PostgreSQL/Valkey 上测得的 QPS、P99
或零错误结果只能作为本次环境的工程证据，禁止直接写成目标 RDS、跨可用区 Valkey、第三方钱包或公网
入口的 SLO，也不能用历史报告替代新候选的验收。

商业发布的容量审批必须在仓库外的受控压测平台保存一份不可变证据，并至少绑定：完整 commit SHA、
三个已签名 OCI digest、公开配置 SHA-256、数学定义身份、目标环境/区域、RDS 与 Valkey 拓扑和参数、
钱包模拟器版本、场景脚本 SHA-256、开始/结束 UTC、并发与到达率模型、原始直方图/错误分类、监控快照、
批准阈值及审批人/变更单。证据必须覆盖稳态、阶跃/突发、入口背压、慢/超时/不确定钱包、PostgreSQL
连接与写入饱和、Valkey 限流/故障转移、恢复 backlog 和发布重叠容量；阈值不满足时只能降载或阻断发布。

当前仓库没有压测平台的身份、不可变对象存储或受保护审批 API，因而不会伪造一个“已通过”的 JSON
占位文件。该接口保留为外部 release gate：部署审批者必须核对与本次 digest/配置完全一致、仍在组织
规定有效期内的证据。原始日志、DSN、钱包 token、玩家标识和完整请求体不得进入 GitHub artifact；只能
上传脱敏汇总与内容摘要。完成平台接入前，真实商业峰值容量与第三方钱包 SLA 仍属于上线阻断项。

## 清理

完成后清除环境变量并销毁 conformance 数据卷：

```sh
unset RGS_POSTGRES_TEST_URL
unset RGS_POSTGRES_MIGRATOR_TEST_URL
docker compose -f deploy/docker-compose.postgres.yml down -v
unset POSTGRES_PASSWORD RGS_MIGRATOR_PASSWORD RGS_RUNTIME_PASSWORD
```

`down -v` 会删除该 Compose 项目的本地 conformance 数据卷。Docker daemon 不可用、
数据库不健康或无法运行十五项测试时属于真实发布阻塞；不得用 mock、跳过或手工伪造
PASS 证据替代。

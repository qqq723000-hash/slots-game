# PostgreSQL 迁移与运行角色契约

模式变更与请求服务使用两个独立部署身份。`rgs-server` 进程绝不执行迁移或修复授权；
PostgreSQL 是模式和权限的唯一权威来源。

## 固定身份

- `rgs_migrator`：一次性 `LOGIN` 角色。它拥有创建的模式对象，可在 `public` 中使用和创建对象，
  但绝不注入常驻业务工作负载；
- `rgs_runtime`：常驻 `LOGIN` 角色。它只拥有数据库 `CONNECT`、模式 `USAGE`、表 `SELECT`、
  精确的列级 `INSERT`/`UPDATE` 白名单、nonce 与 launch-code 保留表的 `DELETE`，以及序列
  `USAGE`。它不能创建临时对象、执行 DDL/`TRUNCATE`、写迁移账本、删除经济或审计记录、
  拥有受管对象，也不能继承迁移角色；
- DBA/引导身份：创建上述两个角色并注入密码，不作为应用凭据使用。

在新数据库中以数据库管理员身份运行
[`../deploy/postgres/init/001-roles.sh`](../deploy/postgres/init/001-roles.sh)。密码只能通过支持
秘密保护的环境注入，脚本和应用都不会打印密码。

## 一次性迁移器

迁移器只读取：

```text
RGS_MIGRATOR_DATABASE_URL
RGS_RUNTIME_DATABASE_ROLE=rgs_runtime
RGS_MIGRATION_TIMEOUT=2m
```

它不会回退读取 `RGS_DATABASE_URL`。支持的命令为：

```sh
make migrate-postgres
make verify-postgres-schema
```

`up` 只接受空账本或九个内嵌迁移的严格有序前缀。迁移 SQL、账本写入、授权收敛和最终验证
都在同一个事务级 advisory lock 内完成。`verify` 和运行时就绪检查要求账本与内嵌清单完全
一致；校验和漂移、版本缺口、重复版本和未知未来版本都会失败关闭。

规范清单格式为 `version<TAB>checksum<LF>`，其冻结 SHA-256 为：

```text
856304eb1796eb81f54f6d41e12c6bbe071f17b69e665f381dfc55d410b7ae6e
```

退出码保持稳定：`0` 表示成功，`1` 表示内部错误，`2` 表示命令或配置错误，`3` 表示数据库、
锁或超时错误，`4` 表示模式或迁移错误，`5` 表示角色或权限策略错误。迁移器故意不提供
down、force、baseline 或跳过校验和的命令。

## 发布顺序

1. 由 DBA 创建固定角色，或独立验证角色已经符合契约；
2. 在模式仍与现网完全一致的准备发布中先交付双组件静默能力。数据库维护必须在同一份已保存
   values 上同时设置 `rgs.maintenanceQuiesced=true` 和 `worker.maintenanceQuiesced=true`；Chart 会把
   API/Worker Deployment 固定为零副本，并删除它们各自的 HPA。禁止只设置 Worker；Chart 会失败
   关闭。只设置 `rgs.maintenanceQuiesced=true` 是既有 HMAC 轮换语义：仅 API 静默，Worker 继续资金
   恢复，不能作为数据库无 writer 证明；
3. 执行维护 Helm 变更并确认 API/Worker Deployment 的期望、更新、可用副本全部为零，两个 HPA
   均不存在，旧 ReplicaSet/终止中 Pod 已归零，数据库没有来自旧 API/Worker 的活动事务。必须在
   变更单中保存渲染 diff 和观测证据；不能把“入口已关”或“API 为零”冒充 Worker 已排空；
4. 若候选清单包含 `0008_wallet_recovery_scheduler` 或 `0009_postgres_hot_path`，保持双组件静默。
   两项迁移会改变钱包恢复状态约束和热表索引，不允许与旧 writer 混跑，也不能假定
   `CREATE INDEX` 在大表上无锁；
5. 只向 `migrator` 镜像注入迁移 DSN，在已确认排空后依次执行 `up` 和 `verify`。记录迁移耗时、
   锁等待和目标索引执行计划；任一项超出批准窗口就保持双组件静默并前向修复；
6. 使用候选 runtime 摘要、但仍保持两个静默值为 `true` 完成 Helm `verify` 和工作负载清单替换；
   只有候选 migrator 与 runtime 都接受新清单后，才能在一次受保护变更中把两个值同时恢复为
   `false`。恢复渲染必须重新出现 API/Worker HPA（以及启用 Web 时的 Web HPA），且 API/Worker
   Deployment 不再固定 `spec.replicas`；
7. 在入口放量前，等待 `/readyz` 报告 `database`、`database_schema`、
   `database_privileges`、`operator_keys`，以及启用审计时的 `outbox_delivery` 全部就绪。
   只有 schema 清单、钱包 profile/route binding 与候选镜像完全一致时，才能把
   流量从零逐步恢复。

维护期间 API/Worker 目标消失与 HPA 缺失告警会按设计触发。只能创建绑定变更单、明确 owner 和
到期时间的临时静默；退出维护后必须先确认全部已启用 HPA 完整、API/Worker 指标目标恢复，再删除静默。
若迁移失败，两个静默值都保持为 `true`；数据库迁移不提供自动 down，不能为了恢复流量而重新
启动无法验证新账本的旧 writer。

`/healthz` 只表示进程存活。模式或授权漂移会让启动和 `/readyz` 失败，但不会向客户端返回
DSN、SQL 或角色策略细节。

## 回滚

数据库迁移只允许向前修复。禁止修改账本、让旧二进制跨越未来账本运行，或把对象所有权授予
运行角色。发生故障时应停止发布、保留数据库与经济证据；只有旧运行时的 `verify` 仍能通过时，
才可恢复上一兼容版本，并通过评审后的后续迁移修复模式。

## 实时一致性门禁

单元测试锁定清单、事务顺序、授权白名单、就绪语义和 CLI 分类。正式发布还要求真实
PostgreSQL 17 与 Docker daemon：CI 创建三种隔离身份，执行全新、幂等和并发迁移，验证运行
角色的允许/拒绝矩阵，并检查两个镜像目标。任一依赖不可用时，该实时门禁必须标记为阻断，
不能跳过或报告为通过。

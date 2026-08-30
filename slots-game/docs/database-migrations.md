# PostgreSQL 迁移与运行角色契约 / PostgreSQL migration and runtime-role contract

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

## English summary / 英文摘要

This document defines the PostgreSQL migration, schema-verification, and least-privilege runtime-role contract.
Schema changes use a one-shot migrator identity, while `rgs-server` uses a separate runtime identity that cannot perform DDL, rewrite the migration ledger, own managed objects, or delete economic and audit history; the ordered embedded migration manifest and permission checks fail closed on drift.
DBA role creation, protected credential injection, maintenance quiescence, backup and restore readiness, change approval, and validation against the target database remain external operational gates.

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

`up` 只接受空账本或十二个内嵌迁移的严格有序前缀。迁移 SQL、账本写入、授权收敛和最终验证
都在同一个事务级 advisory lock 内完成。`verify` 和运行时就绪检查要求账本与内嵌清单完全
一致；校验和漂移、版本缺口、重复版本和未知未来版本都会失败关闭。

规范清单格式为 `version<TAB>checksum<LF>`，其冻结 SHA-256 为：

```text
3683a51292b36ebe723b4be451ec10bdbd786ed1fed8477e71d818484c8b09c7
```

`0010_wallet_recovery_registry_invariant` 的当前嵌入校验和为
`5fc3fe96f71a66bd252713751e36139000eb6e503f981fb520df7e5f3412ce17`。迁移事务提交前、
migrator `verify` 以及运行时 `SchemaCheck`/readiness 都会从 PostgreSQL 目录动态回读并核对
精确函数与两条已启用触发器；函数或触发器被禁用、删除或替换时失败关闭，不能只凭迁移账本判定
模式就绪。

`0011_high_value_risk_review` 的嵌入校验和为
`260ddb33a04620d3ca2b2300855a94485ff57befd6101a7544471d6441288246`。它增加
`RISK_PENDING`、持久审批表和运行时列级最小权限；策略默认关闭。旧二进制不认识该状态，必须在
全部 API/Worker 升级并通过新 schema/readiness 后才可显式启用，禁止混跑期间产生风险待决轮次。
状态机、签名决策、到期策略和外部人工控制边界详见
[《高额派奖持久审批边界》](high-value-risk-review.md)。

`0012_session_idle_disconnect` 的嵌入校验和为
`bae4016984f9099d06c8b833348f4d6214b37fb9e67e3be87e0f307db4182580`。它增加已签名 operator
策略控制的空闲秒数、数据库时钟截止时间和浏览器 transport generation。迁移保留三个列默认值并在
回填后设为 `NOT NULL`，因此迁移先落库时，尚未排空的旧 writer 省略新列的 `INSERT` 仍能完成；旧
writer 的 deadline 默认使用数据库当前时间并立即超时，只有新的已签名 relaunch 才能建立未来
deadline。数据库 CHECK 永久保证 `idle_disconnect_at <= expires_at`，reader 不会静默修正漂移。
这些默认值只是 expand 阶段的失败关闭写兼容，不代表允许旧、新运行时混跑，也不表示外部参考版本公开了
一个可确认的分钟数。

同一版本还把浏览器 bearer 从 `RGS-ACCESS-v2` 升到绑定 transport generation 的
`RGS-ACCESS-v3`。v3 令牌会被旧 Pod 拒绝，v2 令牌会被新 Pod 拒绝，因此该协议变更**不能**使用
普通 RollingUpdate。Chart 在 RGS Pod 模板写入 `slots-game.io/access-token-protocol`，并在发现
现网注解与候选 v3 不同时，除非 `rgs.maintenanceQuiesced=true` 否则渲染失败。发布必须先静默并
排空所有 API Pod；完成迁移和 v3 runtime 替换后再恢复流量。旧浏览器令牌不会被重新接受，客户端
必须通过新的已签名 launch 交接恢复同一未绝对过期的持久会话。

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
   `CREATE INDEX` 在大表上无锁。`0010_wallet_recovery_registry_invariant` 会以
   `SHARE ROW EXCLUSIVE` 锁回填恢复运营商游标并安装永久 INSERT/状态进入触发器，也必须评估目标
   表规模、锁等待和维护窗口；触发器只覆盖滚动 writer 的恢复注册不漏项，不能放宽其他 schema/定义
   兼容门禁，除非先提供等价数据库级不变量，后续迁移不得删除它。回填谓词与
   `rgs_rounds_wallet_recovery_due` 的 partial predicate 一致；本机 PostgreSQL 17 的 50,000 条终态、
   25 条在途样本使用 Index Only Scan。`PREPARE` CTE 保留一次有界主键冲突探测，只用于目录漂移后、
   readiness 摘流前的短窗口保险，不能替代永久触发器或模式门禁；正式变更仍必须保存目标 RDS 的
   真实执行计划与锁等待证据。`0011_high_value_risk_review` 会替换轮次状态 CHECK 并新建审批索引，同样必须在双组件静默下
   评估 `rgs_rounds` 锁等待；迁移完成不等于策略启用，启用必须等待所有运行时升级完成。
   `0012_session_idle_disconnect` 的列默认值只保护迁移先行的旧 `INSERT`，不能解决 v2/v3 token
   双向不兼容；该版本必须在 API 全部排空的维护窗口内替换，不得让旧、新 RGS Pod 同时服务；
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

私有 operations 监听器的 `/healthz` 只表示进程存活；公共业务监听器不提供该路径。模式或授权
漂移会让启动和 `/readyz` 失败，但不会向客户端返回 DSN、SQL 或角色策略细节。

## 回滚

数据库迁移只允许向前修复。禁止修改账本、让旧二进制跨越未来账本运行，或把对象所有权授予
运行角色。发生故障时应停止发布、保留数据库与经济证据；只有旧运行时的 `verify` 仍能通过时，
才可恢复上一兼容版本，并通过评审后的后续迁移修复模式。

## 实时一致性门禁

单元测试锁定清单、事务顺序、授权白名单、就绪语义和 CLI 分类。正式发布还要求真实
PostgreSQL 17 与 Docker daemon：CI 创建三种隔离身份，执行全新、幂等和并发迁移，验证运行
角色的允许/拒绝矩阵，并检查两个镜像目标。任一依赖不可用时，该实时门禁必须标记为阻断，
不能跳过或报告为通过。

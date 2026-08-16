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

`up` 只接受空账本或七个内嵌迁移的严格有序前缀。迁移 SQL、账本写入、授权收敛和最终验证
都在同一个事务级 advisory lock 内完成。`verify` 和运行时就绪检查要求账本与内嵌清单完全
一致；校验和漂移、版本缺口、重复版本和未知未来版本都会失败关闭。

规范清单格式为 `version<TAB>checksum<LF>`，其冻结 SHA-256 为：

```text
d77069416303b19b3ac0502add0a8bc81c076b8a2fbb38e9a02323a77d73d6c6
```

退出码保持稳定：`0` 表示成功，`1` 表示内部错误，`2` 表示命令或配置错误，`3` 表示数据库、
锁或超时错误，`4` 表示模式或迁移错误，`5` 表示角色或权限策略错误。迁移器故意不提供
down、force、baseline 或跳过校验和的命令。

## 发布顺序

1. 由 DBA 创建固定角色，或独立验证角色已经符合契约；
2. 只向 `migrator` 镜像注入迁移 DSN，依次执行 `up` 和 `verify`；
3. 只向 `runtime` 镜像注入属于 `rgs_runtime` 的 `RGS_DATABASE_URL`，再发布运行时；
4. 在入口放量前，等待 `/readyz` 报告 `database`、`database_schema`、
   `database_privileges`、`operator_keys`，以及启用审计时的 `outbox_delivery` 全部就绪。

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

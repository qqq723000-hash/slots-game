# RGS 多副本集群运行契约

状态：生产部署约束

最后更新：2026-08-21

本文说明 `rgs-server` 在公司集群中横向扩展时由应用保证的行为，以及必须由平台、PostgreSQL、
运营商钱包和审计接收端提供的外部条件。本文不把本机集成验收套件等同于公司集群。

## 1. 部署边界

- 同一个 `rgs-server` 制品通过显式 `RGS_RUNTIME_ROLE` 形成两个部署边界：`api` 副本只提供公网
  API 与运维监听器，`worker` 副本只提供运维监听器并运行钱包恢复、审计发件箱和过期凭据清理。
- 单机环境未设置角色时保持 `combined`，兼容既有本机验收；公司集群必须显式注入 `api` 或
  `worker`。未知角色会拒绝启动，`api` 角色一旦携带任何审计发件箱配置也会拒绝启动。
- API 与 Worker 必须使用同版本、同数据库模式清单和同数学定义身份，但分别配置副本数、数据库
  连接预算、资源、PDB、NetworkPolicy 和监控 job；Worker 不得创建或暴露公网 Service。
- API 与 Worker 使用不同的运行资产 Secret。Worker 仅加载定义验证、钱包请求签名、钱包响应验证和
  Outbox 所需材料，不加载 launch HMAC、访问令牌签发私钥、运营请求验证材料或运营响应
  签名私钥；不得为省略 Secret 同步配置而让两类角色共用同一资产对象。
- `rgs-migrator` 是使用独立数据库身份的一次性任务；常驻服务不执行迁移，也不持有迁移凭据。
- `local-operator`、`local-production-bootstrap` 及其数据库只服务单机安装、验收和灾备演练。公司集
  群不得依赖它们提供钱包、审计、日志、告警、证书或启动入口。
- 集群必须接入正式运营商钱包、正式审计接收端、集中日志与监控设施。RGS 只依赖版本化 HTTPS
  契约，不依赖某个本机配套进程的名称或生命周期。

## 2. 跨副本权威状态

| 范围 | 应用保证 | 多副本条件 |
|---|---|---|
| 运营商 nonce | PostgreSQL 以 `(operator_id, key_id, nonce_hash)` 原子消费；到期判断使用数据库时钟 | 所有副本必须连接同一权威主库；不得换成进程内存储 |
| 启动码 | 摘要、绑定、消费时间和会话创建均持久化；重复消费失败即关闭 | 所有副本使用同一数据库与同一 launch 密钥代际 |
| 会话 | `(operator_id, session_id)` 是权威身份；修改前锁定会话行并校验版本、定义、货币与辖区 | 不要求入口会话粘滞；数据库必须提供一致的行锁语义 |
| 轮次 | `(operator_id, session_id, round_id)`、不可变请求指纹、结果哈希与钱包操作 ID 共同防重 | 客户端和运营商重试必须复用完全相同的身份及内容 |
| 钱包恢复 | Worker 副本可枚举同一轮次，真正执行权由持久租约决定；租约判断及写入统一使用 PostgreSQL 时钟 | 钱包必须按稳定操作 ID 幂等，并提供同一操作 ID 的状态查询 |
| 发件箱 | Worker 使用 `SKIP LOCKED` 领取、数据库时钟、随机租约令牌围栏和聚合内顺序共同约束投递 | 下游按发件箱 ID 去重；投递语义是至少一次，不是恰好一次 |

进程内 `MemoryRepository`、`MemoryNonceStore` 只用于单元测试和显式开发夹具。生产启动路径固定构
造 PostgreSQL 实现，不能把负载均衡粘滞当成持久一致性的替代品。

数据库拒绝重复 nonce 时，公网响应仍为不透露原因的通用 401；内部固定输出
`security_event=nonce_replay` 的 WARN 安全事件，并只增加无标签计数器
`rgs_auth_replays_total`。日志不得记录 nonce、运营商、密钥、玩家、会话或请求标识；
`SlotsRGSAuthReplay` 使用 `increase(rgs_auth_replays_total[5m]) > 0` 对任何增量告警。

## 3. 钱包恢复租约

钱包租约的持续时间由协调器给出，但 PostgreSQL 事务在锁定会话和轮次后读取
`clock_timestamp()`，使用该时间判断旧租约是否到期并计算新到期时间。容器本地时钟只用于表达
租约时长，快时钟副本不能提前抢占仍有效的租约。

钱包租约不是对外部副作用的恰好一次证明。安全性还依赖以下组合：

1. 游戏结果、钱包命令和操作 ID 在调用钱包前持久化；恢复不重新运行 RNG。
2. 同一会话只允许一个待处理轮次，PostgreSQL 行锁串行化余额和特性状态迁移。
3. 所有重试使用相同操作 ID；超时后先查询该操作，不能生成替代经济意图。
4. 收据字段与原命令逐项匹配；不同收据、幂等冲突或无法判定的状态进入人工审核。
5. 进程崩溃不主动删除租约；其他副本只在数据库判定到期后接管。

因此，平台不得把时钟同步当作钱包租约正确性的唯一保障，但节点和应用时钟仍须同步，用于签名时
间窗、日志关联和证书校验。PostgreSQL 时钟异常必须作为数据库故障处理。

## 4. 发件箱租约与实例身份

每次发件箱扫描生成新的高熵 `lease_token`。完成或失败更新必须同时匹配事件 ID 与该令牌；租约
被其他副本重新领取后，旧工作器的迟到确认会被围栏拒绝。`lease_owner` 用于诊断，不承担围栏正
确性。

`RGS_OUTBOX_OWNER` 为空时，每个进程从密码学随机源生成不同所有者。若平台显式设置该变量，必须
为每个同时存活的副本注入唯一、有界、非敏感的工作负载身份，例如 Pod UID 的不可逆或安全规范化
表示；不能给整个 Deployment 设置同一个固定值。即使 owner 误重复，随机租约令牌仍保护确认围
栏，但定位故障会失真。

RGS 业务正确性不依赖全局实例 ID。集中日志、指标和链路平台应在采集侧附加集群、命名空间、工
作负载、Pod UID、镜像摘要与发布版本，不应把这些高基数字段放入业务 Prometheus 标签。

## 5. 限流与容量

API 先使用每副本有界限制器保护本机资源，再对已验证身份调用共享 Valkey 令牌桶。共享桶只覆盖
会创建新经济意图的 operator launch 与 client spin；键由可信 operator/session 绑定经 HMAC-SHA256
生成，脚本使用 Valkey `TIME` 原子计算。状态、待交付结果、确认和令牌续期不依赖 Valkey，避免准
入故障阻断已提交结果恢复。不得直接信任客户端传入的 `X-Forwarded-For`。

Valkey 不保存或裁决 operation ID、余额、轮次、钱包收据和提交状态。它不可用时，新 launch/spin
返回带 `Retry-After` 的 503；PostgreSQL 仍是上述状态唯一权威。生产 `api` 角色必须通过绝对文件
取得独立 ACL password、键摘要 HMAC 密钥和显式 TLS 根 CA；`worker` 角色携带这些配置会拒绝启动。
单机 `combined` 可以不启用共享准入以保持本机兼容。

每个副本还分别限制：

- `RGS_MAX_IN_FLIGHT_REQUESTS`：进入签名、令牌和数据库路径的并发请求；
- `RGS_MAX_CONNECTIONS_PER_LISTENER`：已接受连接、慢请求头、TLS 状态和文件描述符；
- `RGS_DB_MAX_OPEN_CONNS` 与 `RGS_DB_MAX_IDLE_CONNS`：本副本数据库连接池；
- 钱包、恢复和发件箱并行数，以及正文、请求、写入和关闭超时。

上线前必须满足以下容量不等式，并给数据库故障转移、管理和观测连接保留余量：

```text
最大 API 副本数 × API RGS_DB_MAX_OPEN_CONNS
+ 最大 Worker 副本数 × Worker RGS_DB_MAX_OPEN_CONNS
+ 同时运行的迁移器连接
+ 监控、备份和受控管理连接
+ PostgreSQL 保留连接
≤ PostgreSQL 或连接池代理的安全连接上限
```

同理，入口、文件描述符、钱包和审计接收端容量要分别按 API 与 Worker 的“最大副本数 × 每副本
上限”核算。受 HPA 管理的 API/Worker Deployment 不写 `spec.replicas`，避免 Helm 在升级时与 HPA
争抢副本期望值。API 的三个暖副本和 Worker 的两个暖副本分别仅由各自 HPA
`minReplicas` 控制。任一自动扩缩容上限变更必须重新评审这些总预算，不能只看单 Pod 压测。

当前 Chart 只把 CPU 与内存作为已交付的 HPA 信号。基于并发请求、QPS、数据库等待或钱包待恢复
量的自定义扩缩容，必须先交付低基数指标定义、目标值、Prometheus Adapter 或云厂商指标适配器、
故障回退和压测基线，再作为 required 契约启用。禁止仅在 values 中填写一个提供方名称就宣称这些
信号已经生效，也禁止在没有基准证据时用对象池等微优化替代容量治理。

## 6. 就绪、存活与优雅退出

API 公网监听器只暴露无依赖的 `/healthz`。API 与 Worker 各自的独立运维监听器提供受 Bearer
保护的 `/readyz` 与 `/metrics`，并分别通过 `slots-rgs`、`slots-rgs-worker` job 采集。API 生产
就绪集合包括：

- `lifecycle`：副本尚未进入不可逆排空；
- `database`：数据库连接探测；
- `database_schema`：迁移账本与本二进制嵌入清单完全一致；
- `database_privileges`：运行时角色仍满足最小权限；
- `operator_keys`：API 所需的访问令牌、运营响应和钱包请求签名密钥在各自寿命窗口内可用。

Worker 使用同名 `operator_keys` 检查自己的最小密钥边界，仅验证钱包请求签名密钥和钱包响应验证密钥，
不要求也不读取 API 专属密钥。Worker 在数据库、模式、权限、角色密钥与生命周期检查之外，还必须包含
`outbox_delivery`：扫描
循环已完成且足够新、存储访问成功、未发布事件的最大积压年龄在界内。该检查及发件箱指标只从
Worker job 暴露，不得让审计出口故障拖累 API readiness。Worker 当前的钱包恢复失败通过有界指标
与日志告警暴露；若要把恢复循环本身升级为独立 readiness 条件，必须先定义避免瞬时钱包故障导致
全部 Worker 同时摘除的退避与可用性策略。

收到 `SIGTERM` 或 `SIGINT` 后顺序固定为：

1. 把 `lifecycle` 永久切换为不就绪；
2. Worker 取消恢复、凭据维护和发件箱后台循环；API 没有这些后台任务；
3. API 关闭公网与运维监听器，Worker 只关闭运维监听器，并等待已接收 HTTP 请求完成；
4. 在 `RGS_SHUTDOWN_TIMEOUT` 内等待当前角色实际拥有的监听器与后台任务退出；
5. 超时后强制关闭连接，由钱包与发件箱持久租约负责后续恢复。

平台终止宽限期必须大于 `RGS_SHUTDOWN_TIMEOUT`，并额外覆盖信号投递、端点摘除与容器退出余量。
入口应在发送新请求前观察就绪状态，并只对携带原幂等身份的请求重试。运维探针必须能在不把 Bearer
令牌暴露到公网的前提下访问独立监听器。`/healthz` 保持存活不代表副本仍可接收业务流量。

## 7. 迁移并发与发布模式

`rgs-migrator up` 在单个事务中先验证迁移角色，再获取事务级 PostgreSQL advisory lock，随后验
证账本有序前缀、冻结校验值、权限清单和最终完整清单。多个迁移任务并发启动时会串行执行；失败
任务回滚事务与锁。`rgs-server` 只使用运行时角色，不能写迁移账本或执行 DDL。

发布必须区分三类：

### 7.1 普通滚动发布

当新旧二进制使用完全相同的数据库模式清单、数学定义身份和兼容 HTTP/事件契约时，可执行多副本
滚动更新。密钥轮换必须先让所有副本具备新旧验证键重叠窗口，再切换签发键，最后退役旧键。

`release.definitionIdentity` 必须给出精确的 `gameID`、`version`、小写 64 位 `sha256`。
Chart 把三元组同时写入 API/Worker Pod template 的 `slots-game.io/definition-*` annotation 和
`RGS_EXPECTED_DEFINITION_GAME_ID`、`RGS_EXPECTED_DEFINITION_VERSION`、
`RGS_EXPECTED_DEFINITION_SHA256`。进程完成数学定义签名验证和加载后，再将实际
`gameID/version/hash` 逐项与期望值比对；任一缺失或不符都拒绝启动。

普通升级在 Helm 前还必须运行 AWS 应用部署工作流的现网门禁，同时 Chart 内使用 Helm
`lookup` 比较当前 API/Worker Pod template 与候选三元组。两个 Deployment 均不存在才按
首次安装处理；仅存在其中一个、任一 annotation 缺失或三元组不同均禁止普通滚动。
`release.compatibilityClass=same-schema-and-definition` 仅是必填声明和审计标签，不可替代上述
现网、候选与进程实际加载值的检查。

### 7.2 数据库模式变更

当前运行时就绪策略要求账本与二进制嵌入清单完全一致：旧二进制拒绝未知未来迁移，新二进制拒绝
缺失迁移。因此，包含新迁移的版本不是无停机普通滚动发布。执行迁移后，旧副本会立即不就绪；执
行迁移前，新副本不能通过启动检查。

这类版本必须采用已评审的协调切换或维护窗口，并明确可接受的服务间隙。若业务要求共享数据库上
的无停机模式升级，必须先单独设计并验证“扩展—双版本兼容—收缩”协议，再改变当前精确清单策
略；不能通过跳过校验、篡改账本或临时扩权实现。

### 7.3 数学定义变更

当前每个 `rgs-server` 进程只加载一个获批定义，而会话与轮次永久绑定定义版本及哈希。因此更换数
学定义也不是普通滚动发布：新副本不能处理仍绑定旧定义的会话，随机负载均衡无法解决该问题。
三元组门禁会在普通 AWS/Helm 升级路径中直接拒绝这种混部；它是发布隔离机制，不是数学定义
在线热更新能力。

发布方必须选择并验证以下之一：

- 在旧会话和所有待处理经济轮次耗尽后切换；
- 通过不同入口和明确会话分群让旧、新定义副本并存，直到旧群安全排空；
- 先实现并认证同一进程加载多个不可变获批定义的能力。

禁止让新定义冒用旧版本或哈希，也禁止在恢复期间用新定义重新计算旧轮次。

## 8. 平台必须提供的外部条件

- 高可用 PostgreSQL、受控主库故障转移、加密连接、连接预算、加密备份、时间点恢复与定期恢复演
  练；应用租约只接受主库的单一写入权威。
- 在可信入口实施跨副本共享限流、TLS、正文与连接保护、就绪摘流和幂等安全重试。
- 运维监听器的网络隔离与 Bearer 注入；集中采集 `/metrics`、结构化日志和发布实例元数据。
- 正式钱包必须支持稳定操作 ID 幂等、签名响应、状态查询、超时后结果恢复和运营商级对账。
- 正式审计接收端必须持久化后才返回成功、按事件 ID 去重、校验 HMAC，并监控自身可用性和积压。
- 容器终止宽限、反亲和、Pod 中断预算、可用区容量及负载均衡传播时间必须与应用超时共同演练。
- 集群机密由批准的密钥系统以只读文件注入；不得从本机集成验收目录、镜像层或 `local-operator` 复制
  长期生产私钥。
- API 与 Worker 的版本化运行资产 Secret 必须由密钥系统分别同步、分别授权；Worker Secret 不得
  包含 launch、访问令牌或运营响应签名私钥。

缺少上述任一条件时，只能证明应用层契约成立，不能宣称公司集群已达到正式上线状态。

## 9. 发布验证证据

普通 Go 门禁：

```sh
cd server
go test ./...
go test -race ./...
go vet ./...
```

关键自动化证据包括：

- `internal/postgres/security_store_test.go`：共享 nonce 与启动凭据原子消费；
- `internal/postgres/repository_integrity_test.go`：会话/轮次完整性，以及副本时钟偏差下的钱包租约；
- `internal/postgres/outbox_store_integration_test.go`：双存储实例并发领取、聚合顺序和旧令牌围栏；
- `internal/postgres/schema_test.go` 与 `migrate_test.go`：精确模式清单、迁移冻结及锁定流程；
- `internal/platform/health_test.go` 与 `cmd/rgs-server/main_test.go`：摘流不可逆和关闭顺序；
- `internal/platform/config_test.go`：API/Worker 角色、审计配置隔离和默认单机兼容模式；
- `cmd/rgs-server/main_test.go` 与 `internal/platform/config_test.go`：数学定义三元组格式、精确匹配和
  Worker 无 launch HMAC 的角色边界；
- `cmd/rgs-server/security_events_test.go` 与 `internal/rgsapi`：nonce 重放的固定安全事件、无标签
  指标及敏感字段禁止泄露；
- `deploy/cluster-production/verify-static-contract.sh`：API 无后台能力、Worker 无公网端口、独立监控
  job、定义身份、密钥边界、审计专用出口和角色级资源/PDB 失败闭合；
- `internal/rgs`、`internal/postgres/integration_test.go`：跨请求幂等、会话串行与持久恢复。

真实 PostgreSQL 并发门禁必须设置隔离的 `RGS_POSTGRES_TEST_URL`、
`RGS_POSTGRES_MIGRATOR_TEST_URL` 和 `RGS_REQUIRE_POSTGRES_TESTS=1`。未提供这两套凭据时，普通单元套
件会明确跳过实时数据库测试；发布流水线不得把“跳过”报告为“通过”。

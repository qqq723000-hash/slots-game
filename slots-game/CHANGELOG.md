# 变更记录

本项目采用语义化版本。每个正式版本必须绑定 Git 提交、OCI 镜像摘要、SBOM、来源证明、
签名结果、数据库迁移清单和前端发布清单；仅修改标签不得形成新版本。

## 未发布

## 1.3.0 - 2026-08-28

- 将 52 份项目自有说明统一为个人独立开发者的商用级源码交付口径，把生产、运营、平台、安全、
  审计、法务、合规与审批明确为采用方需要在外部环境落实的职责，不再暗示已有内部组织或线上承诺；
- 清理项目说明中的特定外部厂商名称、公开来源链接及旧有归属措辞，将 PAYTABLE 研究规范
  改为中性的参考基线命名，同时保留素材权属未验证、外部审批和监管认证门禁；
- 增加覆盖 52 份现行项目说明的个人项目说明契约、单元测试与供应链负向门禁，并对历史变更记录
  保留中性来源检查，防止统一声明、身份边界或来源口径在后续变更中静默回退。
- 显式固定 Chrome/Edge 111、Firefox 114、Safari/iOS 16.4 的 JavaScript/CSS 构建下限，移除
  Firefox 旧版不完整的 `:has()` 视觉依赖，增加启动能力失败提示及 Chromium/Firefox/WebKit/Edge
  真实资源、WebGL、旋转、结算 ACK、移动底边与说明页底边自动化门禁；Safari/iOS/Android 真机
  仍作为正式采用方发布前的外部设备验收；
- 在任何外部脚本请求前同步清除 URL 中的启动交接片段，以 CSP 精确摘要绑定一次性交接代码；
  外部预检缺失、被阻断或桥接结构漂移时立即焚毁原始值并固定失败，避免 Firefox 网络控制台回显凭据；
- 将 Big Win、Primal Wheel、King、Kong 与 Free Spins 的桌面流程，以及 King 手机和 Kong 平板布局
  纳入 Chromium、Firefox、WebKit 与 Edge 分离的特殊玩法门禁；截图证据绑定同一流程 epoch 和底边几何。
- 将浏览器端供应商式署名替换为代码原生的个人独立开发标识，移除相关位图及生产清单引用，同时保留
  Primal Rampage 游戏标题与游戏内 Spine logo；全仓身份门禁覆盖普通文本与二进制文件名，阻止旧标识回退；
- 将桌面与移动端 M4A 音频重封装为 WebKit 可渐进解码的 fast-start 容器，并以音频描述、实际字节和
  流式清单三方一致性门禁锁定资源；应用销毁后再发布 retained/active/canvas/spin 零残留诊断证据。

## 1.2.3 - 2026-08-28

- 修复已有持久会话重新启动时的交接边界：新 handoff 在签发前使用 PostgreSQL 权威时钟拒绝
  absolute-expired 会话，同时继续允许 idle-timeout 会话通过 exchange 恢复 transport generation，
  不重置余额、Feature 或绝对有效期；
- 将 launch code 的创建/到期、exact-retry 25 小时墓碑、历史重放和一次性兑换统一绑定存储层权威时间，
  访问令牌 `iat/exp` 绑定会话操作返回的同一服务端时间；移除 Pod 时钟二次裁决，终态会话只重放原响应，
  exchange 仍按当前状态失败关闭，不会复活凭据；
- 补齐 `client.session_status` 与 `operator.risk_decision` 的固定低基数遥测/Vector 路由白名单和负向契约，
  避免合法恢复流量在采集链中被错误归入 `other`，同时保持玩家、会话和轮次标识不进入日志标签。
- 为 PostgreSQL 同轮次 32 路并发收敛测试设置独立的 10 秒有界观察窗和 30 秒上下文栅栏，消除
  `-race` 负载下把合法 `ROUND_PENDING` 快路径误判为经济幂等失败的偶发 CI 报警；生产 1 秒窗口不变。

## 1.2.2 - 2026-08-27

- 完整移除 GitHub Pages、公开静态试玩入口、源码、构建脚本与宣传说明，并增加供应链负向门禁，
  防止这些已退出产品范围的表面重新进入仓库；
- 修复 Vite 子路径部署中的流式特殊玩法资源、favicon 和 GPU 预热路径契约，补充覆盖 CSS、字体与
  Feature Preview 的真实 `/casino/primal/` 构建验证；同时修正 PAYTABLE 金额辅助文本在无投注状态下
  残留旧值的问题；
- 将失败恢复、游戏规则、OpenAPI 响应矩阵和符号赔付注释与运行时实现同步；OpenAPI 以
  `LicenseRef-Proprietary` 明确仓库未授予 API 许可，不虚构开源或商业授权；
- 移除阻断跨源运营商 iframe 的 CloudFront `X-Frame-Options: SAMEORIGIN`，将 release cookie 收紧为
  `Secure; HttpOnly; SameSite=None; Partitioned`，并为 S3 release 前缀增加条件写 bucket policy；
- Web release 上传支持中断后按内容 SHA-256、长度、元数据、MIME、缓存和 KMS 属性精确回读续传，
  任一漂移均在切换 CloudFront KVS 前失败关闭；
- 将 Web OCI 许可证标签显式覆盖为 `NOASSERTION`，扩展全仓 ShellCheck 门禁，并澄清本机多数据源
  备份只保证完整备份集原子发布，不宣称跨数据源时间点原子性；
- 将本机候选镜像的 OCI version 强制绑定仓库 canonical `VERSION`，拒绝空值、别名和元数据首尾空白，
  避免部署 profile、状态选择器与实际镜像标签发生版本分叉。

## 1.2.1 - 2026-08-27

- 收窄本机运营审计/日志持久化的底层 writer 为 `*os.File`，防止今后误将客户端提交内容
  写回 HTTP 响应，并消除 CodeQL 对通用 `io.Writer` 可能指向 ResponseWriter 的跨实现数据流误判；
- 修正中文注释契约对 HTML `-->` / `--!>` 结束符及孤立 CR、Unicode 行分隔符的处理，
  补充表驱动回归测试，阻止尾部汉字掩盖英文人工注释的 CI 规则绕过；
- 在 CodeQL 上传后读取同次扫描的 SARIF，发现 High/Critical、缺失结果或损坏安全元数据时
  立即失败，并用供应链负向契约防止阈值、输出绑定或回归测试被静默移除；
- 将此安全修复作为 `1.2.1` 新提交交付，不改写已不可变的 `v1.2.0` Tag 或 Release。

## 1.2.0 - 2026-08-27

- 将产品交付标题统一为 Primal Rampage，并以 `VERSION` 为版本事实源，同步 Web package/lock、
  Helm Chart、变更记录与发布示例；供应链门禁会拒绝版本漂移或与受保护 Tag 不一致的发布；
- 增加 Dependabot、CodeQL、Pull Request 依赖审查、结构化 Issue 表单、公开支持边界和安全私密入口；
  所有 Action 继续固定完整提交 SHA，安全分析写权限仅授予 CodeQL 结果上传 job；
- 收紧 CI 证据上传白名单并补仓库治理负向契约，阻止原始日志、凭据、本机状态或任意目录通过
  通配符进入构建制品。真实 GitHub Environment、分支/Tag 保护、Release 发布与安全功能启用状态
  仍须由仓库管理员在托管平台回读验收；
- 新增与正式 RGS 入口分离的 GitHub Pages 静态试玩：23 轮公开固定序列覆盖普通赢额、Rage、
  Primal Wheel、Kong Quest、King Spin 与 Vault，使用 `XTS` 测试币种，并常驻标识无真钱、
  无钱包、无经济价值及“不代表概率/RTP”；产物模块图与负向扫描拒绝 RGS 启动交接及内部测试场景；
- Pages 部署使用固定 SHA 的 Action、最小权限 job、正向文件白名单、完整树哈希、SVG 主动内容扫描、
  `PUBLIC-INTERNET` 外部逐文件授权及独立 `github-pages` Environment；缺少权属或审批时保持未部署。

## 1.1.0 - 2026-08-26（历史源码候选，元数据不一致，已由 1.2.0 取代）

远端 `v1.1.0` Tag 指向的 `a3573aa` 提交仍把 Web package/lock 与 Helm Chart 标为 `1.0.0`，
当时的变更记录也未归档为 `1.1.0`，因此它不是元数据闭合的完整正式发布。该不可改写 Tag 只保留
为审计历史，托管 Release 应标为 prerelease/superseded，下游部署允许列表必须拒绝；以下条目仅记录
该源码候选包含的工程变化，正式修复由 `1.2.0` 交付。

- 为当前固定 Vector 0.57 的低流量磁盘缓冲读取唤醒竞态增加 10 秒归档推进心跳；心跳从空对象重建为
  `service/time/level/msg` 四个固定字段；稳定运行名义值为每实例 8,640 条/日，启动/重启余量另计。
  新增 A 阶段中断持久化与 B 阶段 receiver-ready 后全新 sender/data_dir 的双单事件 25 秒门禁，以及防止
  恢复 90 秒等待、同阶段第二业务事件假唤醒的负测；本机 25 秒只由文件增长和唯一 digest 精确语义判定，
  sent counter 另用最长 35 秒覆盖两个 15 秒传播周期，拒绝把 Prometheus 延迟误报成业务未交付。
  这是版本限定缓解而非上游修复，外部归档容量、费用、TLS、保留和合规仍须生产验收；
- 新增默认关闭的高额派奖 `RISK_PENDING` 持久审批状态机、签名幂等决策接口与数据库时钟到期策略；
  候选结果、钱包摘要和审计 Outbox 同事务落库，未经批准不外呼钱包，也不向客户端泄露完整结果；
  生产启用仍须由运营商个人 SSO/MFA、职责分离、双人复核和监管审计系统完成外部身份控制；
- 新增 PostgreSQL `0012` 会话空闲断开、transport generation 栅栏和同会话 relaunch；浏览器使用
  服务端时间加单调时钟展示 `SESSION_TIMEOUT`，保留未 ACK 结果并由新会话恢复。恢复耗尽、人工复核和
  ACK 恢复耗尽现在统一移交运营商新会话，不会永久显示假重试，也不会自动重提 Spin；
- 增加默认关闭的服务端 W3C/OTLP 追踪、远端 Trace ID keyed sampling、固定低基数 span 属性、
  导出失败告警和终止 flush 预算；浏览器为每个 RGS 请求生成无持久身份的独立 W3C `traceparent`，
  日志只保留固定错误类别和单向相关标识，不记录异常文本、金额或业务身份；
- 将 Big Win、Free Spins 与 Wheel 独占资源移出首启路径并改为清单校验后的事件租约；增加 Big Win
  慢帧粒子降档/恢复、移动与平板四视口空闲弹窗、红色 GO favicon、DOM 图片解码就绪和代理空 GET
  兼容恢复门禁；视觉失败只影响表现，不改变权威结果、ACK 或 pending ledger；
- 增加默认关闭的同区域 RDS PostgreSQL reader 接口、独立 endpoint、ReplicaLag 与总 IOPS/吞吐告警，
  以及本地生产 Valkey TLS/ACL 准入、原子备份发布、双库隔离恢复和严格日志脱敏验收；应用读路由、
  RDS Proxy/PgBouncer、跨区 DR 与真实目标账号部署仍是独立门禁；
- 将共享准入启动检查从 PING 升级为匿名短 TTL 的双次真实 Lua canary，覆盖基础桶所需 ACL；独立
  Worker 只有在首次完整恢复 pass 成功后才通过启动就绪，真实 Claim 查询或取得任务的处理失败都会
  阻止晋级，避免滚动发布在恢复路径实际不可用时替换全部旧副本，同时保留 API 的
  status/pending/ACK 恢复流量；
- 增加应用 API Regional WAF 基线、托管规则组、超限请求拒绝、分层速率规则、脱敏日志和告警契约；
  CloudFront 仍只承载静态 Web，不被描述为 API 源站隐藏层；Shield Standard 自动基础防护、真实
  WAF 关联/日志/告警与可选 Shield Advanced 响应仍须在目标 AWS 账号留存验收证据；
- 收紧公共 HTTP 请求头/请求体与编码边界，未认证入口与验签使用统一硬上限；认证后
  status/result/ACK 不占数据库新意图许可，钱包 lookup 使用独立恢复容量；新增畸形、超大、无效
  令牌和高基数身份滥用 profile、告警与安全演练手册，本机结果不替代 AWS DDoS 模拟或容量验收；
- 增加机器可读素材权属分类与逐文件外部哈希审批门禁，拒绝把哈希完整性当成授权链证明；移除
  源 `public/` 中的内部说明并增加防回归校验；最终白名单原已排除内部文档，权属证据未验证的素材
  在授权或自主替换前仍失败关闭；
- 将第三方钱包升级为版本化 v2 结算契约：持久化钱包会话、命令摘要、能力与账本路由绑定，严格区分
  `SUCCEEDED/REJECTED_FINAL/PENDING/NOT_FOUND/CONFLICT/UNKNOWN/NOT_SENT`，并由签名响应绑定完整经济身份；
- 新增 PostgreSQL `0008/0009`：按数据库时钟持久化 APPLY/LOOKUP 恢复阶段、租约围栏、公平跳锁领取、
  钱包账本外呼前预检及热路径索引；该变更不支持新旧 writer 混跑，必须静默 API/Worker 后迁移；
- 增加 PostgreSQL `0010` 恢复注册不变量迁移：在同一锁定事务内回填恢复运营商游标并安装永久
  INSERT/状态进入触发器，覆盖滚动期间的旧 writer；迁移提交前、migrator `verify` 与运行时
  `SchemaCheck`/readiness 动态核对精确函数和已启用触发器，禁用、删除或替换即失败关闭。`PREPARE`
  CTE 只保留 readiness 摘流前的有界冲突探测保险；Worker 领取不再执行全表运营商补种。该不变量
  只证明恢复注册不漏项，不能被描述为任意 schema/应用版本均可安全混跑；
- 会话过期判定统一使用同一加锁查询返回的数据库时钟；钱包 APPLY 与 LOOKUP 各自受持久尝试上限
  约束，达到上限后在下一次外呼前进入人工审核，避免慢钱包把恢复流量放大为无界付费查询；
- 为慢钱包增加 backend/operator 舱壁、独立熔断、有界一秒快路径与 Worker 恢复；为 API 新意图增加
  PostgreSQL critical reserve，status/result/ACK/refresh 不占新意图许可；
- 将 Valkey 共享准入升级为 v2 单字符串桶：允许请求一次写、拒绝请求零写、NOSCRIPT 单飞恢复，
  launch/spin 按已验证 operator 分桶；ACL v1→v2 只允许在有 API 零副本证据的 HMAC 维护 plan 中迁移；
- 前端对 429/503、`Retry-After`、同步最终拒绝和待恢复账本执行有界状态恢复，并为 ACK/状态轮询加入
  不改变截止时间的分布式抖动；exchange 越过发包边界前即清除本实例 launch code，网络、HTTP 或
  协议失败均不重放；同游标 token refresh 禁止改写余额/特性，待处理轮次之外的回退或前跳失败关闭；
- 新增 HTTP、PostgreSQL、Valkey 三类显式高并发入口；每次报告使用唯一临时文件、固定 schema、批准
  阈值和功能不变量校验后才原子发布到 ignored `.artifacts`，本机结果不替代 AWS/第三方/24h soak；
- 增加 Valkey 引擎 CPU、容量、连接、复制延迟、流量管理和 EVAL 延迟，以及 RDS CPU、连接、内存、
  存储、读写延迟和磁盘队列 CloudWatch 告警；为加密 SNS 告警 topic 增加按来源 ARN 收窄的
  CloudWatch/RDS/Backup topic 与 KMS 发布权限；增加数据库双组件维护静默状态；真实 AWS apply、
  Multi-AZ failover、SNS 最终接收和外部钱包认证仍是上线门禁；
- 将正式交付主线改为 AWS，并增加四环境应用 IaC：VPC/EKS、RDS Multi-AZ、ElastiCache Valkey、
  不可变 ECR、Secrets Manager 元数据、私有 S3/OAC/CloudFront、AMP/CloudWatch、备份和归档基线；
  账号工厂、远端 state/部署身份、DNS/ACM、CloudFront global WAF、可选 Shield Advanced/DRT 与
  组织级安全仍由企业落地区提供，API Regional WAF 则由本仓库应用 IaC 交付；
- 增加基础设施、应用发布和 HMAC 静默证据三个 AWS workflow 源码，使用 OIDC、已保存 Terraform
  plan、版本化 delivery 与失败关闭门禁；这些能力仍须在真实目标账号完成 plan/apply 和验收；
- conformance workflow 按 workflow/ref 取消陈旧提交；供应链发布按精确镜像仓库/tag 串行且不取消
  在途发布，并在 candidate push 前失败关闭地确认 final tag 不存在。AWS 实时平台检查同时要求四个
  关键 add-on Deployment 已观测最新 generation、全部副本可用且无 unavailable；这些源码门禁仍不
  替代 ECR tag immutability、目标账号实时回读或外部审批；
- 将同一 RGS 制品拆成可独立扩缩的 API/Worker 运行角色，交付独立 HPA/PDB/Secret/NetworkPolicy，
  并保持 PostgreSQL 对会话、轮次、钱包结果和 `operationId` 幂等的唯一权威；
- 补齐固定枚举的钱包 method/outcome 延迟、inflight 与熔断观测，增加数据库全局恢复 backlog、最老
  逾期年龄、执行循环/快照独立新鲜度和人工审查告警；backlog 使用 501 封顶下界、首次错峰采样及
  同实例新鲜度过滤，避免事故期无界扫描和陈旧副本假告警；API/Worker HPA 在未交付指标 adapter 前
  仍只使用 CPU/内存，并以三/两个暖副本和容量告警失败闭合；
- 增加 API + Valkey 的已验证身份共享准入：只拦截新启动/Spin 意图，使用 TLS、A/B ACL 与 HMAC
  键摘要，故障时失败闭合且不把缓存提升为资金权威；
- 增加 Valkey A/B 密码轮换和 HMAC 静默维护状态机；HMAC entry/exit 后由应用
  `maintenance-complete` 两阶段切换，禁止用旧 delivery 的 `resume` 恢复旧 HMAC Pod；
- 成功访问日志默认确定性采样 1%；4xx/5xx 与 nonce 重放的权威计数、资金审计和安全事件语义
  保持完整，重复物理访问/WARN 日志则使用固定速率和非阻塞写入上限，防止日志背压成为二次 DoS；
  补充低基数采样/丢弃指标、API/Worker HPA 与共享准入故障告警；
- 以基准驱动复用不可变数学配置、固定数组和连续分配，将代表 Spin 路径从 97 降至 22 allocs/op；
  不采用未经 profile 证明的 `sync.Pool` 或伪“零分配”承诺；
- 增加加密、版本化、对象锁定的 S3 冷归档基线与 RDS export 角色；自动快照导出编排、数据库分区
  切换和真实恢复演练仍是上线前平台职责，不宣称仓库已定时执行；
- 补齐 AWS/通用集群/本机集成验收的分层部署契约、树状架构、失败关闭校验与运维边界；
- 修复 Pixi、Spine、renderer 与 reels 跨分块循环导致的浏览器启动失败，并把真实 Chrome
  会话、严格 CSP 和画布就绪纳入必需门禁；
- 增加确定性第三方许可清单、发布清单绑定和镜像交付校验；
- 删除重复素材与旧本机 helper 路径，统一复用正式运行素材和独立容器 helper；
- 本机 Docker Compose 明确降级为开发与集成验收环境，不再作为正式生产证据。

## 1.0.0 - 2026-08-16（仓库声明撤回，不可上线）

该版本仅保留为历史源码候选。它未完成 AWS 正式交付重构与受保护供应链发布，仓库政策已将其
声明为撤回，不得部署到生产、交付运营或作为正式发布证据。已发布的不可改写 `v1.0.0` Tag 应作为
审计历史保留，不得删除、移动或覆盖；托管平台上的同名 Release 必须显著标记“撤回/禁止上线”，
下游部署允许列表也必须拒绝该版本。管理员须通过平台 API 回读这些状态并留证，不能只凭本文宣称
托管平台已完成撤回。以下内容只记录当时已实现的能力边界。

### 核心能力

- Go 权威 RGS、独立迁移器、PostgreSQL 持久化会话/轮次/nonce/结果游标和事务性发件箱；
- 幂等钱包命令、未知结果恢复、服务端 RNG 与数学定义审批绑定；
- TypeScript/PixiJS 表现层、严格 RGS 启动交接、待交付结果恢复和展示后幂等确认；
- 独立公共与运维监听器、认证就绪探针、低基数指标、结构化脱敏日志和有界资源读取；
- Prometheus、Grafana、Alertmanager、Vector、备份、隔离恢复验证和本机集成验收编排；
- Kubernetes Helm 交付：RGS/Web 多副本、HPA、PDB、三可用区分散、默认拒绝网络策略、
  一次性迁移 Hook、外部 Secret 与 ServiceMonitor；
- 固定工具链与镜像摘要、密钥/漏洞扫描、SPDX/CycloneDX SBOM、来源证明、签名和发布门禁；
- 全仓关键人工注释中文化，并以自动契约阻止仅英文注释回归。

### 发布边界

- 当前受保护的集群制品仅支持 `linux/amd64`；Chart 会拒绝 ARM64 调度；
- 普通 RGS 滚动升级只允许数据库模式和数学定义身份完全不变的版本；
- 数据库模式或数学定义变更必须使用经过评审的协调切换流程；
- Web 稳定路径资源升级必须由蓝绿发布或带版本前缀的 CDN 隔离，不能依赖新旧 Pod 混部；
- 本机 `local-operator` 仅用于集成验收，不属于公司集群运行依赖。

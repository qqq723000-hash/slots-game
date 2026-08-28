# Primal Rampage 最终优化与加固状态矩阵

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

状态日期：2026-08-29

本文把《前后端持续优化加固清单》映射到当前仓库的实际实现、可重复验证与外部上线门禁。
它是当前工作树的工程验收快照，不是素材授权书、真钱牌照、独立 RNG/数学认证、渗透测试报告，
也不证明任何 AWS 账号已经部署这些源码。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| 仓库已验证 | 源码、配置和自动化门禁存在，并已在当前工作树运行相应本地验证 |
| 目标环境待验收 | 仓库交付实现或失败关闭接口，但必须在真实 AWS、运营商、钱包或设备环境保存证据 |
| 尚未实现 | 当前源码、配置或制品中不存在完整能力，不得用文档或接口名称冒充完成 |
| 明确替代 | 原建议会破坏资金正确性、隐私或可维护性，仓库采用更强且可审计的等价边界 |

## 主清单映射

| 领域 | 当前结论 | 主要证据 | 未完成或外部门禁 |
| --- | --- | --- | --- |
| UI、动画与跨端体验 | 核心轮盘、Grid Reshaping、镜头/环境、Primal Wheel、Big Win、Free Spins、响应式安全区、Reduced Motion 与键盘/ARIA 路径已有实现和测试 | `web/src/renderer/`、`web/src/reels/`、`web/src/ui/`、`web/tests/` | 真机 60 FPS、低端设备矩阵、音画帧同步、视觉回归签收仍需设备实验室；Big Win 慢帧熔断只降低表现负载，不改变服务端结果 |
| 首屏与资源分发 | 静态 HTML 首屏、分帧初始化、JS 分块预算、桌面/移动资源清单、SHA-256 发布清单、CloudFront OAC、Brotli 协商、immutable release、HTTP/2+3，以及 Big Win、Free Spins、Wheel 真实事件租约延迟加载已有仓库门禁 | `web/index.html`、`web/src/startup/StreamingAssetRuntime.ts`、`web/src/app/AppController.ts`、`web/src/renderer/VerifiedFeatureArtwork.ts`、`web/src/renderer/BigWinView.ts`、`web/scripts/`、`infra/terraform/modules/web-edge/` | Big Win 四项独占首启减少 4,044,706 B。Free Spins 独占 117,536 B；Wheel 目标包独占 1,507,291 B，其中实际从旧首启路径移出的资源为 1,498,108 B（`wheel_hyperspin.skel` 原本未首启加载）。完整事件闭包包含共享 `spine-ui` 和交互音频：Free Spins desktop/mobile 为 8,128,853 B / 7,781,712 B，Wheel 为 9,518,608 B / 9,171,467 B，不能计作独占请求。没有真实弱网/设备 RUM、Brotli level-11 预压缩、边缘预热或目标 Route 53 延迟路由证据 |
| 前端安全与恢复 | 浏览器只表现权威结果；一次性 Launch Code 清除、内存 token、严格解码、pending ledger、状态查询、ACK、空闲断开、transport generation、运营商 relaunch、CSP、Trusted Types、资源完整性、生命周期清理、运行期全局故障关闭，以及无持久身份的逐请求 W3C `traceparent` 已实现 | `web/src/protocol/`、`web/src/main.ts`、`deploy/web/` | 生产浏览器指标/视觉遥测出口仍未实现；真实 BFCache、多标签页、辅助技术和设备矩阵仍是外部门禁 |
| 后端资金与并发 | PostgreSQL 权威事务、服务端 RNG、Operation ID 幂等、原子钱包命令、未知结果只查询、持久恢复、Outbox、Valkey 新意图准入、舱壁/熔断、HPA/PDB、日志脱敏、默认关闭的 W3C/OTLP 服务端追踪，以及默认关闭的高额派奖 `RISK_PENDING` 持久审批状态机已有实现 | `server/internal/rgs/`、`server/internal/postgres/`、`server/internal/recovery/`、`server/internal/outbox/`、`server/internal/sharedadmission/`、`server/internal/telemetry/` | Progressive Jackpot 资金账本尚未实现；高额风控的个人 SSO/MFA、职责分离与双人复核仍由外部运营平台交付；正式钱包 conformance、数学/RNG/RTP 认证、真实 collector 父子链和容量/故障演练均未完成 |
| 数据、AWS 与运维 | 私有 VPC/EKS/RDS/Valkey、Multi-AZ、PITR、KMS、Secrets、Pod Identity、WAF、ECR、S3 Object Lock、跨区备份接口、AMP/CloudWatch、RDS 总 IOPS/总吞吐与日志派生 deadlock 告警、Vector 低流量磁盘归档有界推进门禁、默认关闭的同区域 PostgreSQL read replica/独立 endpoint/ReplicaLag 与容量告警接口、受控 OTLP collector 接口及供应链门禁已有 IaC/契约 | `infra/terraform/`、`deploy/aws-production/`、`deploy/cluster-production/`、`deploy/observability/` | Vector 0.57 方案的稳定运行名义值为每实例 8,640 条固定心跳/日，启动/重启余量另计；它是竞态缓解而非上游修复，外部归档容量/费用/TLS/保留/合规仍待验收；应用尚未采用 reader endpoint，RDS Proxy/PgBouncer、时间分区、定时 RDS 冷归档和 Bot Control 尚未实现；真实副本/KMS/告警、collector TLS/容量/保留期、Route 53、GuardDuty、共享防火墙和告警到人由采用方平台验收 |
| 文档、品牌与视频 | Primal Rampage 已作为交付品牌统一；README、架构、运行手册、资产权属分类和精确哈希审批失败关闭门禁存在 | `README.md`、`docs/`、`web/ASSETS.md`、`web/asset-provenance.json` | `gameId=iron-colossus`、存储键和 runtime manifest 标识是既有部署/缓存兼容协议，不代表产品品牌且不得在无迁移方案时改名；Primal Rampage 运行素材权利证据未在仓库验证；销售演示视频作为仓库外制品单独验收，不进入源码或 Web runtime 发布包。不得通过删除水印或来源声明代替授权和原创替换 |

## 本轮落地的高优先级补强

1. CloudFront distribution 显式使用 `http2and3`，并把该值写入 delivery contract；目标账号
   `get-distribution` 回读、静态契约和负向漂移测试都会拒绝退回仅 HTTP/2。真实 QUIC 协商率与收益
   仍由目标网络 RUM 验收。
2. 前端在应用成功启动后安装单次 `error` / `unhandledrejection` 故障关闭边界。它不读取或展示异常
   payload，会停止输入和表现、销毁当前应用、关闭网关、保留 pending ledger，并只请求运营商创建
   新会话；不会自动重提 Spin。
3. 共享与经济准入提供无标签组合健康、最后成功时间和年龄指标。新意图失败关闭，但 status、pending
   result 与 ACK 恢复通道不因 Valkey 故障被整体摘流；持续不可用由独立告警处理。
4. Big Win 粒子系统在正常帧预算下保持原 24 Hz、分层密度与 150 Sprite 池；慢帧窗口只降低可同时
   活跃粒子和发射密度，健康窗口后分级恢复，清理/跳过不会留下降级状态或残留粒子。
5. Big Win、Free Spins 与 Wheel 的事件视觉资源已从严格首启加载和 GPU 预热移出，生产默认使用
   `on-demand`。权威结果通过来源/形状校验后、任何 reel/feature/game 状态转换前同步启动对应租约，并直接
   消费 manifest bytes/SHA 校验后的负载。Free Spins 跨多轮去重并保留到返回 Base；Wheel/Big Win 保留到
   本次展示完成。Abort/销毁与旧代晚到按对象身份清理，失败只显示固定脱敏提示，ACK 一次且不重提 Spin。
6. 服务端追踪使用官方非阻塞 BatchSpanProcessor、固定资源/路由/数据库操作属性与受控采样；远端父链使用
   启动时 CSPRNG 密钥加 HMAC-SHA256 比例决策，调用方不能通过挑选 Trace ID 强制命中。入口接受 W3C
   Trace Context Level 2 的 `00..03` flags；空 endpoint 不创建 exporter，Chart 只有显式启用时才给
   API/Worker 注入配置并开放 collector CIDR/端口出口，终止宽限计入向上取整的 trace flush 预算，
   API/Worker 导出失败均有 Prometheus 告警。
7. RDS 容量使用 `Read + Write` metric-math 总 IOPS/总吞吐告警；PostgreSQL deadlock 从导出日志的精确
   `"deadlock detected"` 短语派生 Count 告警，不再虚构标准 RDS 指标。
8. 新增默认关闭的同区域 PostgreSQL read replica 接口、独立 reader endpoint、7 个容量告警和
   `ReplicaLag` 告警；生产启用时强制 reader 自身 Multi-AZ，delivery/live gate 回读 source、engine、
   class、gp3/存储、KMS、subnet、参数组、安全组、备份、删除保护和待应用修改。应用读写路由、Proxy、
   自动提升与跨区 DR 均明确未实现。
9. 性能契约明确记录不采用的高风险建议及替代方案，防止未来为满足名称清单而破坏服务端权威、
   隐私或资金幂等。
10. `0012_session_idle_disconnect` 使用 PostgreSQL 时钟持久化权威空闲截止时间，并以 transport
   generation 在 session 行锁内隔离旧页面请求。浏览器以服务端时间和单调时钟驱动四视口
   `SESSION_TIMEOUT` 弹窗，EXIT 只允许受审同源运营商返回地址；relaunch 保留余额、轮次和未 ACK 结果。
11. ACK、round status 与 pending recovery 的截止时间和暂停恢复全部使用服务端锚定单调时钟；恢复预算
   耗尽或进入 `MANUAL_REVIEW` 时保留 ledger、终止旧令牌和在途请求，并只触发一次运营商新会话接管，
   不再永久显示假重试，也不自动重提 Spin。
12. 共享准入启动门禁不再只做 PING，而是用匿名随机短 TTL key 连续执行两次真实 token-bucket Lua，
   覆盖 `GET/PTTL/SET` 与严格响应形状；Valkey 仍不进入基础 `/readyz`，以保留 status、pending 和 ACK
   恢复流量，持续故障由独立健康指标和告警处理。
13. 独立 Worker 的启动就绪只有在恢复循环完成首次完整成功 pass 后才永久打开；该 pass 必须执行真实
   PostgreSQL Claim 查询，且取得的恢复/风控任务不能留下处理错误。初始连续失败或 poison claim 保持
   不就绪，无任务的成功 pass 也可晋级；晋级后的瞬时故障继续由恢复新鲜度告警负责而不反复摘掉指标
   目标。API 与 combined 角色的基础就绪语义不受该启动门禁影响。
14. 针对当前固定 Vector 0.57 在低流量磁盘缓冲下可能等待下一事件的读取唤醒竞态，中央和本机配置
   每 10 秒生成一次从空对象重建的 `service/time/level/msg` 四字段安全心跳，与业务事件进入同一磁盘
   sink。A 阶段在出口中断时产生一条业务探针并先证明其进入磁盘，B 阶段在接收端就绪后用全新 sender
   和 `data_dir` 产生另一条在线探针；两阶段都要求各自 25 秒内精确交付一次。静态负测拒绝恢复 90 秒
   等待、在同一阶段增加第二业务唤醒或把 Prometheus counter 重新耦合进交付判断。文件增长和唯一
   digest 证明
   本机 25 秒业务边界；counter 另以最多 35 秒覆盖两个 15 秒传播周期。稳定运行名义值为每实例
   8,640 条/日，启动/重启余量另计；这不是上游修复，外部 archive 的容量、费用、TLS、保留和合规
   仍是生产门禁。

## P0 发布阻断

- 提供可审计的 Primal Rampage 品牌包与全部运行素材授权链，或完成原创替换；重新生成流式清单、
  release manifest 和仓库外逐文件哈希审批。
- 提供经签名批准的 production game definition。当前 DemoConfig 明确未经认证，不能用于真钱环境。
- 完成独立 RNG、数学、RTP、特性与逐司法辖区认证，以及运营商钱包幂等/故障/容量 conformance。
- 在目标 AWS 账号完成并保存 WAF、ALB/EKS、RDS/Valkey、ECR 扫描、AMP/CloudWatch、告警到人、
  备份隔离恢复和跨区灾备的实时回读与演练证据。
- 如果产品范围包含公共累进奖池，必须先交付独立的 reserve/finalize 资金账本与认证；当前固定倍数命名
  不能被描述为公共累进奖池。高额人工风控的仓库状态机已经实现，但生产启用仍必须完成个人身份、
  双人复核、监管保留和联合故障演练。

## P1 工程缺口

- Big Win、Free Spins 与 Wheel 的仓库事件租约和确定性门禁已完成；下一步仍须在真实弱网和设备上测量
  首局网络字节、首事件延迟、GPU 峰值与首个可交互时间，并把目标包独占字节和包含共享依赖的完整事件
  闭包分开报告。主要交互音频仍由严格交互就绪门统一拥有，并未伪装成视觉事件独占节省。
- 服务端 W3C/OTLP、浏览器逐请求 `traceparent` 与部署接口已实现；浏览器指标/视觉遥测仍须使用隐私字段
  白名单且默认无 sink。目标平台还需验证
  collector TLS、容量、保留期、可检索父子链，并桥接 SDK 自监控以观测官方 BatchSpanProcessor 队列丢弃。
- 高额风控策略默认关闭，Chart 尚未暴露启用参数；生产平台接入前必须增加受保护配置发布合同，并由
  外部运营平台提供个人 SSO/MFA、职责分离、双人复核、案件号和监管审计导出。
- 同区域 RDS read replica、独立 endpoint、ReplicaLag/容量告警、继承合同和 live drift 门禁已实现，但
  四套环境示例均默认关闭，应用合同也固定 `application_routing_adopted=false`。下一步必须基于真实只读
  查询/一致性/连接 profile 决定是否启用并改造应用路由；RDS Proxy/PgBouncer 与时间分区仍未实现，
  不能用副本接口冒充这些能力或跨区 DR。
- 为定时 RDS 冷归档、恢复验证、CloudFront 预热、辖区 Geo restriction 和 Route 53 路由保存平台接口
  与目标环境证据。
- 销售演示视频须在仓库外单独保存、验收和交付；不得混入 Web runtime 发布包，也不得展示凭据、连接串或原始业务标识。

## 明确替代的建议

| 原建议 | 仓库采用的边界 |
| --- | --- |
| 玩家 ID 哈希路由的内存无锁钱包扣减 | 运营商钱包原子幂等命令、签名回执、PostgreSQL 持久状态与未知结果查询 |
| Web Worker 计算赢分或赔率 | Worker 只做无经济语义的资源/视觉工作；中奖、RNG 与派彩只在服务端 |
| 浏览器反调试、蜜罐变量、内存修改器检测作为安全边界 | 短时令牌、严格协议、CSP/Trusted Types、资源完整性、服务端权威和经隐私评审的外部风控 |
| 为形式统一把全部 HTTP 换成 WebSocket/自定义 Protobuf | 保留签名 HTTPS、幂等、202 持久恢复和状态查询；只有同等恢复语义与真实收益证据齐备才新增版本化传输 |
| KMS 作为游戏 RNG 熵源 | 游戏进程使用 OS CSPRNG 并失败关闭；KMS 管理密钥材料，RNG 由独立实验室认证 |
| Big Win 任意叠加双私钥签名 | 全部局统一使用权威结果签名、钱包回执校验、持久结果哈希与审计 Outbox；高额风控使用独立持久状态机 |
| Valkey 保存奖池热点后异步回写为资金权威 | PostgreSQL 或经认证 jackpot service 执行 reserve/finalize；Valkey 只允许缓存、限流或广播 |

## 当前验证入口

```sh
make verify-hardening-checklist
make verify-hardening-stability-50
cd web && npm test -- --run
cd ../server && go test ./...
cd .. && make verify-supply-chain-contract
./infra/terraform/scripts/verify-static-contract.sh
./infra/terraform/scripts/test-negative-contract.sh
./deploy/aws-production/workflow/test-live-application-secrets.sh
```

`verify-hardening-stability-50` 每轮使用轮次作为 Go/Vitest shuffle seed，执行整仓 Go、全部 Web 测试、
Terraform/AWS workflow/Cluster/Observability/Supply Chain/Web/本地生产静态合同、PromQL 行为测试和清单
验证。它会精确核对允许跳过的 23 个外部 PostgreSQL/Valkey/profile 测试，拒绝新增静默 skip，并要求
起止源码 SHA-256 一致。每轮工具版本、种子、通过/跳过数量和耗时写入 ignored 的
`.artifacts/hardening-stability/*.tsv`；任何失败都必须修复后重新从第 1 轮计数。

## 本次本地验证快照

- Web：TypeScript 类型检查、production build、bundle/许可/来源/streaming manifest 契约全部通过；
  串行 Vitest 为 `145/145` 文件、`1977/1977` 测试，另有真实 `/casino/primal/` 子路径构建断言。13 个
  生产 JavaScript 分块均低于 500,000 bytes，
  静态分块图无循环。真实 Chrome 在精确 CSP/Trusted Types 下完成 exchange、Spin、权威结果表现、
  余额更新和 ACK；`cspViolationCount=0`、WebGL 就绪、ACK/Spin/exchange 均精确一次。
- Go：`go test ./...`、`go test -race ./...`、`go vet ./...` 与 `go build ./...` 全部通过。另以固定摘要的
  临时 PostgreSQL 17 容器、独立 migrator/runtime 角色执行全新 `0001..0012`、两个并发 `up`、`verify`
  和 15 条精确 PostgreSQL conformance 测试；全部通过后删除容器和临时数据库，未触碰本地生产库。
- 发布契约：供应链正向/负向合同、第三方声明、可观测性静态/渲染合同、34 条 Prometheus 规则、
  Cluster 五套 Helm 渲染与 kubeconform、AWS 渲染/工作流静态合同和完整本地 mock 回读套件均通过。
  Terraform 静态合同通过，204 个危险变体全部被拒绝；21 组/933 项仅名称加固清单及跳过项审计通过。
- Vector 低流量归档：当前固定 0.57 镜像的隔离行为回归覆盖“A 阶段中断并证明磁盘持久化、B 阶段
  receiver-ready 后使用全新 sender/data_dir、每阶段各一条业务探针、10 秒四字段心跳、各自 25 秒内
  精确一次且无原始 metric”。本地完整部署须从干净的最终 `main` 或受保护 Tag 构建，并以在线
  `release-manifest.json` 的完整 revision 回读作为独立证据。本机验收已把 25 秒精确落盘与最长 35 秒 sent counter 新鲜度观测分离；外部 archive 实际
  容量与合规结果不由该隔离测试替代。
- 本次正式收口按要求没有重新启动 `verify-hardening-stability-50`；此前中止的部分轮次和旧源码上的
  定向循环都不作为当前最终源码的“50/50”证据。当前结论来自上述一次完整回归、独立对抗复核和
  精确负向合同。

本机有 Helm、kubeconform、Docker 和真实 Chrome，但没有 Terraform/OpenTofu CLI，因此没有执行
`terraform fmt/validate/plan/apply`；AWS 回读是本地 mock，不是目标账号证据。真实 AWS、正式钱包、
设备实验室、外部认证与告警到人必须分别保存目标环境结果，不能由本快照替代。

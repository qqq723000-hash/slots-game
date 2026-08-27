# 本机集成验收

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

此目录在一台 macOS 主机上以 `RGS_ENVIRONMENT=production` 配置分支运行完整集成验收，
不属于 AWS 正式生产拓扑，也不能证明多可用区、托管服务或云端安全控制已经落地。环境使用
TLS PostgreSQL、TLS/ACL Valkey 共享准入、一次性迁移器、独立公网/运维监听器、HTTPS 入口、持久化钱包与审计
接收端、Prometheus、Grafana、Alertmanager 和 Vector。所有宿主机端口仅绑定回环地址。

运行态镜像只包含二进制、最终 Web 白名单资产和必要配置；源码、测试、研究文档、
视觉证据和开发服务器不会进入容器。`state/` 位于仓库外，保存密钥、持久卷导出和
本机生成的配置，权限必须为 `0700`。

## 首次部署

```sh
./deploy/local-production/bootstrap.sh
./deploy/local-production/up.sh
./deploy/local-production/trust-local-ca.sh --confirm slots-local-production-ca
./deploy/local-production/verify.sh
```

`bootstrap.sh` 仅使用已审核的 Node.js `v22.22.0`，安装 lockfile 依赖、重新生成
生产 Web 产物，然后构建最小运行镜像。源码、依赖锁、构建配置或 Web 资源有任何变化时，
必须重新执行 `bootstrap.sh`；`up.sh` 只重启最后一次通过 bootstrap 审计的镜像，禁止隐式
重建。`up.sh` 会在启动后自动执行端到端验收；
宿主机必须安装 Google Chrome 或 Chromium，以执行真实 WebGL 会话门禁。
CA 信任命令只修改当前用户的 macOS 登录钥匙串；系统可能要求一次用户确认。

Valkey 只加入未发布到宿主机的内部 `admission` 网络，使用固定摘要镜像、独立 TLS
证书、专用 `rgs-api` ACL、文件口令与 HMAC，并固定 `noeviction`。旧本地状态首次升级时，
`bootstrap.sh` 只补齐全部缺失的四个 Valkey 专用材料；若发现部分文件存在则失败关闭，
不会轮换任何既有数据库、钱包、签名或入口密钥。

当仓库固化的游戏定义版本变化时，`bootstrap.sh` 会先验证现有定义及 Ed25519 审批，
只有在受本目录管理的 `rgs-server` 已停止，且 PostgreSQL 只读门禁证明旧定义的未过期会话、活跃特性、
未终态轮次和有效期内未交付结果全部为零后，才复用原定义审批密钥签署新摘要，并把旧
`definition.json` 和审批信封保存到受限备份目录；
证书、口令、令牌和持久化数据不会随之轮换。只识别明确列入迁移器的旧定义，未知、损坏
或签名不匹配的状态会失败关闭。受本机技术授权约束的资源审批也会与当前发布清单幂等核对：
先在 0700 artifacts 目录生成并独立验证 0600 候选，不修改已提交审批；定义提交成功后才核对
准备阶段记录的前序摘要、保留旧审批备份并原子提交候选。定义提交失败不会污染已提交审批，
外部运营商审批也不会被自动覆盖。

`bootstrap.sh`、`up.sh`、`down.sh` 与 `destroy.sh` 共用仓库外状态目录中的内核排他锁；
macOS 本机部署使用 BSD `lockf`，Linux 合同门禁使用等价的 util-linux `flock`。进程退出时锁由
内核释放，不依赖可陈旧的 PID 文件。bootstrap 先用唯一候选 tag 完成
静态检查、来源证明构建和镜像存在性核对，不覆盖 Compose 当前选择的已提交镜像，且自有镜像
设置 `pull_policy: never`，不会从远端补取本机候选 tag；排空、定义和资源审批提交全部通过后，
才原子替换 `compose.env` 使下一次启动选择候选 tag。`up.sh` 还会在启动任何容器前核对 Compose
中的游戏/定义身份、当前签名审批以及资源审批逐字节 SHA-256；若中断发生在定义或资源审批已经
提交、但镜像选择器尚未提交的混合代际窗口，启动会失败关闭并要求重跑 bootstrap 收敛。若尚未
提交任何新状态，旧代仍可安全启动；系统不会把“新审批 + 旧镜像”或“新定义 + 旧镜像”当成可启动状态。
这些措施只协调本目录的单机命令；手工 Docker 操作、其他主机或多副本发布仍必须由外部发布栅栏
阻止旧定义的新 launch，不能把本机锁当成集群级原子切换。

本地镜像构建会注入 OCI `created/revision/source/version` 标签，并由 `bootstrap.sh`
通过 BuildKit 命令行参数显式生成 `mode=max` SLSA provenance；Compose 文件本身
保持兼容稳定版 schema。默认 revision 来自当前 Git commit；工作区未提交时追加
`-dirty`，避免把脏源码误标为已提交版本；默认 version 来自仓库根目录的 `VERSION`，
并在修改仓库外状态前验证它与 CHANGELOG、Web、Helm 等版本合同一致，避免本机镜像与源码
发布版本失配。自动化构建可显式设置
`LOCAL_PRODUCTION_IMAGE_CREATED`、`LOCAL_PRODUCTION_IMAGE_REVISION`、
`LOCAL_PRODUCTION_IMAGE_SOURCE`；`LOCAL_PRODUCTION_IMAGE_VERSION` 只能重复仓库的 canonical
版本，不能留空，也不能用作 profile、环境名或任意别名。部署类型单独记录为
`com.slots-game.deployment.profile=local-production`。所有格式会在写入 Compose 环境前校验。
静态约束可单独执行：

Web、HTTPS 入口与告警代理继续使用固定多架构摘要的官方 `nginxinc/nginx-unprivileged`
基线和 UID `101`。由于该上游基线尚未包含 Alpine 的 OpenSSL 安全修复，构建按
`amd64`/`arm64` 从 Alpine v3.24 官方稳定仓库取得内容摘要固定的 `libcrypto3`、
`libssl3` `3.5.8-r0` APK，并通过只读挂载离线安装和核对精确版本；不会执行可变
`apk upgrade`。入口与告警代理共用同一 `slots-nginx-proxy` 候选 tag，仍保留各自
带固定 CA 的 `wget` TLS 健康探针。

```sh
./deploy/local-production/verify-static-contract.sh
```

访问地址：

- 游戏与本机运营入口：`https://slots.localhost:8443/operator/`
- RGS API：`https://rgs.localhost:8443`
- Grafana：`http://127.0.0.1:3000`
- Prometheus：`http://127.0.0.1:9090`
- Alertmanager：`https://localhost:9093`（Bearer token 位于仓库外状态目录）

RGS 公共入口只发布业务 API，`https://rgs.localhost:8443/healthz` 固定返回 404。容器存活由
私有 operations `8081/healthz` 无 Bearer 探测，就绪与指标仍在同一私有端口使用文件 Bearer；
运维监听器不发布到宿主机。

`slots.localhost` 与 `rgs.localhost` 统一返回一年 HSTS。Grafana 仅使用固定 digest
镜像和随部署生成的 provisioning bundle；版本检查、使用统计、插件目录写入与插件
自动安装均已关闭。如需新增插件，应更新固定镜像并重新完成供应链审核，不能在运行
容器内临时安装。

RGS 到本机钱包的 HTTPS 调用通过 `RGS_WALLET_ROOT_CA_FILE` 在钱包专用客户端中加载
`local-production-root-ca.pem`，并继续执行证书链与 `wallet` 主机名校验。根证书文件缺失、
超限或不含有效证书时，RGS 会拒绝启动，不会降级为明文或跳过 TLS 验证。

### 本机运营入口凭据

管理员访问令牌由首次部署生成，只保存在仓库外的受限状态目录。使用以下命令把令牌
直接复制到 macOS 剪贴板，终端不会显示令牌内容：

```sh
slots_state_root="${XDG_DATA_HOME:-$HOME/.local/share}/slots-game-production"
pbcopy < "$slots_state_root/secrets/local-operator-admin.token"
```

打开 `https://slots.localhost:8443/operator/` 后粘贴该值。玩家 ID 与钱包账户 ID 可留空；
本机运营服务会使用部署时固定的默认测试身份。入口返回 `401` 时，应重新从上述文件
复制当前令牌，不要把令牌写入 URL、截图、聊天记录或仓库。

本地 profile 把已签名 operator 空闲策略固定为 20 分钟；这是本机验收策略，不是对外部参考版本
公开分钟数的声明。只有成功接受的新经济轮次续期，status/refresh/保活不续期。超时后新的
launch 会复用同一尚未绝对过期的服务端会话并重置 transport generation，保留余额、revision、
feature 与 pending result；浏览器不能提交 `sessionId` 选择要复用的会话。Web 构建还固定注入
`VITE_OPERATOR_RETURN_URL=/operator/`，因此顶层同源游戏执行 EXIT 时回到本机运营入口。

`verify.sh` 不仅检查 HTTP 探针，还会在临时 Chrome 配置中创建并消费一次性会话，确认
精确 RGS origin 的 POST 交换成功、会话已应用到玩家余额、地址栏片段已清除、严格 CSP
生效且游戏画布完成就绪；进程退出时会删除
临时浏览器目录和启动响应。

## 运维与恢复

```sh
./deploy/local-production/backup-now.sh
./deploy/local-production/down.sh
./deploy/local-production/up.sh
```

备份服务每 6 小时生成同一时间标记的 RGS 库、local-operator 库与审计/日志/告警归档，
最后原子发布 SHA-256 完成清单，默认保留 14 天。`backup-now.sh` 还会在无网络、
无宿主机端口的临时 PostgreSQL 中真实恢复两个数据库。

每次周期备份会原子更新 `backups/backup-status.json`；失败后每分钟重试，容器健康
检查与 Prometheus 同时校验最近成功时间、连续失败次数和状态文件结构。成功时间超过
7 小时会触发 `LocalProductionBackupStale`，任何连续失败会触发
`LocalProductionBackupFailed`。

Alertmanager 默认 receiver 通过 TLS 主机名校验和文件 Bearer 投递到 local-operator，
通知按规范化内容摘要幂等写入 `alerts/events.jsonl`，不再静默吞掉告警。审计、脱敏日志
和告警均使用原子只读分段归档；Prometheus 在 75% 容量时预警。硬配额不足时对应 sink
失败闭合，但基础 readiness 保持可观测，避免因磁盘水位产生无意义重启循环。审计归档
不会自动删除；运行日志只会在总配额不足时删除至少 24 小时前的最旧只读段，确保已越过
六小时备份窗口。

`down.sh` 只停止容器，不删除数据库、钱包、审计、日志或监控卷。只有显式执行
`destroy.sh --confirm slots-game-production` 才会删除本部署的 Compose 卷；该脚本会再次核对
项目名，避免误删其他 Docker 数据。仓库外的密钥和备份始终保留。

生成器把本机授权标记为 `LOCAL_TECHNICAL_PRODUCTION`。它满足应用的生产配置与
密码学边界，但不把本机材料描述为任何外部机构的证明。

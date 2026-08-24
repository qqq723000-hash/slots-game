# 本机集成验收

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

本地镜像构建会注入 OCI `created/revision/source/version` 标签，并由 `bootstrap.sh`
通过 BuildKit 命令行参数显式生成 `mode=max` SLSA provenance；Compose 文件本身
保持兼容稳定版 schema。默认 revision 来自当前 Git commit；工作区未提交时追加
`-dirty`，避免把脏源码误标为已提交版本。自动化构建可显式设置
`LOCAL_PRODUCTION_IMAGE_CREATED`、`LOCAL_PRODUCTION_IMAGE_REVISION`、
`LOCAL_PRODUCTION_IMAGE_SOURCE` 与 `LOCAL_PRODUCTION_IMAGE_VERSION`，格式会在写入
Compose 环境前校验。静态约束可单独执行：

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

本地 profile 把已签名 operator 空闲策略固定为 20 分钟；这是本机验收策略，不是对原游戏
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

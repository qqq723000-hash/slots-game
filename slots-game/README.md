# Iron Colossus 商用交付项目

本仓库包含完整的 Go RGS 后端、PostgreSQL 迁移器、运营商/钱包适配服务、TypeScript/PixiJS
前端、生产容器、监控告警、日志采集、备份恢复和供应链门禁。浏览器只展示服务端已验证结果；
RNG、余额、派彩、特性状态和幂等轮次均由服务端负责。

生产入口只接受完整的 HTTPS RGS 配置及一次性运营商交接值；任何缺失或畸形配置都会在下注前
失败关闭。

## 目录

- `server/`：`rgs-server`、`rgs-migrator`、本机运营/钱包服务和生产配置引导器；
- `web/`：只消费权威 RGS 结果的浏览器表现层；
- `deploy/local-production/`：macOS 本机完整生产模式编排；
- `deploy/cluster-production/`：公司 Kubernetes 集群的 RGS、Web 与一次性 migrator Helm 交付；
- `deploy/observability/`：Prometheus、Grafana、Alertmanager 与 Vector 契约；
- `deploy/supply-chain/`：漏洞/密钥扫描、SBOM、来源证明与镜像签名门禁；
- `docs/`：架构、运营商集成、迁移、恢复、密钥轮换与安全运行手册。

当前正式版本及兼容边界见 [变更记录](CHANGELOG.md)。

## 本机正式部署

前置环境为 Docker Desktop、Go 1.26.6、Node.js 22.22.0 和 Git LFS 3.7.1。克隆后先执行
`git lfs install --local && git lfs pull`，再进行首次部署：

```sh
./deploy/local-production/bootstrap.sh
./deploy/local-production/up.sh
./deploy/local-production/verify.sh
```

默认入口：

- 运营入口与游戏：`https://slots.localhost:8443/operator/`
- RGS：`https://rgs.localhost:8443`
- Grafana：`http://127.0.0.1:3000`
- Prometheus：`http://127.0.0.1:9090`
- Alertmanager：`https://localhost:9093`（需要仓库外状态目录中的 Bearer token）

运行状态和真实凭据位于仓库外的
`${XDG_DATA_HOME:-$HOME/.local/share}/slots-game-production/`，不得复制回 Git。停止服务使用 `down.sh`；
只有明确需要销毁本部署持久卷时才执行 `destroy.sh`。

完整说明见 [本机生产部署手册](deploy/local-production/README.md)。

## 公司集群生产部署

集群交付不复用本机 `local-operator` 或本机 PostgreSQL，只引用公司提供的入口网关、全局限流、
高可用 PostgreSQL、钱包、审计、密钥同步与 Prometheus Operator。先按
[公司集群生产部署手册](deploy/cluster-production/README.md) 准备外部 Secret/CIDR/selector 和镜像摘要，再执行：

```sh
make verify-deployment-contracts
helm upgrade --install slots deploy/cluster-production/chart \
  --namespace slots-production --create-namespace \
  -f /secure/change/slots-production-values.yaml \
  --atomic --wait --timeout 15m
```

当前受保护发布制品只交付 `linux/amd64`。数据库模式、数学定义变更不能走普通无停机滚动；Web
稳定路径素材也要求公司蓝绿发布或版本化 CDN 隔离。详细的本机与公司集群双树见
[生产架构](docs/architecture.md)。

## 交付验证

```sh
make bootstrap
make verify
make test-postgres
make verify-deployment-contracts
./deploy/local-production/verify.sh
```

前端发布镜像还要求仓库外的精确资源审批文件，并通过 BuildKit secret mount 注入：

```sh
RELEASE_ASSET_APPROVAL_FILE=/secure/release/asset-approval.json \
VITE_RGS_BASE_URL=https://rgs.example \
VITE_RGS_BET_OPTIONS_MINOR=10,20,50,100,200 \
VITE_RGS_DEFAULT_BET_MINOR=100 \
VITE_RGS_HOST_ORIGIN=https://operator.example \
  make build-web-release-image
```

## 生产不变量

- 金额始终使用最小货币单位的规范十进制字符串，禁止浮点结算；
- 同一轮次使用稳定 `operationId` 执行一条原子钱包命令，未知结果只查询、不重复扣款；
- PostgreSQL、钱包、审计出口或生产审批不可用时，就绪探针失败；
- 一次性启动码、Bearer token、私钥和 DSN 不进入浏览器存储、日志、Git 或镜像层；
- 迁移器与运行时使用独立角色，运行时不能取得 DDL 权限；
- 生产资源由字节长度、SHA-256、发布清单和外部审批逐项绑定。

详细生产架构树见 [docs/architecture.md](docs/architecture.md)，贡献和注释规范见
[CONTRIBUTING.md](CONTRIBUTING.md)。

# 本机生产部署

此目录把项目以 `RGS_ENVIRONMENT=production` 运行在一台 macOS 主机上。部署使用
TLS PostgreSQL、一次性迁移器、独立公网/运维监听器、HTTPS 入口、持久化钱包与审计
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
生产 Web 产物，然后构建最小运行镜像。`up.sh` 会在启动后自动执行端到端验收。
CA 信任命令只修改当前用户的 macOS 登录钥匙串；系统可能要求一次用户确认。

本地镜像构建会注入 OCI `created/revision/source/version` 标签，并由 `bootstrap.sh` 与
`up.sh` 通过 BuildKit 命令行参数显式生成 `mode=max` SLSA provenance；Compose 文件本身
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

`slots.localhost` 与 `rgs.localhost` 统一返回一年 HSTS。Grafana 仅使用固定 digest
镜像和随部署生成的 provisioning bundle；版本检查、使用统计、插件目录写入与插件
自动安装均已关闭。如需新增插件，应更新固定镜像并重新完成供应链审核，不能在运行
容器内临时安装。

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

# Iron Colossus

生产级槽位游戏交付仓库，包含权威 Go RGS、PostgreSQL、运营商/钱包适配服务、
TypeScript/PixiJS 前端、容器编排、监控告警、日志采集、备份恢复与供应链门禁。

项目源码位于 [`slots-game/`](slots-game/)，GitHub Actions 位于 [`.github/workflows/`](.github/workflows/)。
本机完整部署、公司 Kubernetes 集群 Helm 交付、验证、运维和双树架构说明请从
[`slots-game/README.md`](slots-game/README.md) 开始；集群入口为
[`slots-game/deploy/cluster-production/`](slots-game/deploy/cluster-production/)。

本仓库不保存运行密码、私钥、数据库、日志、发布审批或构建产物；这些内容由部署脚本写入
仓库外的受限状态目录。

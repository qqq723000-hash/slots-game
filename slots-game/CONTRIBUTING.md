# 贡献指南

## 不可破坏的不变量

- 服务端是结果、余额、RNG、特性状态、轮次修订和定义身份的唯一事实来源；
- 前端只驱动已经验证的服务端结果，不得本地重摇、补奖或修改派彩；
- 金额使用整数最小货币单位，禁止浮点结算；
- 同一轮次只允许一条稳定 `operationId` 的原子钱包命令；未知状态只查询、不重复调用；
- 生产配置、签名、数据库、钱包、审计或外部依赖缺失时必须失败关闭；
- 动画、音频和字幕可以延迟，但不能重算或回滚已经提交的经济结果；
- 抓包、研究截图、真实凭据、发布审批和本机状态禁止进入 Git 或容器。

## 修改流程

1. 克隆后执行 `git lfs install --local && git lfs pull`，确保生产二进制资源不是指针文件；
2. 先确定改动属于表现层、协议层、经济层还是发布基础设施；
3. 先补失败测试，再做最小实现；
4. 为取消、销毁、幂等、并发、迟到回调、超时与重试补齐边界测试；
5. 关键路径使用中文注释解释设计原因与禁止行为，不逐句翻译代码；
6. 修改协议、资源或配置时同步更新 OpenAPI、manifest、运行手册和契约负测；
7. 不提交生成目录、运行状态、真实证书/密钥、`.env` 或发布资源审批文件。
8. 新增或替换 Web 素材时同步更新权属分类、运行清单和仓库外逐文件审批；SHA-256 一致不等于
   已取得商标、著作权或商业分发授权。

注释细则见 [docs/code-comment-standard.md](docs/code-comment-standard.md)。Go 导出标识符遵循
GoDoc 命名要求；协议字段、错误码、指标名和标准术语保留英文。

## 提交前验证

```sh
cd web
npm ci
npm run typecheck
npm test -- --run --fileParallelism=false
npm run assets:provenance-check
npm run assets:check-streaming-packages
npm run build
npm run build:determinism-check
npm run build:assets-check
npm run build:bundle-check

cd ../server
go mod verify
go test ./...
go test -race ./...
go vet ./...
go build ./...

cd ..
make verify-supply-chain-contract
make verify-web-container-contract
make verify-deployment-contracts
```

涉及数据库、迁移、钱包或恢复时还必须运行 `make test-postgres`；涉及本机集成验收编排时运行
`./deploy/local-production/verify.sh`。涉及 Helm、网络策略、Secret、探针、容量或发布 Hook 时，
必须同时评审 `deploy/cluster-production/` 的渲染结果，并保留失败关闭负测。

涉及公共入口、WAF、限流、超时、请求大小、密码学容量或恢复保留容量时，还必须同步更新
`docs/ddos-threat-model.md`，运行受控的滥用 profile，并明确区分本机负载证据、目标云环境验收和
需要预授权的 DDoS 模拟。不得对未获授权的生产端点执行压力、穿透或 DDoS 测试。

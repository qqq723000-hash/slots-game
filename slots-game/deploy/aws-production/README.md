# AWS 正式交付契约

本目录把通用 Helm Chart 收敛为 AWS 正式环境的可执行发布边界，它不提交 Secret。应用专属的
VPC、EKS、RDS、Valkey、ECR、Secrets Manager 元数据、S3、CloudFront、KMS、IAM、AMP、CloudWatch、
API regional WAF 和备份资源由 `infra/terraform` 创建；企业平台仓库提供账号、部署身份、state、
DNS/证书、CloudFront global WAF 与组织级安全能力。

```text
AWS 正式交付
├── Web 边缘面
│   ├── Route 53
│   ├── CloudFront + AWS WAF
│   └── 私有 S3 + OAC + release ID 不可变前缀
├── RGS 在线面
│   ├── Route 53
│   ├── Shield Standard 服务基线 + Regional AWS WAF + 公网 ALB
│   │   ├── ACM 证书在 ALB 终止 TLS
│   │   ├── HTTP 80 强制重定向到 HTTPS 443
│   │   └── ip target 转发到 EKS RGS Service
│   └── EKS
│       ├── RGS API/Worker Deployment + HPA + PDB
│       ├── Cluster Autoscaler + 托管节点组
│       ├── migrator Helm hook Job
│       ├── 默认拒绝 NetworkPolicy
│       └── ServiceMonitor + PrometheusRule
└── 外部状态与平台面
    ├── RDS PostgreSQL Multi-AZ
    ├── TLS/ACL Valkey 共享准入状态
    ├── Secrets Manager 同步的版本化 Kubernetes Secret
    ├── 外部钱包与幂等审计接收端
    └── Prometheus Agent/ADOT → AMP，CloudWatch 日志与 AMG
```

## 目录内容

- `values.example.yaml`：AWS 字段形状与失败闭合基线，所有账号、ARN、域名、digest、CIDR、
  subnet、security group 和日志 bucket 都是不可部署占位值。
- `verify-static-contract.sh`：运行 Helm strict lint、install/upgrade 渲染、AWS 语义负向测试及
  Kubernetes 1.30 kubeconform strict 校验。
- `verify-rendered-contract.rb`：解析实际 YAML，证明 EKS 不包含 Web、Ingress 使用 ALB、TLS 不引用
  Kubernetes Secret、WAF/ACM/安全组/三子网/访问日志已声明、API NetworkPolicy 只接受受控 CIDR。
- `verify-live-platform-prerequisites.sh`：在受保护私网执行器只读回查实际 Regional/CloudFront WAF、
  日志、CloudWatch 告警、CloudFront distribution/OAC、EKS add-on/Pod Identity 与应用依赖；其中
  vpc-cni 必须是 delivery 固定版本、`ACTIVE`、实际 `enableNetworkPolicy=true`，且 aws-node 精确绑定专用
  Pod Identity；CloudWatch Observability 同样必须固定版本、`ACTIVE`、实际启用 container logs/增强
  Container Insights，并证明 cloudwatch-agent 与 fluent-bit DaemonSet 在全部节点就绪。仓库测试只运行
  本地 AWS/kubectl 夹具，不能作为真实账号验收结果。
- `verify-waf-rollout-evidence.rb`：只在 staged rule 为 Block 时读取精确 S3 object version，核对
  SHA-256、SSE-KMS/Object Lock、当前规则 configuration hash、源码 commit、七天观测、双人审批与
  回滚 schema；晋级/配置变化要求未过期批准，稳态只重验不可变历史绑定，不输出证据正文。
- `verify-live-alb-edge.sh`：Helm 后有界重试实际 ALB reconcile，精确回查子网/SG/WAF、TLS 1.2/1.3
  policy 与 ACM 证书、`waf.fail_open.enabled=false`、HTTP 仅默认 301、HTTPS 默认 404 加唯一
  host + Prefix `/` forward rule、Terraform delivery 批准的 access log bucket/环境 prefix、8081 health，
  并要求当前 release 的每个 Ready RGS Pod IP 都成为健康
  8080 target；旧 target 仅允许 draining。本地 mock 不等于真实 AWS 验收。

## 必须保持的边界

ALB access log bucket 与环境 prefix 是企业落地区受保护输入，必须由 delivery 精确传递到 Ingress 和实际
ALB 属性；legacy ALB access logs 使用 AWS 支持的 SSE-S3 边界，本仓库不会错误要求该日志目标使用 KMS。

1. `web.enabled=false`。Web 制品发布到私有 S3，CloudFront 只能通过 OAC 读取，并由 release ID
   路由隔离版本；EKS 不创建 Web Deployment、Service、Ingress、HPA、PDB 或 ServiceAccount。
   S3 输入必须由 `deploy/supply-chain/extract-aws-web-static-root.sh` 从已验证的 Web OCI digest
   提取并逐文件对照 `release-manifest.json`，不得直接同步工作区 dist。CloudFront Response Headers
   Policy 必须使用同一 digest 提取的 CSP，并与 bundle 的 `CONFIGURATION_SHA256` 一起归档。
2. `ingress.className=alb` 且 `ingress.tlsSecretEnabled=false`。公网证书来自 ALB 所在区域的 ACM；
   示例中的两个 TLS Secret 名称只为兼容通用 schema，渲染结果不得引用它们。
3. ALB 必须绑定 WAFv2、ACM、三个明确子网和专用安全组并使用 `ip` target。业务转发仍走 Pod
   `8080`，target health 以数值端口 `8081` 直连私有 operations `/healthz`；公网 `/healthz` 由
   Regional WAF 精确返回 404，应用公网 handler 也不提供该路由。依赖就绪由 Pod 对私有
   `8081/readyz` 的 Kubernetes readiness 控制；ALB 不得用需要 Bearer 的 `/readyz` 作为 target
   health。ALB SG 必须分别只向 VPC 数据路径开放 TCP 8080 与 TCP 8081 egress，不得用端口范围或公网
   egress 替代；443 listener 固定批准的 TLS 1.2/1.3 policy 与 regional ACM ARN。同时必须开启
   删除保护、无效请求头丢弃、`strictest` desync mitigation、30 秒 idle timeout、300 秒 client
   keepalive 和 S3 访问日志。动态 API 的权威入口就是公网 ALB；CloudFront 不代理 API，因此不得用
   “只允许 CloudFront IP/共享 Header”把 ALB 误封。若未来引入 CloudFront 或 Global Accelerator，
   必须在同一变更交付可达的上游、健康检查、源站访问和回滚方案。
4. `networkPolicy.ingressController.mode=cidrs`。示例三个 `/24` 只表示经审批的 ALB 入口子网；正式值
   必须按实际 ALB/EKS 数据路径逐个替换并叠加 security group，只对这些来源开放业务 8080 与健康
   检查 8081，禁止使用整个 VPC 或 `0.0.0.0/0`。
5. RDS、Valkey、钱包和审计出口只填写平台确认的 `/24` 或更窄 IPv4 网段。RDS/Valkey 故障转移
   需覆盖全部数据子网，同时由各自 security group 只接受 RGS 节点路径；Worker 不获得 Valkey 出口。
6. 所有镜像使用 ECR 返回的 `sha256` manifest digest。示例的重复数字摘要不得进入变更单。
7. Terraform 基础设施 `apply` 不代表应用可以发布。EKS 私网 API 只能由 VPC 内受保护执行器访问；
   AWS Load Balancer Controller、Cluster Autoscaler、External Secrets、metrics-server、Prometheus Operator、
   kube-state-metrics、Prometheus Agent 及所需 CRD/APIService
   必须先按 `infra/terraform/contracts/cluster-addons-interface.v1.yaml` 安装并通过实时门禁。RGS
   ServiceAccount 不获得 AWS 身份，Valkey 使用版本化 Secret 中的 A/B ACL 用户名和密码文件、HMAC key
   文件及显式 TLS 根证书；两个 ACL 用户始终留在 user group，当前发布只选择其中一个。
8. External Secrets 同步资源必须由 `render-external-secrets.rb` 从受保护、版本化的 Terraform
   `delivery` JSON 生成 namespace 级 SecretStore 和六个 ExternalSecret。渲染内容只有 Secret 名称和
   属性映射，不含 Secret 值；其中五个应用 Secret 元数据容器必须先由各职责的受控写入/轮换流程填充，
   shared-admission Secret 由受保护 Terraform 轮换状态机发布，任何空容器都不能冒充就绪。
9. `monitoring/prometheus-agent` 必须是 Operator 管理的 PrometheusAgent，使用专用 ServiceAccount、
   精确二进制版本、只选择 `slots-game` ServiceMonitor，并以 SigV4 写入当前 AMP workspace。Agent
   不求值 PrometheusRule；Chart 规则同步到 AMP rule group 及最终告警路由仍是上线前独立证据。
10. API 与 Worker 运行资产必须分别同步到 `api-runtime-assets` 和 `worker-runtime-assets` 版本化 Secret。
    Worker Secret 禁止包含 `launch-hmac.key`、operator access 私钥或 operator response 私钥；节点层扩容必须由
    固定 Chart/镜像版本的 Cluster Autoscaler 使用专用 Pod Identity 完成，Terraform 不回写它接管的 `desired_size`。
11. Valkey 普通密码轮换必须先对保存的 Terraform plan 执行
    `infra/terraform/scripts/verify-valkey-rotation-plan.rb`。状态机禁止重置当前活动槽、禁止切槽时修改密码，
    并把两个密码与 HMAC fingerprint 绑定到实际 ephemeral 值。HMAC 桶重置必须由独立私网流程生产
    版本化静默证据；单个已保存 plan 在同一活动槽内进入维护、换 HMAC 并把 Secret 版本递增 2，
    随后单独 plan 退回 target `steady`。维护模式尚未退出时，本目录的实时门禁禁止应用发布；退出
    后仍必须运行应用流水线 `maintenance-complete`，以 `--no-hooks` 的零副本安全 revision 和 atomic
    恢复两阶段切到 target Secret，写完成标记后才删除持久锁。`resume` 只允许在 Terraform entry 前、
    最新 delivery 仍等于旧 `steady` 时中止静默；进入维护或发布 target `steady` 后只能继续
    `maintenance-complete`。
12. WAF `body-size-limit` 因合法 JSON 协议上界已证明而直接 Block；8 KiB aggregate header、所有
    source-IP rate rule 和 AWS Managed Rules 的环境示例都必须从 Count 开始。launch/spin 的低阈值
    只以 POST 精确匹配 `/operator/v1/launches` 与 `/client/v1/spins`，不得扩大到 status/result/ACK；后者
    受覆盖 GET/OPTIONS/POST 的高阈值 `public-api-rate-limit` 粗保护，OPTIONS 不能形成分布式旁路。WAF 429 固定返回
    `Retry-After: 30`、`X-RGS-Edge-Error: RATE_LIMITED`、`Access-Control-Allow-Origin: *` 并 expose 前两者，
    不返回敏感 body 或 credentials。每条规则切 Block 前都要绑定
    `s3://bucket/key?versionId=...#sha256` 不可变观测证据，覆盖 NAT/CGNAT、正常与营销高峰、合法流量存活率、误杀、
    规则版本、owner 和回滚条件。IP 规则绝不替代认证后 operator/session + Valkey 精确准入。
13. WAF 日志只保留 BLOCK/COUNT，并脱敏完整 query string 及 Authorization/Cookie/签名/nonce/幂等
    Header。正式协议不使用 query；保留 URI path/method 供处置，禁止攻击者借 query 注入秘密或扩大
    日志泄漏与摄取成本。Regional 与 CloudFront WAF 的 Web ACL/全部规则必须关闭 sampled requests；日志
    redaction 不保护 `GetSampledRequests` 数据面，不能用采样请求调优敏感协议。

## 验证与发布

安装固定版本 Helm 与 kubeconform 后执行：

```sh
make verify-aws-production
make verify-deployment-contracts
```

从示例生成受限变更文件，替换全部占位值后再渲染评审：

```sh
cp deploy/aws-production/values.example.yaml /secure/change/slots-production-values.yaml

helm lint --strict deploy/cluster-production/chart \
  -f /secure/change/slots-production-values.yaml

helm template slots deploy/cluster-production/chart \
  --namespace slots-production \
  -f /secure/change/slots-production-values.yaml \
  > /secure/change/slots-production-rendered.yaml
```

基础设施应用完成后，先把 `terraform output -json delivery` 保存到受保护临时文件，再在同一个 VPC
私网执行器上生成并应用不含秘密的同步声明；该临时文件和渲染结果必须由流水线退出清理：

```sh
deploy/aws-production/render-external-secrets.rb \
  /secure/change/slots-delivery.json slots-production \
  > /secure/change/slots-external-secrets.yaml
kubectl apply --server-side --field-manager=slots-platform-delivery \
  -f /secure/change/slots-external-secrets.yaml
```

受控 Secret 写入流程完成且 External Secrets 已同步后，再执行只读实时检查：

```sh
deploy/aws-production/verify-live-platform-prerequisites.sh \
  /secure/change/slots-delivery.json slots-production
```

脚本会拒绝 Regional WAF 的规则集合、低阈值 scope、Count→Block 阶段、8 KiB oversize、日志脱敏/
成本过滤、CloudWatch 告警与 delivery 不一致，也会核对 CloudFront global WAF 的阶段、静态限额及
私有 S3 OAC 绑定，并精确回读源站 bucket 的四项 Public Access Block 与 bucket policy；唯一读取 `Allow` 必须是当前 CloudFront distribution，另保留全主体明文传输 `Deny`。它还会拒绝 add-on 版本契约不完整、kubectl 指向错误集群、集群 API 不可达、Controller/Autoscaler/Agent
身份或状态不匹配；AWS Load Balancer Controller、Cluster Autoscaler、External Secrets controller
和 kube-prometheus-stack operator 四个关键 Deployment 还必须期望副本至少为一、controller 已观测
最新 generation、updated/ready/available 全部等于期望值且 unavailable 为零。Cluster Autoscaler
实际内联策略缺少 `autoscaling:DescribeTags`、
metrics-server 不是声明的 EKS add-on 版本或未达到 ACTIVE、
`v1beta1.metrics.k8s.io` APIService 未达到 `Available=True`、固定 release 的 kube-state-metrics 未就绪、
CRD/`alb` IngressClass 缺失、ExternalSecret 未同步、目标 Secret 缺 `username/password` 等必需 key，或
Prometheus Agent 没有用 SigV4 指向当前 AMP。该检查通过前不得执行下面的 Helm 发布。

渲染文件只用于 schema、策略、签名、Secret 引用与 diff 评审，不得绕过 Helm hook 直接执行
`kubectl apply`。审批完成后，由 VPC 内的受保护发布身份执行 `helm upgrade --install --atomic --wait`；
真实上线步骤、外部控制和回滚证据见
[`docs/aws-production-deployment.md`](../../docs/aws-production-deployment.md)。

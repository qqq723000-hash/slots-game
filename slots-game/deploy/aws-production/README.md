# AWS 正式交付契约

本目录把通用 Helm Chart 收敛为 AWS 正式环境的可执行发布边界，它不提交 Secret。应用专属的
VPC、EKS、RDS、Valkey、ECR、Secrets Manager 元数据、S3、CloudFront、KMS、IAM、AMP、CloudWatch
和备份资源由 `infra/terraform` 创建；企业平台仓库只提供账号、部署身份、state、DNS/证书/WAF
与组织级安全能力。

```text
AWS 正式交付
├── Web 边缘面
│   ├── Route 53
│   ├── CloudFront + AWS WAF
│   └── 私有 S3 + OAC + release ID 不可变前缀
├── RGS 在线面
│   ├── Route 53
│   ├── AWS WAF + 公网 ALB
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

## 必须保持的边界

1. `web.enabled=false`。Web 制品发布到私有 S3，CloudFront 只能通过 OAC 读取，并由 release ID
   路由隔离版本；EKS 不创建 Web Deployment、Service、Ingress、HPA、PDB 或 ServiceAccount。
   S3 输入必须由 `deploy/supply-chain/extract-aws-web-static-root.sh` 从已验证的 Web OCI digest
   提取并逐文件对照 `release-manifest.json`，不得直接同步工作区 dist。CloudFront Response Headers
   Policy 必须使用同一 digest 提取的 CSP，并与 bundle 的 `CONFIGURATION_SHA256` 一起归档。
2. `ingress.className=alb` 且 `ingress.tlsSecretEnabled=false`。公网证书来自 ALB 所在区域的 ACM；
   示例中的两个 TLS Secret 名称只为兼容通用 schema，渲染结果不得引用它们。
3. ALB 必须绑定 WAFv2、ACM、三个明确子网和专用安全组，使用 `ip` target，并在公网 `8080`
   探测 `/healthz`。依赖就绪由 Pod 对私有 `8081/readyz` 的 Kubernetes readiness 控制；ALB 不得
   探测只存在于运维监听器且要求 Bearer 的 `/readyz`。同时必须开启
   删除保护、无效请求头丢弃和 S3 访问日志。
4. `networkPolicy.ingressController.mode=cidrs`。示例三个 `/24` 只表示经审批的入口子网；正式值必须
   按实际 ALB/EKS 数据路径逐个替换并叠加 security group，禁止使用整个 VPC 或 `0.0.0.0/0`。
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

脚本会拒绝 add-on 版本契约不完整、kubectl 指向错误集群、集群 API 不可达、Controller/Autoscaler/Agent
身份或状态不匹配、Cluster Autoscaler 实际内联策略缺少 `autoscaling:DescribeTags`、
metrics-server 不是声明的 EKS add-on 版本或未达到 ACTIVE、
`v1beta1.metrics.k8s.io` APIService 未达到 `Available=True`、固定 release 的 kube-state-metrics 未就绪、
CRD/`alb` IngressClass 缺失、ExternalSecret 未同步、目标 Secret 缺 `username/password` 等必需 key，或
Prometheus Agent 没有用 SigV4 指向当前 AMP。该检查通过前不得执行下面的 Helm 发布。

渲染文件只用于 schema、策略、签名、Secret 引用与 diff 评审，不得绕过 Helm hook 直接执行
`kubectl apply`。审批完成后，由 VPC 内的受保护发布身份执行 `helm upgrade --install --atomic --wait`；
真实上线步骤、外部控制和回滚证据见
[`docs/aws-production-deployment.md`](../../docs/aws-production-deployment.md)。

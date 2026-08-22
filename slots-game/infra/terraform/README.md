# AWS 应用基础设施 Terraform

本目录定义 Slots 应用自己负责的 AWS 基础设施。它可以独立创建 VPC、EKS、RDS PostgreSQL、
ECR、Secrets Manager 元数据、S3/CloudFront、AMP、CloudWatch 与 AWS Backup 基线；不会创建
AWS Organizations、账号工厂、集中身份、组织级审计或安全账号。

```text
infra/terraform
├── contracts
│   ├── cluster-addons-interface.v1.yaml
│   └── landing-zone-interface.v1.yaml
├── modules
│   ├── delivery-contract
│   ├── network
│   ├── kms
│   ├── ecr
│   ├── eks
│   ├── rds
│   ├── cache
│   ├── secrets
│   ├── web-edge
│   ├── observability
│   ├── backup
│   └── archive
├── stacks
│   ├── application-platform
│   └── environment
├── environments
│   ├── dev
│   ├── staging
│   ├── prod-primary
│   └── prod-dr
└── scripts
    ├── verify.sh
    ├── verify-static-contract.sh
    ├── verify-valkey-rotation-plan.rb
    ├── test-valkey-rotation-plan.rb
    └── test-negative-contract.sh
```

## 安全边界

- Terraform Core 固定为 `1.15.9`，AWS Provider 固定为 `6.57.1`；每个环境提交
  `.terraform.lock.hcl`。
- 每个环境使用独立 S3 state key 和 S3 原生锁文件。state bucket、KMS key 和部署角色由企业落地区
  提前提供，仓库只提交 `backend.example.hcl`。
- Provider 使用 `allowed_account_ids`，账号不匹配时拒绝执行；示例账号、域名、ARN 和 bucket 均为
  不可部署占位值。
- 账号工厂必须先创建默认 `AWSServiceRoleForAutoScaling`。EKS 节点卷 CMK 直接绑定该服务关联角色，
  并只允许 AWS 资源持久 grant；缺少该角色时 KMS key 创建会失败关闭，不会退回未加密节点卷。
- RDS 使用 Secrets Manager 托管主密码；五个职责隔离应用 Secret 只创建空的元数据容器。API 与 Worker
  运行资产分别使用 `api-runtime-assets` 和 `worker-runtime-assets`，Worker 不再获得 launch HMAC 或
  API operator 私钥。共享准入固定创建 A/B 两个 Valkey ACL 用户并始终保留在同一 user group；两个密码、
  HMAC key 与显式根证书通过 Terraform 1.15 ephemeral 变量进入 provider write-only 参数，不写入普通
  tfvars、plan 或 state。活动槽位的用户名和密码共同写入版本化 Secrets Manager Secret。
- EKS API 默认只开放私网端点，业务 Pod 不获得 AWS IAM 权限；平台插件通过 Pod Identity 获取最小权限。
  RDS 与 Valkey 的入口引用 EKS 托管节点实际持有的集群安全组，再由 Chart 的默认拒绝 NetworkPolicy
  限制到需要访问的 Pod，不再创建没有 SecurityGroupPolicy 绑定的占位安全组。
- 当前 Valkey 只保存可丢弃的跨副本身份准入令牌桶；没有实现 `operationId` 重复抑制或资金结果
  缓存。资金幂等、钱包结果和游戏局状态继续以 PostgreSQL、Outbox 与恢复 Worker 为唯一权威；
  Kafka 不属于钱包正确性依赖。
- 冷归档模块只创建加密 S3、生命周期和受限 RDS snapshot export 角色；它不会创建定时导出任务，
  也不能作为“归档已经运行”的证据。
- `prod-primary` 必须配置跨区域备份目标 vault ARN；`prod-dr` 先创建目标 vault，再把输出交给主区域。
- 本目录不会连接或修改任何 AWS 账号，除非操作者明确执行经审批的 `plan`/`apply`。

## 企业落地区接口

企业平台必须先满足 [`contracts/landing-zone-interface.v1.yaml`](contracts/landing-zone-interface.v1.yaml)。
应用仓库只接收账号 ID、区域、三个可用区、Terraform state 接口、DNS/证书标识和受保护部署角色；
Organizations、Control Tower、SCP、集中 CloudTrail、Security Hub、GuardDuty、预算与网络互联仍由平台仓库负责。
应用发布角色还需对 delivery 指向的 Cluster Autoscaler role 具有只读 `iam:GetRolePolicy`，
以让实时门禁确认实际策略包含 `autoscaling:DescribeTags`；该权限不允许写 IAM。

集群 add-on 的交付边界由
[`contracts/cluster-addons-interface.v1.yaml`](contracts/cluster-addons-interface.v1.yaml) 固定。Terraform
基础设施 `apply` 的输出始终包含 `foundation_apply_is_application_ready=false`；AWS Load Balancer
Controller、Cluster Autoscaler、External Secrets、Prometheus Operator 与 Prometheus Agent 未在 VPC 私网执行器上通过实时门禁前，
禁止进入应用 Helm 发布。

`platform_addon_versions` 中除 `prometheus-agent` 外的四个值是 Helm Chart 精确版本，`prometheus-agent` 是
Prometheus Agent CR 的 `spec.version`（配置中不带 `v`，实时门禁按 `v<SemVer>` 校验）。这些版本
是受保护环境输入，不由仓库猜测“最新版本”。`cluster_autoscaler_image_tag` 必须是与 EKS 主次版本一致的
精确 patch；Terraform 只忽略节点组 `desired_size` 的漂移，`min_size` 与 `max_size` 仍由变更评审管理。

## 初始化与验证

从目标环境复制示例文件到受限目录，替换全部 `REPLACE_` 值：

```sh
cd infra/terraform/environments/prod-primary
cp backend.example.hcl /secure/change/prod-primary.backend.hcl
cp terraform.tfvars.example /secure/change/prod-primary.tfvars

terraform init -backend-config=/secure/change/prod-primary.backend.hcl
terraform plan -var-file=/secure/change/prod-primary.tfvars -out=/secure/change/prod-primary.tfplan
```

`configuration` 只包含非秘密参数。计划和应用还必须由受保护执行器注入四个 ephemeral 环境变量：
`TF_VAR_valkey_password_a`、`TF_VAR_valkey_password_b`、`TF_VAR_shared_admission_hmac_key`、
`TF_VAR_valkey_root_ca_pem`。前三项由密码管理系统生成；根证书来自受控 AWS 信任库。即使某个槽位本次
不更新，执行器仍必须注入两个密码；只有相应的 `valkey_password_version_a` 或
`valkey_password_version_b` 递增时 provider 才会重置该槽位。`valkey_secret_version` 控制发布给新
工作负载的不可变 Secret 名称；奇数版本必须选择 A，偶数版本必须选择 B。
`valkey_password_fingerprint_a`、`valkey_password_fingerprint_b` 和
`shared_admission_hmac_key_fingerprint` 分别是实际 ephemeral 字符串的 64 位小写 SHA-256；Terraform
会重新计算并失败关闭，因此 tfvars 不能用伪造 fingerprint 绕过状态机。fingerprint 只用于高熵随机值的
变更绑定，不得替代密码管理系统中的原值。
`application_secret_versions` 分别控制五个职责 Secret 的不可变名称版本。所有 Kubernetes
Secret 只同步一次并设置 `immutable=true`，任何值轮换都必须先递增对应版本并以新名称滚动工作负载，
不得原地覆盖。秘密值不得写入仓库、普通 tfvars、日志或制品。
`configuration.application_namespace` 和 `configuration.helm_release_name` 必须分别与受保护
Environment 的 `AWS_EKS_NAMESPACE` 和 `AWS_HELM_RELEASE_NAME` 精确一致；它们会进入持久化
`rotation_guard.target_identity`，使 HMAC 证据不能在其他 namespace 或 release 之间复用。

## Valkey A/B 零停机密码轮换

初始配置是 A 槽活动、两个密码版本均为 1、共享准入 Secret 版本为 1。轮换必须分为三个独立变更，禁止
把“发布新槽”和“重置旧槽”合并在同一次 Terraform apply：

1. 把 `valkey_rotation_mode` 设为 `password-rotation`，保持 A 活动和 Secret v1 不变。确认没有 Pod
   使用 B 后，为 B 生成新密码、递增
   `valkey_password_version_b`，并在 `valkey_password_reset_approvals.b` 记录另一活动槽、当前 Secret
   版本、旧连接已排空、HMAC 未改变以及受控 live evidence 引用。此阶段只重置 B。
2. 保持两个密码版本不变，把 `valkey_active_slot` 切到 `b`，并把 `valkey_secret_version` 从奇数递增到
   偶数。Terraform 创建包含 B 用户名和 B 密码的新版本 Secret；应用滚动期间旧 Pod 仍可用 A 用户重连。
3. 只有发布门禁证明所有 Pod 已使用 B、A 连接已经排空后，才能递增
   `valkey_password_version_a` 并提交匹配的 `valkey_password_reset_approvals.a`。这一步撤销旧 A 密码，
   不能与第二步合并。下一轮按相反方向执行。

版本大于 1 的每个槽位都必须永久保留匹配版本的审计批准。批准对象要求：
`approved_password_version` 与槽位密码版本一致，`observed_active_slot` 必须是另一槽，
`observed_secret_version` 不得晚于当前 Secret，`old_slot_connections_drained=true`、
`hmac_key_unchanged=true`，并提供至少八字符的 `live_evidence_reference`。缺失或版本不一致时 plan
失败关闭。

受保护流水线还必须对实际保存的 plan 执行：

```sh
terraform show -json /secure/change/environment.tfplan |
  ruby ../../scripts/verify-valkey-rotation-plan.rb -
terraform apply /secure/change/environment.tfplan
```

该门禁读取 `terraform_data.rotation_guard` 的真实 before/after 状态，而不是相信 tfvars 的自我声明：
活动槽不变时只允许唯一非活动槽的密码版本和 fingerprint 精确递增；活动槽切换时禁止改变任一密码，且
Secret 版本必须精确递增 1。它稳定拒绝“声明另一槽已活动但实际重置当前活动槽”以及“同一次 apply
切槽并修改新槽密码”。部署角色必须由企业落地区限制为只能应用已通过该门禁的保存 plan，禁止直接
`terraform apply` 自动重新计划。

`live_evidence_reference` 字符串本身不是真实性证明。受保护轮换流程必须先在私网集群保存带时间戳的
`kubectl rollout status`、全部 RGS Pod 使用当前不可变 shared-admission Secret、旧 ReplicaSet 为零副本
等只读证据，再由审批系统生成不可改写的变更记录引用；没有该制品不得提交槽位密码版本变更。

共享准入 HMAC key 决定限流桶键摘要的连续性。密码 A/B 轮换期间必须注入完全相同的 HMAC key；
更换它会使既有桶证明失效并造成短时配额重新开始或突发行为。HMAC 轮换必须作为独立维护变更执行，先评估
桶重置影响并取得业务批准，不能借用密码槽位退休批准。

HMAC 维护是独立的受证据状态机，不能与 A/B 密码轮换并行：

1. 独立私网静默流程先从版本化 delivery 对象确认目标，保存 API Deployment/HPA 身份与可恢复
   HPA manifest，并创建名为 `slots-hmac-maintenance-lock` 的持久 ConfigMap 锁；证据必须保存该锁 UID。
   删除 API HPA 后将 API 缩到零副本；Worker 必须保持至少一个并全部健康。流程把
   `slots-game/hmac-quiesce-attestation/v1` 规范 JSON 写入固定 KMS 加密、已开启版本的 S3 key，
   并记录精确 VersionId 和 SHA-256。证据有效期最长 60 分钟。
2. 同一份已保存 plan 必须从 `steady` 进入 `hmac-maintenance`、更换实际 HMAC 及 fingerprint，
   并把同一活动槽的 Secret 版本精确递增 2。活动槽、A/B 密码版本、密码 fingerprint 和退休批准
   必须完全不变。`valkey_hmac_maintenance_approval` 字段集只能是
   `{bucket_reset_accepted,evidence_reference{bucket,key,version_id,sha256}}`，不再接受由 tfvars 自证的
   零副本布尔值或自由文本引用。
   plan 的所有非 `no-op` 资源也必须命中精确单一变更 allowlist：入口只能是
   `module.cache.terraform_data.rotation_guard` 的 `update`、
   `module.cache.aws_secretsmanager_secret.shared_admission` 的 `create,delete` 和
   `module.cache.aws_secretsmanager_secret_version.shared_admission` 的 `delete,create`；出口只能是
   `rotation_guard` 的 `update`。RDS、EKS、IAM、网络、Valkey ACL 用户、其他 Secret 或普通配置变化
   即使证据合法也会失败关闭。Secret 同步角色使用固定账号/区域/名称前缀的
   `*-rgs-shared-admission-v*` 版本族 ARN，因此 vN 到 vN+2 不会要求在维护 plan 中夹带 IAM policy 更新。
3. 应用同一份证据校验同一份已保存 plan，不得 apply 时重新计划：

   ```sh
   terraform show -json /secure/change/hmac-maintenance.tfplan |
     ruby ../../scripts/verify-valkey-rotation-plan.rb \
       --evidence /secure/change/hmac-quiesce-attestation.json -
   terraform apply /secure/change/hmac-maintenance.tfplan
   ```

   证据必须是 key 递归排序的单行 JSON，并以一个换行结束（等价于 `jq -cS` 输出）；
   `hpa_spec_sha256` 是递归排序后的 `spec` 单行 JSON 字节串（不含末尾换行）的 SHA-256。
4. HMAC entry apply 成功后必须照常发布新版本 delivery 对象，其中
   `valkey_rotation_mode=hmac-maintenance`、`maintenance_in_progress=true` 且
   `application_release_allowed=false`；后两个布尔字段在 delivery 顶层、`application_handoff` 和
   `valkey_rotation_contract` 中必须完全一致。基础设施流水线不得因该状态拒绝交接并留下旧的
   `steady` delivery，应用流水线必须拒绝维护 delivery。
5. 另建一份不携带静默证据的已保存 exit plan，只允许清空 HMAC 维护批准并把模式从
   `hmac-maintenance` 恢复为 `steady`。apply 后必须发布引用 target Secret、新 HMAC fingerprint 且
   `maintenance_in_progress=false`、`application_release_allowed=true` 的最新 delivery；这一步不恢复
   API Pod 或 HPA。
6. 只有应用流水线的 `maintenance-complete` 模式可以完成恢复。它重新核对最新 target `steady`
   delivery、原证据/复证、持久 lock、API 零副本且无 HPA、Worker 身份与健康状态。Phase A 使用
   `--no-hooks`、非 atomic 的 Helm upgrade，只允许沿用当前镜像/数学定义/values/Worker/hooks 并提交
   target shared-admission Secret、API 零副本和无 HPA 的安全 revision；Phase B 使用
   `--no-hooks --atomic` 恢复证据中保存的 HPA，验证新 API/Worker 与 HPA fingerprint 后写 completion marker，
   最后删除精确 UID 的 lock。任一失败都必须维持或重新建立 API 零副本锁定。

显式 `resume` 只用于 Terraform entry 前中止 quiesce，且最新 delivery 仍逐字等于证据观察到的旧
`steady` 时恢复旧 HPA/API；一旦最新 delivery 已进入 `hmac-maintenance` 或已发布 target `steady`，
`resume` 必须失败关闭，只能继续 `maintenance-complete`。

静默证据生产角色才能访问私网 EKS。Terraform plan/apply 角色只获得固定证据对象的
`s3:GetObjectVersion` 与对应 KMS decrypt 权限，不得因 HMAC 维护而扩大 EKS 权限。

因此第一次 A 到 B 的发布也不能顺便改变 HMAC；离线状态机负测专门覆盖该绕过路径。

本地和 required CI 的统一门禁：

```sh
make -C infra/terraform verify
```

`verify` 会执行格式检查、静态契约、危险变体负测，并对四个环境执行 `init -backend=false` 与
`validate`。它不执行 `plan` 或访问 AWS API。

## 应用顺序

1. 企业平台创建账号、受保护部署角色、state bucket/KMS 和集中安全能力。
2. 先应用 `prod-dr`，记录 `backup_vault_arn`。
3. 把该 ARN 写入受限的 `prod-primary.tfvars`，再评审和应用主区域。
4. 在 VPC 内受保护执行器安装配置中声明的精确版本 add-on，并使用
   `deploy/aws-production/verify-live-platform-prerequisites.sh` 校验后，才发布 Helm 应用。
5. Web 只能从已验证 OCI digest 提取到不可变 S3 release 前缀，再更新 CloudFront 发布路由。
6. 冷归档需由独立、可观测、可重试的作业启动 RDS snapshot export；未经恢复抽检不得删除在线数据。

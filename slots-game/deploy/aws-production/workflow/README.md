# AWS 工作流交付边界

<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。

本目录由三个 GitHub Actions 工作流调用。只有人工 `workflow_dispatch` 按目标环境共享同一个不可取消
concurrency group；PR 与 push 的无凭据静态 run 使用“workflow identity + ref”独立分组，避免 GitHub 在同组
已有 running 与 pending 时用新的 pending 替换并取消另一条 workflow 的 required check：

- `aws-infrastructure.yml`：所有 PR 与 `main` 分支受控路径 push 只执行无凭据静态门禁；人工 dispatch 后，
  计划角色生成二进制 Terraform plan；无云权限 job 先绑定精确 artifact ID、服务端 digest、run 与 commit，
  独立 apply Environment 审批后才下载并应用该次计划。
- `aws-application-deploy.yml`：所有 PR 都运行无凭据静态门禁；人工 dispatch 后先用只读角色验证三个 ECR
  digest、Cosign 身份、SLSA provenance 和 SPDX SBOM；源码 artifact 在该 OIDC job 下载前先由无云权限 job
  绑定服务端 digest，源码/验证 artifact 在私网部署前再被二次绑定，最后才由独立部署角色执行 Helm、
  不可变 S3 Web 发布与 CloudFront 切换。
- `aws-hmac-quiesce-evidence.yml`：所有 PR 都运行无凭据静态门禁；只在受保护 Environment 人工 dispatch 后
  由固定私网 runner 运行。
  `quiesce` 删除 API HPA、把 API 缩到零并保持 Worker 就绪，生成最长 60 分钟的版本化证据；`resume`
  只允许在 Terraform delivery 仍是证据观察到的旧 `steady` 版本时恢复。PR 与 `main` push 只运行无凭据门禁。

三个工作流都禁止长期 AWS access key。账号、区域、角色、仓库、bucket、集群和 CloudFront 标识只能
来自受保护 GitHub Environment 的 `vars`；dispatch 输入不能覆盖这些边界。取得 AWS 权限的 job 只使用
`aws-actions/configure-aws-credentials` 换取 GitHub OIDC 短期凭据。

API 或 CloudFront 任一 staged WAF rule 从 Count 晋升为 Block，或者已经 Block 的 configuration / evidence
引用发生变化时，基础设施工作流会在 `terraform apply` 前调用 `verify-waf-rollout-evidence.rb`，把当前
受保护 infrastructure source SHA 与仍在有效期内的批准证据绑定。后续稳态 Block 的应用发布仍会在 Helm
前读取精确 S3 version，重算 SHA-256，并重验 SSE-KMS、COMPLIANCE Object Lock、schema、原始 40 位
source SHA 与 configuration hash；它不会把应用发布的 `GITHUB_SHA` 当成 WAF 证据 SHA，历史批准到期也
不是阻断日常发布的租约。规则配置或证据引用一旦变化，infra pre-apply 会再次要求未过期审批。对象正文
不会输出到日志；这不替代采用方安全责任角色对原始观测真实性的审批。

GitHub Branch Protection API 的 required status-check context 使用 job 的 `name`，不包含 workflow display
name。为避免三个 workflow 共同使用 job id `static-contract` 造成歧义，分支保护必须精确配置以下三个唯一
required contexts，确保合并前与进入 `main` 后都得到对应动态检查结果：

- `AWS infrastructure static contract`
- `AWS application static contract`
- `AWS HMAC quiesce static contract`

三条 workflow 的 `pull_request` 触发器禁止配置 `paths`、`paths-ignore`、branch 或 event-type 过滤；否则与
Branch Protection required check 组合时，未命中过滤条件的 PR 会永久停在 Waiting。`push` 到 `main` 仍可保留
受控路径过滤。所有取得 OIDC、Environment 或 AWS 权限的 job 继续以
`github.event_name == 'workflow_dispatch' && !inputs.static_only` 失败闭合，因此任意 PR 以及默认手动验证都只执行无凭据
`static-contract` job。只有显式取消 `static_only` 并填写完整受保护输入，才能进入环境变更 job。

## Environment 命名

每个 `<环境>` 为 `dev`、`staging`、`prod-primary` 或 `prod-dr`：

```text
aws-<环境>-terraform-plan
├── AWS_ACCOUNT_ID
├── AWS_REGION
├── AWS_TERRAFORM_PLAN_ROLE_ARN
├── AWS_TF_STATE_BUCKET
├── AWS_TF_STATE_KEY
├── AWS_TF_STATE_KMS_KEY_ARN
├── AWS_TERRAFORM_DELIVERY_BUCKET / KEY / KMS_KEY_ARN
├── AWS_HMAC_QUIESCE_EVIDENCE_BUCKET / KEY / KMS_KEY_ARN
├── AWS_HMAC_QUIESCE_CANCELLATION_PREFIX / COMPLETION_PREFIX
├── AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN
├── AWS_EKS_CLUSTER_NAME / NAMESPACE / AWS_HELM_RELEASE_NAME
├── secret: TERRAFORM_TFVARS_JSON
├── secret: TERRAFORM_VALKEY_PASSWORD_A
├── secret: TERRAFORM_VALKEY_PASSWORD_B
├── secret: TERRAFORM_SHARED_ADMISSION_HMAC_KEY
└── secret: TERRAFORM_VALKEY_ROOT_CA_PEM

aws-<环境>-terraform-apply
├── AWS_ACCOUNT_ID
├── AWS_REGION
├── AWS_TERRAFORM_APPLY_ROLE_ARN
├── AWS_TF_STATE_BUCKET
├── AWS_TF_STATE_KEY
├── AWS_TF_STATE_KMS_KEY_ARN
├── AWS_TERRAFORM_DELIVERY_BUCKET / KEY / KMS_KEY_ARN
├── AWS_HMAC_QUIESCE_EVIDENCE_BUCKET / KEY / KMS_KEY_ARN
├── AWS_HMAC_QUIESCE_CANCELLATION_PREFIX / COMPLETION_PREFIX
├── AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN
├── AWS_EKS_CLUSTER_NAME / NAMESPACE / AWS_HELM_RELEASE_NAME
├── secret: TERRAFORM_VALKEY_PASSWORD_A
├── secret: TERRAFORM_VALKEY_PASSWORD_B
├── secret: TERRAFORM_SHARED_ADMISSION_HMAC_KEY
└── secret: TERRAFORM_VALKEY_ROOT_CA_PEM

aws-<环境>-artifact-verify
├── AWS_ACCOUNT_ID
├── AWS_REGION
├── AWS_ARTIFACT_VERIFY_ROLE_ARN
└── 三个 AWS_ECR_*_REPOSITORY

aws-<环境>-application-deploy
├── AWS_ACCOUNT_ID / AWS_REGION / AWS_APPLICATION_DEPLOY_ROLE_ARN
├── 三个 AWS_ECR_*_REPOSITORY
├── AWS_EKS_CLUSTER_NAME
├── AWS_EKS_NAMESPACE / AWS_HELM_RELEASE_NAME
├── AWS_HELM_VALUES_BUCKET / KEY / VERSION_ID
├── AWS_TERRAFORM_DELIVERY_BUCKET / KEY / VERSION_ID / KMS_KEY_ARN
├── AWS_HMAC_QUIESCE_EVIDENCE_BUCKET / KEY / KMS_KEY_ARN
├── AWS_HMAC_QUIESCE_CANCELLATION_PREFIX / COMPLETION_PREFIX
├── AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN
├── AWS_WEB_BUCKET / AWS_WEB_KMS_KEY_ARN
├── AWS_CLOUDFRONT_DISTRIBUTION_ID / DOMAIN_NAME
├── AWS_CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID
├── AWS_CLOUDFRONT_KVS_ARN
└── AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME

aws-<环境>-hmac-quiesce-evidence
├── AWS_ACCOUNT_ID / AWS_REGION / AWS_HMAC_QUIESCE_ROLE_ARN
├── AWS_EKS_CLUSTER_NAME / AWS_EKS_NAMESPACE / AWS_HELM_RELEASE_NAME
├── AWS_TERRAFORM_DELIVERY_BUCKET / KEY / KMS_KEY_ARN
├── AWS_HMAC_QUIESCE_EVIDENCE_BUCKET / KEY / KMS_KEY_ARN
├── AWS_HMAC_QUIESCE_CANCELLATION_PREFIX / COMPLETION_PREFIX
└── 固定 runner 标签：slots-aws-private-hmac-quiescer
```

生产 plan、apply、制品验证、应用部署和 HMAC 停机 Environment 必须启用 required reviewers，角色 trust policy 必须把
OIDC `sub` 精确限制到对应仓库和 Environment。Terraform plan 角色只读，apply 角色可修改应用 IaC；
制品验证角色只有 ECR 读取权限；应用部署角色只拥有目标 EKS、版本化 Helm values、目标 Web bucket、
指定 CloudFront/KVS 读取以及 `active-release` 单键更新所需的最小权限。HMAC 停机角色必须与 Terraform
plan/apply 角色分离，只允许访问固定私网 EKS、读取当前 Terraform delivery，并向固定版本化证据 key 与
按证据派生的 marker prefix 条件写入；Terraform 角色只读固定证据 VersionId 与 KMS，禁止取得 EKS 权限。

`TERRAFORM_TFVARS_JSON` 是 Terraform 变量文件，不是 AWS 密钥。它不得包含数据库密码、应用私钥或
其他运行时 Secret，顶层结构固定为 `{"configuration":{...全部非秘密环境字段...}}`。运行时 Secret
只经 Secrets Manager 的独立同步链路进入集群。

Valkey A/B 密码、共享准入 HMAC key 和 Valkey 根证书分别从上述四个 Environment secret
注入 `TF_VAR_valkey_password_a`、`TF_VAR_valkey_password_b`、
`TF_VAR_shared_admission_hmac_key` 和 `TF_VAR_valkey_root_ca_pem`。工作流在 OIDC 前确认它们存在，
plan/apply 两个 Environment 必须保存完全相同的值。计划制品只记录与本次
repository/run/environment 绑定的 HMAC 指纹；apply 在取得 OIDC 前重算并精确比对，四个原值不会进入
tfvars、plan、state、artifact 或日志。

生成 plan 前，工作流直接对本次 Environment 注入的 A/B 密码和共享准入 HMAC key 分别计算 SHA-256，
并强制覆盖 `configuration.valkey_password_fingerprint_a`、
`configuration.valkey_password_fingerprint_b` 和
`configuration.shared_admission_hmac_key_fingerprint`，因此调用者无法用声明值冒充实际 ephemeral 值。
plan 生成后、上传制品前会用前后状态机校验 Valkey A/B 轮换顺序；apply 初始化同一后端后会对下载且已校验
SHA-256 的同一 plan 再执行一次状态机门禁，通过后才允许 apply。

Terraform delivery 只发布非秘密的 `valkey_active_slot`、`valkey_user_name`、`valkey_user_names`、
`valkey_password_versions` 和 `valkey_rotation_contract`。A/B 用户始终同时留在 Valkey user group；切换
活动槽必须发布奇数 A、偶数 B 的新版本共享准入 Secret，重置旧槽密码必须先取得 live evidence，密码轮换
期间不得顺带重置 HMAC 限流桶。轮换契约只携带 A/B 密码与 HMAC key 的 SHA-256 fingerprint，不携带原值。
正常应用发布只接受 `steady` 或 `password-rotation`；`hmac-maintenance` 必须在独立停机维护中把工作负载缩到
零副本，且禁止与普通 Helm 滚动并行，应用部署工作流会失败闭合拒绝该模式。
共享准入 ACL 从 v1 切到 v2 也不是普通滚动：delivery 固定声明
`acl_schema_transition=maintenance-quiesced`、禁止 rolling/双权限并携带严格步骤。运维必须先设置 API
`maintenanceQuiesced` 停止新 launch/spin、排空旧 API Pod，再用同一 API 零副本证据进入
`hmac-maintenance`；基础设施 plan 校验器只允许 rotation guard、版本化 Secret/SecretVersion 和 A/B
两个用户的精确 v1→v2 ACL 更新。退出 HMAC 维护后才启动 v2 镜像并验证，最后恢复新意图；普通
`steady`/密码轮换 plan 会拒绝 ACL 变化，Worker 资金恢复和既有状态/ACK 绕行不得随该维护停止。
这与既有 v2-basic 到 `acl_command_profile=v2-economic` 的命令追加是两个不同迁移：后者不改 keyspace
或 HMAC，旧 runtime 所需权限是新 profile 的严格子集，因此必须先用 `steady` Terraform plan 同时
只更新 A/B 两个用户的 `access_string`，再把携带新 profile 的 delivery 交给应用发布。partial A/B、
未知前态、额外命令、密码/HMAC 混入都会被 plan 门禁拒绝；新 runtime 启动 canary 再验证实际权限。
应用实时门禁会验证 delivery 的活动用户名与 A/B 槽位一致，并要求不可变
共享准入 Secret 同时包含 `username`、`password`、`hmac.key`、`root-ca.pem` 四个非空 key；Helm 渲染
门禁还会确认 `RGS_SHARED_ADMISSION_USERNAME` 精确引用该版本化 Secret 的 `username` key。合并后的
`rgs.sharedAdmission.endpointURL` 必须逐字等于 delivery 的无凭据 `valkey_endpoint_url`，禁止 Helm values
把工作负载导向另一套缓存。所有门禁都不会输出或解码 Secret 值。

Terraform apply 成功后使用 `terraform output -json delivery` 生成不含秘密的应用交接对象，
写入已启用 versioning 的固定 S3 bucket/key，显式绑定 `AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN`。
工作流在 summary 和审计 artifact 中记录新 version ID；审批者必须把该精确 ID 写入对应
`aws-<环境>-application-deploy` 的 `AWS_TERRAFORM_DELIVERY_VERSION_ID`。应用工作流既按该 VersionId 下载，
也会 HEAD 固定 key 并核对最新 VersionId、CMK、metadata 与内容 SHA；任何 standard 或 maintenance-complete
尝试消费旧 delivery 都会失败，防止 maintenance 结束后重新引入旧共享 HMAC Secret。

应用部署 job 固定使用 `self-hosted,linux,x64,slots-aws-private-deployer` 四个 runner 标签。该 runner
必须位于目标 VPC 的受控 runner group，能够访问 private-only EKS API；每个 job 使用短命、任务后销毁
的执行环境，不保存 AWS、Docker、kubeconfig 或 Helm values 凭据。Environment var 或 dispatch 输入都
不能替换此标签。runner 镜像必须预装 AWS CLI v2、kubectl、Docker、Ruby、Node.js、jq、curl、
ShellCheck 与 GNU coreutils；Helm 由工作流按固定版本和 SHA-256 临时安装。ECR digest 的只读验证继续
使用隔离的 GitHub-hosted 临时 runner。

## HMAC 停机维护状态机

HMAC bucket 重置不是 `tfvars` 自证。唯一允许的生产顺序如下，任一步失败都保持失败闭合：

```text
旧 steady delivery
└── quiesce（私网证据角色）
    ├── 创建 release 标签绑定的 slots-hmac-maintenance-lock
    ├── 保存 API HPA 规范与 UID，删除 HPA，API 缩到 0，无 API Pod
    ├── 持续校验 Worker Deployment/HPA UID 与全部 Pod 就绪
    └── 条件上传 60 分钟证据并把 VersionId/SHA 回写 lock
        └── Terraform 单一保存 plan
            ├── 同一次 steady → hmac-maintenance
            ├── 同槽共享 Secret 版本精确 +2，并更新 HMAC fingerprint
            └── 发布 application_release_allowed=false 的最新 maintenance delivery
                └── 独立 exit plan：hmac-maintenance → steady
                    └── maintenance-complete（私网应用角色）
                        ├── Phase A：同一镜像、定义、values、delivery、evidence
                        │   ├── comparator 只允许 API sharedAdmission Secret、runtime 摘要、停机注解变化
                        │   ├── --no-hooks，非 atomic，提交 target Secret + replicas=0 + 无 API HPA
                        │   └── 验证 live 模板、零 Pod、HPA 缺失和安全 Helm revision
                        ├── Phase B：--no-hooks --atomic，从安全 revision 恢复原 HPA
                        ├── 校验新 Pod 只引用 target Secret，HPA spec SHA 等于停机证据
                        └── 写 completion marker，删除精确 UID lock
```

maintenance-complete 禁止 Migrator、任何 Helm hook、Web S3 发布和 CloudFront 切换。当前成功 release 的
Worker、镜像 digest、数学定义、hooks 以及除 API 共享准入边界外的全部资源必须与两个候选 manifest 语义
相同。Phase A 失败继续保持旧模板零副本；Phase B atomic 失败只能回滚到已经使用 target Secret 的零副本
安全 revision，随后门禁再次删除 HPA 并缩到零，因此不会启动旧 HMAC Pod。

证据 JSON 顶层 `schema` 固定为 `slots-game/hmac-quiesce-attestation/v1`，规范化为递归 key 排序的单行 JSON
加一个末尾换行。它绑定生产者仓库/workflow/role/run、环境/账号/区域/集群/namespace/release、当前 delivery
VersionId/SHA、活动槽、旧 Secret 版本、旧 HMAC fingerprint、目标 `v+2`、API/Worker UID 与计数、HPA 恢复
规范及最长 60 分钟时效。每个 cancellation/completion marker 的 key 都由该证据 VersionId 与 SHA-256 派生，
使用 `If-None-Match: *` 条件创建并回读 CMK/metadata；后续证据不能遮蔽旧证据终态。

证据上传后、lock 提交前的任何失败必须先写该证据的 cancellation marker，再恢复旧 HPA/API 并删除 lock；
若 marker 写入失败则保持 API 零副本与 lock，禁止恢复旧 Pod。显式 `resume` 也先写 cancellation marker，且仅在
最新 delivery 仍逐字等于证据观察到的旧 `steady` 时恢复；一旦进入 `hmac-maintenance` 或发布 target 新
`steady`，只能继续 maintenance-complete。三个 AWS workflow 的人工 dispatch 共享环境级 concurrency group，
消除检查与使用之间的跨工作流竞态；PR 与 push 静态门禁则按 workflow identity 和 ref 隔离，不互相取消。

原停机证据的 60 分钟 TTL 只约束 Terraform `steady → hmac-maintenance` 的 plan/apply，绝不放宽。如果
Terraform 已发布 target 新 `steady` 后原证据到期，application 私网 runner 可以读取其不可变历史内容，但必须
重新实时证明：latest delivery 仍是同槽 target `v+2` 与新 HMAC、同一 lock UID/证据引用仍存在、API 为零副本且
无 HPA/Pod、Worker Deployment/HPA UID 不变且全部 Pod Ready、当前证据没有 cancellation/completion marker。
工作流随后生成 `slots-game/hmac-finalize-attestation/v1` 的 15 分钟规范化复证，绑定原证据 VersionId/SHA 和
target delivery VersionId/SHA，并在 Phase A 前再次验证。任一实时状态、引用、身份或时效漂移都会保持 API
零副本与 lock；因此原证据过期不会造成永久停机，也不会被用于重放 Terraform HMAC entry。

## 精确计划与部署制品

Terraform apply 不重新运行 plan，也不按 artifact 名称搜索。独立 `actions: read` job 先通过 Actions API
回读 plan job 返回的 `artifact-id`，要求服务端 `sha256`、workflow run ID、完整 `head_sha`、环境/run-attempt
唯一名称和未过期状态全部匹配；apply 只消费该 ID，并逐项核对源码 SHA、run ID/attempt、环境、账号、区域、
state 坐标、Terraform 版本和 plan SHA-256。state、Terraform delivery 与 Helm values 的 S3 key 都必须包含
目标环境独立路径段；任何差异都会在申请 apply OIDC 凭据前失败。Terraform 计划只允许从 GitHub 标记为
protected 的 ref 运行，Actions API 元数据绑定失败不得降级为只相信下载动作的 warning。

应用部署的源码与 ECR 验证证据也不只依赖 artifact 名称。源码 artifact 在 ECR 只读验证 job 取得 OIDC
之前先经独立无云权限 job 绑定；私网部署前再通过 Actions API 回读源码与验证证据两个不可变 artifact ID，
要求服务端 `sha256`、workflow run ID、完整 `head_sha`、run-attempt 唯一名称和未过期状态全部匹配。私网
job 随后按这两个 ID 下载，并再次校验内部逐文件 checksum 与 release identity。
私网 runner 会在下载前以 `0700` 创建本次 run/attempt 专属根目录，处理镜像、Kubeconfig、Web 静态根和
证据的脚本统一使用 `umask 077`。部署证据上传固定为 `if-no-files-found: error`，不能在发布成功后用
warning 掩盖审计制品缺失。Actions 服务真实可用性和 artifact API 权限仍是外部门禁，失败时不得跳过绑定。

应用部署与 HMAC 停机在接触 Kubernetes 前都会实时回读 EKS：集群 ARN 必须精确属于目标账号、区域和名称，
状态必须为 `ACTIVE`，且只能接受 `endpointPrivateAccess=true`、`endpointPublicAccess=false`。应用部署的
完整 `describe-cluster` 响应只短暂写入 `RUNNER_TEMP` 并立即删除，90 天审计 artifact 只保留 ARN、版本、
状态和两项端点布尔值，禁止持久化 subnet、security group、OIDC provider 或集群 endpoint 等拓扑元数据。

应用部署只接受三个 `sha256:<64 位小写十六进制>` 摘要。工作流不接受镜像 tag、ECR host、仓库名、
账号或区域输入。签名身份严格绑定生成 digest 的 `supply-chain-release.yml@refs/tags/<release_tag>`，
OIDC issuer 固定为 GitHub Actions。

应用部署在私网 runner 上下载 version ID 固定的 Terraform delivery，回读校验 S3 metadata、
Content-Type、CMK、环境、账号、区域、EKS、ECR、Web 和 CloudFront 边界。然后按不可变源码 artifact 中的
renderer 以 server-side apply 创建 namespace SecretStore 与六个版本化 ExternalSecret，再依次验证：

- 固定版本 add-on、CRD、ServiceAccount、AMP Prometheus Agent 与 remote-write 目标；
- Cluster Autoscaler 镜像版本必须与 EKS 主次版本一致，自动发现只允许当前集群托管节点组；
- Load Balancer Controller、Cluster Autoscaler、External Secrets 和 Prometheus Agent 必须分别绑定
  受控 EKS Pod Identity，禁止业务工作负载复用这些 AWS 身份；
- ExternalSecret Ready、已同步版本和 owner 关系；
- Helm effective values 引用的六个原生 Secret 名必须与 delivery 一致；API 与 Worker 运行素材使用对象级
  分离边界，全部 Secret 都以 `-v<正整数>` 版本化、
  `immutable=true` 且所有必需 data key 非空。

普通 Helm 滚动还必须从 effective values 提取
`release.definitionIdentity.{gameID,version,sha256}`，并与当前 RGS API、Worker Deployment 的
`slots-game.io/definition-*` Pod-template annotations 逐字段比较。只有两个 Deployment 都不存在时才视为
首次安装；仅一方存在、任一字段缺失、API/Worker 彼此不同或候选三元组变化都会在 Helm upgrade 前失败。
数学定义升级必须走维护窗口或独立版本分群流程，不能伪装成普通镜像滚动。

门禁只检查 key 存在性，不输出或解码 Secret 值。任何前置失败都在 Helm upgrade 之前失败闭合。

### 非滚动 PostgreSQL 迁移边界

AWS 普通应用升级中的 Migrator hook 固定执行 `verify`，不会自动执行 `up`；因此它能在任何 Deployment
变化前拒绝“候选镜像包含未应用迁移”，但不能把数据库模式变更伪装成 atomic 滚动。当前仓库已预留
Chart 的 `rgs.maintenanceQuiesced=true` + `worker.maintenanceQuiesced=true` 双组件零副本接口、独立
Migrator digest/Secret 和前向恢复约束，但尚未交付一个能同时证明 PostgreSQL 旧 writer 活动事务归零、
受保护执行 `up`、保存锁等待/耗时/执行计划并完成分阶段恢复的 AWS 自动化 workflow。

所以任何非空生产迁移仍是明确的外部上线阻断：必须走 `docs/database-migrations.md` 的已审批维护序列，
在目标私网和真实 RDS 上保存排空、迁移、`verify`、readiness 与渐进放量证据。禁止手工把 Helm values
直接恢复、禁止 down migration，也不能把首次安装/CI 干净库上的 `up` 成功宣称为现网大表迁移已验证。
在上述实时事务门禁实现并演练前，本仓库不会把该能力标记为自动化生产就绪。

## Web 不可变发布与切换接口

Web 静态根只能从已经验证并按 digest 拉取的 OCI 镜像提取。每个对象使用 S3 `If-None-Match: *` 写入
`releases/<release-id>/`，并立即使用 checksum mode 回读核对：

- S3 原生 SHA-256 checksum 与本地内容摘要、`ContentLength` 与本地字节数；
- release ID、Web digest、配置摘要和 CSP 摘要元数据；
- Content-Type、Cache-Control 和 KMS 服务端加密，实际 `SSEKMSKeyId` 必须精确等于
  受保护 Environment 中的 `AWS_WEB_KMS_KEY_ARN`；
- 本地普通文件数量与 S3 release 前缀对象数量完全一致。

release 前缀不要求在发布开始时为空：上传中断后重跑仍会对每个本地对象执行条件 `PutObject`。条件写入
非零（包括对象已存在或响应丢失）时，只有上述 SHA-256、长度、四项身份元数据、Content-Type、
Cache-Control、KMS 算法与 key 全部回读一致才会把该对象视为已完成；任何字段漂移、对象缺失或最终对象
总数不精确都会在 KVS 切换前失败关闭。因此重跑只补齐缺失对象，不会覆盖不可变前缀，也不会接受同名漂移。
应用发布角色必须具备对应对象的最小 `s3:PutObject`/`s3:GetObject`、前缀 `s3:ListBucket`，以及该 Web
CMK 的 `kms:GenerateDataKey*`/`kms:Decrypt`；后两项是 SSE-KMS 条件写入和 checksum HEAD 回读的必要权限。

CloudFront Response Headers Policy 的 CSP 由 Terraform 管理，应用发布只能回读，不能制造 IaC drift；
回读值必须与同一 OCI digest 提取的 CSP 逐字相同。工作流还会从 CloudFront 的不可变 release 路径读取
manifest，核对字节和实际 CSP 响应头后才允许切换。

切换接口是 `infra/terraform` 创建并绑定到 LIVE CloudFront Function 的 KeyValueStore。工作流验证
distribution 的 `viewer-request` 关联、Function 的唯一 KVS 关联和 KVS `READY` 状态，再使用当前 ETag
执行以下单键条件更新：

```text
active-release = sha256:<64 位小写十六进制>
```

工作流随后同时回读 KVS API 和无 Cookie 的 CloudFront 公网入口。任何 ETag 冲突、KVS 回读不一致、
公网 manifest/CSP 不一致都会失败关闭；若条件更新已经成功，则只在 KVS ETag 仍等于本次写入结果时
自动恢复旧 `active-release`，绝不覆盖并发发布。回退后还会轮询公网读路径：有旧版本时必须重新读回旧
`releaseId`，首次发布时必须恢复为 router 的受控 `503 release is not ready`；控制面或公网任一项未恢复
都不得宣称回滚完成，必须立即人工处置。应用发布禁止直接修改 distribution origin/path、CloudFront
Function 或 Response Headers Policy。本地开发机不得调用正式 KVS 切换接口。

KVS 写命令返回非零不能直接退出：CLI 超时或响应丢失时服务端可能已经完成条件写入。发布器会保存旧状态，
先用 `get-key` 进行第一次权威回读；若该调用失败，再以完整 `list-keys` 区分“key 确实不存在”和“控制面
不可读”。精确读到目标 release 才会进入受控公网验证；第一次读到保存的旧状态仍不能直接判定未应用，
因为超时请求可能仍在服务端排队。旧版存在时，发布器以原 ETag 条件写回旧值来推进版本并 fence 掉迟到请求；
首次发布没有旧值可写回时，以相同目标重试消费原 ETag。随后只读轮询必须观察到 ETag 已离开切换前版本：
由于 key 与 store ETag 来自两个 API，发布器还必须连续两次读到完全相同的 key/ETag pair，才会把它当作
稳定快照；若 active-release 是目标则进入公网验证，若仍是旧状态才可安全失败。读到其他 release、畸形/重复 key、
权威读取失败或 ETag 在时限内始终未推进时，立即冻结自动写入并生成权限为 `0600` 的
`kvs-manual-intervention.env`，禁止猜测状态后盲目回退。回退命令本身的非零或损坏响应也执行同样的权威
对账，并要求 ETag 离开回退前版本；只有已恢复保存状态才继续公网恢复验证。纯本地 fault fixture 固定覆盖 `applied-then-error`、
`not-applied-error`、`lookup-error`、`delayed-apply-after-read`，并额外验证首次发布删除 key 后必须读回受控 503。

Helm `--atomic` 与 Web KVS 的 ETag 条件切换是两个独立原子边界，不构成 EKS、S3 与 CloudFront 之间的
分布式事务。标准发布先完成 RGS Helm revision，再发布 Web；如果 Web 最终回退，已经成功并可能处理交易的
RGS revision 会保留，工作流不会盲目自动回滚服务端。整包商业发布因此还必须有同一组三个 digest 的前后向
协议/配置兼容证据、分阶段放量与经批准的服务端回退判据；在该外部证据和审批未接入前，禁止宣称“全栈原子发布”。

## 本地只读门禁

以下命令不会取得 AWS 凭据，也不会执行 plan/apply、Helm 发布、S3 写入或 CloudFront 切换：

```sh
cd slots-game
deploy/aws-production/workflow/verify-contract.sh
deploy/aws-production/workflow/test-negative-contract.sh
deploy/aws-production/workflow/test-live-application-secrets.sh
deploy/aws-production/workflow/test-live-definition-identity.sh
deploy/aws-production/workflow/test-web-release-switch-faults.sh
deploy/aws-production/workflow/test-hmac-quiesce-evidence.sh
deploy/aws-production/workflow/test-hmac-application-maintenance.sh
deploy/aws-production/workflow/test-hmac-only-release-diff.sh
deploy/aws-production/workflow/test-latest-terraform-delivery.sh
shellcheck deploy/aws-production/workflow/*.sh deploy/aws-production/workflow/fixtures/*.sh \
  deploy/aws-production/verify-live-platform-prerequisites.sh
ruby -c deploy/aws-production/render-external-secrets.rb
ruby -c deploy/aws-production/workflow/verify-rendered-release.rb
for file in deploy/aws-production/workflow/*.rb; do ruby -c "$file"; done
actionlint ../.github/workflows/aws-infrastructure.yml \
  ../.github/workflows/aws-application-deploy.yml \
  ../.github/workflows/aws-hmac-quiesce-evidence.yml
```

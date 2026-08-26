# 商用供应链门禁

本目录把“依赖、源码、候选构建、Web 素材审批、Registry 发布和 OIDC 签名”拆成四个
互不共享凭据的权限域。执行 npm/测试的 job、fresh-checkout 候选构建 job、仅持有一次性
素材审批的 Web job 与最终发布签名 job 彼此隔离；任何执行仓库依赖的 job 都拿不到
Registry 凭据或 GitHub OIDC 发布身份。

这套实现不会生成占位签名、模拟审批或虚构漏洞豁免。仓库当前的
[`vulnerability-exceptions.json`](vulnerability-exceptions.json) 是严格的零豁免策略：
任一可达 Go 漏洞、npm HIGH/CRITICAL advisory、Gitleaks 命中或 Trivy
HIGH/CRITICAL 漏洞都会使作业失败。需要豁免时，必须先扩展成经过安全负责人批准、
带工单、受影响组件、补偿控制和到期时间的机器可校验策略；不能直接添加 ignore 参数。

## 已落地门禁

[`scan.sh`](scan.sh) 在固定 digest 的短命容器中执行以下操作：

- `govulncheck v1.7.0`：按实际可达调用链扫描 `server` Go 模块；
- Node 22.22.0 的 `npm audit`：分别扫描完整锁文件和生产依赖，阈值为 HIGH；
- Gitleaks 8.29.1：先用运行时构造的 GitHub classic PAT 形状假凭据证明默认规则能命中且
  `redact=100` 报告不含明文，再分别扫描当前发布 `HEAD` 可达的完整历史和当前工作树；检出
  附带的其他远端引用不会混入发布证据，仓库级 `.gitleaks.toml`、`.gitleaksignore` 与内联
  allow 均不能缩小范围；`gitleaks-history-commit-count.txt` 记录同一 `HEAD` 边界内的提交数；
- Syft 1.51.0：对完整 Git 根（包含父级 `.github` 发布工作流）同时输出 CycloneDX JSON
  1.6 与 SPDX JSON 2.3；源码、Docker 归档与 OCI 归档三种模式均在断网只读容器内运行，
  仅使用带 sticky 权限的短命 `/tmp` 及其隔离 HOME/cache；
- Trivy 0.74.0：扫描文件系统依赖漏洞、五个正式 Dockerfile、渲染后的 Helm 配置、四个
  AWS Terraform 环境根的 IaC 错配，以及每个发布候选镜像中的漏洞和 secret；
- Trivy 镜像 JSON 在留档前由固定 Node 镜像执行最小净化，删除 secret finding 的 `Code`
  与 `Match` 原文/上下文字段，同时保留规则、位置和严重级别，避免 `always()` artifact
  泄露邻近但未被 Trivy 遮蔽的业务值；
- 联网阶段下载 vulnerability DB 与官方 checks bundle，并用故意不安全的 Kubernetes Pod
  canary 证明 Rego 检查确实执行；校验 DB/checks schema、checks OCI digest、内容数量和
  symlink 边界后，记录 metadata、数据库 SHA-256 与 checks 内容树 SHA-256；漏洞库下载使用
  显式 30 分钟上限，慢速镜像不会被 Trivy 默认 5 分钟超时误判，但超过上限仍失败关闭；
- 实际文件系统扫描覆盖完整 Git 根，使用断网、只读 cache、内存分析缓存、`--skip-check-update`
  和空 ignore/config 文件；零豁免策略还会拒绝仓库内联 Trivy ignore；若 checks bundle 被删除
  或退回不可证明的内置 fallback，会失败关闭；
- 镜像先由 Docker 导出为只读归档，再交给 Syft/Trivy，不把 Docker socket 暴露给扫描器。

所有工具镜像引用集中在 [`tool-images.env`](tool-images.env)，同时固定可读版本标签和
64 位 SHA-256 多架构清单 digest。更新工具必须作为独立安全变更复核，不能只改标签。

仓库级 CI 位于 `.github/workflows/supply-chain.yml`：

1. daemon-independent 静态门禁、签名输入校验、scanner 资产负向测试与多项策略篡改测试；
2. Go/Node/secret/依赖漏洞扫描、五个正式 Dockerfile、使用有效生产值渲染的 Helm 配置，以及
   dev/staging/prod-primary/prod-dr 四个独立 Terraform 环境扫描；Terraform 使用各环境受跟踪的
   `terraform.tfvars.example` 和固定的非秘密 scanner-only ephemeral 输入，不读取部署 Secret；
   同一阶段还生成源码双格式 SBOM；
3. 从 `deploy/cluster-production/Dockerfile.services` 构建正式 Chart 使用的 RGS runtime、
   migrator，并动态验证 `/secret-env`、`/service-probe` 和缺 Secret 失败关闭；同时构建带
   不可发布标签的 Web 静态契约镜像；
4. 为三个镜像生成双格式 SBOM 并执行 HIGH/CRITICAL 镜像扫描；
5. 无论扫描成功或失败，都保留有限期 JSON/SBOM/数据库、checks bundle 与 canary 身份报告，
   便于审计失败原因。

本机没有 Docker daemon 时仍可执行：

```sh
./deploy/supply-chain/verify-contract.sh
./deploy/supply-chain/test-contract.sh
make verify-supply-chain-contract
```

动态扫描需要 Docker，并显式写入报告目录；纯 OCI layout tar 可直接扫描：

```sh
./deploy/supply-chain/scan.sh source "${TMPDIR:-/tmp}/slots-supply-chain-source"
./deploy/supply-chain/scan.sh image slots-rgs-runtime:local rgs-runtime "${TMPDIR:-/tmp}/slots-supply-chain-images"
./deploy/supply-chain/scan.sh oci-archive /approved/path/release-image.oci.tar release-image "${TMPDIR:-/tmp}/slots-supply-chain-oci"
```

源码报告目录和 `TRIVY_CACHE_DIR` 必须位于 Git 根之外，否则报告或 cache 会被本次完整根扫描
再次读入，脚本会在启动 scanner 前拒绝执行。依赖结果写入 `trivy-filesystem.json`，显式生产
Docker/Helm 配置结果写入 `trivy-config.json`，后置覆盖契约精确要求十七个正式目标，其中包括
本地 Nginx 代理以及独立的 API 与 Worker Deployment；新增或删除目标都必须同步安全评审与机器契约。
Terraform 分别写入 `trivy-terraform-dev.json`、`trivy-terraform-staging.json`、
`trivy-terraform-prod-primary.json` 和 `trivy-terraform-prod-dr.json`，每份报告都保留环境身份并
精确校验 Trivy 当前解析出的 root、archive 与 web-edge 目标及其 `config/terraform` 类型。
`trivy-terraform-tracked-files.txt` 由 `git ls-files -z` 生成；扫描器逐项拒绝异常路径和符号链接后
复制到隔离 tmpfs，再用独立遍历结果写出 `trivy-terraform-copied-files.txt`，两份清单必须完全一致。
当前清单包含全部 48 个受跟踪 `.tf`、四个环境 tfvars example 与 web-edge 的两个 template JS，
合计 54 个 scanner 输入；新增受跟踪 `.tf` 会自动纳入，而四个 tfvars 和两个 JS 必须始终精确存在。
任一报告解析类型变化、阻断级发现、额外/缺失目标、清单目录逃逸、未跟踪残留或链接替换都会失败关闭。

## Provenance、SBOM attestation 与镜像签名

`.github/workflows/supply-chain-release.yml` 只接受 `workflow_dispatch`。上线前管理员必须在
GitHub 仓库设置中**预先**创建以下两个 Environment；仅在 YAML 中引用名称不能证明审批规则
存在，缺失时不得运行生产发布：

1. `supply-chain-web-approval`
   - 启用 required reviewers，审批人必须是素材/法务授权责任人；
   - deployment branches/tags policy 只允许组织批准的受保护发布 tag；
   - 只在这个 Environment 保存短期、逐构建且内容精确的
     `SUPPLY_CHAIN_WEB_RELEASE_ASSET_APPROVAL`；不得把同名值配置成 repository/organization
     secret，否则会绕过独立审批边界；
   - 不配置 Registry 用户名、密码或任何云身份。
2. `supply-chain-release`
   - 启用独立 required reviewers，deployment policy 同样只允许批准的受保护 tag；
   - 以 Environment variables 固定 `AWS_ACCOUNT_ID`、`AWS_REGION`、`AWS_RELEASE_ROLE_ARN`，以及
     `AWS_ECR_RGS_RUNTIME_REPOSITORY`、`AWS_ECR_RGS_MIGRATOR_REPOSITORY`、
     `AWS_ECR_WEB_REPOSITORY`；不得保存长期 AWS access key，也不得允许 dispatch 输入改变账号或仓库；
   - AWS IAM trust 必须把 GitHub OIDC `sub` 精确限制到本仓库、该 Environment 和受保护发布 tag；
   - 发布角色只拥有三个预创建 ECR 仓库所需的上传/读取权限，不得创建、删除仓库或删除镜像；
   - 三个 ECR 仓库必须启用 KMS、`IMMUTABLE`，Registry 必须使用 Enhanced continuous scanning。

工作流还要求：

- 从受保护 tag 运行，且 GitHub `ref_protected` 必须为 `true`；
- 人工输入 ECR host、无 tag 的镜像仓库、构建目标、与受保护 Git tag 完全相同的
  OCI tag、精确证书身份和精确 OIDC issuer；工作流会将账号、区域和仓库与受保护
  Environment variables 逐项相等校验；
- 证书身份必须精确等于
  `https://github.com/<owner>/<repo>/.github/workflows/supply-chain-release.yml@<protected-tag>`，
  issuer 必须精确等于 `https://token.actions.githubusercontent.com`。

受保护 ref 本身不等于该 SHA 已通过测试。发布 workflow 用五个权限域闭合真实执行结果与
候选字节之间的 TOCTOU 和权限边界：

1. `verify-source-conformance` 只有 `contents: read`，在 clean checkout 上先执行当前发布提交
   可达的完整历史/worktree secret、Go/Node 漏洞、源码 SBOM、完整根 Trivy 依赖扫描与四环境
   Terraform IaC 扫描；该步骤严格位于 `npm ci`/build 之前，`node_modules`、`dist` 与宿主
   tool cache 不会污染源码证据；随后用固定 SHA 的 setup actions 安装 Go 1.26.6、Node
   22.22.0 与 `npm ci`；
2. 同一 job 执行 `make verify` 的前后端全量测试、race、vet、前后端 build/typecheck 与
   供应链静态契约，并在该构建输出上再次执行前端确定性复建；
   固定 digest 的 PostgreSQL 17 service、真实 PostgreSQL conformance，以及使用短命 CI-only
   v2 审批/TLS 材料的 production-configuration runtime fail-closed smoke 也在此完成；此外会
   真实构建并运行正式集群 Dockerfile 的两个目标，防止可签名候选缺少 Secret/probe helper；
3. `build-rgs` 依赖上述 job 成功，但使用独立 fresh checkout 的精确 `github.sha`，不运行宿主
   npm/Go/make，不绑定 Environment，也没有 secret/OIDC/Registry；它记录真实 Git tree SHA，
   用固定 Buildx 与固定 digest 的 BuildKit 构建 RGS OCI archive，再对该 archive 生成双 SBOM
   和漏洞/secret 报告；测试依赖即使污染前一 workspace，也不能修改候选构建上下文；
4. `build-approved-web` 同样 fresh checkout，但只绑定 `supply-chain-web-approval`；审批 JSON
   仅在一个 step 写入 `0600` 临时文件并通过 BuildKit secret mount 交给 Dockerfile 中
   `RUN --network=none` 的授权层，构建后立即删除。此 job 没有 OIDC、attestation 或 Registry
   凭据，并把真实 source tree、四项公开生产配置、受保护 tag、完整 commit 及 exact
   approval SHA-256、规范化审批元数据 SHA-256 与规范化 UTC `expiresAt` 绑定到 schema v2 包清单和
   job outputs；审批引用、辖区与资产明文不会进入 bundle；
5. `bind-release-artifact` 不 checkout、不绑定 Environment，也没有 OIDC/Registry 权限；它唯一的
   `actions: read` 权限只用于从 GitHub Actions API 回读所选 artifact ID，并将服务端 archive digest、
   本次 workflow run、完整 commit SHA、未过期状态和唯一 artifact 名称逐项绑定。陈旧 ID、摘要
   不一致或跨 run 制品会在进入最终发布 Environment 前失败关闭；
6. `publish-sign` 是唯一绑定 `supply-chain-release` 且具有 `id-token: write` 的 job。它先在无
   AWS 身份的阶段离线复核全部字节，随后才用 GitHub OIDC 换取短期发布角色并登录精确 ECR；它不
   checkout、不 setup 工具、不运行 npm/Go/make/test/build/scanner，只按同一 workflow run 返回的
   immutable artifact ID 下载被选中的 RGS/Web bundle。

静态契约按完整 permissions block 做精确白名单比较：前三个执行源码的 job 只能是 `contents: read`，
`bind-release-artifact` 只能是 `actions: read`；
`publish-sign` 只能额外拥有 `id-token: write`、`attestations: write` 和
`artifact-metadata: write`。即使新增 `packages`、`actions` 或 `security-events` 等写权限也会由
负向夹具失败关闭，不能以“仍包含 contents: read”为由放行。

这些检查的静态结构和执行次序均有负向契约锁定，不能用外部 workflow 名称或“required
check 已配置”的声明代替。候选清单同时绑定 commit SHA、真实 Git tree SHA、ref、target、
repository/tag、公开配置摘要、Web approval/规范化元数据摘要及 UTC 有效期、OCI manifest digest、archive/SBOM SHA-256
和严格文件 allowlist；删除或替换任一控制都会被 daemon-independent 负向测试拒绝。

`publish-sign` 在任何 Registry 登录前离线复核上游 job output、artifact service digest、清单
摘要、逐文件 checksum、OCI layout/单 manifest、双 SBOM schema 和已净化 Trivy 报告。纯 OCI
archive 随后由固定 digest、`--network=none`、无 OIDC env/Registry/Docker socket 的 Skopeo
转换成 Docker 明确定义可 load 的 archive；本地 Docker daemon 不可用时无法动态演练此转换与
load，CI 中任何转换/load 失败都会失败关闭，而不会回退到重新 build。

Web 浏览器 smoke 的 OCI→Docker 转换同样不向 Skopeo 容器挂载宿主 Docker socket：转换容器只读
审批后 bundle、写入独立短命目录，宿主随后 `docker load` 并提取静态根。最终发布 job 也把转换后的
完整 Docker archive 留在独立 work 目录，并在上传审计证据前删除 bundle 与 work；90 天证据只保留
摘要、Cosign 验证结果和 Sigstore attestation，不会把完整镜像或授权素材借由 evidence artifact
延长留存。全部 release evidence 上传使用 `if-no-files-found: error`，缺失证据不能以 warning 通过。

只有离线复核与转换成功后才读取 Registry secret、登录、load 相同制品字节。Web candidate push
紧前会以当前时钟复核包内 `expiresAt`。发布 workflow 以精确的镜像仓库和 final tag 为并发键串行，
且不会取消已经在途的同目标发布；取得 AWS 身份后、Registry 登录和 candidate push 前，它必须先
证明 final tag 不存在，非 `ImageNotFoundException` 的回读失败一律阻断。随后才推送本次 run
唯一 candidate 并解析 Registry 返回的不可变 digest，然后：

1. 使用固定完整 SHA 的 `actions/attest` 为该 digest 生成 SLSA build provenance；
2. 把重新生成的 SPDX SBOM 作为 SBOM attestation 绑定到同一 digest；
3. 使用固定 digest 的 Cosign 3.1.3 和 GitHub OIDC 短命证书签名；
4. 立刻用精确 certificate identity/issuer 反向验证，并归档 Sigstore bundle 与验证结果；
5. 只有以上步骤全部通过，且在最终 push 紧前再次以当前时钟复核 Web 审批仍有效，才把同一已验证
   digest 提升为最终发布 tag；末端仍会再次拒绝已存在的 final tag。workflow 内串行与前置回读
   不能约束管理员或仓库外写入，Registry 端仍必须配置 tag immutability 作为外部保护。

GitHub Artifact Attestations 对私有/内部仓库的套餐限制、目标 Registry 是否支持 OCI
attestation/signature、Registry 写权限和 Environment 审批均属于真实外部发布输入。
任何一项未配置或验证失败，发布工作流都会停止；本仓库不替这些输入伪造“通过”。

下游部署必须按 digest 拉取，并在准入层再次验证 Cosign 身份与 provenance；仅“存在签名”
不等于制品安全，也不能替代漏洞、素材授权、数学/RNG、法规和运营审批。AWS S3/CloudFront 发布
必须使用 `extract-aws-web-static-root.sh`（或经同等评审的外部实现）从该 digest 提取静态根和 CSP，
逐文件对照 `release-manifest.json`，并把 CloudFront policy 与同一 bundle 的
`CONFIGURATION_SHA256` 绑定；禁止直接同步工作区 `web/dist`。

## 官方依据（2026-08-16 复核）

- [Go govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck)
- [npm audit](https://docs.npmjs.com/cli/commands/npm-audit)
- [Gitleaks README](https://github.com/gitleaks/gitleaks)
- [Syft SBOM 格式](https://oss.anchore.com/docs/guides/sbom/formats/)
- [Trivy 文件系统扫描](https://trivy.dev/docs/latest/target/filesystem/)
- [Trivy 官方 checks bundle 下载、缓存与内置 fallback 说明](https://trivy.dev/docs/latest/scanner/misconfiguration/check/builtin/)
- [GitHub Artifact Attestations](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds)
- [GitHub OIDC job 权限边界](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub workflow artifact 摘要校验](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [`actions/attest` SBOM/provenance 模式](https://github.com/actions/attest)
- [Docker OCI/Docker exporters 与 load 边界](https://docs.docker.com/build/exporters/)
- [Skopeo 官方 OCI 传输实现](https://github.com/containers/skopeo)
- [Cosign 签名与精确身份验证](https://github.com/sigstore/cosign)
- [GitHub Action 完整 SHA 固定建议](https://docs.github.com/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)

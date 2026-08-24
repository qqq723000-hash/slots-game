#!/bin/sh
# shellcheck disable=SC1003,SC2016

# 负向门禁对临时副本注入危险变体，证明静态契约会失败；不会连接任何 AWS 服务。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../../../.." && pwd)
contract_verifier="$script_directory/verify-contract.sh"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-aws-workflow-negative.XXXXXX")

cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf '%s\n' "AWS 工作流负向契约失败：$*" >&2
  exit 1
}

reset_fixture() {
  rm -rf "$fixture_root/.github" "$fixture_root/slots-game"
  mkdir -p "$fixture_root/.github/workflows" \
    "$fixture_root/slots-game/deploy/aws-production/workflow" \
    "$fixture_root/slots-game/infra/terraform/contracts" \
    "$fixture_root/slots-game/infra/terraform/scripts"
  cp "$repository_root/.github/workflows/aws-infrastructure.yml" \
    "$repository_root/.github/workflows/aws-application-deploy.yml" \
    "$repository_root/.github/workflows/aws-hmac-quiesce-evidence.yml" \
    "$fixture_root/.github/workflows/"
  cp "$script_directory"/*.sh "$script_directory"/*.rb \
    "$script_directory/README.md" \
    "$fixture_root/slots-game/deploy/aws-production/workflow/"
  cp -R "$script_directory/fixtures" "$fixture_root/slots-game/deploy/aws-production/workflow/"
  cp "$repository_root/slots-game/deploy/aws-production/render-external-secrets.rb" \
    "$repository_root/slots-game/deploy/aws-production/verify-live-alb-edge.sh" \
    "$repository_root/slots-game/deploy/aws-production/verify-waf-rollout-evidence.rb" \
    "$repository_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh" \
    "$fixture_root/slots-game/deploy/aws-production/"
  cp "$repository_root/slots-game/infra/terraform/contracts/cluster-addons-interface.v1.yaml" \
    "$fixture_root/slots-game/infra/terraform/contracts/"
  cp "$repository_root/slots-game/infra/terraform/scripts/verify-valkey-rotation-plan.rb" \
    "$fixture_root/slots-game/infra/terraform/scripts/"
}

replace_once() {
  source_text=$1
  replacement_text=$2
  target_file=$3
  SOURCE_TEXT=$source_text REPLACEMENT_TEXT=$replacement_text TARGET_FILE=$target_file ruby -e '
    path = ENV.fetch("TARGET_FILE")
    text = File.binread(path).force_encoding(Encoding::UTF_8)
    source = ENV.fetch("SOURCE_TEXT").dup.force_encoding(Encoding::UTF_8)
    replacement = ENV.fetch("REPLACEMENT_TEXT").dup.force_encoding(Encoding::UTF_8)
    abort "负向替换目标不是 UTF-8" unless
      text.valid_encoding? && source.valid_encoding? && replacement.valid_encoding?
    abort "未找到负向替换目标" unless text.include?(source)
    File.binwrite(path, text.sub(source, replacement))
  '
}

expect_rejected() {
  label=$1
  if AWS_WORKFLOW_REPOSITORY_ROOT="$fixture_root" "$contract_verifier" >/dev/null 2>&1; then
    fail "$label 没有被拒绝"
  fi
}

reset_fixture
AWS_WORKFLOW_REPOSITORY_ROOT="$fixture_root" "$contract_verifier" >/dev/null || \
  fail '未注入危险变体的基线副本未通过静态契约'

reset_fixture
replace_once 'rgs_base_url == "https://#{api_host}"' \
  'rgs_base_url != "https://#{api_host}"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-web-rgs-origin.rb"
expect_rejected 'Web RGS Origin 未精确绑定实际 Ingress host'

reset_fixture
replace_once "expect_rejected 'foreign RGS Origin' https://foreign.example.com" \
  "true # foreign RGS negative removed" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/test-web-rgs-origin.sh"
expect_rejected 'foreign RGS Origin 负向夹具被删除'

reset_fixture
replace_once 'managed.keys.sort == %w[Name VendorName Version] &&' \
  'true && # managed hidden overrides accepted' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected '区域 WAF managed statement 允许隐藏 override/exclude/scope'

reset_fixture
replace_once 'filter.fetch("Behavior") == "KEEP" && filter.fetch("Requirement") == "MEETS_ANY" &&' \
  'true && # logging filter behavior ignored' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'WAF logging filter 未精确固定 KEEP+MEETS_ANY'

reset_fixture
replace_once 'empty_associations.call(default_behavior.fetch("LambdaFunctionAssociations"))' \
  'true # Lambda@Edge associations accepted' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'CloudFront default behavior 允许 Lambda@Edge 绕过'

reset_fixture
replace_once '.DistributionConfig.CacheBehaviors.Quantity == 1 and' \
  'true and # extra cache behaviors accepted' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'Web publisher 允许额外 CloudFront cache behavior'

reset_fixture
replace_once 'header_match.fetch("MatchScope") == "ALL" &&' \
  'true && # aggregate header match scope ignored' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'WAF header size rule 未固定检查全部 headers'

reset_fixture
replace_once 'size.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}]' \
  'true # transformed size accepted' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'WAF size rule 允许压缩后计量绕过 8KiB'

reset_fixture
replace_once 'rate.keys.sort == %w[AggregateKeyType EvaluationWindowSec Limit] &&' \
  'true && # CloudFront rate scope-down accepted' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'CloudFront 全站 rate rule 允许 ScopeDownStatement'

reset_fixture
replace_once 'web_acl_visibility.fetch("CloudWatchMetricsEnabled") == true &&' \
  'true && # WebACL metrics may be disabled' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'WAF WebACL visibility 可静默禁用 CloudWatch metrics'

reset_fixture
replace_once 'alarm.fetch("ComparisonOperator") == "GreaterThanOrEqualToThreshold" &&' \
  'true && # alarm comparison drift accepted' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'WAF alarm comparison operator 未精确固定'

reset_fixture
replace_once 'actual_cidrs.length == expected_cidrs.length && actual_cidrs.sort == expected_cidrs.sort' \
  'true # actual NetworkPolicy CIDRs not bound to Terraform' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-alb-edge.sh"
expect_rejected 'postdeploy ALB gate 未精确回读实际 NetworkPolicy CIDR'

reset_fixture
replace_once '"kubernetes.io/metadata.name" => "monitoring"' \
  '"kubernetes.io/metadata.name" => "foreign-monitoring"' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-alb-edge.sh"
expect_rejected 'postdeploy ALB gate 未精确绑定 monitoring namespace selector'

reset_fixture
replace_once '"app.kubernetes.io/name" => "prometheus-agent"' \
  '"app.kubernetes.io/name" => "foreign-agent"' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-alb-edge.sh"
expect_rejected 'postdeploy ALB gate 未精确绑定 monitoring pod selector'

reset_fixture
replace_once '"$kubectl_binary" -n "$application_namespace" get networkpolicy \' \
  '"$kubectl_binary" -n "$application_namespace" get networkpolicy -l "app.kubernetes.io/instance=$release_name" \' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-alb-edge.sh"
expect_rejected 'postdeploy ALB gate 仅按 release label 回读 NetworkPolicy，允许未标记附加策略旁路'

reset_fixture
replace_once \
  'aws-actions/configure-aws-credentials@61815dcd50bd041e203e49132bacad1fd04d2708' \
  'aws-actions/configure-aws-credentials@v5' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected '未固定 SHA 的 Action'

reset_fixture
replace_once '    name: AWS infrastructure static contract' \
  '    name: static-contract' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected '基础设施 required context 退回歧义 job id'

reset_fixture
replace_once '    name: AWS application static contract' \
  '    name: AWS infrastructure static contract' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用 required context 与基础设施重复'

reset_fixture
replace_once '    name: AWS HMAC quiesce static contract' \
  '    name: AWS application static contract' \
  "$fixture_root/.github/workflows/aws-hmac-quiesce-evidence.yml"
expect_rejected 'HMAC required context 与应用重复'

for filtered_workflow in \
  aws-infrastructure.yml \
  aws-application-deploy.yml \
  aws-hmac-quiesce-evidence.yml
do
  reset_fixture
  replace_once '  pull_request:
  workflow_dispatch:' \
    '  pull_request:
    paths:
      - README.md
  workflow_dispatch:' \
    "$fixture_root/.github/workflows/$filtered_workflow"
  expect_rejected "$filtered_workflow 的 required check 仍使用 PR paths 过滤"
done

reset_fixture
replace_once '      - main' "      - '*'" \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected '基础设施 push 静态门禁扩展到非 main 分支'

reset_fixture
replace_once "    if: github.event_name == 'workflow_dispatch'" \
  "    if: github.event_name == 'push'" \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform plan 在 push 时申请 AWS 凭据'

reset_fixture
replace_once "    if: github.event_name == 'workflow_dispatch' && inputs.operation == 'apply'" \
  "    if: github.event_name == 'pull_request'" \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform apply 在 PR 时申请 AWS 凭据'

reset_fixture
printf '%s\n' '      AWS_ACCESS_KEY_ID: forbidden' >> \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '长期 AWS access key'

reset_fixture
replace_once '"$INPUT_WEB_DIGEST"' '${{ inputs.web_digest }}' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '未验证的 dispatch 摘要直接展开到 shell 脚本'

reset_fixture
replace_once 'grep -F -x -- "$verified_image" "$VERIFIED_RELEASE/verified-images.env"' \
  'true' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '部署 Environment 没有绑定制品验证 Environment 的精确 ECR 引用'

reset_fixture
replace_once '.digest == $digest and .workflow_run.id == $run_id and' \
  '.workflow_run.id == $run_id and' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'OIDC 前部署源码 artifact 服务端摘要未绑定'

reset_fixture
replace_once '      - bind-deployment-source' \
  '      - static-contract # source artifact binding dependency removed' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'ECR OIDC 验证没有等待源码 artifact 元数据绑定成功'

reset_fixture
replace_once '      - bind-deployment-artifacts' \
  '      - verify-release # artifact binding dependency removed' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '私网部署没有等待 artifact 元数据绑定成功'

reset_fixture
replace_once '    permissions:
      actions: read
    env:
      SOURCE_ARTIFACT_ID:' \
  '    permissions:
      actions: read
      contents: write
    env:
      SOURCE_ARTIFACT_ID:' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'artifact 元数据绑定 job 获得额外写权限'

reset_fixture
replace_once 'install -d -m 0700 "/tmp/slots-aws-deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/downloads"' \
  'mkdir -p "/tmp/slots-aws-deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/downloads"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '私网 runner 下载目录退回宽松默认权限'

reset_fixture
replace_once '          if-no-files-found: error' '          if-no-files-found: warn' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用部署证据缺失仍只给 warning'

reset_fixture
replace_once '--atomic --wait --wait-for-jobs --timeout 20m' '--wait --timeout 20m' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '非 atomic Helm 发布'

reset_fixture
replace_once '.scanningConfiguration as $configuration' '. as $configuration' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '错误读取 ECR scanningConfiguration 顶层'

reset_fixture
replace_once '$configuration.scanType == "ENHANCED"' '$configuration.scanType == "BASIC"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'ECR 扫描类型降级为 BASIC'

reset_fixture
replace_once 'all($repositories[];' 'any($repositories[];' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'ECR 持续扫描没有覆盖全部三个仓库'

reset_fixture
replace_once '"$HELM_BIN" upgrade --install "$AWS_HELM_RELEASE_NAME" "$chart"' \
  '"$HELM_BIN" upgrade --install slots "$chart"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '跨环境硬编码 Helm release'

reset_fixture
replace_once '--namespace "$AWS_EKS_NAMESPACE"' '--namespace slots-production' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '跨环境硬编码 Kubernetes namespace'

reset_fixture
replace_once "\${{ 'slots-aws-private-deployer' }}" '\${{ vars.AWS_RUNNER_LABEL }}' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '部署 runner 标签可被 Environment 动态替换'

reset_fixture
replace_once 'artifact-ids: ${{ needs.terraform-plan.outputs.artifact_id }}' \
  'name: mutable-plan-name' "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected '按可变名称下载 Terraform plan'

reset_fixture
replace_once '.digest == $digest and .workflow_run.id == $run_id and' \
  '.workflow_run.id == $run_id and' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform plan artifact 服务端摘要未绑定'

reset_fixture
replace_once '      - bind-terraform-plan' \
  '      - terraform-plan # artifact binding dependency removed' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform apply 没有等待 plan artifact 元数据绑定成功'

reset_fixture
replace_once '    permissions:
      actions: read
    env:
      PLAN_ARTIFACT_ID:' \
  '    permissions:
      actions: read
      contents: write
    env:
      PLAN_ARTIFACT_ID:' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform plan artifact 元数据绑定 job 获得额外写权限'

reset_fixture
replace_once '          test "$GITHUB_REF_PROTECTED" = true' \
  '          true' "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform plan 允许未受保护 ref 申请 OIDC'

reset_fixture
replace_once 'type == "object" and keys == ["configuration"] and' \
  'type == "object" and' "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform tfvars 允许 configuration 之外的顶层键'

reset_fixture
replace_once 'TF_VAR_valkey_password_a: ${{ secrets.TERRAFORM_VALKEY_PASSWORD_A }}' \
  'TF_VAR_valkey_password_a: forbidden-plain-value' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform ephemeral A 槽密码未全部来自受保护 secret'

reset_fixture
replace_once 'TF_VAR_valkey_password_b: ${{ secrets.TERRAFORM_VALKEY_PASSWORD_B }}' \
  'TF_VAR_valkey_password_b: forbidden-plain-value' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform ephemeral B 槽密码未全部来自受保护 secret'

reset_fixture
replace_once '    "TF_VAR_valkey_password_b",' '    "TF_VAR_shared_admission_hmac_key",' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/fingerprint-terraform-ephemeral-inputs.sh"
expect_rejected 'Terraform ephemeral 指纹遗漏 Valkey B 槽密码'

reset_fixture
replace_once \
  'valkey_password_fingerprint_a=$(printf '\''%s'\'' "$TF_VAR_valkey_password_a" | sha256sum | awk '\''{ print $1 }'\'')' \
  'valkey_password_fingerprint_a=$(printf '\''%s'\'' "$TF_VAR_valkey_password_b" | sha256sum | awk '\''{ print $1 }'\'')' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform configuration 的 A 槽 fingerprint 未绑定实际 A 槽密码'

reset_fixture
replace_once \
  '.configuration.valkey_password_fingerprint_b = $valkey_password_fingerprint_b |' \
  '.configuration.valkey_password_fingerprint_b = .configuration.valkey_password_fingerprint_b |' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform configuration 允许调用者伪造 B 槽 fingerprint'

reset_fixture
replace_once \
  'ruby "$GITHUB_WORKSPACE/slots-game/infra/terraform/scripts/verify-valkey-rotation-plan.rb" \
                --evidence "$HMAC_EVIDENCE_FILE" -' \
  'ruby "$GITHUB_WORKSPACE/slots-game/infra/terraform/scripts/verify-valkey-rotation-plan-skipped.rb" \
                --evidence "$HMAC_EVIDENCE_FILE" -' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform plan 上传前跳过 Valkey A/B 前后状态机门禁'

reset_fixture
replace_once '                consume "$HMAC_EVIDENCE_FILE"' \
  '                finalize "$HMAC_EVIDENCE_FILE"' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform plan 错误使用 application finalize 绕过原证据 TTL'

reset_fixture
replace_once \
  'test "$evidence_mode" = none
            terraform show -json "$TF_PLAN_DIR/terraform.tfplan" |
              ruby "$GITHUB_WORKSPACE/slots-game/infra/terraform/scripts/verify-valkey-rotation-plan.rb" -
          fi
          source_sha=' \
  'test "$evidence_mode" = none
            true
          fi
          source_sha=' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform apply 执行前跳过同一 plan 的 Valkey A/B 状态机复核'

reset_fixture
replace_once \
  '          terraform show -json "$TF_PLAN_DIR/terraform.tfplan" |
            ruby "$GITHUB_WORKSPACE/slots-game/deploy/aws-production/verify-waf-rollout-evidence.rb" \
              --terraform-plan aws "$AWS_REGION" "$source_sha"
          terraform apply -input=false -auto-approve -lock-timeout=10m "$TF_PLAN_DIR/terraform.tfplan"' \
  '          terraform apply -input=false -auto-approve -lock-timeout=10m "$TF_PLAN_DIR/terraform.tfplan"
          terraform show -json "$TF_PLAN_DIR/terraform.tfplan" |
            ruby "$GITHUB_WORKSPACE/slots-game/deploy/aws-production/verify-waf-rollout-evidence.rb" \
              --terraform-plan aws "$AWS_REGION" "$source_sha"' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform apply 在 planned WAF Block evidence 校验前执行'

reset_fixture
replace_once '"$aws_region" ||' '"$aws_region" "${GITHUB_SHA:-}" ||' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected '应用发布错误使用自身 tag SHA 复核 infrastructure WAF evidence'

reset_fixture
replace_once 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-alb-edge.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"' \
  'true "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-alb-edge.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用 Helm 发布后跳过实际 ALB/WAF/target-health 回读'

reset_fixture
replace_once '          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-alb-edge.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"
          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"' \
  '          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-alb-edge.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"
          true "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用 Helm 发布后删除完整平台/WAF 实时回读'

reset_fixture
replace_once '          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-alb-edge.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"
          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"' \
  '          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-alb-edge.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
replace_once '          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"' \
  '          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"
          sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh" \
            "$TERRAFORM_DELIVERY_FILE" "$AWS_EKS_NAMESPACE"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用把最终平台/WAF 回读错误移到 Helm mutation 之前'

reset_fixture
replace_once 'grep -F -x "EPHEMERAL_INPUTS_HMAC=$ephemeral_fingerprint" "$metadata"' \
  'true' "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform apply 未验证 ephemeral 输入与 plan 完全一致'

reset_fixture
replace_once '--server-side-encryption aws:kms --ssekms-key-id "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN"' \
  '--server-side-encryption aws:kms' "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform delivery 对象未显式绑定固定 CMK'

reset_fixture
replace_once '              "cluster-autoscaler",' \
  '              "forbidden-addon",' "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform delivery 未精确包含 Cluster Autoscaler 版本交接'

reset_fixture
replace_once 'startswith("v\($handoff.kubernetes_version).")' 'startswith("v")' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform delivery 未绑定 Cluster Autoscaler 与 EKS 主次版本'

reset_fixture
replace_once '($rotation.password_fingerprints | keys | sort) == ["a", "b"]' \
  '($rotation.password_fingerprints | type) == "object"' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform delivery 发布前跳过 Valkey A/B password fingerprint 集合校验'

reset_fixture
replace_once '$handoff.required_api_services == {"resource_metrics": "v1beta1.metrics.k8s.io"}' \
  '$handoff.required_api_services == {}' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform delivery 发布前跳过 metrics APIService 交接校验'

reset_fixture
replace_once '$handoff.vpc_cni_network_policy.expected_status == "ACTIVE"' \
  '$handoff.vpc_cni_network_policy.expected_status == "DEGRADED"' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform delivery 未失败关闭绑定 vpc-cni ACTIVE NetworkPolicy 执行面'

reset_fixture
replace_once '$handoff.cloudwatch_observability.configuration_values.containerLogs.enabled == true' \
  '$handoff.cloudwatch_observability.configuration_values.containerLogs.enabled == false' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform delivery 未失败关闭绑定 CloudWatch containerLogs 执行面'

reset_fixture
replace_once '$handoff.alb_access_logs == {' '$handoff.alb_access_logs != {' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform delivery 未精确绑定批准的 ALB access log bucket/prefix'

reset_fixture
replace_once 'AWS_TERRAFORM_APPLY_ROLE_ARN: ${{ vars.AWS_TERRAFORM_APPLY_ROLE_ARN }}
      AWS_TF_STATE_BUCKET: ${{ vars.AWS_TF_STATE_BUCKET }}
      AWS_TF_STATE_KEY: ${{ vars.AWS_TF_STATE_KEY }}
      AWS_TF_STATE_KMS_KEY_ARN: ${{ vars.AWS_TF_STATE_KMS_KEY_ARN }}
      AWS_TERRAFORM_DELIVERY_BUCKET: ${{ vars.AWS_TERRAFORM_DELIVERY_BUCKET }}' \
  'AWS_TERRAFORM_APPLY_ROLE_ARN: ${{ vars.AWS_TERRAFORM_APPLY_ROLE_ARN }}
      AWS_TF_STATE_BUCKET: ${{ vars.AWS_TF_STATE_BUCKET }}
      AWS_TF_STATE_KEY: ${{ vars.AWS_TF_STATE_KEY }}
      AWS_TF_STATE_KMS_KEY_ARN: ${{ vars.AWS_TF_STATE_KMS_KEY_ARN }}
      AWS_TERRAFORM_DELIVERY_BUCKET: missing-protected-apply-var' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'Terraform apply job 缺少受保护 delivery bucket 变量'

reset_fixture
replace_once 'require_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET"' ':' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/validate-environment.sh"
expect_rejected 'Terraform apply 固定 Environment 跳过 delivery bucket 校验'

reset_fixture
replace_once '*"/$target_environment/"*) ;;' '*) ;;' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/validate-environment.sh"
expect_rejected '跨环境 S3 key 不再失败闭合'

reset_fixture
replace_once 'test "$version_value" != null || fail "$version_label 不得是未版本化对象的 null"' \
  ':' "$fixture_root/slots-game/deploy/aws-production/workflow/validate-environment.sh"
expect_rejected 'S3 version ID 允许未版本化对象的 null'

reset_fixture
replace_once '--version-id "$AWS_TERRAFORM_DELIVERY_VERSION_ID"' \
  '' "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用部署未读取精确版本的 Terraform delivery 对象'

reset_fixture
replace_once '.cluster_name == $cluster and .cluster_arn == $cluster_arn and' \
  '.cluster_name == $cluster and' "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'Terraform delivery 未绑定实际 EKS ARN'

reset_fixture
rm "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected '平台实时门禁脚本被删除'

reset_fixture
replace_once 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"' \
  'true "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '平台实时门禁调用被跳过'

reset_fixture
replace_once 'list-pod-identity-associations' 'list-unsafe-associations' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected '平台实时门禁跳过 EKS Pod Identity 列表校验'

reset_fixture
replace_once '      --region "$aws_region" \' \
  '      --region "$aws_region" \
      --no-paginate \' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'Pod Identity association 回读禁用分页而可能漏掉额外身份'

reset_fixture
rm "$fixture_root/slots-game/deploy/aws-production/workflow/verify-live-application-secrets.sh"
expect_rejected '原生 Secret 实时门禁脚本被删除'

reset_fixture
replace_once 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/workflow/verify-live-application-secrets.sh"' \
  'true "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/workflow/verify-live-application-secrets.sh"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '原生 Secret 实时门禁调用被跳过'

reset_fixture
rm "$fixture_root/slots-game/deploy/aws-production/workflow/verify-live-definition-identity.sh"
expect_rejected '数学定义滚动门禁脚本被删除'

reset_fixture
replace_once 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/workflow/verify-live-definition-identity.sh"' \
  'true "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/workflow/verify-live-definition-identity.sh"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '数学定义滚动门禁调用被跳过'

reset_fixture
replace_once 'get deployment -l "$release_selector" -o json' \
  'get deployment hard-coded-candidate --ignore-not-found -o json' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-live-definition-identity.sh"
expect_rejected '数学定义门禁退回按候选资源名查询'

reset_fixture
replace_once 'AWS 正式发布禁止 nameOverride/fullnameOverride' \
  'AWS 正式发布允许资源改名' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-live-definition-identity.sh"
expect_rejected '数学定义门禁不再禁止 AWS 资源改名'

reset_fixture
replace_once 'kubectl apply --server-side --field-manager=slots-aws-delivery' \
  'kubectl apply' "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'ExternalSecret 没有使用受控 server-side field manager 应用'

reset_fixture
replace_once 'kinds.count("ExternalSecret") == 6 && kinds.length == 8' \
  'kinds.count("ExternalSecret") == 5 && kinds.length == 7' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'ExternalSecret 渲染集合重新合并 API 与 Worker 边界'

reset_fixture
replace_once '      - secretKey: username' '      - secretKey: removed-username' \
  "$fixture_root/slots-game/deploy/aws-production/render-external-secrets.rb"
expect_rejected 'ExternalSecret renderer 不再同步 Valkey ACL username'

reset_fixture
replace_once 'application_names.fetch("worker-runtime-assets")' \
  'application_names.fetch("runtime-assets")' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-live-application-secrets.sh"
expect_rejected '原生 Secret 门禁重新合并 Worker 运行素材边界'

reset_fixture
replace_once 'shared_admission_keys.fetch("username") == "username"' \
  'shared_admission_keys.fetch("password") == "password"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-live-application-secrets.sh"
expect_rejected '原生 Secret 门禁跳过 Valkey ACL username key'

reset_fixture
replace_once 'configured_endpoint == delivery.fetch("valkey_endpoint_url")' \
  'configured_endpoint == configured_endpoint' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-live-application-secrets.sh"
expect_rejected '原生 Secret 门禁跳过 Helm values 与 delivery 的 Valkey endpoint 绑定'

reset_fixture
replace_once '"rgs-worker" => expected_worker_runtime_secret' \
  '"rgs-worker" => expected_api_runtime_secret' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-rendered-release.rb"
expect_rejected 'Helm 渲染门禁允许 Worker 挂载 API 运行素材 Secret'

reset_fixture
replace_once 'username_reference["key"] == "username"' \
  'username_reference["key"] == "password"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-rendered-release.rb"
expect_rejected 'Helm 渲染门禁允许共享准入用户名引用错误 Secret key'

reset_fixture
replace_once 'subnets.sort == expected_subnets.sort' \
  'subnets.sort == subnets.sort' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-rendered-release.rb"
expect_rejected 'Helm 渲染门禁未精确绑定 Terraform 公网子网集合'

reset_fixture
replace_once 'actual_alb_source_cidrs.sort == expected_alb_source_cidrs.sort' \
  'actual_alb_source_cidrs.sort == actual_alb_source_cidrs.sort' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-rendered-release.rb"
expect_rejected 'Helm 渲染门禁未精确绑定 ALB 节点来源 CIDR 与 NetworkPolicy'

reset_fixture
replace_once \
  'annotations.fetch("alb.ingress.kubernetes.io/security-groups", "") == expected_security_group' \
  'annotations.fetch("alb.ingress.kubernetes.io/security-groups", "") == annotations.fetch("alb.ingress.kubernetes.io/security-groups", "")' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-rendered-release.rb"
expect_rejected 'Helm 渲染门禁未精确绑定 Terraform ALB 安全组'

reset_fixture
replace_once 'annotations["alb.ingress.kubernetes.io/scheme"] == "internet-facing"' \
  'annotations.key?("alb.ingress.kubernetes.io/scheme")' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-rendered-release.rb"
expect_rejected 'Helm 渲染门禁允许 ALB scheme 漂移'

reset_fixture
replace_once 'listen_ports == [{"HTTP" => 80}, {"HTTPS" => 443}]' \
  'listen_ports.is_a?(Array)' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-rendered-release.rb"
expect_rejected 'Helm 渲染门禁允许 ALB listener 集合漂移'

reset_fixture
replace_once 'test "$current_cluster" = "$expected_cluster_arn" || {' \
  'true || {' "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '写入 ExternalSecret 前跳过精确 EKS ARN 门禁'

reset_fixture
replace_once '.resourcesVpcConfig.endpointPublicAccess == false' \
  '.resourcesVpcConfig.endpointPublicAccess == true' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用部署接受公开 EKS API endpoint'

reset_fixture
replace_once '.cluster.resourcesVpcConfig.endpointPublicAccess == false' \
  '.cluster.resourcesVpcConfig.endpointPublicAccess == true' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/manage-hmac-quiesce-evidence.sh"
expect_rejected 'HMAC 停机接受公开 EKS API endpoint'

reset_fixture
replace_once '.cluster.arn == $cluster_arn and' \
  '.cluster.arn != $cluster_arn and' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/manage-hmac-quiesce-evidence.sh"
expect_rejected 'HMAC 停机未绑定精确 EKS ARN'

reset_fixture
replace_once 'rm -f "$cluster_raw"' 'true # raw cluster topology retained' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用部署审计前未删除完整 EKS 拓扑响应'

reset_fixture
replace_once '--kubeconfig "$kubeconfig"' \
  '--alias mutable-cluster-name --kubeconfig "$kubeconfig"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'update-kubeconfig 使用别名掩盖精确 EKS ARN'

reset_fixture
replace_once "--if-none-match '*'" '--no-guess-mime-type' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected '允许覆盖 Web release 对象'

reset_fixture
replace_once 'test "$rollback_public_ready" = true' 'true # public rollback not verified' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'Web KVS 回退后未验证 CloudFront 公网读路径'

reset_fixture
replace_once "*.avif) printf '%s\\n' 'image/avif'" \
  "*.avif) printf '%s\\n' 'application/octet-stream'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'AVIF 被上传为通用二进制类型'

reset_fixture
replace_once "*.m4a) printf '%s\\n' 'audio/mp4'" \
  "*.m4a) printf '%s\\n' 'application/octet-stream'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'M4A 被上传为通用二进制类型'

reset_fixture
replace_once "*.woff) printf '%s\\n' 'font/woff'" \
  "*.woff) printf '%s\\n' 'application/octet-stream'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'WOFF 被上传为通用二进制类型'

reset_fixture
replace_once "*.ico) printf '%s\\n' 'image/vnd.microsoft.icon'" \
  "*.ico) printf '%s\\n' 'application/octet-stream'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'ICO 被上传为通用二进制类型'

reset_fixture
replace_once "*.atlas|*.fnt|*.txt) printf '%s\\n' 'text/plain; charset=utf-8'" \
  "*.txt) printf '%s\\n' 'text/plain; charset=utf-8'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'Atlas 与 FNT 生产文件类型未锁定'

reset_fixture
replace_once "*.skel) printf '%s\\n' 'application/octet-stream'" \
  "*.skel) printf '%s\\n' 'text/plain; charset=utf-8'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'Spine SKEL 二进制类型被错误更改'

reset_fixture
replace_once '*) return 1' "*) printf '%s\\n' 'application/octet-stream'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected '未知 Web 扩展名未失败闭合'

reset_fixture
replace_once '--server-side-encryption aws:kms --ssekms-key-id "$AWS_WEB_KMS_KEY_ARN"' \
  '--server-side-encryption aws:kms' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'Web S3 上传未显式绑定固定 CMK'

reset_fixture
replace_once '--if-match "$kvs_etag_before" --key active-release --value "$release_id"' \
  '--key active-release --value "$release_id"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected '切换接口未执行 ETag 乐观锁校验'

reset_fixture
replace_once 'if aws cloudfront-keyvaluestore put-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN"' \
  'aws cloudfront-keyvaluestore put-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'KVS 切换命令非零后被 set -e 直接退出'

reset_fixture
replace_once 'if ! read_active_release_authoritatively "$active_json"; then' \
  'if false; then' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected '模糊成功后跳过 active-release 权威回读'

reset_fixture
replace_once 'CAS fence 已推进原 ETag 且 active-release 保持旧状态' \
  '单次旧值读取被错误当作安全失败' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected '切换未应用时没有先推进原 ETag'

reset_fixture
replace_once '--if-match "$kvs_etag_before" --key active-release --value "$previous_release"' \
  '--if-match "$kvs_etag_before" --key active-release --value "$release_id"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected '旧 release CAS fence 被改成重复 promotion'

reset_fixture
replace_once 'test "$authoritative_kvs_etag" != "$kvs_etag_before"' \
  'test "$authoritative_kvs_etag" = "$kvs_etag_before"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'CAS fence 未等待原 ETag 被消费'

reset_fixture
replace_once 'test "$fence_release_first" = "$fence_release_confirm"' \
  'test "$fence_release_first" = "$fence_release_first"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'CAS fence 接受 key 与 ETag 撕裂快照'

reset_fixture
replace_once 'manual_intervention promotion-reconciliation' \
  'true # unknown promotion state ignored' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected '权威回读未知时仍允许自动写入'

reset_fixture
replace_once 'run_scenario applied-then-error "$previous_release" success' \
  'true # applied-then-error fault fixture removed' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/test-web-release-switch-faults.sh"
expect_rejected '删除 KVS applied-then-error 故障夹具'

reset_fixture
replace_once 'run_scenario lookup-error "$previous_release" failure' \
  'true # lookup-error fault fixture removed' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/test-web-release-switch-faults.sh"
expect_rejected '删除 KVS lookup-error 失败闭合夹具'

reset_fixture
replace_once 'run_scenario delayed-apply-after-read "$previous_release" success' \
  'true # delayed-apply-after-read fault fixture removed' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/test-web-release-switch-faults.sh"
expect_rejected '删除 KVS delayed-apply-after-read 迟到提交夹具'

reset_fixture
replace_once '.DistributionConfig.Origins.Items[0].DomainName == $origin' \
  'true' "$fixture_root/slots-game/deploy/aws-production/workflow/publish-web-release.sh"
expect_rejected 'CloudFront distribution 未绑定固定 Web bucket origin'

reset_fixture
replace_once '      contents: read' '      contents: read\n      id-token: write' \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'PR 静态 job 获得 OIDC'

reset_fixture
replace_once "    if: github.event_name == 'workflow_dispatch'" \
  "    if: github.event_name == 'push'" \
  "$fixture_root/.github/workflows/aws-hmac-quiesce-evidence.yml"
expect_rejected 'HMAC 停机证据 job 在 push 时申请 AWS 凭据'

reset_fixture
replace_once "      - \${{ 'slots-aws-private-hmac-quiescer' }}" \
  '      - ${{ vars.AWS_RUNNER_LABEL }}' \
  "$fixture_root/.github/workflows/aws-hmac-quiesce-evidence.yml"
expect_rejected 'HMAC 停机证据 runner 标签可被 Environment 动态替换'

reset_fixture
replace_once "group: \${{ github.event_name == 'workflow_dispatch' && format('slots-aws-environment-mutation-{0}', inputs.target_environment) || format('slots-aws-static-{0}-{1}', github.workflow, github.ref) }}" \
  'group: slots-aws-environment-mutation-${{ inputs.target_environment || github.ref }}' \
  "$fixture_root/.github/workflows/aws-hmac-quiesce-evidence.yml"
expect_rejected 'PR 静态工作流错误进入跨工作流环境级互斥锁'

reset_fixture
replace_once "format('slots-aws-static-{0}-{1}', github.workflow, github.ref)" \
  "format('slots-aws-static-{0}', github.ref)" \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'PR 静态 concurrency group 缺少 workflow identity'

reset_fixture
replace_once "format('slots-aws-static-{0}-{1}', github.workflow, github.ref)" \
  "format('slots-aws-static-{0}-{1}', github.workflow, github.sha)" \
  "$fixture_root/.github/workflows/aws-infrastructure.yml"
expect_rejected 'PR 静态 concurrency group 未绑定 ref'

reset_fixture
replace_once "trap 'exit 143' TERM" 'trap cleanup TERM' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/manage-hmac-quiesce-evidence.sh"
expect_rejected 'TERM 信号不再经 EXIT 统一触发失败恢复'

reset_fixture
replace_once "hpa_spec_sha256=\$(jq -j -S -c '.spec'" \
  "hpa_spec_sha256=\$(jq -S -c '.spec'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/manage-hmac-quiesce-evidence.sh"
expect_rejected 'HPA spec SHA 错误包含 jq 末尾换行'

reset_fixture
replace_once '"$script_directory/hmac-evidence-marker.sh" publish cancellation "$evidence_file" >/dev/null; then' \
  '"$script_directory/hmac-evidence-marker-skipped.sh" publish cancellation "$evidence_file" >/dev/null; then' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/manage-hmac-quiesce-evidence.sh"
expect_rejected '孤儿证据失败恢复前跳过精确 cancellation marker'

reset_fixture
replace_once 'reference_hash=$(printf '\''%s\n%s'\'' "$evidence_version" "$evidence_sha" | sha256sum' \
  'reference_hash=$(printf '\''%s'\'' "$evidence_version" | sha256sum' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-evidence-marker.sh"
expect_rejected 'marker 路径没有同时绑定证据 VersionId 与 SHA-256'

reset_fixture
replace_once "--if-none-match '*'" '--no-guess-mime-type' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-evidence-marker.sh"
expect_rejected '证据 marker 允许覆盖同一证据的历史终态'

reset_fixture
replace_once '"$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/workflow/verify-latest-terraform-delivery.sh" \' \
  '"$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/workflow/verify-latest-terraform-delivery-skipped.sh" \' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '应用发布未确认 Terraform delivery 是当前 latest 版本'

reset_fixture
replace_once '              finalize "$hmac_evidence_file"' \
  '              consume "$hmac_evidence_file"' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'target 已发布后原证据过期会造成 application 永久停机'

reset_fixture
rm "$fixture_root/slots-game/deploy/aws-production/workflow/verify-hmac-finalize-attestation.rb"
expect_rejected 'finalize 短时实时复证 verifier 被删除'

reset_fixture
replace_once 'assert(now < expires_at, "证据已过期") if purpose == "consume"' \
  'assert(now < expires_at, "证据已过期") if purpose == "finalize"' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-hmac-quiesce-evidence.rb"
expect_rejected 'Terraform consume TTL 被错误放宽给过期原证据'

reset_fixture
replace_once 'now + 900' 'now + 7200' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected 'finalize 实时复证不再是 15 分钟短时证明'

reset_fixture
replace_once '"$script_directory/hmac-evidence-marker.sh" check all "$evidence_file" >/dev/null' \
  '"$script_directory/hmac-evidence-marker-skipped.sh" check all "$evidence_file" >/dev/null' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected 'finalize 实时复证跳过 cancellation/completion marker'

reset_fixture
replace_once '.data.evidenceSha256 == $evidence_sha and .data.evidenceExpiresAt == $expires_at' \
  '.data.evidenceSha256 == $evidence_sha' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected 'finalize 实时复证 lock 没有绑定原证据 expires_at'

reset_fixture
replace_once '  select(' '  (' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected 'target delivery 条件被错误求值后仍无条件输出 Secret 名称'

reset_fixture
replace_once 'app.kubernetes.io/component=rgs-worker' \
  'app.kubernetes.io/component=worker-check-skipped' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected 'finalize 实时复证跳过 Worker Pod 全部 Ready'

reset_fixture
replace_once 'test "$GITHUB_WORKFLOW_REF" = "$expected_workflow_ref"' 'true' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected 'finalize 实时复证生产者没有绑定 main 上的固定应用工作流'

reset_fixture
replace_once '复证 TTL 必须精确为 15 分钟' '复证 TTL 未验证' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-hmac-finalize-attestation.rb"
expect_rejected 'finalize verifier 不再锁定短时 TTL'

reset_fixture
replace_once 'slots-game/hmac-finalize-attestation/v1' \
  'slots-game/hmac-finalize-attestation/unsafe' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/README.md"
expect_rejected '交付说明遗漏过期原证据的 finalize 恢复接口'

reset_fixture
replace_once '仍是明确的外部上线阻断' '已自动化生产就绪' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/README.md"
expect_rejected 'AWS 交付说明误宣称非滚动 PostgreSQL 迁移已经自动化'

reset_fixture
replace_once '禁止宣称“全栈原子发布”' '可以宣称“全栈原子发布”' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/README.md"
expect_rejected 'AWS 交付说明把两个组件原子边界误称为全栈原子发布'

reset_fixture
replace_once 'hmac-application-maintenance-gate.sh" \
              standard' \
  'hmac-application-maintenance-gate.sh" \
              skipped-standard' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected '普通发布跳过持久 HMAC maintenance lock'

reset_fixture
replace_once 'safe "$current_manifest" "$current_hooks" "$safe_rendered" \' \
  'unsafe "$current_manifest" "$current_hooks" "$safe_rendered" \' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'maintenance Phase A 跳过 HMAC 单一变更语义 comparator'

reset_fixture
replace_once '"${common_arguments[@]}" --no-hooks --wait --timeout 20m \' \
  '"${common_arguments[@]}" --wait --timeout 20m \' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'maintenance Phase A 允许执行 Migrator 或 Helm hook'

reset_fixture
replace_once '"${common_arguments[@]}" --no-hooks --atomic --wait --timeout 20m \' \
  '"${common_arguments[@]}" --atomic --wait --timeout 20m \' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'maintenance Phase B 允许执行 Migrator 或 Helm hook'

reset_fixture
replace_once "if: inputs.deployment_mode == 'standard'" 'if: always()' \
  "$fixture_root/.github/workflows/aws-application-deploy.yml"
expect_rejected 'maintenance-complete 仍发布 Web 或切换 CloudFront'

reset_fixture
replace_once "live_hpa_sha=\$(jq -j -S -c '.spec'" \
  "live_hpa_sha=\$(jq -S -c '.spec'" \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected 'Phase B live HPA SHA 错误包含 jq 末尾换行'

reset_fixture
replace_once 'evidence_hpa.fetch("spec") == current_hpa.fetch("spec")' \
  'evidence_hpa.fetch("spec") == evidence_hpa.fetch("spec")' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/verify-hmac-only-release-diff.rb"
expect_rejected 'Phase A 前未绑定证据 live HPA 与当前 Helm HPA spec'

reset_fixture
replace_once '      autoscaling:DescribeTags' '      autoscaling:DescribeAccountLimits' \
  "$fixture_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
expect_rejected 'Cluster Autoscaler 实际 IAM allowlist 缺少 DescribeTags'

reset_fixture
replace_once 'E2 发布后 E1 cancellation 被遮蔽，旧证据可重放' \
  'E2 覆盖测试已跳过' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/test-hmac-quiesce-evidence.sh"
expect_rejected 'E1/E2 交错 marker 重放负测被删除'

reset_fixture
replace_once 'live_hpa_sha=$(jq -j -S -c '\''.spec'\''' \
  'live_hpa_sha=$(jq -j -S -c '\''.metadata'\''' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected 'Phase B 后不再复核 live HPA canonical spec SHA'

reset_fixture
replace_once '"$KUBECTL_BIN" delete "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" \' \
  '"$KUBECTL_BIN" delete "configmap/$lock_name" --namespace "$AWS_EKS_NAMESPACE" --preconditions "uid=$evidence_lock_uid" \' \
  "$fixture_root/slots-game/deploy/aws-production/workflow/hmac-application-maintenance-gate.sh"
expect_rejected '使用真实 kubectl 不支持的 delete --preconditions 参数'

if env -i PATH="$PATH" \
  AWS_ACCOUNT_ID=123456789012 AWS_REGION=ap-southeast-1 \
  TARGET_ENVIRONMENT=prod-primary \
  AWS_TERRAFORM_APPLY_ROLE_ARN=arn:aws:iam::123456789012:role/slots-terraform-apply \
  AWS_TF_STATE_BUCKET=slots-terraform-state-123456789012 \
  AWS_TF_STATE_KEY=slots-game/prod-primary/terraform.tfstate \
  AWS_TF_STATE_KMS_KEY_ARN=arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-1111-1111-111111111111 \
  AWS_TERRAFORM_DELIVERY_KEY=slots-game/prod-primary/delivery.json \
  AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN=arn:aws:kms:ap-southeast-1:123456789012:key/22222222-2222-2222-2222-222222222222 \
  "$script_directory/validate-environment.sh" terraform-apply >/dev/null 2>&1; then
  fail 'Terraform apply Environment 缺少 delivery bucket 仍被接受'
fi

fingerprint_script="$script_directory/fingerprint-terraform-ephemeral-inputs.sh"
fingerprint_a=$(env -i PATH="$PATH" \
  TF_VAR_valkey_password_a=fixture-password-a-0000000000000001 \
  TF_VAR_valkey_password_b=fixture-password-b-0000000000000002 \
  TF_VAR_shared_admission_hmac_key=fixture-hmac-000000000000000000000003 \
  TF_VAR_valkey_root_ca_pem=fixture-root-ca-0000000000000000000004 \
  GITHUB_REPOSITORY=company/slots-game GITHUB_RUN_ID=100 GITHUB_RUN_ATTEMPT=1 \
  "$fingerprint_script" prod-primary)
fingerprint_b=$(env -i PATH="$PATH" \
  TF_VAR_valkey_password_a=fixture-password-a-0000000000000001 \
  TF_VAR_valkey_password_b=fixture-password-b-changed-0000000002 \
  TF_VAR_shared_admission_hmac_key=fixture-hmac-000000000000000000000003 \
  TF_VAR_valkey_root_ca_pem=fixture-root-ca-0000000000000000000004 \
  GITHUB_REPOSITORY=company/slots-game GITHUB_RUN_ID=100 GITHUB_RUN_ATTEMPT=1 \
  "$fingerprint_script" prod-primary)
for fingerprint in "$fingerprint_a" "$fingerprint_b"; do
  printf '%s\n' "$fingerprint" | grep -Eq '^[0-9a-f]{64}$' || \
    fail 'A/B ephemeral 输入没有生成规范 HMAC 指纹'
done
test "$fingerprint_a" != "$fingerprint_b" || fail 'Valkey B 槽密码变化没有改变 ephemeral 指纹'
if env -i PATH="$PATH" \
  TF_VAR_valkey_password_a=fixture-password-a-0000000000000001 \
  TF_VAR_shared_admission_hmac_key=fixture-hmac-000000000000000000000003 \
  TF_VAR_valkey_root_ca_pem=fixture-root-ca-0000000000000000000004 \
  GITHUB_REPOSITORY=company/slots-game GITHUB_RUN_ID=100 GITHUB_RUN_ATTEMPT=1 \
  "$fingerprint_script" prod-primary >/dev/null 2>&1; then
  fail '缺少 Valkey B 槽密码仍生成 ephemeral 指纹'
fi

"$script_directory/test-web-release-switch-faults.sh" >/dev/null || \
  fail 'Web KVS 模糊成功故障夹具未通过'

printf '%s\n' 'AWS 工作流危险变体负向门禁通过。'

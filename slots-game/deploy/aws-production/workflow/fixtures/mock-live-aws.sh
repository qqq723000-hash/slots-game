#!/bin/sh

# 只模拟平台实时门禁读取的 EKS Pod Identity API，不连接 AWS。
set -eu

fail() {
  printf '%s\n' "AWS 平台 fixture 调用错误：$*" >&2
  exit 2
}

argument_value() {
  expected_name=$1
  shift
  while test "$#" -gt 0; do
    if test "$1" = "$expected_name"; then
      test "$#" -ge 2 || fail "$expected_name 缺少值"
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  fail "缺少参数 $expected_name"
}

test "$#" -ge 2 || fail '参数不足'
if test "$1" = iam; then
  test "$2" = get-role-policy || fail '只允许读取 Cluster Autoscaler 内联策略'
  shift 2
  role_name=$(argument_value --role-name "$@")
  policy_name=$(argument_value --policy-name "$@")
  test "$role_name" = slots-cluster-autoscaler || fail 'Cluster Autoscaler role 名不匹配'
  test "$policy_name" = scale-managed-node-groups || fail 'Cluster Autoscaler policy 名不匹配'
  jq -n --arg mode "${MOCK_PLATFORM_MODE:-valid}" '
    [
      "autoscaling:DescribeAutoScalingGroups",
      "autoscaling:DescribeAutoScalingInstances",
      "autoscaling:DescribeLaunchConfigurations",
      "autoscaling:DescribeScalingActivities",
      "autoscaling:DescribeTags",
      "ec2:DescribeImages",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeLaunchTemplateVersions",
      "ec2:GetInstanceTypesFromInstanceRequirements",
      "eks:DescribeNodegroup"
    ] as $expected |
    (if $mode == "autoscaler-policy-missing-describe-tags" then
      [$expected[] | select(. != "autoscaling:DescribeTags")]
    elif $mode == "autoscaler-policy-wildcard" then
      ["autoscaling:*"]
    else $expected end) as $actions |
    {RoleName: "slots-cluster-autoscaler", PolicyName: "scale-managed-node-groups",
      PolicyDocument: {Version: "2012-10-17", Statement: [{Sid: "ReadCapacityMetadata",
        Effect: "Allow", Action: $actions, Resource: "*"}]}}
  '
  exit 0
fi
test "$1" = eks || fail '只允许 EKS 或固定 IAM 只读 API'
operation=$2
shift 2
cluster_name=$(argument_value --cluster-name "$@")
test "$cluster_name" = slots-prod-primary || fail '集群名不匹配'

case "$operation" in
  describe-addon)
    addon_name=$(argument_value --addon-name "$@")
    region=$(argument_value --region "$@")
    test "$addon_name" = metrics-server || fail 'EKS add-on 名称不匹配'
    test "$region" = ap-southeast-1 || fail 'EKS add-on区域不匹配'
    status=ACTIVE
    if test "${MOCK_PLATFORM_MODE:-valid}" = metrics-server-degraded; then
      status=DEGRADED
    fi
    jq -n --arg status "$status" '
      {
        addon: {
          addonName: "metrics-server",
          addonVersion: "v0.7.2-eksbuild.1",
          status: $status
        }
      }
    '
    ;;
  list-pod-identity-associations)
    namespace=$(argument_value --namespace "$@")
    service_account=$(argument_value --service-account "$@")
    case "$namespace/$service_account" in
      kube-system/cluster-autoscaler) association_id=pia-cluster-autoscaler ;;
      kube-system/aws-load-balancer-controller) association_id=pia-load-balancer ;;
      external-secrets/external-secrets) association_id=pia-external-secrets ;;
      monitoring/prometheus-agent) association_id=pia-prometheus-agent ;;
      *) fail '未知 Pod Identity 查询边界' ;;
    esac
    jq -n --arg association_id "$association_id" \
      '{associations: [{associationId: $association_id}]}'
    ;;
  describe-pod-identity-association)
    association_id=$(argument_value --association-id "$@")
    case "$association_id" in
      pia-cluster-autoscaler)
        namespace=kube-system
        service_account=cluster-autoscaler
        role_arn=arn:aws:iam::123456789012:role/slots-cluster-autoscaler
        ;;
      pia-load-balancer)
        namespace=kube-system
        service_account=aws-load-balancer-controller
        role_arn=arn:aws:iam::123456789012:role/slots-load-balancer-controller
        ;;
      pia-external-secrets)
        namespace=external-secrets
        service_account=external-secrets
        role_arn=arn:aws:iam::123456789012:role/slots-external-secrets
        ;;
      pia-prometheus-agent)
        namespace=monitoring
        service_account=prometheus-agent
        role_arn=arn:aws:iam::123456789012:role/slots-prometheus-agent
        ;;
      *) fail '未知 Pod Identity association ID' ;;
    esac
    if test "${MOCK_PLATFORM_MODE:-valid}" = pod-identity-drift && \
      test "$association_id" = pia-external-secrets; then
      role_arn=arn:aws:iam::123456789012:role/forbidden-shared-role
    fi
    jq -n --arg cluster "$cluster_name" --arg namespace "$namespace" \
      --arg service_account "$service_account" --arg role_arn "$role_arn" '
      {
        association: {
          clusterName: $cluster,
          namespace: $namespace,
          serviceAccount: $service_account,
          roleArn: $role_arn
        }
      }
    '
    ;;
  *) fail '未知 EKS API' ;;
esac

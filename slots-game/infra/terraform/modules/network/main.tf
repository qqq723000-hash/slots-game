locals {
  zones               = toset(var.availability_zones)
  public_subnets      = zipmap(var.availability_zones, var.public_subnet_cidrs)
  private_subnets     = zipmap(var.availability_zones, var.private_subnet_cidrs)
  data_subnets        = zipmap(var.availability_zones, var.data_subnet_cidrs)
  all_subnet_cidrs    = concat(var.public_subnet_cidrs, var.private_subnet_cidrs, var.data_subnet_cidrs)
  nat_gateway_zones   = var.enable_nat_gateway_per_az ? local.zones : toset([var.availability_zones[0]])
  vpc_network_address = cidrhost(var.vpc_cidr, 0)
  vpc_prefix_length   = tonumber(split("/", var.vpc_cidr)[1])
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, { Name = "${var.name_prefix}-vpc" })

  lifecycle {
    precondition {
      condition = (
        length(var.availability_zones) == 3 &&
        length(var.public_subnet_cidrs) == 3 &&
        length(var.private_subnet_cidrs) == 3 &&
        length(var.data_subnet_cidrs) == 3 &&
        length(distinct(concat(var.public_subnet_cidrs, var.private_subnet_cidrs, var.data_subnet_cidrs))) == 9
      )
      error_message = "公网、应用和数据层必须各有三个且互不重复的子网 CIDR。"
    }

    precondition {
      condition = alltrue([
        for subnet_cidr in local.all_subnet_cidrs : try(
          can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", cidrhost(subnet_cidr, 0))) &&
          split("/", subnet_cidr)[0] == cidrhost(subnet_cidr, 0) &&
          tonumber(split("/", subnet_cidr)[1]) >= local.vpc_prefix_length &&
          tonumber(split("/", subnet_cidr)[1]) <= 28 &&
          cidrhost("${cidrhost(subnet_cidr, 0)}/${local.vpc_prefix_length}", 0) == local.vpc_network_address,
          false,
        )
      ])
      error_message = "所有子网都必须是 VPC 内规范、有效且不大于 /28 的 IPv4 CIDR。"
    }

    precondition {
      condition = alltrue(flatten([
        for left_index in range(length(local.all_subnet_cidrs)) : [
          for right_index in range(length(local.all_subnet_cidrs)) :
          left_index >= right_index || !try(
            cidrhost(
              "${cidrhost(local.all_subnet_cidrs[left_index], 0)}/${split("/", local.all_subnet_cidrs[right_index])[1]}",
              0,
            ) == cidrhost(local.all_subnet_cidrs[right_index], 0) ||
            cidrhost(
              "${cidrhost(local.all_subnet_cidrs[right_index], 0)}/${split("/", local.all_subnet_cidrs[left_index])[1]}",
              0,
            ) == cidrhost(local.all_subnet_cidrs[left_index], 0),
            true,
          )
        ]
      ]))
      error_message = "九个子网 CIDR 之间不得存在任何重叠。"
    }
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  for_each = local.public_subnets

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name                     = "${var.name_prefix}-public-${each.key}"
    "kubernetes.io/role/elb" = "1"
    Tier                     = "public"
  })
}

resource "aws_subnet" "private" {
  for_each = local.private_subnets

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name                              = "${var.name_prefix}-private-${each.key}"
    "kubernetes.io/role/internal-elb" = "1"
    Tier                              = "application"
  })
}

resource "aws_subnet" "data" {
  for_each = local.data_subnets

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-data-${each.key}"
    Tier = "data"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  for_each = local.nat_gateway_zones

  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name_prefix}-nat-${each.key}" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  for_each = local.nat_gateway_zones

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id
  tags          = merge(var.tags, { Name = "${var.name_prefix}-nat-${each.key}" })
}

resource "aws_route_table" "private" {
  for_each = local.zones

  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-private-${each.key}" })
}

resource "aws_route" "private_internet" {
  for_each = local.zones

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = aws_nat_gateway.this[
    var.enable_nat_gateway_per_az ? each.key : var.availability_zones[0]
  ].id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_route_table" "data" {
  for_each = local.zones

  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-data-${each.key}" })
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data[each.key].id
}

data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${var.name_prefix}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume.json
  tags               = var.tags
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/aws/vpc/${var.name_prefix}/flow-logs"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.flow_log_kms_key_arn
  tags              = var.tags
}

data "aws_iam_policy_document" "flow_logs" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.flow_logs.arn}:*"]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs.json
}

resource "aws_flow_log" "this" {
  iam_role_arn             = aws_iam_role.flow_logs.arn
  log_destination          = aws_cloudwatch_log_group.flow_logs.arn
  log_destination_type     = "cloud-watch-logs"
  max_aggregation_interval = 60
  traffic_type             = "ALL"
  vpc_id                   = aws_vpc.this.id
  log_format               = "$${version} $${account-id} $${interface-id} $${srcaddr} $${dstaddr} $${srcport} $${dstport} $${protocol} $${packets} $${bytes} $${start} $${end} $${action} $${log-status} $${flow-direction}"
  tags                     = var.tags
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  description = "公网 ALB 专用安全组"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = toset(var.edge_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP 仅用于重定向"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.edge_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS 业务入口"
}

resource "aws_vpc_security_group_egress_rule" "alb_application" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 8080
  to_port           = 8080
  ip_protocol       = "tcp"
  description       = "只允许 ALB 向应用 HTTP target 转发"
}

resource "aws_vpc_security_group_egress_rule" "alb_operations_health" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 8081
  to_port           = 8081
  ip_protocol       = "tcp"
  description       = "只允许 ALB 向私有 operations target 执行健康探针"
}

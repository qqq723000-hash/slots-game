import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const localDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(localDirectory, "../..");
const outputRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: render-observability.mjs OUTPUT_DIRECTORY");
}

mkdirSync(resolve(outputRoot, "rules"), { recursive: true, mode: 0o700 });
mkdirSync(resolve(outputRoot, "grafana/dashboards"), { recursive: true, mode: 0o700 });
mkdirSync(resolve(outputRoot, "grafana/provisioning"), { recursive: true, mode: 0o700 });
// Grafana 会枚举全部标准 provisioning 目录；空目录也显式创建，避免无意义的启动错误。
mkdirSync(resolve(outputRoot, "grafana/provisioning/plugins"), { recursive: true, mode: 0o700 });
mkdirSync(resolve(outputRoot, "grafana/provisioning/alerting"), { recursive: true, mode: 0o700 });

const replace = (contents) => contents
  .replaceAll("__ENVIRONMENT__", "production")
  .replaceAll("__CLUSTER_ID__", "local-mac")
  .replaceAll("__ALERTMANAGER_TARGET__", "alert-proxy:8443")
  .replaceAll("__ALERTMANAGER_SERVER_NAME__", "alert-proxy")
  .replaceAll("__RUNBOOK_BASE_URL__", "https://slots.localhost:8443/operator/runbooks");

let prometheus = replace(readFileSync(
  resolve(repositoryRoot, "deploy/observability/prometheus.yml"),
  "utf8",
));
prometheus = prometheus.replace(
  "  - job_name: vector\n",
  [
    "  - job_name: local-operator",
    "    scheme: https",
    "    metrics_path: /metrics",
    "    honor_labels: false",
    "    authorization:",
    "      type: Bearer",
    "      credentials_file: /run/secrets/local_operator_metrics_bearer_token",
    "    tls_config:",
    "      ca_file: /run/secrets/local-production-root-ca.pem",
    "      server_name: wallet",
    "      min_version: TLS12",
    "      insecure_skip_verify: false",
    "    static_configs:",
    "      - targets:",
    "          - wallet:8443",
    "        labels:",
    "          service: local-operator",
    "          environment: production",
    "",
    "  - job_name: vector",
    "",
  ].join("\n"),
);
writeFileSync(resolve(outputRoot, "prometheus.yml"), prometheus, { mode: 0o600 });

let alerts = replace(readFileSync(resolve(repositoryRoot, "deploy/observability/rules/rgs-alerts.yml"), "utf8"));
alerts += [
  "",
  "  - name: local-production-operator-alerts",
  "    interval: 30s",
  "    rules:",
  "      - alert: LocalOperatorUnavailable",
  "        expr: (max_over_time(local_operator_ready{job=\"local-operator\"}[2m]) < 1) or absent(local_operator_ready{job=\"local-operator\"})",
  "        for: 2m",
  "        labels:",
  "          severity: critical",
  "          service: local-operator",
  "        annotations:",
  "          summary: 本机运营钱包或持久化文件不可用",
  "          description: 数据库或持久化文件句柄连续不可用；容量水位由独立告警覆盖。",
  "          runbook_url: \"https://slots.localhost:8443/operator/runbooks/local-operator-unavailable\"",
  "",
  "      - alert: LocalProductionBackupStatusUnreadable",
  "        expr: (local_production_backup_status_file_readable{job=\"local-operator\"} < 1) or absent(local_production_backup_status_file_readable{job=\"local-operator\"})",
  "        for: 2m",
  "        labels:",
  "          severity: critical",
  "          service: backup",
  "        annotations:",
  "          summary: 本机备份状态文件不可读",
  "          description: 原子备份状态缺失或校验失败，备份新鲜度不可证明。",
  "          runbook_url: \"https://slots.localhost:8443/operator/runbooks/backup-status-unreadable\"",
  "",
  "      - alert: LocalProductionBackupFailed",
  "        expr: local_production_backup_consecutive_failures{job=\"local-operator\"} > 0",
  "        for: 2m",
  "        labels:",
  "          severity: critical",
  "          service: backup",
  "        annotations:",
  "          summary: 本机数据库备份连续失败",
  "          description: 周期任务正在按一分钟间隔重试；检查数据库 TLS、凭据、磁盘与归档权限。",
  "          runbook_url: \"https://slots.localhost:8443/operator/runbooks/backup-failed\"",
  "",
  "      - alert: LocalProductionBackupStale",
  "        expr: (time() - local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"} > 25200) or (local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"} <= 0) or absent(local_production_backup_last_success_timestamp_seconds{job=\"local-operator\"})",
  "        for: 10m",
  "        labels:",
  "          severity: critical",
  "          service: backup",
  "        annotations:",
  "          summary: 本机备份超过七小时未成功",
  "          description: 六小时备份周期已越过一小时容错窗口；恢复点目标无法满足。",
  "          runbook_url: \"https://slots.localhost:8443/operator/runbooks/backup-stale\"",
  "",
  ...[
    ["Audit", "audit", "审计"],
    ["Log", "log", "运行日志"],
    ["Alert", "alert", "告警归档"],
  ].flatMap(([title, metric, chinese]) => [
    `      - alert: LocalOperator${title}StoreNearCapacity`,
    `        expr: (local_operator_${metric}_store_bytes{job=\"local-operator\"} / clamp_min(local_operator_${metric}_store_capacity_bytes{job=\"local-operator\"}, 1) > 0.75) or absent(local_operator_${metric}_store_bytes{job=\"local-operator\"})`,
    "        for: 10m",
    "        labels:",
    "          severity: warning",
    "          service: local-operator",
    "        annotations:",
    `          summary: 本机${chinese}存储接近容量上限`,
    `          description: ${chinese}分段归档已超过硬容量的 75%；先确认备份完整，再处理最旧只读段。`,
    `          runbook_url: \"https://slots.localhost:8443/operator/runbooks/${metric}-store-capacity\"`,
    "",
    `      - alert: LocalOperator${title}StoreNotWritable`,
    `        expr: (local_operator_${metric}_store_writable{job=\"local-operator\"} < 1) or absent(local_operator_${metric}_store_writable{job=\"local-operator\"})`,
    "        for: 2m",
    "        labels:",
    "          severity: critical",
    "          service: local-operator",
    "        annotations:",
    `          summary: 本机${chinese}存储无法接受最大批次`,
    `          description: ${chinese}硬容量剩余不足；服务保持可观测但对应 sink 会失败闭合。`,
    `          runbook_url: \"https://slots.localhost:8443/operator/runbooks/${metric}-store-not-writable\"`,
    "",
  ]),
  "",
].join("\n");
writeFileSync(
  resolve(outputRoot, "rules/rgs-alerts.yml"),
  alerts,
  { mode: 0o600 },
);
const dashboard = JSON.parse(replace(readFileSync(
  resolve(repositoryRoot, "deploy/observability/grafana/dashboards/rgs-overview.json"),
  "utf8",
)));
const readinessPanel = structuredClone(dashboard.panels.find((panel) => panel.id === 1));
readinessPanel.id = 20;
readinessPanel.title = "本机运营服务就绪状态";
readinessPanel.description = "同时显示 TLS/Bearer 指标抓取状态与数据库、审计/日志容量就绪状态。";
readinessPanel.gridPos = { h: 6, w: 8, x: 0, y: 21 };
readinessPanel.targets = [
  {
    editorMode: "code",
    expr: "min(up{job=\"local-operator\"})",
    legendFormat: "operator scrape",
    range: true,
    refId: "A",
  },
  {
    editorMode: "code",
    expr: "min(local_operator_ready{job=\"local-operator\"}) or vector(0)",
    legendFormat: "operator readiness",
    range: true,
    refId: "B",
  },
];

const trafficPanel = structuredClone(dashboard.panels.find((panel) => panel.id === 2));
trafficPanel.id = 21;
trafficPanel.title = "本机运营流量与异常";
trafficPanel.gridPos = { h: 6, w: 16, x: 8, y: 21 };
trafficPanel.targets = [
  ["sum(rate(local_operator_requests_total[5m]))", "requests/s", "A"],
  ["sum(rate(local_operator_failures_total[5m]))", "failures/s", "B"],
  ["sum(rate(local_operator_launches_total[5m]))", "launches/s", "C"],
  ["sum(rate(local_operator_audit_accepted_total[5m]))", "audit batches/s", "D"],
  ["sum(rate(local_operator_log_batches_total[5m]))", "log batches/s", "E"],
].map(([expr, legendFormat, refId]) => ({ editorMode: "code", expr, legendFormat, range: true, refId }));
dashboard.panels.push(readinessPanel, trafficPanel);
const storagePanel = structuredClone(dashboard.panels.find((panel) => panel.id === 2));
storagePanel.id = 22;
storagePanel.title = "本机持久化容量使用率";
storagePanel.description = "审计、脱敏日志和 Alertmanager 本地通知的分段归档容量；75% 触发预警。";
storagePanel.gridPos = { h: 6, w: 12, x: 0, y: 27 };
storagePanel.targets = ["audit", "log", "alert"].flatMap((name, index) => [
  {
    editorMode: "code",
    expr: `local_operator_${name}_store_bytes / clamp_min(local_operator_${name}_store_capacity_bytes, 1)`,
    legendFormat: `${name} utilization`,
    range: true,
    refId: String.fromCharCode(65 + index * 2),
  },
  {
    editorMode: "code",
    expr: `local_operator_${name}_store_writable`,
    legendFormat: `${name} writable`,
    range: true,
    refId: String.fromCharCode(66 + index * 2),
  },
]);
const backupPanel = structuredClone(dashboard.panels.find((panel) => panel.id === 1));
backupPanel.id = 23;
backupPanel.title = "本机备份健康与新鲜度";
backupPanel.description = "显示状态文件有效性、连续失败次数和距离最近成功备份的秒数。";
backupPanel.gridPos = { h: 6, w: 12, x: 12, y: 27 };
backupPanel.targets = [
  ["local_production_backup_status_file_readable", "status readable", "A"],
  ["local_production_backup_consecutive_failures", "consecutive failures", "B"],
  ["time() - local_production_backup_last_success_timestamp_seconds", "backup age seconds", "C"],
].map(([expr, legendFormat, refId]) => ({ editorMode: "code", expr, legendFormat, range: true, refId }));
dashboard.panels.push(storagePanel, backupPanel);
const panelIds = dashboard.panels.map((panel) => panel.id);
if (panelIds.some((id) => !Number.isInteger(id)) || new Set(panelIds).size !== panelIds.length) {
  throw new Error("rendered dashboard panel IDs must be unique integers");
}
writeFileSync(
  resolve(outputRoot, "grafana/dashboards/rgs-overview.json"),
  `${JSON.stringify(dashboard, null, 2)}\n`,
  { mode: 0o600 },
);
cpSync(
  resolve(repositoryRoot, "deploy/observability/grafana/provisioning"),
  resolve(outputRoot, "grafana/provisioning"),
  { recursive: true, force: true },
);

// Grafana 只挂载一个服务专用只读 bundle，dashboard provider 与该路径对齐。
const dashboardProviderPath = resolve(outputRoot, "grafana/provisioning/dashboards/rgs.yml");
writeFileSync(
  dashboardProviderPath,
  readFileSync(dashboardProviderPath, "utf8").replace(
    "path: /var/lib/grafana/dashboards",
    "path: /run/grafana-bundle/dashboards",
  ),
  { mode: 0o600 },
);

const generatedAt = new Date().toISOString();
writeFileSync(resolve(outputRoot, "retention-policy.yml"), [
  "schema: rgs-observability-retention-v1",
  "policyReference: local-technical-production-retention",
  "jurisdictions:",
  "  - LOCAL",
  "dataOwner: local-machine-owner",
  "approvedBy: local-machine-owner",
  `effectiveAt: \"${generatedAt}\"`,
  `expiresAt: \"${new Date(Date.now() + 365 * 86400_000).toISOString()}\"`,
  "metrics:",
  "  retentionDays: 15",
  "  retentionSizeBytes: 1073741824",
  "logs:",
  "  retentionDays: 30",
  "audit:",
  "  retentionDays: 90",
  "",
].join("\n"), { mode: 0o600 });

process.stdout.write(`observability bundle rendered at ${outputRoot}\n`);

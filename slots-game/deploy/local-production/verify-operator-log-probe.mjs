#!/usr/bin/env node

import process from "node:process";

if (process.argv.length !== 3 || !/^sha256:[0-9a-f]{64}$/.test(process.argv[2])) {
  process.exit(2);
}

const expected = process.argv[2];
let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  try {
    const records = source.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const matches = records.filter(
      (record) => record?.request_id === expected && record?.route === "operator.launch",
    );
    const allowed = new Set([
      "service", "time", "level", "msg", "route", "request_id", "method",
      "status", "status_class", "duration_ms",
    ]);
    const forbidden = [
      "container_id", "container_name", "source", "log", "message",
      "wallet_session_id", "walletSessionId", "authorization", "access_token",
    ];
    if (matches.length < 1) process.exit(1);
    for (const record of matches) {
      if (record.service !== "rgs-server" || record.msg !== "http request") process.exit(1);
      if (record.level !== "WARN" || record.status !== 401 || record.status_class !== "4xx") process.exit(1);
      if (!Number.isInteger(record.duration_ms) || record.duration_ms < 0 || record.duration_ms > 3_600_000) {
        process.exit(1);
      }
      if (Object.keys(record).some((key) => !allowed.has(key))) process.exit(1);
      if (forbidden.some((key) => Object.hasOwn(record, key))) process.exit(1);
    }
  } catch {
    process.exit(1);
  }
});

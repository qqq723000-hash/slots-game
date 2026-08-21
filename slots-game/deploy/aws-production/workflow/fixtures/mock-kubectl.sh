#!/bin/sh

# 只为本地负向门禁返回不含真实秘密的 Kubernetes Secret fixture。
set -eu

test "$#" -eq 7
test "$1" = -n
namespace=$2
test "$3" = get
test "$4" = secret
secret_name=$5
test "$6" = -o
test "$7" = json

test "${MOCK_SECRET_MODE:-valid}" != absent || exit 1

jq -n --arg namespace "$namespace" --arg name "$secret_name" \
  --arg mode "${MOCK_SECRET_MODE:-valid}" '
  {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {namespace: $namespace, name: $name},
    type: "Opaque",
    immutable: ($mode != "mutable"),
    data: {
      "database-url": "Zml4dHVyZQ==",
      "operations.token": "Zml4dHVyZQ==",
      "username": "Zml4dHVyZQ==",
      "password": "Zml4dHVyZQ==",
      "hmac.key": "Zml4dHVyZQ==",
      "root-ca.pem": "Zml4dHVyZQ==",
      "operators.json": "Zml4dHVyZQ==",
      "definition.json": "Zml4dHVyZQ==",
      "definition-approval.json": "Zml4dHVyZQ==",
      "definition-approval-public.pem": "Zml4dHVyZQ==",
      "launch-hmac.key": "Zml4dHVyZQ==",
      "outbox-hmac.key": "Zml4dHVyZQ==",
      "outbox-bearer.token": "Zml4dHVyZQ==",
      "outbox-root-ca.pem": "Zml4dHVyZQ==",
      "trust-bundle.pem": "Zml4dHVyZQ==",
      "operator-access-private.pem": "Zml4dHVyZQ==",
      "operator-access-public.pem": "Zml4dHVyZQ==",
      "operator-request-public.pem": "Zml4dHVyZQ==",
      "operator-response-private.pem": "Zml4dHVyZQ==",
      "operator-response-public.pem": "Zml4dHVyZQ==",
      "wallet-request-private.pem": "Zml4dHVyZQ==",
      "wallet-request-public.pem": "Zml4dHVyZQ==",
      "wallet-response-public.pem": "Zml4dHVyZQ=="
    }
  }
  | if $mode == "missing-key" and ($name | contains("api-runtime-assets"))
    then del(.data["definition.json"])
    elif $mode == "missing-worker-key" and ($name | contains("worker-runtime-assets"))
    then del(.data["outbox-hmac.key"])
    elif $mode == "missing-username" and ($name | contains("shared-admission"))
    then del(.data.username)
    else .
    end
'

#!/bin/sh
# 只读检查本机单副本定义轮换是否已排空。调用者必须先停止 RGS，
# 避免检查与文件轮换之间继续签发旧定义会话。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"

test "$#" -eq 3 || {
  printf '%s\n' '用法: verify-definition-drain.sh GAME_ID DEFINITION_VERSION DEFINITION_HASH' >&2
  exit 1
}
target_game="$1"
target_version="$2"
target_hash="$3"

test -s "$compose_environment" || {
  printf '%s\n' '缺少 Compose 状态，无法证明旧定义已排空。' >&2
  exit 1
}
if [ -n "$(compose ps --status running --quiet rgs-server)" ]; then
  printf '%s\n' '定义轮换前必须先排空并停止 rgs-server，禁止检查后继续签发旧会话。' >&2
  exit 1
fi
test -n "$(compose ps --status running --quiet postgres)" || {
  printf '%s\n' '定义轮换前 PostgreSQL 必须运行，以执行只读排空证明。' >&2
  exit 1
}

counts="$(compose exec -T postgres psql \
  --username postgres --dbname rgs --no-align --tuples-only \
  --set=target_game="$target_game" \
  --set=target_version="$target_version" \
  --set=target_hash="$target_hash" <<'SQL'
WITH predecessor_sessions AS (
    SELECT operator_id, session_id, status, expires_at, feature_state
    FROM rgs_sessions
    WHERE game_id=:'target_game'
      AND (definition_version<>:'target_version' OR definition_hash<>:'target_hash')
), predecessor_rounds AS (
    SELECT operator_id, session_id, status,
           result_delivery_required, result_acknowledged_at
    FROM rgs_rounds
    WHERE game_id=:'target_game'
      AND (definition_version<>:'target_version' OR definition_hash<>:'target_hash')
)
SELECT
    (SELECT count(*) FROM predecessor_sessions
     WHERE status='ACTIVE' AND expires_at>clock_timestamp()) || '|' ||
    (SELECT count(*) FROM predecessor_sessions
     WHERE COALESCE((feature_state->>'Remaining')::integer, 0)>0
       AND COALESCE(feature_state->>'Mode', 'NONE')<>'NONE') || '|' ||
    (SELECT count(*) FROM predecessor_rounds
     WHERE status IN ('PREPARED', 'RISK_PENDING', 'WALLET_PENDING', 'ROLLBACK_PENDING')) || '|' ||
    (SELECT count(*)
     FROM predecessor_rounds AS round
     JOIN predecessor_sessions AS session USING (operator_id, session_id)
     WHERE round.status='COMMITTED'
       AND round.result_delivery_required
       AND round.result_acknowledged_at IS NULL
       AND session.expires_at>clock_timestamp());
SQL
)"

if [ "$counts" != '0|0|0|0' ]; then
  printf '%s\n' "旧定义尚未排空 (active_sessions|active_features|nonterminal_rounds|pending_deliveries=$counts)。" >&2
  exit 1
fi
printf '%s\n' '定义排空检查通过。'

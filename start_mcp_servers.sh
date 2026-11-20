#!/usr/bin/env bash
# Start all 9 小灵 MCP SSE servers (idempotent — pkill+spawn each).
# Run *inside* the ten_agent_dev container, e.g.:
#   docker exec ten_agent_dev /app/agents/examples/websocket-example/start_mcp_servers.sh
#
# Addresses PROJECT_CONTEXT gotcha #5 ("MCP servers require manual restart
# after reboot").

set -u
export TZ=Asia/Shanghai  # MCP servers must report Beijing time (container TZ is UTC)
cd "$(dirname "$0")"

# Load centralized credentials from secrets.env (Phase 1 of credential
# refactor). All Python MCP servers read os.environ.get(...) and hard-fail
# at boot if missing, so a missing/typo'd secrets.env shows up immediately
# in the post-boot health check below rather than as a silent runtime 401.
if [[ -f secrets.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source secrets.env
  set +a
else
  echo "[start_mcp] FATAL: secrets.env not found in $(pwd)" >&2
  echo "[start_mcp] Create it with the keys MCP servers expect (see top of each *_mcp_server.py)." >&2
  exit 1
fi

declare -A SERVERS=(
  ["fetch_mcp_server.py"]=7777
  ["context_mcp_server.py"]=7778
  ["memory_mcp_server.py"]=7779
  ["bocha_search_mcp_server.py"]=7780
  ["baidu_map_mcp_server.py"]=7781
  ["hotnews_mcp_server.py"]=7782
  ["poetry_mcp_server.py"]=7783
  ["wecom_bot_mcp_server.py"]=7785
  ["feishu_mcp_server.py"]=7786
)

for script in "${!SERVERS[@]}"; do
  port="${SERVERS[$script]}"
  log="/tmp/${script%.py}.log"
  echo "[start_mcp] $script -> :$port"
  pkill -f "python3 $script" 2>/dev/null || true
  sleep 0.2
  nohup python3 "$script" > "$log" 2>&1 &
  disown
done

sleep 2
echo
echo "[start_mcp] post-boot SSE health:"
for script in "${!SERVERS[@]}"; do
  port="${SERVERS[$script]}"
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "http://127.0.0.1:$port/sse")
  printf "  %-30s :%d → %s\n" "$script" "$port" "$code"
done

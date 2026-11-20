# AI-Lover 2.0 Server Deployment

This deployment keeps the existing `linux-consolidation-20260703` services isolated.

## Runtime Layout

- App root: `/data/apps/ai-lover-2.0`
- Frontend: `/data/apps/ai-lover-2.0/frontend`
- Agent API: `/data/apps/ai-lover-2.0/server/bin/api`
- TEN runtime source: `/data/apps/ai-lover-2.0/ai_agents/agents/examples/websocket-example/tenapp`
- Public nginx domain: `ai.vituralmodel.com`, with optional aliases `vmodel.cc` and `www.vmodel.cc`
- Internal ports:
  - Frontend: `127.0.0.1:3000`
  - Agent API: `127.0.0.1:8080`
  - TEN WebSocket workers: dynamic local ports returned by `/start`

## Production 2.0 Profile

The current Aliyun production deployment runs from:

```text
/data/apps/ai-lover-2.0/current
```

Systemd units:

```text
ai-lover-frontend.service
ai-lover-agent.service
```

The agent service uses:

```text
TEN_WORKER_START_DIRECT=true
TEN_PYTHON_LIB_PATH=/opt/ai-lover-runtime/python-3.10.14/lib/libpython3.10.so
```

The cloud profile is intentionally minimal:

- `websocket_server`
- `deepgram_asr_python`
- `openai_llm2_python`
- `azure_tts_python`
- `main_python`
- `client_control_tool_python`

Optional MCP tools should not be included in the default graph unless their
SSE services on `127.0.0.1:7777-7786` are actually running. Otherwise graph
startup will fail even though the core voice assistant could work.

The current server environment uses these variable names:

```text
DEEPGRAM_API_KEY
OPENAI_API_KEY
OPENAI_API_BASE
OPENAI_MODEL
OPENAI_PROXY_URL
MINIMAX_TTS_API_KEY
MINIMAX_TTS_GROUP_ID
AZURE_TTS_API_KEY
AZURE_TTS_REGION
ELEVENLABS_TTS_KEY
AGORA_APP_ID
AGORA_APP_CERTIFICATE
```

Do not print or commit the actual values.

TTS priority rule:

- Production is configured to prefer Microsoft/Azure TTS through
  `azure_tts_python`.
- Azure Speech needs both `AZURE_TTS_API_KEY` and `AZURE_TTS_REGION`. A key
  alone is not enough to authenticate. The current verified region is `eastus`.
- The server Python runtime must include `azure-cognitiveservices-speech`.
- Keep MiniMax variables configured as the rollback provider. If Azure has an
  incident, restore the backed-up `property.json` or switch the TEN graph `tts`
  node back to `minimax_tts_websocket_python`.

If the graph fails immediately after `/start`, check:

```bash
journalctl -u ai-lover-agent.service -n 160 --no-pager
```

Known failure patterns:

- `Unable to find extension:client_control_tool_python`: the extension folder is missing `__init__.py`.
- `Environment variable ALIYUN_ASR_API_KEY is not found`: the cloud graph is using the local Aliyun ASR profile instead of the production Deepgram profile.
- `httpx.ConnectError` from `mcp_client_python`: optional MCP nodes were enabled without starting their local MCP SSE services.

## Local Head/Hand Access From Cloud Pages

A public cloud server cannot directly reach a customer LAN device such as
`192.168.x.x`. The browser page must talk to a local bridge running on the
customer computer:

- Robot head bridge: `http://127.0.0.1:8787`
- Hand bridge: `http://127.0.0.1:8791`

The cloud page can use those local bridge endpoints after the customer starts
the local connector package. The bridge then connects to the local robot head
or hand over Wi-Fi/USB. This avoids exposing private LAN hardware to the
internet and works per user.

For a pure browser-only visit without the local connector, AI chat and the
digital avatar can work, but local head/hand control cannot.

## Safe Deployment Rules

1. Do not modify existing services on ports `18000`, `18001`, or `18002`.
2. Do not expose `8080` or `3000` publicly; nginx is the only public entry.
3. Back up nginx config before enabling the AI-Lover vhost.
4. Keep secrets in server-local `.env` files; never commit them.
5. Use `TEN_WORKER_START_DIRECT=true` on servers without `tman`.

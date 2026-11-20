"""
Feishu (飞书) MCP SSE server — 用自建应用的 App ID/Secret 调飞书 OpenAPI。

Runs locally inside the Docker container on port 7786.
Used by mcp_client_python extension via SSE transport.

API docs: https://open.feishu.cn/document/server-docs/api-call-guide/calling-process

Tools exposed:
    - feishu_send_to_chat(chat_query, content)   — 发消息到模糊匹配的群
    - feishu_list_chats()                         — 列出 bot 所在的所有群

Start:
    python3 feishu_mcp_server.py
"""

from __future__ import annotations

import asyncio
import json
import os
import time

import httpx
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Feishu app credentials — read from env (sourced by start_mcp_servers.sh
# from secrets.env). Hard-fail at boot if missing.
# ---------------------------------------------------------------------------
LARK_APP_ID = os.environ.get("LARK_APP_ID", "")
LARK_APP_SECRET = os.environ.get("LARK_APP_SECRET", "")
if not LARK_APP_ID or not LARK_APP_SECRET:
    raise RuntimeError(
        "LARK_APP_ID / LARK_APP_SECRET env vars not set — ensure secrets.env "
        "is sourced before launching this MCP server (see start_mcp_servers.sh)."
    )

_BASE = "https://open.feishu.cn/open-apis"
_TIMEOUT_SECONDS = 10.0

# tenant_access_token 缓存,避免每次调用都换 token。
_token_cache: tuple[str, float] | None = None  # (token, expire_unix_ts)
_token_lock = asyncio.Lock()


async def _get_token() -> str:
    """Get a valid tenant_access_token, refreshing on expiry. Raises on auth fail."""
    global _token_cache
    async with _token_lock:
        now = time.time()
        if _token_cache and _token_cache[1] > now + 60:
            return _token_cache[0]

        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{_BASE}/auth/v3/tenant_access_token/internal",
                json={"app_id": LARK_APP_ID, "app_secret": LARK_APP_SECRET},
            )
        body = resp.json()
        if body.get("code") != 0:
            raise RuntimeError(
                f"feishu auth failed: code={body.get('code')} msg={body.get('msg')}"
            )

        token = body["tenant_access_token"]
        # 飞书一般给 7200s 有效期;留 5 分钟安全边距。
        expire_at = now + body.get("expire", 7200) - 300
        _token_cache = (token, expire_at)
        return token


async def _list_chats(token: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
        resp = await client.get(
            f"{_BASE}/im/v1/chats",
            headers={"Authorization": f"Bearer {token}"},
            params={"page_size": 50},
        )
    body = resp.json()
    if body.get("code") != 0:
        raise RuntimeError(
            f"feishu list_chats failed: code={body.get('code')} msg={body.get('msg')}"
        )
    return (body.get("data") or {}).get("items") or []


# ---------------------------------------------------------------------------
# MCP server.
# ---------------------------------------------------------------------------
mcp = FastMCP("feishu-tool", host="127.0.0.1", port=7786)


@mcp.tool()
async def feishu_list_chats() -> str:
    """List Feishu groups/chats this bot has been added to.

    Use this for debugging or when the user asks 「机器人在哪些群」/
    「飞书有哪些群」。Returns chat names + chat_ids.

    The bot can only send messages to chats it's been added to, so if a
    target group isn't here, the user needs to invite the bot first.
    """
    try:
        token = await _get_token()
        items = await _list_chats(token)
    except Exception as exc:  # noqa: BLE001
        return f"Error: {type(exc).__name__}: {exc}"

    if not items:
        return "(机器人还没被加到任何群,先去飞书把'小灵'机器人拉进群)"
    lines = [f"飞书机器人当前在 {len(items)} 个群:"]
    for c in items:
        name = c.get("name") or "(no name)"
        chat_id = c.get("chat_id") or ""
        lines.append(f"- {name}  [chat_id={chat_id}]")
    return "\n".join(lines)


@mcp.tool()
async def feishu_send_to_chat(chat_query: str, content: str) -> str:
    """Send a text message to a Feishu group, fuzzy-matched by group name.

    Use when the user says 「发飞书」/「飞书群说...」/「往 XX 群发」 etc.
    日常聊天不要主动调,会刷屏。

    Args:
        chat_query: 群名关键字,大小写不敏感,部分匹配。比如要发到
                    "北京海百川科技" 群,传 "海百川" 或 "公司" 都行。
                    传空字符串时如果只有一个群,默认发那个群。
        content: 自然中文,一两句把事情讲清楚。

    Returns: success line "已发到飞书群「<name>」: <content>" or error string.
    """
    chat_query = (chat_query or "").strip()
    content = (content or "").strip()
    if not content:
        return "Error: empty content."

    try:
        token = await _get_token()
        items = await _list_chats(token)
    except Exception as exc:  # noqa: BLE001
        return f"Error: {type(exc).__name__}: {exc}"

    if not items:
        return "(机器人还没被加到任何群,先去飞书把'小灵'机器人拉进群)"

    # Fuzzy match by name. Empty query → use the only group if exactly one.
    if not chat_query and len(items) == 1:
        target = items[0]
    else:
        ql = chat_query.lower()
        matches = [c for c in items if ql in (c.get("name") or "").lower()]
        if not matches:
            available = ", ".join(c.get("name") or "(无名)" for c in items[:5])
            return (
                f"找不到名字含 '{chat_query}' 的飞书群。"
                f"机器人当前在的群: {available}"
            )
        target = matches[0]

    chat_id = target["chat_id"]
    chat_name = target.get("name") or "(无名)"

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{_BASE}/im/v1/messages",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                params={"receive_id_type": "chat_id"},
                json={
                    "receive_id": chat_id,
                    "msg_type": "text",
                    # 飞书 IM API 要求 content 是 JSON 字符串(不是对象)
                    "content": json.dumps({"text": content}, ensure_ascii=False),
                },
            )
    except httpx.HTTPError as exc:
        return f"Error: {type(exc).__name__}: {exc}"

    body = resp.json()
    if body.get("code") != 0:
        return f"飞书发送失败: code={body.get('code')} msg={body.get('msg')}"
    return f"已发到飞书群「{chat_name}」: {content}"


if __name__ == "__main__":
    mcp.run(transport="sse")

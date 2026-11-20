"""
WeCom (企业微信) Bot MCP SSE server — 通过群机器人 webhook 发消息到企业微信群。

Runs locally inside the Docker container on port 7785.
Used by mcp_client_python extension via SSE transport.

API: https://developer.work.weixin.qq.com/document/path/91770

Start:
    python3 wecom_bot_mcp_server.py
"""

from __future__ import annotations

import os

import httpx
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# WeCom config — read from env (sourced by start_mcp_servers.sh from
# secrets.env). Hard-fail at boot so missing config is loud, not silent.
# ---------------------------------------------------------------------------
WECOM_WEBHOOK_KEY = os.environ.get("WECOM_WEBHOOK_KEY", "")
if not WECOM_WEBHOOK_KEY:
    raise RuntimeError(
        "WECOM_WEBHOOK_KEY env var not set — ensure secrets.env is sourced "
        "before launching this MCP server (see start_mcp_servers.sh)."
    )

WECOM_ENDPOINT = (
    f"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={WECOM_WEBHOOK_KEY}"
)

_TIMEOUT_SECONDS = 10.0
_MAX_CONTENT = 4096  # 企微文本上限

mcp = FastMCP("wecom-bot-tool", host="127.0.0.1", port=7785)


async def _post(payload: dict) -> str:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(WECOM_ENDPOINT, json=payload)
    except httpx.HTTPError as exc:
        return f"Error calling WeCom webhook: {type(exc).__name__}: {exc}"

    if resp.status_code >= 400:
        return f"WeCom HTTP {resp.status_code}: {resp.text[:300]}"

    try:
        body = resp.json()
    except ValueError:
        return f"WeCom non-JSON ({resp.status_code}): {resp.text[:300]}"

    if body.get("errcode") != 0:
        return f"WeCom error code={body.get('errcode')}: {body.get('errmsg', '')}"
    return "ok"


@mcp.tool()
async def wecom_send_text(content: str) -> str:
    """Send a plain-text message to the configured WeCom (企业微信) group.

    Use this when the user explicitly says 「发到企微」/「企业微信群说一下」/
    「发企微」之类。日常聊天不要主动调,会刷屏惹人烦。

    Args:
        content: 发到群里的文本,自然中文,一两句讲清楚事情就行。

    Returns: "ok" on success, otherwise an error string starting with "Error" or "WeCom".
    """
    content = (content or "").strip()
    if not content:
        return "Error: empty content."
    if len(content) > _MAX_CONTENT:
        content = content[:_MAX_CONTENT]
    result = await _post({"msgtype": "text", "text": {"content": content}})
    return f"已发到企微群: {content}" if result == "ok" else result


@mcp.tool()
async def wecom_send_markdown(content: str) -> str:
    """Send a markdown-formatted message to the configured WeCom group.

    Use only when richer formatting helps — bolds / lists / headers / links.
    For one-liners just use wecom_send_text.

    Args:
        content: markdown 内容。企微 markdown 比标准受限:
                 不支持图片;表格只支持简单的;标题用 # / ## / ###;
                 强调用 **bold**;链接 [text](url);代码块用 ``` 但限单行。

    Returns: "ok" / 错误信息。
    """
    content = (content or "").strip()
    if not content:
        return "Error: empty content."
    if len(content) > _MAX_CONTENT:
        content = content[:_MAX_CONTENT]
    result = await _post({"msgtype": "markdown", "markdown": {"content": content}})
    return f"已发到企微群(markdown)" if result == "ok" else result


if __name__ == "__main__":
    mcp.run(transport="sse")

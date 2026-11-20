"""
Bocha (博查) Search MCP SSE server — gives 小灵 real Chinese-internet search.

Runs locally inside the Docker container on port 7780.
Used by mcp_client_python extension via SSE transport.

API docs: https://open.bochaai.com/

Start:
    python3 bocha_search_mcp_server.py
"""

from __future__ import annotations

import os

import httpx
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Bocha config — read from env (sourced by start_mcp_servers.sh from
# secrets.env). Hard-fail at boot if missing.
# ---------------------------------------------------------------------------
BOCHA_API_KEY = os.environ.get("BOCHA_API_KEY", "")
if not BOCHA_API_KEY:
    raise RuntimeError(
        "BOCHA_API_KEY env var not set — ensure secrets.env is sourced "
        "before launching this MCP server (see start_mcp_servers.sh)."
    )
BOCHA_ENDPOINT = "https://api.bochaai.com/v1/web-search"

_TIMEOUT_SECONDS = 20.0
_MAX_RESULTS = 6           # cap items returned to the LLM
_MAX_SUMMARY_CHARS = 240   # cap each summary so context doesn't explode

mcp = FastMCP("bocha-search-tool", host="127.0.0.1", port=7780)


def _format_results(payload: dict) -> str:
    """Squash Bocha JSON into a small text block the LLM can read fast."""
    data = payload.get("data") or {}
    web = (data.get("webPages") or {}).get("value") or []
    if not web:
        return "（博查没有返回结果）"

    lines: list[str] = []
    for i, item in enumerate(web[:_MAX_RESULTS], start=1):
        title = (item.get("name") or "").strip()
        url = (item.get("url") or "").strip()
        snippet = (item.get("summary") or item.get("snippet") or "").strip()
        if len(snippet) > _MAX_SUMMARY_CHARS:
            snippet = snippet[:_MAX_SUMMARY_CHARS] + "…"
        site = (item.get("siteName") or "").strip()
        when = (item.get("dateLastCrawled") or "").strip()[:10]
        meta_bits = [b for b in (site, when) if b]
        meta = f"  [{' · '.join(meta_bits)}]" if meta_bits else ""
        lines.append(f"{i}. {title}{meta}\n   {url}\n   {snippet}")
    return "\n\n".join(lines)


@mcp.tool()
async def bocha_search(query: str, freshness: str = "noLimit") -> str:
    """Search the live Chinese-internet via Bocha (博查) and get top results.

    Use this whenever the user asks anything that needs current real-world info
    that the model can't know on its own — news, weather, prices, public
    events, "今天发生了什么", "XX 是谁", etc.

    Args:
        query: 用中文写。要搜什么就直接写成一个短句,别加引号。
        freshness: 时间过滤,可选 "oneDay" / "oneWeek" / "oneMonth" / "oneYear" /
                   "noLimit"。默认 noLimit;明显是新闻类问题(关键词含"今天/最新/
                   刚刚/发生")时传 "oneDay" 或 "oneWeek"。

    Returns plain text — top results numbered 1..6, each with title, url and a
    short summary. Pick the most relevant 1-2 facts and tell the user in your
    own words; never paste this raw text back to the user.
    """
    query = (query or "").strip()
    if not query:
        return "Error: empty query."
    if freshness not in ("oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"):
        freshness = "noLimit"

    headers = {
        "Authorization": f"Bearer {BOCHA_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "query": query,
        "freshness": freshness,
        "summary": True,
        "count": _MAX_RESULTS,
    }

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(BOCHA_ENDPOINT, headers=headers, json=body)
    except httpx.HTTPError as exc:
        return f"Error calling Bocha: {type(exc).__name__}: {exc}"

    if resp.status_code >= 400:
        return f"Bocha HTTP {resp.status_code}: {resp.text[:300]}"

    try:
        payload = resp.json()
    except ValueError:
        return f"Bocha returned non-JSON ({resp.status_code}): {resp.text[:300]}"

    if payload.get("code") not in (None, 200):
        return f"Bocha error code={payload.get('code')}: {payload.get('msg', '')}"

    return _format_results(payload)


if __name__ == "__main__":
    mcp.run(transport="sse")

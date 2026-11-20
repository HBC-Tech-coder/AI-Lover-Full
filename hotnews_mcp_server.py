"""
Hot News (国内热榜) MCP SSE server — gives 小灵 today's trending topics.

Runs locally inside the Docker container on port 7782.
Used by mcp_client_python extension via SSE transport.

We talk directly to upstream JSON endpoints that are reachable from the
production network:
    - 百度热搜:  https://top.baidu.com/api/board?platform=wise&tab=realtime
    - 36氪热榜:  https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot

Other sources (微博 / 知乎 / 抖音) are intentionally NOT included because
their public endpoints either require login cookies or are DNS-blocked from
this network. We can add them later via a self-hosted aggregator.

Start:
    python3 hotnews_mcp_server.py
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

_TIMEOUT_SECONDS = 12.0
_TOP_N = 8
_CACHE_TTL_SECONDS = 180          # share results for ~3 minutes
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 XiaolingMCP/0.1"
)

_cache: dict[str, tuple[float, str]] = {}
_cache_lock = asyncio.Lock()

# Source key → human label.
_SOURCES = {
    "baidu": "百度热搜",
    "36kr": "36氪热榜",
}

mcp = FastMCP("hotnews-tool", host="127.0.0.1", port=7782)


# ---------------------------------------------------------------------------
# Per-source fetchers. Each returns a list[str] of "title" lines (best-effort).
# ---------------------------------------------------------------------------
async def _fetch_baidu(client: httpx.AsyncClient) -> list[str]:
    resp = await client.get(
        "https://top.baidu.com/api/board",
        params={"platform": "wise", "tab": "realtime"},
        headers={"User-Agent": _UA, "Accept": "application/json"},
    )
    resp.raise_for_status()
    payload = resp.json()
    cards = (payload.get("data") or {}).get("cards") or []
    titles: list[str] = []
    for card in cards:
        for outer in card.get("content") or []:
            # Baidu wraps the actual list one level deeper:
            #     cards[0].content[0].content -> [{word, desc, ...}, ...]
            inner = outer.get("content") if isinstance(outer, dict) else None
            if isinstance(inner, list):
                for item in inner:
                    word = (item.get("word") or item.get("query") or "").strip()
                    desc = (item.get("desc") or "").strip()
                    if word:
                        titles.append(f"{word}{f' — {desc}' if desc else ''}")
            else:
                # Some boards return the items at this level already.
                word = (outer.get("word") or outer.get("query") or "").strip()
                desc = (outer.get("desc") or "").strip()
                if word:
                    titles.append(f"{word}{f' — {desc}' if desc else ''}")
        if titles:
            break
    return titles


async def _fetch_36kr(client: httpx.AsyncClient) -> list[str]:
    resp = await client.post(
        "https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot",
        json={"partner_id": "wap", "param": {"siteId": 1, "platformId": 2}},
        headers={"User-Agent": _UA, "Content-Type": "application/json"},
    )
    resp.raise_for_status()
    payload = resp.json()
    items = ((payload.get("data") or {}).get("hotRankList")) or []
    titles: list[str] = []
    for item in items:
        tm = item.get("templateMaterial") or {}
        title = (tm.get("widgetTitle") or "").strip()
        author = (tm.get("authorName") or "").strip()
        if title:
            titles.append(f"{title}{f' — {author}' if author else ''}")
    return titles


_FETCHERS = {
    "baidu": _fetch_baidu,
    "36kr": _fetch_36kr,
}


def _format(label: str, titles: list[Any]) -> str:
    if not titles:
        return f"{label}: 当前没拿到数据。"
    lines = [f"{label}（实时 Top {min(len(titles), _TOP_N)}）:"]
    for i, t in enumerate(titles[:_TOP_N], start=1):
        lines.append(f"{i}. {t}")
    return "\n".join(lines)


async def _fetch_one(source_key: str) -> str:
    now = time.time()
    async with _cache_lock:
        cached = _cache.get(source_key)
        if cached and (now - cached[0] < _CACHE_TTL_SECONDS):
            return cached[1]

    label = _SOURCES[source_key]
    fetcher = _FETCHERS[source_key]
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            titles = await fetcher(client)
    except httpx.HTTPError as exc:
        return f"{label}: 抓取失败 ({type(exc).__name__})"
    except (KeyError, ValueError, TypeError) as exc:
        return f"{label}: 数据解析失败 ({type(exc).__name__})"

    text = _format(label, titles)
    async with _cache_lock:
        _cache[source_key] = (now, text)
    return text


@mcp.tool()
async def get_hotnews(source: str = "baidu") -> str:
    """Fetch today's hot trending topics from a Chinese platform.

    Use this whenever the user asks 今天的热点 / 热搜 / 大家在聊什么 / 最近什么火 /
    现在网上在传什么 / 36 氪今天有啥 之类问题。

    Args:
        source: 平台关键字。可选:
                "baidu"  — 百度热搜（综合民生类热点,泛问"热搜"用这个）
                "36kr"   — 36氪热榜（创业 / 科技 / 商业)
                默认 "baidu"。

    Returns: a small text block of top items. Pick 1-3 things actually worth
    mentioning to the user; don't read out the whole list verbatim.
    """
    src = (source or "baidu").strip().lower()
    if src not in _SOURCES:
        return f"Error: 不支持的来源 {src!r}。可选: {', '.join(_SOURCES.keys())}"
    return await _fetch_one(src)


if __name__ == "__main__":
    mcp.run(transport="sse")

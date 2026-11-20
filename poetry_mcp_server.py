"""
Poetry & 节气 (古诗词/节气文化) MCP SSE server — gives 小灵 a curated Chinese
poem to drop into chat, optionally tied to today's 节气 / 季节 / 月份。

Runs locally inside the Docker container on port 7783.
Used by mcp_client_python extension via SSE transport.

Primary upstream:
    今日诗词  https://www.jinrishici.com/  (smart recommend by date/season/etc.)
Fallback when 今日诗词 is unreachable: a tiny built-in 节气-themed pool.

Token handling: 今日诗词 needs a one-time POST to /token (永久有效).
We persist it next to the script so we don't refetch each restart.

Start:
    python3 poetry_mcp_server.py
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Constants.
# ---------------------------------------------------------------------------
_TOKEN_URL = "https://v2.jinrishici.com/token"
_SENTENCE_URL = "https://v2.jinrishici.com/sentence"
_TIMEOUT_SECONDS = 10.0

_TOKEN_PATH = Path(__file__).resolve().parent / ".memory" / "jinrishici_token.txt"
_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
_token_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Tiny offline 节气-themed fallback pool, keyed by 节气 keyword.
# Used only when 今日诗词 is unreachable.
# ---------------------------------------------------------------------------
_JIEQI_POOL: dict[str, tuple[str, str, str]] = {
    "立春":   ("律回岁晚冰霜少,春到人间草木知。",        "张栻",     "《立春偶成》"),
    "雨水":   ("好雨知时节,当春乃发生。",                "杜甫",     "《春夜喜雨》"),
    "惊蛰":   ("一雷惊蛰始,耕种从此起。",                "陶渊明",   "《拟古九首·其三》"),
    "春分":   ("仲春初四日,春色正中分。",                "徐铉",     "《春分日》"),
    "清明":   ("清明时节雨纷纷,路上行人欲断魂。",        "杜牧",     "《清明》"),
    "谷雨":   ("谷雨春光晓,山川黛色青。",                "朱槔",     "《谷雨》"),
    "立夏":   ("绿树阴浓夏日长,楼台倒影入池塘。",        "高骈",     "《山亭夏日》"),
    "小满":   ("夜莺啼绿柳,皓月醒长空。",                "欧阳修",   "《小满》"),
    "芒种":   ("时雨及芒种,四野皆插秧。",                "陆游",     "《时雨》"),
    "夏至":   ("昼晷已云极,宵漏自此长。",                "韦应物",   "《夏至避暑北池》"),
    "小暑":   ("倏忽温风至,因循小暑来。",                "元稹",     "《小暑六月节》"),
    "大暑":   ("何以销烦暑,端居一院中。",                "白居易",   "《销夏》"),
    "立秋":   ("乳鸦啼散玉屏空,一枕新凉一扇风。",        "刘翰",     "《立秋》"),
    "处暑":   ("疾风驱急雨,残暑扫除空。",                "仇远",     "《处暑后风雨》"),
    "白露":   ("蒹葭苍苍,白露为霜。",                    "《诗经》", "《秦风·蒹葭》"),
    "秋分":   ("秋分一夜停,阴魄最圆时。",                "刘攽",     "《新秋》"),
    "寒露":   ("空山新雨后,天气晚来秋。",                "王维",     "《山居秋暝》"),
    "霜降":   ("霜降水返壑,风落木归山。",                "白居易",   "《岁晚》"),
    "立冬":   ("冻笔新诗懒写,寒炉美酒时温。",            "李白",     "《立冬》"),
    "小雪":   ("莫怪虹无影,如今小雪时。",                "释善珍",   "《小雪》"),
    "大雪":   ("夜深知雪重,时闻折竹声。",                "白居易",   "《夜雪》"),
    "冬至":   ("冬至阳生春又来,日光惨淡水萦回。",        "杜甫",     "《小至》"),
    "小寒":   ("小寒料峭,一番春意换年芳。",              "宋无名氏", "《小寒》"),
    "大寒":   ("旧雪未及消,新雪又拥户。",                "邵雍",     "《大寒吟》"),
}

# Generic season fallback if not on a 节气 day.
_SEASON_POOL: dict[str, tuple[str, str, str]] = {
    "春": ("春眠不觉晓,处处闻啼鸟。", "孟浩然", "《春晓》"),
    "夏": ("接天莲叶无穷碧,映日荷花别样红。", "杨万里", "《晓出净慈寺送林子方》"),
    "秋": ("空山新雨后,天气晚来秋。", "王维", "《山居秋暝》"),
    "冬": ("墙角数枝梅,凌寒独自开。", "王安石", "《梅花》"),
}


def _current_season() -> str:
    m = datetime.now().month
    if 3 <= m <= 5:
        return "春"
    if 6 <= m <= 8:
        return "夏"
    if 9 <= m <= 11:
        return "秋"
    return "冬"


def _current_jieqi() -> str | None:
    """Return today's 节气 if any, else None. Best-effort, lunar_python optional."""
    try:
        from lunar_python import Lunar  # type: ignore[import-not-found]
    except ImportError:
        return None
    try:
        lunar = Lunar.fromDate(datetime.now())
        jieqi = (lunar.getJieQi() or "").strip()
        return jieqi or None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Token + remote fetch.
# ---------------------------------------------------------------------------
async def _get_token() -> str | None:
    """Load cached token, else POST /token to mint a new one (永久有效)."""
    async with _token_lock:
        if _TOKEN_PATH.exists():
            tok = _TOKEN_PATH.read_text(encoding="utf-8").strip()
            if tok:
                return tok
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
                # jinrishici /token endpoint accepts GET as well.
                resp = await client.get(_TOKEN_URL)
            data = resp.json()
            tok = (data.get("data") or "").strip()
            if tok:
                _TOKEN_PATH.write_text(tok, encoding="utf-8")
                return tok
        except (httpx.HTTPError, ValueError):
            return None
    return None


async def _fetch_remote() -> tuple[str, str, str] | None:
    """Hit jinrishici /sentence; return (line, author, title) or None."""
    token = await _get_token()
    if not token:
        return None
    headers = {"X-User-Token": token}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.get(_SENTENCE_URL, headers=headers)
        body = resp.json()
    except (httpx.HTTPError, ValueError):
        return None
    if body.get("status") != "success":
        return None
    data = body.get("data") or {}
    line = (data.get("content") or "").strip()
    origin = data.get("origin") or {}
    title = (origin.get("title") or "").strip()
    author = (origin.get("author") or "").strip()
    if not line:
        return None
    return line, author, title


# ---------------------------------------------------------------------------
# MCP server.
# ---------------------------------------------------------------------------
mcp = FastMCP("poetry-tool", host="127.0.0.1", port=7783)


def _format(line: str, author: str, title: str, jieqi: str | None) -> str:
    head = f"今日节气:{jieqi}\n" if jieqi else ""
    cite_bits = [b for b in (author, title) if b]
    cite = "  —— " + " ".join(cite_bits) if cite_bits else ""
    return f"{head}{line}{cite}"


@mcp.tool()
async def get_poetry() -> str:
    """Return one curated Chinese classical poem line, ideally matching today.

    Use this when 用户:
      - 问"今天有什么诗" / "应景的诗" / "来一句诗"
      - 提到节气、季节、节日、想要文化感 → 主动调一次,把诗自然带进回应
      - 早安 / 晚安 / 应景寒暄场合,可以用诗收个尾

    Returns one line + 作者《篇名》。如果今天正好是节气,返回里也会带上节气信息。
    Tool intentionally takes no arguments — 一次调用拿一句即可,不要在同一轮反复调。
    """
    jieqi = _current_jieqi()

    # Try jinrishici first (smarter recommendation).
    remote = await _fetch_remote()
    if remote:
        line, author, title = remote
        return _format(line, author, title, jieqi)

    # Fall back to curated pools.
    if jieqi and jieqi in _JIEQI_POOL:
        line, author, title = _JIEQI_POOL[jieqi]
        return _format(line, author, title, jieqi)

    line, author, title = _SEASON_POOL[_current_season()]
    return _format(line, author, title, jieqi)


@mcp.tool()
async def get_jieqi_info() -> str:
    """Return today's 节气 (if on one) plus the next upcoming 节气, in plain text.

    Use this for cultural context — when user asks "今天什么节气" / "下一个节气是
    什么" / "立春是哪天" 之类。Note 小灵 already has get_lunar_date which returns
    today's 节气; only call this one when user explicitly wants 节气 info or the
    *next* one.
    """
    try:
        from lunar_python import Lunar  # type: ignore[import-not-found]
    except ImportError:
        return "节气数据不可用（lunar_python 未安装）。"

    try:
        lunar = Lunar.fromDate(datetime.now())
        today_jq = (lunar.getJieQi() or "").strip()
        # getNextJieQi returns a JieQi object; format date manually.
        nxt = lunar.getNextJieQi()
        nxt_name = nxt.getName() if nxt else ""
        nxt_solar = nxt.getSolar() if nxt else None
        nxt_date = (
            f"{nxt_solar.getYear()}-{nxt_solar.getMonth():02d}-{nxt_solar.getDay():02d}"
            if nxt_solar
            else ""
        )
    except Exception as exc:  # noqa: BLE001
        return f"节气查询出错:{type(exc).__name__}"

    parts: list[str] = []
    if today_jq:
        parts.append(f"今日节气:{today_jq}")
    else:
        parts.append("今天不是节气日。")
    if nxt_name and nxt_date:
        parts.append(f"下一个节气:{nxt_name}（{nxt_date}）")
    return "\n".join(parts)


if __name__ == "__main__":
    mcp.run(transport="sse")

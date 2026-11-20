"""
Baidu Map (百度地图) MCP SSE server — gives 小灵 location/route/POI/weather.

Runs locally inside the Docker container on port 7781.
Used by mcp_client_python extension via SSE transport.

API docs: https://lbsyun.baidu.com/

Start:
    python3 baidu_map_mcp_server.py
"""

from __future__ import annotations

import os

import httpx
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Baidu Map config — read from env (sourced by start_mcp_servers.sh from
# secrets.env). Hard-fail at boot if missing.
# ---------------------------------------------------------------------------
BAIDU_AK = os.environ.get("BAIDU_MAP_AK", "")
if not BAIDU_AK:
    raise RuntimeError(
        "BAIDU_MAP_AK env var not set — ensure secrets.env is sourced "
        "before launching this MCP server (see start_mcp_servers.sh)."
    )

_TIMEOUT_SECONDS = 15.0
_BASE = "https://api.map.baidu.com"

mcp = FastMCP("baidu-map-tool", host="127.0.0.1", port=7781)


async def _get(path: str, params: dict) -> dict:
    """GET wrapper that auto-injects ak + output=json."""
    params = {**params, "ak": BAIDU_AK, "output": "json"}
    async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
        resp = await client.get(f"{_BASE}{path}", params=params)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Tools.
# ---------------------------------------------------------------------------
@mcp.tool()
async def map_geocode(address: str) -> str:
    """Convert a Chinese address/place name to lat/lng coordinates.

    Use this as a stepping stone before calling map_route_driving when you
    only have the user's free-text origin and destination (e.g. "我从国贸去
    首都机场").

    Args:
        address: 中文地址或地名,例如 "北京国贸"、"首都机场 T3"。

    Returns: a single line "lat,lng — formatted_address" or an error string.
    """
    address = (address or "").strip()
    if not address:
        return "Error: empty address."
    try:
        payload = await _get("/geocoding/v3/", {"address": address})
    except httpx.HTTPError as exc:
        return f"Error: {type(exc).__name__}: {exc}"

    if payload.get("status") != 0:
        return f"Baidu geocode failed: {payload.get('message') or payload}"

    loc = (payload.get("result") or {}).get("location") or {}
    lat = loc.get("lat")
    lng = loc.get("lng")
    formatted = (payload.get("result") or {}).get("formatted_address") or address
    if lat is None or lng is None:
        return "Error: no coordinates returned."
    return f"{lat:.6f},{lng:.6f} — {formatted}"


@mcp.tool()
async def map_search_poi(query: str, region: str = "北京") -> str:
    """Search for points of interest (POI) by keyword in a city.

    Use for "附近的咖啡店"、"找家烤肉"、"有什么好吃的" 之类 free-text 询问。

    Args:
        query: 搜索关键词,例如 "咖啡"、"川菜"、"加油站"。
        region: 限定城市,例如 "北京"、"上海"。默认 "北京"。

    Returns: top 5 results, each with name, address, optional phone.
    """
    query = (query or "").strip()
    region = (region or "北京").strip()
    if not query:
        return "Error: empty query."
    try:
        payload = await _get(
            "/place/v2/search",
            {"query": query, "region": region, "page_size": 5},
        )
    except httpx.HTTPError as exc:
        return f"Error: {type(exc).__name__}: {exc}"

    if payload.get("status") != 0:
        return f"Baidu POI failed: {payload.get('message') or payload}"

    results = payload.get("results") or []
    if not results:
        return f"在{region}没找到「{query}」相关的地点。"

    lines: list[str] = []
    for i, item in enumerate(results[:5], start=1):
        name = item.get("name") or ""
        addr = item.get("address") or ""
        tel = (item.get("telephone") or "").strip()
        meta = f" · {tel}" if tel else ""
        lines.append(f"{i}. {name} — {addr}{meta}")
    return "\n".join(lines)


@mcp.tool()
async def map_route_driving(origin: str, destination: str) -> str:
    """Plan a driving route between two places (in China).

    Args:
        origin: 起点。可以是中文地名(自动 geocode)或 "lat,lng" 字符串。
        destination: 终点。同上。

    Returns: a one-line summary "约 X 公里, 估时 Y 分钟, 路况: …"。
    """
    origin = (origin or "").strip()
    destination = (destination or "").strip()
    if not origin or not destination:
        return "Error: origin and destination are both required."

    async def _to_latlng(text: str) -> str | None:
        if "," in text and all(p.strip().replace(".", "").replace("-", "").isdigit() for p in text.split(",")[:2]):
            return text  # already lat,lng
        # Reuse geocode tool inline.
        try:
            payload = await _get("/geocoding/v3/", {"address": text})
        except httpx.HTTPError:
            return None
        if payload.get("status") != 0:
            return None
        loc = (payload.get("result") or {}).get("location") or {}
        if "lat" in loc and "lng" in loc:
            return f"{loc['lat']:.6f},{loc['lng']:.6f}"
        return None

    o = await _to_latlng(origin)
    d = await _to_latlng(destination)
    if not o or not d:
        return f"Error: 无法定位 origin/destination（origin={o!r}, dest={d!r}）"

    try:
        payload = await _get(
            "/directionlite/v1/driving",
            {"origin": o, "destination": d},
        )
    except httpx.HTTPError as exc:
        return f"Error: {type(exc).__name__}: {exc}"

    if payload.get("status") != 0:
        return f"Baidu route failed: {payload.get('message') or payload}"

    routes = (payload.get("result") or {}).get("routes") or []
    if not routes:
        return "没有可用路线。"
    r = routes[0]
    distance_km = (r.get("distance") or 0) / 1000.0
    duration_min = (r.get("duration") or 0) / 60.0
    traffic_map = {0: "未知", 1: "畅通", 2: "缓行", 3: "拥堵", 4: "严重拥堵"}
    traffic = traffic_map.get(r.get("traffic_condition", 0), "未知")
    return f"约 {distance_km:.1f} 公里, 估时 {duration_min:.0f} 分钟, 路况: {traffic}"


@mcp.tool()
async def map_traffic(road_or_city: str) -> str:
    """Query real-time traffic for a road or whole city.

    Args:
        road_or_city: e.g. "北京 二环" or "上海"。

    Returns: a short text describing road condition.
    """
    road_or_city = (road_or_city or "").strip()
    if not road_or_city:
        return "Error: empty input."
    try:
        payload = await _get(
            "/traffic/v1/road",
            {"road_name": road_or_city, "city": "北京"},
        )
    except httpx.HTTPError as exc:
        return f"Error: {type(exc).__name__}: {exc}"
    if payload.get("status") != 0:
        return f"Baidu traffic failed: {payload.get('message') or payload}"
    desc = (payload.get("description") or "").strip()
    return desc or "目前没有突出的路况信息。"


if __name__ == "__main__":
    mcp.run(transport="sse")

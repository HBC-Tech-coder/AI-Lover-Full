#
# This file is part of TEN Framework, an open source project.
# Licensed under the Apache License, Version 2.0.
# See the LICENSE file for more information.
#
import asyncio
import json
import traceback
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Literal, Optional
from ten_ai_base.const import CMD_PROPERTY_RESULT
from ten_ai_base.helper import AsyncQueue
from ten_ai_base.struct import (
    LLMMessage,
    LLMMessageContent,
    LLMMessageFunctionCall,
    LLMMessageFunctionCallOutput,
    LLMRequest,
    LLMResponse,
    LLMResponseMessageDelta,
    LLMResponseMessageDone,
    LLMResponseReasoningDelta,
    LLMResponseReasoningDone,
    LLMResponseToolCall,
    parse_llm_response,
)
from ten_ai_base.types import (
    LLMToolMetadata,
    LLMToolMetadataParameter,
    LLMToolResult,
)
from ..helper import _send_cmd, _send_cmd_ex, _send_data
import time
from ten_runtime import AsyncTenEnv, Loc, StatusCode
import uuid


_BEIJING_TZ = timezone(timedelta(hours=8))
_WEEKDAY_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
_GAN = "甲乙丙丁戊己庚辛壬癸"
_ZHI = "子丑寅卯辰巳午未申酉戌亥"
_ZODIAC = "鼠牛虎兔龙蛇马羊猴鸡狗猪"
_MONTH_ZH = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"]
_DAY_ZH = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]
_SOLAR_TERMS_REFERENCE = [
    ((1, 5), "小寒"),
    ((1, 20), "大寒"),
    ((2, 4), "立春"),
    ((2, 19), "雨水"),
    ((3, 6), "惊蛰"),
    ((3, 21), "春分"),
    ((4, 5), "清明"),
    ((4, 20), "谷雨"),
    ((5, 6), "立夏"),
    ((5, 21), "小满"),
    ((6, 6), "芒种"),
    ((6, 21), "夏至"),
    ((7, 7), "小暑"),
    ((7, 23), "大暑"),
    ((8, 8), "立秋"),
    ((8, 23), "处暑"),
    ((9, 8), "白露"),
    ((9, 23), "秋分"),
    ((10, 8), "寒露"),
    ((10, 23), "霜降"),
    ((11, 7), "立冬"),
    ((11, 22), "小雪"),
    ((12, 7), "大雪"),
    ((12, 22), "冬至"),
]

# 1900-2100 Chinese lunar calendar data. Each entry encodes month lengths and
# leap-month information; this avoids making core greeting tools depend on MCP
# sidecars or optional Python packages.
_LUNAR_INFO = [
    0x04BD8, 0x04AE0, 0x0A570, 0x054D5, 0x0D260, 0x0D950, 0x16554,
    0x056A0, 0x09AD0, 0x055D2, 0x04AE0, 0x0A5B6, 0x0A4D0, 0x0D250,
    0x1D255, 0x0B540, 0x0D6A0, 0x0ADA2, 0x095B0, 0x14977, 0x04970,
    0x0A4B0, 0x0B4B5, 0x06A50, 0x06D40, 0x1AB54, 0x02B60, 0x09570,
    0x052F2, 0x04970, 0x06566, 0x0D4A0, 0x0EA50, 0x06E95, 0x05AD0,
    0x02B60, 0x186E3, 0x092E0, 0x1C8D7, 0x0C950, 0x0D4A0, 0x1D8A6,
    0x0B550, 0x056A0, 0x1A5B4, 0x025D0, 0x092D0, 0x0D2B2, 0x0A950,
    0x0B557, 0x06CA0, 0x0B550, 0x15355, 0x04DA0, 0x0A5D0, 0x14573,
    0x052D0, 0x0A9A8, 0x0E950, 0x06AA0, 0x0AEA6, 0x0AB50, 0x04B60,
    0x0AAE4, 0x0A570, 0x05260, 0x0F263, 0x0D950, 0x05B57, 0x056A0,
    0x096D0, 0x04DD5, 0x04AD0, 0x0A4D0, 0x0D4D4, 0x0D250, 0x0D558,
    0x0B540, 0x0B6A0, 0x195A6, 0x095B0, 0x049B0, 0x0A974, 0x0A4B0,
    0x0B27A, 0x06A50, 0x06D40, 0x0AF46, 0x0AB60, 0x09570, 0x04AF5,
    0x04970, 0x064B0, 0x074A3, 0x0EA50, 0x06B58, 0x05AC0, 0x0AB60,
    0x096D5, 0x092E0, 0x0C960, 0x0D954, 0x0D4A0, 0x0DA50, 0x07552,
    0x056A0, 0x0ABB7, 0x025D0, 0x092D0, 0x0CAB5, 0x0A950, 0x0B4A0,
    0x0BAA4, 0x0AD50, 0x055D9, 0x04BA0, 0x0A5B0, 0x15176, 0x052B0,
    0x0A930, 0x07954, 0x06AA0, 0x0AD50, 0x05B52, 0x04B60, 0x0A6E6,
    0x0A4E0, 0x0D260, 0x0EA65, 0x0D530, 0x05AA0, 0x076A3, 0x096D0,
    0x04BD7, 0x04AD0, 0x0A4D0, 0x1D0B6, 0x0D250, 0x0D520, 0x0DD45,
    0x0B5A0, 0x056D0, 0x055B2, 0x049B0, 0x0A577, 0x0A4B0, 0x0AA50,
    0x1B255, 0x06D20, 0x0ADA0, 0x14B63, 0x09370, 0x049F8, 0x04970,
    0x064B0, 0x168A6, 0x0EA50, 0x06B20, 0x1A6C4, 0x0AAE0, 0x0A2E0,
    0x0D2E3, 0x0C960, 0x0D557, 0x0D4A0, 0x0DA50, 0x05D55, 0x056A0,
    0x0A6D0, 0x055D4, 0x052D0, 0x0A9B8, 0x0A950, 0x0B4A0, 0x0B6A6,
    0x0AD50, 0x055A0, 0x0ABA4, 0x0A5B0, 0x052B0, 0x0B273, 0x06930,
    0x07337, 0x06AA0, 0x0AD50, 0x14B55, 0x04B60, 0x0A570, 0x054E4,
    0x0D160, 0x0E968, 0x0D520, 0x0DAA0, 0x16AA6, 0x056D0, 0x04AE0,
    0x0A9D4, 0x0A2D0, 0x0D150, 0x0F252, 0x0D520,
]


def _now_beijing() -> datetime:
    return datetime.now(_BEIJING_TZ)


def _time_period(hour: int) -> str:
    if 5 <= hour < 9:
        return "早上"
    if 9 <= hour < 12:
        return "上午"
    if 12 <= hour < 14:
        return "中午"
    if 14 <= hour < 18:
        return "下午"
    if 18 <= hour < 20:
        return "傍晚"
    if 20 <= hour < 23:
        return "晚上"
    return "深夜"


def _lunar_leap_month(year: int) -> int:
    return _LUNAR_INFO[year - 1900] & 0xF


def _lunar_leap_days(year: int) -> int:
    if not _lunar_leap_month(year):
        return 0
    return 30 if (_LUNAR_INFO[year - 1900] & 0x10000) else 29


def _lunar_month_days(year: int, month: int) -> int:
    return 30 if (_LUNAR_INFO[year - 1900] & (0x10000 >> month)) else 29


def _lunar_year_days(year: int) -> int:
    days = 348
    for month in range(1, 13):
        if _LUNAR_INFO[year - 1900] & (0x10000 >> month):
            days += 1
    return days + _lunar_leap_days(year)


def _solar_to_lunar(day: datetime) -> tuple[int, int, int, bool]:
    if day.year < 1900 or day.year > 2100:
        raise ValueError("lunar fallback only supports 1900-2100")

    offset = (day.replace(tzinfo=None) - datetime(1900, 1, 31)).days
    year = 1900
    while year <= 2100 and offset >= _lunar_year_days(year):
        offset -= _lunar_year_days(year)
        year += 1

    leap_month = _lunar_leap_month(year)
    is_leap = False
    month = 1
    while month <= 12:
        days = (
            _lunar_leap_days(year)
            if is_leap and month == leap_month
            else _lunar_month_days(year, month)
        )
        if offset < days:
            break
        offset -= days
        if leap_month == month and not is_leap:
            is_leap = True
        else:
            if is_leap and leap_month == month:
                is_leap = False
            month += 1
    return year, month, offset + 1, is_leap


def _lunar_day_name(day: int) -> str:
    if day == 10:
        return "初十"
    if day == 20:
        return "二十"
    if day == 30:
        return "三十"
    prefixes = ["", "初", "十", "廿", "三"]
    return f"{prefixes[day // 10 + 1]}{_DAY_ZH[day % 10]}"


def _solar_term_text(now: datetime) -> str:
    today = now.date()
    terms = []
    for year in (now.year, now.year + 1):
        for (month, day), name in _SOLAR_TERMS_REFERENCE:
            terms.append((datetime(year, month, day, tzinfo=_BEIJING_TZ).date(), name))

    for term_day, name in terms:
        if term_day == today:
            return f"今日节气:{name}"

    upcoming = [
        (term_day, name)
        for term_day, name in terms
        if 0 < (term_day - today).days <= 7
    ]
    if upcoming:
        term_day, name = min(upcoming, key=lambda item: item[0])
        return f"再过 {(term_day - today).days} 天是{name}"
    return ""


def _builtin_current_time() -> str:
    now = _now_beijing()
    return (
        f"现在是北京时间 {now.year}年{now.month}月{now.day}日 "
        f"{_WEEKDAY_ZH[now.weekday()]} {now.hour:02d}:{now.minute:02d}"
        f"（{_time_period(now.hour)}）"
    )


def _builtin_lunar_date() -> str:
    now = _now_beijing()
    lunar_year, lunar_month, lunar_day, is_leap = _solar_to_lunar(now)
    gz_index = (lunar_year - 4) % 60
    year_gz = f"{_GAN[gz_index % 10]}{_ZHI[gz_index % 12]}"
    zodiac = _ZODIAC[gz_index % 12]
    month_name = f"{'闰' if is_leap else ''}{_MONTH_ZH[lunar_month - 1]}月"
    parts = [
        f"农历 {year_gz}({zodiac})年 {month_name}{_lunar_day_name(lunar_day)}"
    ]
    term_text = _solar_term_text(now)
    if term_text:
        parts.append(term_text)
    return ";".join(parts)


def _builtin_runtime_context() -> str:
    utc_now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    return "\n".join(
        [
            "[LOCAL_CONTEXT]",
            f"server_utc_time={utc_now}",
            f"server_beijing_time={_builtin_current_time()}",
            f"server_lunar={_builtin_lunar_date()}",
            (
                "Use this hidden context for natural greetings, date wording, "
                "and lunar/solar-term awareness. Do not call get_current_time "
                "or get_lunar_date just to start a conversation; only call them "
                "when the user explicitly asks for exact time/date/lunar "
                "recalculation."
            ),
        ]
    )


class LLMExec:
    """
    Context for LLM operations, including ASR and TTS.
    This class handles the interaction with the LLM, including processing commands and data.
    """

    def __init__(self, ten_env: AsyncTenEnv):
        self.ten_env = ten_env
        self.input_queue = AsyncQueue()
        self.stopped = False
        self.on_response: Optional[
            Callable[[AsyncTenEnv, str, str, bool], Awaitable[None]]
        ] = None
        self.on_reasoning_response: Optional[
            Callable[[AsyncTenEnv, str, str, bool], Awaitable[None]]
        ] = None
        self.on_tool_call: Optional[
            Callable[[AsyncTenEnv, LLMToolMetadata], Awaitable[None]]
        ] = None
        self.current_task: Optional[asyncio.Task] = None
        self.loop = asyncio.get_event_loop()
        self.loop.create_task(self._process_input_queue())
        self.available_tools: list[LLMToolMetadata] = []
        self.tool_registry: dict[str, str] = {}
        self.available_tools_lock = (
            asyncio.Lock()
        )  # Lock to ensure thread-safe access
        self.contexts: list[LLMMessage] = []
        self.current_request_id: Optional[str] = None
        self.current_text = None
        # Tools the LLM has called since the last user input. We hard-cap at
        # one call per tool per round — Claude has a habit of re-calling
        # get_lunar_date / recall right after producing a greeting, which
        # produces visible duplicate chips. The prompt asks it not to, but
        # it doesn't always listen.
        self._tools_called_this_round: set[str] = set()

        # Tools that are exempt from the per-round dedup. Use for tools the
        # user drives directly — e.g. terminal commands and file reads in
        # the desktop relay path, where calling the same tool multiple times
        # ("list desktop, then list downloads, then read X") is the whole
        # point. The dedup guard exists for tools the LLM tends to spam on
        # its own (memory/lunar/etc.), not these.
        self._tools_no_dedup: set[str] = {"read_file", "run_command"}
        self._builtin_tool_names: set[str] = {
            "get_current_time",
            "get_lunar_date",
            "get_weather",
        }
        self._silent_builtin_tool_names: set[str] = {
            "get_current_time",
            "get_lunar_date",
        }

        # Phase 1 (xiaoling-desktop): tools whose execution is forwarded to
        # the connected WebSocket client (the Tauri shell on the user's
        # machine) instead of being dispatched to a server-side extension.
        # We seed the in-process registry directly so the existing dispatch
        # path in `_handle_llm_response` ends up at `websocket_server`,
        # which bridges over the WS. See websocket_server/extension.py.
        self._register_builtin_tools()
        self._register_client_relay_tools()

    def _upsert_tool(self, tool: LLMToolMetadata) -> None:
        for idx, existing in enumerate(self.available_tools):
            if existing.name == tool.name:
                self.available_tools[idx] = tool
                return
        self.available_tools.append(tool)

    def _register_builtin_tools(self) -> None:
        tools: list[LLMToolMetadata] = [
            LLMToolMetadata(
                name="get_current_time",
                description=(
                    "Get the current Beijing date, weekday, clock time, and "
                    "time-of-day bucket. Use only when the user explicitly "
                    "asks for exact time/date, timezone conversion, or date "
                    "recalibration. Do not call at conversation start; hidden "
                    "LOCAL_CONTEXT already provides the current time."
                ),
                parameters=[],
            ),
            LLMToolMetadata(
                name="get_lunar_date",
                description=(
                    "Get today's Chinese lunar date and nearby solar term. "
                    "Use only when the user explicitly asks about lunar dates, "
                    "festivals, solar terms, seasons, traditional culture, or "
                    "date recalibration. Do not call at conversation start; "
                    "hidden LOCAL_CONTEXT already provides today's lunar date."
                ),
                parameters=[],
            ),
            LLMToolMetadata(
                name="get_weather",
                description=(
                    "Fallback weather tool. If the real weather MCP service "
                    "is unavailable, this explains that live weather is not "
                    "configured instead of failing the conversation."
                ),
                parameters=[
                    LLMToolMetadataParameter(
                        name="city",
                        type="string",
                        description="City name, defaults to 北京.",
                        required=False,
                    )
                ],
            ),
        ]
        for tool in tools:
            self._upsert_tool(tool)
            self.tool_registry[tool.name] = "__builtin__"

    def _register_client_relay_tools(self) -> None:
        relay_tools: list[LLMToolMetadata] = [
            LLMToolMetadata(
                name="read_file",
                description=(
                    "Read a text file from the user's local computer. "
                    "Use this when the user asks to read, show, open, or "
                    "look at a file by path. Accepts an absolute path or a "
                    "path that starts with ~/ for the home directory. "
                    "Only available when the user is running the xiaoling "
                    "desktop app — fails fast otherwise."
                ),
                parameters=[
                    LLMToolMetadataParameter(
                        name="path",
                        type="string",
                        description=(
                            "Absolute path (e.g. /Users/foo/x.txt) or path "
                            "starting with ~/"
                        ),
                        required=True,
                    ),
                ],
            ),
            LLMToolMetadata(
                name="run_command",
                description=(
                    "Run a shell command on the user's local computer. "
                    "Returns combined stdout and stderr (truncated to ~5KB). "
                    "Has a 30 second timeout. Use ONLY when the user "
                    "explicitly asks to run, execute, or check something via "
                    "the terminal — e.g. 'list my desktop files', 'check git "
                    "status', 'show running processes', 'what's the date'. "
                    "Do NOT chain into destructive commands (rm, mv, kill, "
                    "sudo) without the user spelling them out clearly. Only "
                    "available when the user is running the xiaoling desktop "
                    "app."
                ),
                parameters=[
                    LLMToolMetadataParameter(
                        name="command",
                        type="string",
                        description=(
                            "The shell command to run, e.g. 'ls -la "
                            "~/Desktop' or 'date' or 'git status'"
                        ),
                        required=True,
                    ),
                    LLMToolMetadataParameter(
                        name="cwd",
                        type="string",
                        description=(
                            "Optional working directory; defaults to the "
                            "user's home. Accepts ~/ prefix."
                        ),
                        required=False,
                    ),
                ],
            ),
        ]
        for tool in relay_tools:
            self._upsert_tool(tool)
            self.tool_registry[tool.name] = "websocket_server"

    async def queue_input(self, item: str) -> None:
        await self.input_queue.put(item)

    async def flush(self) -> None:
        """
        Flush the input queue to ensure all items are processed.
        This is useful for ensuring that all pending inputs are handled before stopping.
        """
        await self.input_queue.flush()
        if self.current_request_id:
            request_id = self.current_request_id
            self.current_request_id = None
            await _send_cmd(
                self.ten_env, "abort", "llm", {"request_id": request_id}
            )
        if self.current_task:
            self.current_task.cancel()

    async def stop(self) -> None:
        """
        Stop the LLMExec processing.
        This will stop the input queue processing and any ongoing tasks.
        """
        self.stopped = True
        await self.flush()
        if self.current_task:
            self.current_task.cancel()

    async def register_tool(self, tool: LLMToolMetadata, source: str) -> None:
        """
        Register tools with the LLM.
        This method sends a command to register the provided tools.
        """
        async with self.available_tools_lock:
            self._upsert_tool(tool)
            if (
                tool.name in {"get_current_time", "get_lunar_date"}
                and self.tool_registry.get(tool.name) == "__builtin__"
            ):
                return
            self.tool_registry[tool.name] = source

    def _run_builtin_tool(self, name: str, args: dict | None) -> LLMToolResult:
        if name == "get_current_time":
            return {"type": "llmresult", "content": _builtin_current_time()}
        if name == "get_lunar_date":
            return {"type": "llmresult", "content": _builtin_lunar_date()}
        if name == "get_weather":
            city = ""
            if isinstance(args, dict):
                city = str(args.get("city") or "").strip()
            city_label = city or "北京"
            return {
                "type": "llmresult",
                "content": (
                    f"{city_label}实时天气工具当前未配置。你可以先自然回答，"
                    "不要编造温度；需要实时天气时请启用 QWeather MCP 服务。"
                ),
            }
        return {
            "type": "llmresult",
            "content": f"Error: builtin tool {name} is not supported.",
        }

    async def _process_input_queue(self):
        """
        Process the input queue for commands and data.
        This method runs in a loop, processing items from the queue.
        """
        while not self.stopped:
            try:
                text = await self.input_queue.get()
                # Reset per-round tool dedup set on each new user input
                # (proactive ticks count as user input here, which is what
                # we want — every tick is its own greeting round).
                self._tools_called_this_round = set()
                new_message = LLMMessageContent(role="user", content=text)
                self.current_task = self.loop.create_task(
                    self._send_to_llm(self.ten_env, new_message)
                )
                await self.current_task
            except asyncio.CancelledError:
                self.ten_env.log_info("LLMExec processing cancelled.")
                text = self.current_text
                self.current_text = None
                if self.on_response and text:
                    await self.on_response(self.ten_env, "", text, True)
            except Exception as e:
                self.ten_env.log_error(
                    f"Error processing input queue: {traceback.format_exc()}"
                )
            finally:
                self.current_task = None

    async def _queue_context(
        self, ten_env: AsyncTenEnv, new_message: LLMMessage
    ) -> None:
        """
        Queue a new message to the LLM context.
        This method appends the new message to the existing context and sends it to the LLM.
        """
        ten_env.log_info(f"_queue_context: {new_message}")
        self.contexts.append(new_message)

    async def _write_context(
        self,
        ten_env: AsyncTenEnv,
        role: Literal["user", "assistant"],
        content: str,
    ) -> None:
        last_context = self.contexts[-1] if self.contexts else None
        if last_context and last_context.role == role:
            # If the last context has the same role, append to its content
            last_context.content = content
        else:
            # Otherwise, create a new context message
            new_message = LLMMessageContent(role=role, content=content)
            await self._queue_context(ten_env, new_message)

    async def _send_to_llm(
        self, ten_env: AsyncTenEnv, new_message: LLMMessage
    ) -> None:
        messages: list[LLMMessage] = [
            LLMMessageContent(role="system", content=_builtin_runtime_context())
        ]
        messages.extend(self.contexts.copy())
        messages.append(new_message)
        request_id = str(uuid.uuid4())
        self.current_request_id = request_id
        llm_input = LLMRequest(
            request_id=request_id,
            messages=messages,
            streaming=True,
            parameters={"temperature": 0.7},
            tools=self.available_tools,
        )
        input_json = llm_input.model_dump()
        response = _send_cmd_ex(ten_env, "chat_completion", "llm", input_json)

        # Queue the new message to the context
        await self._queue_context(ten_env, new_message)

        async for cmd_result, _ in response:
            if cmd_result and cmd_result.is_final() is False:
                if cmd_result.get_status_code() == StatusCode.OK:
                    response_json, _ = cmd_result.get_property_to_json(None)
                    ten_env.log_info(
                        f"_send_to_llm: response_json {response_json}"
                    )
                    completion = parse_llm_response(response_json)
                    await self._handle_llm_response(completion)

    async def _handle_llm_response(self, llm_output: LLMResponse | None):
        self.ten_env.log_info(f"_handle_llm_response: {llm_output}")

        match llm_output:
            case LLMResponseMessageDelta():
                delta = llm_output.delta
                text = llm_output.content
                self.current_text = text
                if delta and self.on_response:
                    await self.on_response(self.ten_env, delta, text, False)
                if text:
                    await self._write_context(self.ten_env, "assistant", text)
            case LLMResponseMessageDone():
                text = llm_output.content
                self.current_text = None
                if self.on_response and text:
                    await self.on_response(self.ten_env, "", text, True)
            case LLMResponseReasoningDelta():
                delta = llm_output.delta
                text = llm_output.content
                if delta and self.on_reasoning_response:
                    await self.on_reasoning_response(
                        self.ten_env, delta, text, False
                    )
            case LLMResponseReasoningDone():
                text = llm_output.content
                if self.on_reasoning_response and text:
                    await self.on_reasoning_response(
                        self.ten_env, "", text, True
                    )
            case LLMResponseToolCall():
                self.ten_env.log_info(
                    f"_handle_llm_response: invoking tool call {llm_output.name}"
                )
                src_extension_name = self.tool_registry.get(llm_output.name)

                # Duplicate-call guard (FIRST — before any UI broadcast so
                # blocked calls don't even create a chip). Claude often
                # re-calls recall / get_lunar_date right after producing the
                # greeting text. We swallow these silently — the user sees
                # only the first reply, the model's internal flailing stays
                # in the logs.
                #
                # Exception: tools in `_tools_no_dedup` (read_file,
                # run_command) — those are user-driven and chaining is the
                # whole point. Don't block.
                if (
                    src_extension_name
                    and llm_output.name in self._tools_called_this_round
                    and llm_output.name not in self._tools_no_dedup
                ):
                    self.ten_env.log_warn(
                        f"duplicate tool call '{llm_output.name}' in same round — "
                        f"silently dropped (no UI chip)"
                    )
                    # Record the call + a placeholder output in context so the
                    # OpenAI tool-use protocol stays consistent, but do NOT
                    # trigger a new completion — that's what causes the
                    # endless "tool, text, tool, text" cascade. The current
                    # LLM stream finishes on its own; the user sees only the
                    # first greeting.
                    context_function_call = LLMMessageFunctionCall(
                        name=llm_output.name,
                        arguments=json.dumps(llm_output.arguments),
                        call_id=llm_output.tool_call_id,
                        id=llm_output.response_id,
                        type="function_call",
                    )
                    await self._queue_context(self.ten_env, context_function_call)
                    await self._queue_context(
                        self.ten_env,
                        LLMMessageFunctionCallOutput(
                            output=(
                                f"(skipped — '{llm_output.name}' already "
                                f"called in this round; previous result applies)"
                            ),
                            call_id=llm_output.tool_call_id,
                            type="function_call_output",
                        ),
                    )
                    return

                if src_extension_name == "__builtin__":
                    should_broadcast_builtin = (
                        llm_output.name not in self._silent_builtin_tool_names
                    )
                    if should_broadcast_builtin:
                        try:
                            await _send_data(
                                self.ten_env,
                                "text_data",
                                "websocket_server",
                                {
                                    "data_type": "mcp_call",
                                    "tool_name": llm_output.name,
                                    "arguments": llm_output.arguments,
                                    "source": src_extension_name,
                                    "ts": int(time.time() * 1000),
                                },
                            )
                        except Exception as exc:  # noqa: BLE001
                            self.ten_env.log_warn(
                                f"failed to broadcast builtin mcp_call event: {exc}"
                            )

                    self._tools_called_this_round.add(llm_output.name)
                    tool_result = self._run_builtin_tool(
                        llm_output.name,
                        llm_output.arguments
                        if isinstance(llm_output.arguments, dict)
                        else {},
                    )
                    result_content = tool_result.get("content", "")
                    result_preview = (
                        result_content[:200]
                        if isinstance(result_content, str)
                        else ""
                    )

                    if should_broadcast_builtin:
                        try:
                            await _send_data(
                                self.ten_env,
                                "text_data",
                                "websocket_server",
                                {
                                    "data_type": "mcp_result",
                                    "tool_name": llm_output.name,
                                    "ok": not result_preview.startswith("Error:"),
                                    "preview": result_preview,
                                    "ts": int(time.time() * 1000),
                                },
                            )
                        except Exception as exc:  # noqa: BLE001
                            self.ten_env.log_warn(
                                f"failed to broadcast builtin mcp_result event: {exc}"
                            )

                    context_function_call = LLMMessageFunctionCall(
                        name=llm_output.name,
                        arguments=json.dumps(llm_output.arguments),
                        call_id=llm_output.tool_call_id,
                        id=llm_output.response_id,
                        type="function_call",
                    )
                    await self._queue_context(self.ten_env, context_function_call)
                    await self._send_to_llm(
                        self.ten_env,
                        LLMMessageFunctionCallOutput(
                            output=str(result_content),
                            call_id=llm_output.tool_call_id,
                            type="function_call_output",
                        ),
                    )
                    return

                # Hallucination guard: the LLM sometimes invents tool names
                # that aren't in the registry (e.g. "run_command"). If we just
                # let _send_cmd fall through with dest=None, the call silently
                # 404s and the LLM's turn dead-ends with no recovery signal.
                # Instead, synthesize a corrective tool result and feed it
                # back so the LLM self-corrects on the next step. We DO show
                # a red chip here — a model hallucinating a tool name is
                # interesting noise worth surfacing for debugging.
                if not src_extension_name:
                    available = sorted(self.tool_registry.keys())
                    err_msg = (
                        f"Error: tool '{llm_output.name}' does not exist. "
                        f"Available tools: {', '.join(available) or '(none)'}. "
                        f"Pick one of those and try again — do NOT invent tool names."
                    )
                    self.ten_env.log_warn(
                        f"unknown tool '{llm_output.name}' — feeding error back to LLM"
                    )
                    try:
                        await _send_data(
                            self.ten_env,
                            "text_data",
                            "websocket_server",
                            {
                                "data_type": "mcp_call",
                                "tool_name": llm_output.name,
                                "arguments": llm_output.arguments,
                                "source": "",
                                "ts": int(time.time() * 1000),
                            },
                        )
                        await _send_data(
                            self.ten_env,
                            "text_data",
                            "websocket_server",
                            {
                                "data_type": "mcp_result",
                                "tool_name": llm_output.name,
                                "ok": False,
                                "preview": "未注册的工具,已提示模型纠正",
                                "ts": int(time.time() * 1000),
                            },
                        )
                    except Exception as exc:  # noqa: BLE001
                        self.ten_env.log_warn(
                            f"failed to broadcast mcp_result(unknown) event: {exc}"
                        )

                    context_function_call = LLMMessageFunctionCall(
                        name=llm_output.name,
                        arguments=json.dumps(llm_output.arguments),
                        call_id=llm_output.tool_call_id,
                        id=llm_output.response_id,
                        type="function_call",
                    )
                    await self._queue_context(self.ten_env, context_function_call)
                    await self._send_to_llm(
                        self.ten_env,
                        LLMMessageFunctionCallOutput(
                            output=err_msg,
                            call_id=llm_output.tool_call_id,
                            type="function_call_output",
                        ),
                    )
                    return  # done with this tool-call event

                # Legitimate call — broadcast mcp_call now so the frontend
                # shows a "calling…" chip while we dispatch.
                try:
                    await _send_data(
                        self.ten_env,
                        "text_data",
                        "websocket_server",
                        {
                            "data_type": "mcp_call",
                            "tool_name": llm_output.name,
                            "arguments": llm_output.arguments,
                            "source": src_extension_name,
                            "ts": int(time.time() * 1000),
                        },
                    )
                except Exception as exc:  # noqa: BLE001
                    self.ten_env.log_warn(
                        f"failed to broadcast mcp_call event: {exc}"
                    )

                # Mark this tool as used in the current round (before the
                # actual dispatch so even a slow/failed call still blocks
                # immediate duplicates).
                self._tools_called_this_round.add(llm_output.name)

                result, _ = await _send_cmd(
                    self.ten_env,
                    "tool_call",
                    src_extension_name,
                    {
                        "name": llm_output.name,
                        "arguments": llm_output.arguments,
                    },
                )

                if result.get_status_code() == StatusCode.OK:
                    r, _ = result.get_property_to_json(CMD_PROPERTY_RESULT)
                    tool_result: LLMToolResult = json.loads(r)

                    self.ten_env.log_info(f"tool_result: {tool_result}")

                    # Broadcast tool result (truncated) to the frontend.
                    try:
                        result_preview = ""
                        rc = tool_result.get("content") if isinstance(tool_result, dict) else None
                        if isinstance(rc, str):
                            result_preview = rc[:200]
                        await _send_data(
                            self.ten_env,
                            "text_data",
                            "websocket_server",
                            {
                                "data_type": "mcp_result",
                                "tool_name": llm_output.name,
                                "ok": True,
                                "preview": result_preview,
                                "ts": int(time.time() * 1000),
                            },
                        )
                    except Exception as exc:  # noqa: BLE001
                        self.ten_env.log_warn(
                            f"failed to broadcast mcp_result event: {exc}"
                        )

                    context_function_call = LLMMessageFunctionCall(
                        name=llm_output.name,
                        arguments=json.dumps(llm_output.arguments),
                        call_id=llm_output.tool_call_id,
                        id=llm_output.response_id,
                        type="function_call",
                    )
                    if tool_result["type"] == "llmresult":
                        result_content = tool_result["content"]
                        if isinstance(result_content, str):
                            await self._queue_context(
                                self.ten_env, context_function_call
                            )
                            await self._send_to_llm(
                                self.ten_env,
                                LLMMessageFunctionCallOutput(
                                    output=result_content,
                                    call_id=llm_output.tool_call_id,
                                    type="function_call_output",
                                ),
                            )
                        else:
                            self.ten_env.log_error(
                                f"Unknown tool result content: {result_content}"
                            )
                    elif tool_result["type"] == "requery":
                        pass
                        # self.memory_cache = []
                        # self.memory_cache.pop()
                        # result_content = tool_result["content"]
                        # nonlocal message
                        # new_message = {
                        #     "role": "user",
                        #     "content": self._convert_to_content_parts(
                        #         message["content"]
                        #     ),
                        # }
                        # new_message["content"] = new_message[
                        #     "content"
                        # ] + self._convert_to_content_parts(
                        #     result_content
                        # )
                        # await self.queue_input_item(
                        #     True, messages=[new_message], no_tool=True
                        # )
                else:
                    self.ten_env.log_error("Tool call failed")
                    try:
                        await _send_data(
                            self.ten_env,
                            "text_data",
                            "websocket_server",
                            {
                                "data_type": "mcp_result",
                                "tool_name": llm_output.name,
                                "ok": False,
                                "preview": "tool call failed",
                                "ts": int(time.time() * 1000),
                            },
                        )
                    except Exception as exc:  # noqa: BLE001
                        self.ten_env.log_warn(
                            f"failed to broadcast mcp_result(error) event: {exc}"
                        )

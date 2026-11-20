import asyncio
import json
import time
from typing import Literal

from .agent.decorators import agent_event_handler
from ten_runtime import (
    AsyncExtension,
    AsyncTenEnv,
    Cmd,
    Data,
)

from .agent.agent import Agent
from .agent.events import (
    ASRResultEvent,
    LLMResponseEvent,
    ToolRegisterEvent,
    UserJoinedEvent,
    UserLeftEvent,
)
from .helper import _send_cmd, _send_data, parse_sentences
from .config import MainControlConfig  # assume extracted from your base model
from .turn_detector import TurnDetector

import uuid


class MainControlExtension(AsyncExtension):
    """
    The entry point of the agent module.
    Consumes semantic AgentEvents from the Agent class and drives the runtime behavior.
    """

    # Silence watchdog: after this many seconds without real user input,
    # we synthesize a __PROACTIVE_TICK__:silence_60s event so 小灵 follows up
    # ("还在吗?" / 闲扯一句). Lower for demo feel, raise for production.
    _SILENCE_TIMEOUT_SECONDS = 45.0
    _PROACTIVE_TICK_PREFIX = "__PROACTIVE_TICK__"
    # While a typed message's reply is being produced, audio ASR is
    # suppressed so mic noise / TTS echo can't interrupt the text turn.
    # Hard cap in case the LLM stream never emits its final chunk.
    _TEXT_REPLY_MAX_SECONDS = 45.0

    def __init__(self, name: str):
        super().__init__(name)
        self.ten_env: AsyncTenEnv = None
        self.agent: Agent = None
        self.config: MainControlConfig = None

        self.stopped: bool = False
        self._rtc_user_count: int = 0
        self.sentence_fragment: str = ""
        self.turn_id: int = 0
        self.session_id: str = "0"

        # Silence-watchdog state (lazy started — see _on_asr_result).
        self._silence_task: asyncio.Task = None
        # Text-reply protection window (see _on_asr_result / _send_to_tts).
        self._text_reply_active: bool = False
        self._text_reply_deadline: float = 0.0
        # Optional speaker lock. This becomes effective once the ASR/voiceprint
        # worker supplies metadata.speaker or metadata.speaker_id.
        self._voice_lock_speaker: str | None = None
        # Optional TEN Turn Detection adapter. It delays LLM input when the
        # user's final ASR segment still sounds unfinished.
        self._turn_detector: TurnDetector | None = None
        self._turn_history: list[dict[str, str]] = []
        self._pending_turns: dict[str, dict] = {}
        self._pending_turn_tasks: dict[str, asyncio.Task] = {}

    def _current_metadata(self) -> dict:
        return {"session_id": self.session_id, "turn_id": self.turn_id}

    def _speaker_from_metadata(self, metadata: dict) -> str | None:
        speaker = (
            metadata.get("speaker_label")
            or metadata.get("speaker_name")
            or metadata.get("speaker_id")
            or metadata.get("speaker")
        )
        if speaker is None:
            return None
        value = str(speaker).strip()
        return value or None

    def _voice_lock_allows(self, metadata: dict) -> bool:
        mode = metadata.get("voice_lock_mode", "off")
        if mode not in ("auto_learning", "manual"):
            self._voice_lock_speaker = None
            return True
        speaker = self._speaker_from_metadata(metadata)
        if not speaker:
            # No diarization/voiceprint metadata yet; do not break normal chat.
            return True
        if not self._voice_lock_speaker:
            self._voice_lock_speaker = speaker
            self.ten_env.log_info(
                f"[MainControl] voice lock enrolled speaker={speaker}"
            )
            return True
        allowed = speaker == self._voice_lock_speaker
        if not allowed:
            self.ten_env.log_info(
                "[MainControl] voice lock rejected speaker="
                f"{speaker}, locked={self._voice_lock_speaker}"
            )
        return allowed

    def _text_with_speaker_prefix(self, text: str, metadata: dict) -> str:
        speaker = self._speaker_from_metadata(metadata)
        if not speaker:
            return text
        prefix = f"[{speaker}]"
        if text.strip().startswith(prefix):
            return text
        return f"{prefix} {text}"

    async def on_init(self, ten_env: AsyncTenEnv):
        self.ten_env = ten_env

        # Load config from runtime properties
        config_json, _ = await ten_env.get_property_to_json(None)
        self.config = MainControlConfig.model_validate_json(config_json)
        self._turn_detector = TurnDetector(
            endpoint=self.config.turn_detection_endpoint,
            timeout_ms=self.config.turn_detection_timeout_ms,
            fallback_rules=self.config.turn_detection_fallback_rules,
        )

        self.agent = Agent(ten_env)

        # Now auto-register decorated methods
        for attr_name in dir(self):
            fn = getattr(self, attr_name)
            event_type = getattr(fn, "_agent_event_type", None)
            if event_type:
                self.agent.on(event_type, fn)

    # === Register handlers with decorators ===
    @agent_event_handler(UserJoinedEvent)
    async def _on_user_joined(self, event: UserJoinedEvent):
        self._rtc_user_count += 1
        if self._rtc_user_count == 1 and self.config and self.config.greeting:
            await self._send_to_tts(self.config.greeting, True)
            await self._send_transcript(
                "assistant", self.config.greeting, True, 100
            )

    @agent_event_handler(UserLeftEvent)
    async def _on_user_left(self, event: UserLeftEvent):
        self._rtc_user_count -= 1

    @agent_event_handler(ToolRegisterEvent)
    async def _on_tool_register(self, event: ToolRegisterEvent):
        await self.agent.register_llm_tool(event.tool, event.source)

    @agent_event_handler(ASRResultEvent)
    async def _on_asr_result(self, event: ASRResultEvent):
        self.session_id = event.metadata.get("session_id", "100")
        stream_id = int(self.session_id)
        if not event.text:
            return
        if not self._voice_lock_allows(event.metadata):
            return

        is_text_input = event.metadata.get("source") == "text_input"
        now = time.time()
        # Coexist with voice: while a typed message's reply is still
        # streaming, drop incoming AUDIO ASR (mic noise / TTS echo while
        # the user types) so it cannot interrupt or hijack the text turn.
        # Typed input is never suppressed.
        if (
            not is_text_input
            and self._text_reply_active
            and now < self._text_reply_deadline
        ):
            self.ten_env.log_info(
                "[MainControl] suppressing audio ASR during active "
                "text-reply window"
            )
            return

        if event.final or len(event.text) > 2:
            await self._interrupt()

        if event.final:
            if is_text_input:
                self._discard_pending_turn(self.session_id)
                candidate_text = event.text
            else:
                candidate_text = self._merge_pending_turn_text(
                    self.session_id, event.text
                )
            should_queue = True
            if self._should_run_turn_detection(candidate_text, event.metadata):
                decision = await self._detect_turn(candidate_text, event.metadata)
                self.ten_env.log_info(
                    "[MainControl] turn detection decision="
                    f"{decision.decision}, source={decision.source}, "
                    f"confidence={decision.confidence}, text={candidate_text}"
                )
                if decision.decision in ("unfinished", "wait"):
                    should_queue = False
                    self._set_pending_turn(
                        self.session_id, candidate_text, event.metadata
                    )
                    self._schedule_pending_turn_flush(self.session_id)

            if should_queue:
                self._discard_pending_turn(self.session_id)
                await self._queue_final_user_turn(
                    candidate_text, event.metadata, is_text_input, now
                )

        await self._send_transcript(
            "user",
            event.text,
            event.final,
            stream_id,
            metadata=event.metadata,
        )

    def _should_run_turn_detection(self, text: str, metadata: dict) -> bool:
        if not self.config or not self.config.turn_detection_enabled:
            return False
        if metadata.get("source") == "text_input":
            return False
        if text.startswith(self._PROACTIVE_TICK_PREFIX):
            return False
        return bool(text.strip())

    async def _detect_turn(self, text: str, metadata: dict):
        language = metadata.get("language") or metadata.get("lang")
        return await self._turn_detector.detect(
            text=text,
            history=self._turn_history,
            language=language,
        )

    def _merge_pending_turn_text(self, session_id: str, text: str) -> str:
        pending = self._pending_turns.pop(session_id, None)
        if not pending:
            return text
        self._cancel_pending_turn(session_id)
        previous = str(pending.get("text") or "").strip()
        current = text.strip()
        if not previous:
            return current
        if not current:
            return previous
        return f"{previous} {current}"

    def _set_pending_turn(self, session_id: str, text: str, metadata: dict):
        self._pending_turns[session_id] = {
            "text": text,
            "metadata": dict(metadata or {}),
            "created_at": time.time(),
        }

    def _cancel_pending_turn(self, session_id: str):
        task = self._pending_turn_tasks.pop(session_id, None)
        if task and not task.done():
            task.cancel()

    def _discard_pending_turn(self, session_id: str):
        self._cancel_pending_turn(session_id)
        self._pending_turns.pop(session_id, None)

    def _schedule_pending_turn_flush(self, session_id: str):
        self._cancel_pending_turn(session_id)
        delay = max(0.5, self.config.turn_detection_max_wait_ms / 1000)
        self._pending_turn_tasks[session_id] = asyncio.create_task(
            self._flush_pending_turn_after_delay(session_id, delay)
        )

    async def _flush_pending_turn_after_delay(self, session_id: str, delay: float):
        try:
            await asyncio.sleep(delay)
            pending = self._pending_turns.pop(session_id, None)
            if not pending or self.stopped:
                return
            self.ten_env.log_info(
                "[MainControl] turn detection max wait reached; "
                f"forcing final turn for session={session_id}"
            )
            await self._queue_final_user_turn(
                str(pending.get("text") or ""),
                dict(pending.get("metadata") or {}),
                False,
                time.time(),
            )
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.ten_env.log_error(
                f"[MainControl] pending turn flush error: {e}"
            )

    async def _queue_final_user_turn(
        self,
        text: str,
        metadata: dict,
        is_text_input: bool,
        now: float,
    ):
        self.turn_id += 1
        self._turn_history.append({"role": "user", "content": text})
        self._turn_history = self._turn_history[-12:]
        await self.agent.queue_llm_input(
            self._text_with_speaker_prefix(text, metadata)
        )
        if is_text_input:
            self._text_reply_active = True
            self._text_reply_deadline = now + self._TEXT_REPLY_MAX_SECONDS

        is_tick = text.startswith(self._PROACTIVE_TICK_PREFIX)
        if is_tick:
            if not self._silence_task or self._silence_task.done():
                self._reschedule_silence_watchdog()
        else:
            self._reschedule_silence_watchdog()

    def _reschedule_silence_watchdog(self):
        """Cancel any existing watchdog and start a fresh one."""
        if self._silence_task and not self._silence_task.done():
            self._silence_task.cancel()
        self._silence_task = asyncio.create_task(self._silence_watchdog_loop())

    async def _silence_watchdog_loop(self):
        """Wait the silence timeout, then synthesize a silence_60s tick.
        Cancellation is the normal "user did something" signal."""
        try:
            await asyncio.sleep(self._SILENCE_TIMEOUT_SECONDS)
            if self.stopped:
                return
            self.ten_env.log_info(
                f"[MainControl] Silence watchdog fired after "
                f"{self._SILENCE_TIMEOUT_SECONDS}s — injecting silence_60s tick"
            )
            self.turn_id += 1
            await self.agent.queue_llm_input(
                f"{self._PROACTIVE_TICK_PREFIX}:silence_60s"
            )
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.ten_env.log_error(
                f"[MainControl] silence watchdog error: {e}"
            )

    @agent_event_handler(LLMResponseEvent)
    async def _on_llm_response(self, event: LLMResponseEvent):
        if not event.is_final and event.type == "message":
            sentences, self.sentence_fragment = parse_sentences(
                self.sentence_fragment, event.delta
            )
            for s in sentences:
                await self._send_to_tts(s, False)

        if event.is_final and event.type == "message":
            remaining_text = self.sentence_fragment or ""
            self.sentence_fragment = ""
            await self._send_to_tts(remaining_text, True)
            if event.text:
                self._turn_history.append(
                    {"role": "assistant", "content": event.text}
                )
                self._turn_history = self._turn_history[-12:]

        await self._send_transcript(
            "assistant",
            event.text,
            event.is_final,
            100,
            data_type=("reasoning" if event.type == "reasoning" else "text"),
        )

    async def on_start(self, ten_env: AsyncTenEnv):
        ten_env.log_info("[MainControlExtension] on_start")

    async def on_stop(self, ten_env: AsyncTenEnv):
        ten_env.log_info("[MainControlExtension] on_stop")
        self.stopped = True
        # Stop silence watchdog before agent.stop() so it doesn't try to
        # queue input into a tearing-down agent.
        if self._silence_task and not self._silence_task.done():
            self._silence_task.cancel()
        for task in list(self._pending_turn_tasks.values()):
            if task and not task.done():
                task.cancel()
        self._pending_turn_tasks.clear()
        self._pending_turns.clear()
        if self.agent:
            await self.agent.stop()
        else:
            ten_env.log_warn(
                "[MainControlExtension] on_stop skipped: agent was not initialized"
            )

    async def on_cmd(self, ten_env: AsyncTenEnv, cmd: Cmd):
        if not self.agent:
            ten_env.log_warn(
                "[MainControlExtension] on_cmd ignored: agent was not initialized"
            )
            return
        await self.agent.on_cmd(cmd)

    async def on_data(self, ten_env: AsyncTenEnv, data: Data):
        if not self.agent:
            ten_env.log_warn(
                "[MainControlExtension] on_data ignored: agent was not initialized"
            )
            return
        await self.agent.on_data(data)

    # === helpers ===
    async def _send_transcript(
        self,
        role: str,
        text: str,
        final: bool,
        stream_id: int,
        data_type: Literal["text", "reasoning"] = "text",
        metadata: dict | None = None,
    ):
        """
        Sends the transcript (ASR or LLM output) to the message collector.
        """
        transcript_metadata = dict(metadata or self._current_metadata())
        speaker = (
            transcript_metadata.get("speaker_label")
            or transcript_metadata.get("speaker_name")
            or transcript_metadata.get("speaker_id")
            or transcript_metadata.get("speaker")
        )
        if data_type == "text":
            payload = {
                "data_type": "transcribe",
                "role": role,
                "text": text,
                "text_ts": int(time.time() * 1000),
                "is_final": final,
                "stream_id": stream_id,
                "metadata": transcript_metadata,
            }
            if speaker:
                payload["speaker"] = speaker
            await _send_data(
                self.ten_env,
                "text_data",
                "websocket_server",
                payload,
            )
        elif data_type == "reasoning":
            await _send_data(
                self.ten_env,
                "text_data",
                "websocket_server",
                {
                    "data_type": "raw",
                    "role": role,
                    "text": json.dumps(
                        {
                            "type": "reasoning",
                            "data": {
                                "text": text,
                            },
                        }
                    ),
                    "text_ts": int(time.time() * 1000),
                    "is_final": final,
                    "stream_id": stream_id,
                },
            )
        self.ten_env.log_info(
            f"[MainControlExtension] Sent transcript: {role}, final={final}, text={text}"
        )

    async def _send_to_tts(self, text: str, is_final: bool):
        """
        Sends a sentence to the TTS system.
        """
        request_id = f"tts-request-{self.turn_id}"
        await _send_data(
            self.ten_env,
            "tts_text_input",
            "tts",
            {
                "request_id": request_id,
                "text": text,
                "text_input_end": is_final,
                "metadata": self._current_metadata(),
            },
        )
        self.ten_env.log_info(
            f"[MainControlExtension] Sent to TTS: is_final={is_final}, text={text}"
        )
        # The text-reply protection window ends once the reply has fully
        # streamed to TTS — after this, normal voice barge-in resumes.
        if is_final and self._text_reply_active:
            self._text_reply_active = False
            self.ten_env.log_info(
                "[MainControl] text-reply window cleared (TTS final)"
            )

    async def _interrupt(self):
        """
        Interrupts ongoing LLM and TTS generation. Typically called when user speech is detected.
        """
        self.sentence_fragment = ""
        await self.agent.flush_llm()
        await _send_data(
            self.ten_env, "tts_flush", "tts", {"flush_id": str(uuid.uuid4())}
        )
        await _send_cmd(self.ten_env, "flush", "agora_rtc")
        self.ten_env.log_info("[MainControlExtension] Interrupt signal sent")

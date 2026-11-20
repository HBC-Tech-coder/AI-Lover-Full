import json
import time
from typing import Any

from ten_ai_base.llm_tool import AsyncLLMToolBaseExtension
from ten_ai_base.types import (
    LLMToolMetadata,
    LLMToolMetadataParameter,
    LLMToolResult,
    LLMToolResultLLMResult,
)
from ten_runtime import AsyncTenEnv, Data, Loc


TOOL_NAME = "client_control"
TOOL_DESCRIPTION = (
    "Control the local client, robot head, robot hand/arm, or UI settings. "
    "Use this tool only when the user explicitly asks for a physical action "
    "or setting change, such as smile, blink, make a funny face, speak louder, "
    "speak quieter, use English, open the hand, make a fist, switch microphone, "
    "open camera, or switch renderer. Do not put hidden JSON commands in the "
    "spoken reply; call this tool instead. For louder/quieter requests, call "
    "target=head action=set_volume with args_json {\"direction\":\"up\"} or "
    "{\"direction\":\"down\"}; the client will say OK at the old volume, change "
    "volume, then ask whether the new volume is suitable."
)


class ClientControlToolExtension(AsyncLLMToolBaseExtension):
    def __init__(self, name: str = "client_control_tool_python"):
        super().__init__(name)

    def get_tool_metadata(self, ten_env: AsyncTenEnv) -> list[LLMToolMetadata]:
        return [
            LLMToolMetadata(
                name=TOOL_NAME,
                description=TOOL_DESCRIPTION,
                parameters=[
                    LLMToolMetadataParameter(
                        name="target",
                        type="string",
                        required=True,
                        description=(
                            "One of: head, hand, settings. Use head for robot "
                            "face/head actions and speaker volume; hand for "
                            "robot hand/arm gestures; settings for language, "
                            "mic, speaker, camera, renderer, and UI preferences."
                        ),
                    ),
                    LLMToolMetadataParameter(
                        name="action",
                        type="string",
                        required=True,
                        description=(
                            "Action name. Head examples: smile, sad, makeface, "
                            "kiss, blink, blink_left, blink_right, eyes_rotate, "
                            "turn_neck, init, set_volume. Hand examples: open, "
                            "relax, fist, full_fist, point, two, three, four, "
                            "thumb, pinch, pattern. Settings examples: "
                            "set_reply_language, set_language, set_camera, "
                            "set_computer_mic, set_head_mic, set_head_speaker, "
                            "set_head_motion, set_renderer, set_voice_volume."
                        ),
                    ),
                    LLMToolMetadataParameter(
                        name="args_json",
                        type="string",
                        required=False,
                        description=(
                            "Optional JSON object string for action arguments. "
                            "Examples: {\"direction\":\"up\"}, "
                            "{\"direction\":\"down\"}, {\"value\":24}, "
                            "{\"language\":\"en\"}, {\"enabled\":true}, "
                            "{\"pattern\":\"111111\"}."
                        ),
                    ),
                    LLMToolMetadataParameter(
                        name="reason",
                        type="string",
                        required=False,
                        description=(
                            "Short reason in natural language. This is only "
                            "for logs/debugging."
                        ),
                    ),
                ],
            )
        ]

    async def run_tool(
        self, ten_env: AsyncTenEnv, name: str, args: dict
    ) -> LLMToolResult | None:
        if name != TOOL_NAME:
            return LLMToolResultLLMResult(
                type="llmresult",
                content=f"Error: unsupported tool {name}",
            )

        command = self._build_command(args)
        if not command:
            return LLMToolResultLLMResult(
                type="llmresult",
                content="Error: missing target or action for client_control",
            )

        payload = {
            "data_type": "client_control",
            "command": command,
            "ts": int(time.time() * 1000),
        }
        data = Data.create("text_data")
        data.set_dests([Loc("", "", "websocket_server")])
        data.set_property_from_json(None, json.dumps(payload, ensure_ascii=False))

        err = await ten_env.send_data(data)
        if err:
            ten_env.log_error(f"[ClientControlTool] send_data failed: {err}")
            return LLMToolResultLLMResult(
                type="llmresult",
                content=f"Error: failed to send client command: {err}",
            )

        target = command.get("target")
        action = command.get("action")
        ten_env.log_info(
            "[ClientControlTool] dispatched "
            f"{target}.{action} {json.dumps(command.get('args', {}), ensure_ascii=False)}"
        )
        return LLMToolResultLLMResult(
            type="llmresult",
            content=f"OK: {target}.{action} command sent to the client.",
        )

    def _build_command(self, raw_args: dict[str, Any]) -> dict[str, Any] | None:
        target = str(raw_args.get("target") or "").strip().lower()
        action = str(raw_args.get("action") or "").strip().lower()
        if not target or not action:
            return None

        command_args: dict[str, Any] = {}
        args_obj = raw_args.get("args")
        if isinstance(args_obj, dict):
            command_args.update(args_obj)

        args_json = raw_args.get("args_json")
        if isinstance(args_json, str) and args_json.strip():
            try:
                decoded = json.loads(args_json)
                if isinstance(decoded, dict):
                    command_args.update(decoded)
            except json.JSONDecodeError:
                command_args["raw"] = args_json

        passthrough_keys = (
            "value",
            "delta",
            "pattern",
            "language",
            "enabled",
            "renderer",
            "volume",
        )
        for key in passthrough_keys:
            if key in raw_args and key not in command_args:
                command_args[key] = raw_args[key]

        return {
            "target": target,
            "action": action,
            "args": command_args,
            "source": "assistant_tool",
            "reason": raw_args.get("reason") or "",
        }

# Client Command Bus

The browser has a single command bus for local hardware and UI settings. It is
separate from normal assistant text so TTS will not read hidden JSON aloud.

## Layer 1: Lightweight Rules

The browser watches final user and assistant text and silently maps common
phrases into commands. Rule-triggered commands do not show tool chips.

Supported examples:

- Small/loud volume requests, such as `\u5c0f\u58f0\u70b9` and
  `\u5927\u58f0\u70b9`, adjust head speaker volume.
- Smile/funny-face requests, such as `\u5fae\u7b11` and
  `\u505a\u4e2a\u9b3c\u8138`, trigger `head.smile` or `head.makeface`.
- Blink requests, such as `\u7728\u773c`, trigger `head.blink`.
- Hand requests, such as `\u5f20\u5f00\u624b`, `\u63e1\u62f3`, and
  `\u526a\u5200\u624b`, trigger hand actions.
- Mic/camera requests switch settings.
- Language requests, such as `\u8ddf\u6211\u8bf4\u82f1\u8bed`, set the
  preferred reply language for the next agent start.

## Layer 2: Formal Tool/Command Bus

TEN now includes `client_control_tool_python`, which registers the LLM tool
`client_control`. When the model calls the tool, the extension sends:

```json
{
  "type": "data",
  "name": "text_data",
  "data": {
    "data_type": "client_control",
    "command": {
      "target": "head",
      "action": "smile",
      "args": {},
      "source": "assistant_tool",
      "reason": "user asked the robot to smile"
    },
    "ts": 1780000000000
  }
}
```

The frontend also accepts direct WebSocket commands:

```json
{
  "type": "cmd",
  "name": "client_control",
  "data": {
    "target": "head",
    "action": "smile",
    "args": {},
    "requestId": "optional-id"
  }
}
```

Batch form:

```json
{
  "commands": [
    { "target": "head", "action": "makeface" },
    {
      "target": "settings",
      "action": "set_head_volume",
      "args": { "volume": 0.6 }
    }
  ]
}
```

Accepted command names:

- `client_control`
- `agent_command`
- `xiaoling_command`

## Targets

### `head`

Actions:

- `init`
- `smile`
- `sad`
- `kiss`
- `makeface`
- `blink`
- `blink_left`
- `blink_right`
- `eyes_rotate`
- `turn_neck`
- `set_volume`

Examples:

```json
{ "target": "head", "action": "set_volume", "args": { "volume": 0.75 } }
{ "target": "head", "action": "set_volume", "args": { "delta": -0.18 } }
```

### `hand`

Actions:

- `open`
- `relax`
- `fist`
- `full_fist`
- `point`
- `two`
- `three`
- `four`
- `thumb`
- `pinch`
- `pattern`

Example:

```json
{ "target": "hand", "action": "pattern", "args": { "pattern": "011111" } }
```

### `settings`

Actions:

- `set_language` with `zh`, `en`, or `ja`
- `set_reply_language` with `auto`, `zh`, `en`, `ja`, `ko`, `fr`, `de`, `es`
- `set_voice_volume`
- `set_head_volume`
- `set_head_speaker`
- `set_head_motion`
- `set_head_mic`
- `set_computer_mic`
- `set_camera`
- `set_renderer` with `live2d` or `gpu`

Examples:

```json
{
  "target": "settings",
  "action": "set_reply_language",
  "args": { "language": "en" }
}
{
  "target": "settings",
  "action": "set_head_speaker",
  "args": { "enabled": true }
}
```

## LLM Tool Examples

For user text like `\u4f60\u53ef\u4ee5\u5fae\u7b11\u5417`, the model should call:

```json
{
  "target": "head",
  "action": "smile",
  "args_json": "{}",
  "reason": "user asked for a smile"
}
```

For `\u5927\u58f0\u70b9`, call:

```json
{
  "target": "head",
  "action": "set_volume",
  "args_json": "{\"delta\":0.18}",
  "reason": "user asked for louder voice"
}
```

For `\u8ddf\u6211\u8bf4\u82f1\u8bed`, call:

```json
{
  "target": "settings",
  "action": "set_reply_language",
  "args_json": "{\"language\":\"en\"}",
  "reason": "user asked to speak English"
}
```

The model should still answer naturally after tool execution, but the action
itself should be sent through `client_control`, not embedded in spoken text.

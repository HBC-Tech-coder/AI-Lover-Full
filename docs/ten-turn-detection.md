# TEN Turn Detection 集成说明

AI-Lover 的 TEN 主控扩展已接入对话轮次判断，位置：

- `tenapp/ten_packages/extension/main_python/turn_detector.py`
- `tenapp/ten_packages/extension/main_python/extension.py`
- `tenapp/property.json` 中的 `main_control.property`

## 工作方式

1. ASR 返回 `final=true` 后，主控不会立即把文本送给 LLM。
2. 主控先调用 Turn Detection 判断用户是否已经说完。
3. 如果结果是 `finished`，立即送给 LLM。
4. 如果结果是 `unfinished` 或 `wait`，先缓冲文本，等待用户继续说。
5. 如果用户没有继续说，超过 `turn_detection_max_wait_ms` 后自动送出，避免一直等待。

## 官方 TEN Turn Detection Worker

官方模型输出三类标签：

- `finished`
- `unfinished`
- `wait`

如已部署官方 worker，请在运行环境中设置：

```env
TEN_TURN_DETECTION_URL=http://127.0.0.1:8789/detect
```

HTTP 请求体：

```json
{
  "text": "用户当前这一轮说的话",
  "history": [
    { "role": "user", "content": "上一轮用户话" },
    { "role": "assistant", "content": "上一轮助手话" }
  ],
  "language": "auto"
}
```

兼容的返回字段包括 `decision`、`label`、`prediction`、`turn_status`、`status`、`result`。

返回示例：

```json
{ "decision": "unfinished", "confidence": 0.91 }
```

## 默认 fallback

如果未配置 `TEN_TURN_DETECTION_URL`，系统会启用保守规则：

- “然后、因为、但是、如果、比如、还有、首先”等结尾会先等待。
- “嗯、呃、那个、等一下”等短语会进入 `wait`。
- 逗号、顿号、分号结尾会先等待。

这不是官方模型，只是为了在没有 GPU worker 时不破坏对话体验。

## 配置项

```json
{
  "turn_detection_enabled": true,
  "turn_detection_endpoint": "${env:TEN_TURN_DETECTION_URL|}",
  "turn_detection_timeout_ms": 800,
  "turn_detection_max_wait_ms": 1800,
  "turn_detection_fallback_rules": true
}
```

生产建议：

- 本地/客户电脑默认保留 fallback。
- 服务器 2.0 可单独部署官方 worker，再通过 `TEN_TURN_DETECTION_URL` 接入。
- 如果用户觉得等待太久，把 `turn_detection_max_wait_ms` 调到 `1200`。

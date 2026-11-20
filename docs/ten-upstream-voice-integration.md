# TEN upstream voice integration notes

Last checked: 2026-07-02

## Current local status

- The local app is a TEN-based voice assistant graph, but it is customized for browser WebSocket plus local hardware bridges.
- Local graph uses `websocket_server -> aliyun_asr_bigmodel_python -> openai_llm2_python -> minimax_tts_websocket_python`.
- Local graph does not currently include official `agora_rtc`, `message_collector2`, `streamid_adapter`, or TEN VAD.
- Local graph now includes an optional `voice_assistant_diarization` graph using TEN's Speechmatics ASR extension for speaker diarization.
- The frontend now has subtitle settings and voice-lock settings, and audio frames carry `user_id` plus `voice_lock_mode` metadata.
- `main_python` now forwards ASR metadata such as `speaker`, `speaker_id`, and `speaker_label` to the frontend transcript payload, and prefixes LLM input with `[S1]` / `[S2]` when speaker labels are present.
- The frontend can turn the robot head toward the active speaker. If ASR metadata contains `speaker_angle`/`azimuth`, that physical angle is used. Without a microphone array, the frontend falls back to stable demo seats for `S1`, `S2`, `S3`, etc.

## Official TEN voice-assistant comparison

Official example:
https://github.com/TEN-framework/ten-framework/tree/main/ai_agents/agents/examples/voice-assistant

What it has:

- Agora RTC audio/data transport.
- Deepgram/XAI ASR options.
- OpenAI-compatible LLM.
- ElevenLabs/XAI/Deepgram/Oracle TTS options.
- `message_collector2` and `streamid_adapter` in the graph for RTC transcript/data flow.

What we keep different:

- We use browser WebSocket so the app can run locally, control robot head/hand bridges, and be packaged for customers without Agora setup.
- We should not overwrite our graph with the official graph. Instead, selectively borrow `message_collector2` transcript semantics and optional ASR providers.

## TEN VAD

Official repo:
https://github.com/TEN-framework/ten-vad

TEN VAD is useful for:

- Low-latency speech/silence detection.
- Better turn boundaries before ASR/LLM.
- Local CPU-friendly segmentation on Windows/Web/Linux/macOS.

TEN VAD is not enough for:

- Identifying a person.
- Voiceprint enrollment.
- Voice-lock filtering by itself.

Recommended integration:

1. Add a small local VAD worker before ASR input to mark speech start/end.
2. Use VAD segments as input windows for a speaker embedding worker.
3. Forward segment metadata to TEN as `metadata.vad = { speech, start_ms, end_ms }`.

## Speaker diarization

Official example:
https://github.com/TEN-framework/ten-framework/tree/main/ai_agents/agents/examples/speaker-diarization

What it does:

- Uses Speechmatics ASR diarization.
- Returns speaker labels like `S1`, `S2`.
- Passes speaker labels into transcript UI and LLM context.

Important limitation:

- This is diarization, not a private local voiceprint lock. It labels different speakers, but does not prove an enrolled identity unless we add enrollment/matching logic.

Recommended two-path plan:

1. Fast provider path: use the optional `voice_assistant_diarization` graph for demos where cloud diarization is acceptable.
2. Private product path: TEN VAD + local speaker embedding + enrolled profiles, then reject/ignore non-matching speakers when voice-lock mode is enabled.

Current implementation:

- Add `SPEECHMATICS_API_KEY` and optional `SPEECHMATICS_LANGUAGE=cmn` in `secrets.env`.
- In Settings, enable `TEN 说话人分离`.
- Restart the conversation. The frontend will start `voice_assistant_diarization` instead of the default `voice_assistant` graph.
- Speaker labels are shown in chat as `[S1]`, `[S2]`; the LLM receives the same speaker prefix for context separation.
- Robot head focus can be enabled separately. Eyes look first, the neck follows, then eyes return to straight ahead.

Direction limitation:

- TEN diarization tells us "who is speaking" in the audio stream, not where that person is standing.
- For real left/right positioning, add a microphone array or a camera-side speaker tracker that writes `metadata.speaker_angle` in degrees. Until then, fallback seat mapping is only a demo approximation.

## Shengwang Conversational AI Demo

Official repo:
https://github.com/Shengwang-Community/Conversational-AI-Demo/tree/main/Web/Scenes/VoiceAgent

Features to borrow:

- Subtitle rendering modes: word-level, text-sync, chunk/text fallback.
- Voice lock UI modes: off, auto-learning, manual.
- A clearer settings panel for user identity, avatar, subtitle mode, and voice locking.

Local implementation status:

- Added subtitle display toggle and three render modes:
  - `word`: UI-side progressive reveal now; backend word timings later.
  - `text_sync`: current partial/final text follows ASR/assistant text.
  - `text_once`: only final text is shown.
- Added voice-lock modes:
  - `off`
  - `auto_learning`
  - `manual`
- Added audio metadata for backend matching:
  - `source`
  - `user_id`
  - `voice_lock_mode`
  - sample format fields

## Next backend work

1. Add `voice_lock_mode` handling in the WebSocket server/TEN adapter.
2. Add a `speaker_id`/`speaker_score` field to ASR/transcript metadata.
3. Add a real physical direction provider (`speaker_angle`) from mic array or calibrated camera tracking.
4. Add local VAD + speaker embedding worker for private/offline customer deployments.
5. Add word-level subtitle metadata once the chosen ASR/TTS path exposes timings.

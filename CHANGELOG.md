# Changelog

## 2.0.4 - GPU Digital Human Worker Bridge

- Added a pluggable GPU digital-human path for AI-Lover, keeping Live2D/CPU as the default while allowing GPU avatar rendering from TTS audio.
- Added a local GPU avatar worker adapter on port `8810`, with a bundled Xingye poster fallback and optional `GPU_AVATAR_BACKEND_URL` forwarding to MuseTalk/SoulX/LiveAct services.
- Added Local Connector-safe GPU routes under `/api/local-services/gpu-avatar/*`, so cloud pages can reach a customer's local or LAN 4090 worker through `/device-bridge`.
- Added LAN backend override support from the settings page: default `127.0.0.1:8810` is auto-managed, while `192.168.x.x` GPU worker URLs are forwarded by the customer's Local Connector.
- Updated the GPU avatar renderer to consume `videoUrl` or `streamUrl`, materialize private LAN media through the connector, and keep the old audio/TTS pipeline intact.
- Documented the GPU worker API contract, recommended model tiers, and SoulX/MuseTalk integration boundary in `docs/gpu-digital-human-worker.md`.

## 2.0.3 - Offline Local Hardware Console

- Added `/local-control`, a Local Connector local-only hardware console for offline or low-latency field testing without cloud AI conversation.
- Made the browser hand gesture camera the primary large stage on the local console, with skeleton overlay, particle effects, live gesture code, FPS, and direct hand-bridge command delivery.
- Added local head controls on the same console: bridge reconnect, health check, speaker test, microphone test, volume, and common expression actions.
- Surfaced multi-Arduino hand control in the UI and docs: comma-separated ports such as `COM5,COM6` broadcast the same gesture/action to multiple Arduino hands.
- Updated the Local Connector download link, bundled README, UTF-8 Chinese HTML/TXT manual, and package builder default version for `AI-Lover-Local-Connector-2.0.3.zip`.

## 2.0.2 - Self-contained Local Connector Delivery

- Made the Local Connector customer package self-contained by bundling the local Next.js runtime dependencies, packaged Python 3.11 hand runtime, hand gesture virtual environment, and Android platform-tools when available.
- Updated the connector launcher to auto-start the local AI-Lover hardware API server, pass bundled Python/ADB paths into the server, repair the packaged hand virtual environment after unzip, and report local-server readiness before cloud pairing.
- Changed the default hand bridge configuration to avoid fake COM ports on clean customer machines, so `/hand-control` shows real detected serial ports instead of stale placeholders.
- Added UTF-8 Chinese HTML/TXT operation manuals with visual step diagrams and troubleshooting for Connector pairing, head 502, hand 502, serial-port detection, and Windows device-manager checks.
- Updated the cloud settings download link and local-hardware bridge documentation for the 2.0.2 connector package.

## 2.0.1 - Hand Bridge Sync and Arduino Delivery Safety

- Merged the company-PC hand gesture update into the main codebase.
- Added configurable browser-side hand recognition and hardware-send intervals, defaulting to 90 ms and 120 ms.
- Passed the configured send interval through the local connector into the hand bridge as `send_interval_ms`.
- Improved Arduino hand delivery safety by defaulting to the saved `local_hardware_config.json` COM ports and disabling dry-run automatically when a saved Arduino port exists.
- Added bridge-side continuous Arduino finger-angle state and delivery metadata so the UI can show when commands were not actually sent to hardware.
- Updated `/hand-control`, homepage camera preview, and the background browser hand controller to share the same throttling behavior.
- Refreshed colleague/customer documentation for the 2.0.1 package names and current local-hardware workflow.
- Fixed the cloud settings download button to point at `AI-Lover-Local-Connector-2.0.1.zip`; the production server also keeps the old `2.0.0` URL compatible for cached pages.

## 2.0.0 - Cloud Deployment and Local Hardware Bridge

- Added the production `/device-bridge` WebSocket relay so a cloud browser session can pair with a customer's local connector and relay `/api/local-services/*` hardware calls.
- Added `AI-Lover Local Connector`, plus Windows/macOS starter scripts and a PowerShell package builder for customer-side bridge packages.
- Added the settings-page "连接本地设备向导" with pairing-code generation, connector status testing, and the exact local connector startup command.
- Updated robot-head and robot-hand frontend clients so cloud pages automatically route local hardware calls through the connector when enabled, while local/private-LAN pages keep the existing direct workflow.
- Added cloud-safe robot head and hand bridge routing: public pages can talk to each user's local connector endpoint instead of assuming the cloud server can reach private `192.168.x.x` hardware.
- Added the TEN agent API server source to this repository so cloud deployments can build the `/start`, `/stop`, and `/ping` backend instead of relying on a separate old export directory.
- Added optional direct TEN worker startup via `TEN_WORKER_START_DIRECT=true`, allowing Linux deployments without `tman` to launch the packaged `tenapp/scripts/start.py` directly.
- Added the missing `client_control_tool_python` package initializer so TEN can register the command-bus extension in server deployments.
- Hardened the cloud default graph: optional MCP tools are not started unless their local SSE services are present, preventing missing `127.0.0.1:7777-7786` tool servers from taking down the basic voice agent.
- Documented the production cloud profile that uses the server-provided Deepgram ASR key and Minimax TTS environment names while keeping local hardware control on each customer's connector.
- Documented the 2.0 server deployment layout, nginx isolation rules, and the expected local hardware connector model.

## 1.9.9 - Camera Selection and Second Screen Stage

- Added browser camera device selection for the main homepage camera preview and gesture effects.
- Added separate second-screen camera settings so an external HD camera can be used only when the second-screen page is opened.
- Added `/second-screen`, a read-only high-definition camera stage for a second monitor with skeleton and particle effects while avoiding duplicate robot-hand hardware control.
- Added homepage/settings shortcuts for opening the second-screen stage and choosing 480p/720p/1080p capture quality.

## 1.9.8 - Gesture Effect Interaction Polish

- Improved single-hand finger-heart recognition so thumb/index/middle heart gestures can trigger even when the hand points downward instead of only upward.
- Changed the finger-heart particle effect to emit clear heart shapes one by one, growing, floating upward, and fading out instead of dense particle bursts.
- Added a two-hand heart `LOVE` handwriting animation with glow and particle trails instead of center heart bursts.
- Added fingertip writing mode: a V gesture enters writing, the index fingertip draws a glowing trace, and an OK gesture converts the trace into fireworks.
- Added two-person/two-hand star-connection effects with a live glowing line, stronger glow as hands approach, and a final heart/star/firework burst.
- Fixed a startup hydration mismatch caused by browser-cached generated-avatar thumbnails, preventing the production homepage from falling into an application error.

## 1.9.7 - TEN Speaker Diarization and Head Focus

- Added an optional `voice_assistant_diarization` TEN graph using the official Speechmatics ASR extension with speaker diarization enabled.
- Added settings for TEN speaker diarization, robot-head speaker focus, fallback speaker-seat mapping, and separate eye/head focus ranges.
- Forwarded speaker metadata through `main_python`, prefixed LLM input with `[S1]` / `[S2]`, and kept transcript speaker labels visible in the chat UI.
- Added frontend speaker-focus motion: eyes look toward the current speaker first, the neck follows, then eyes return to straight ahead.
- Added optional customer-launch dependency checks for Speechmatics diarization packages.

## 1.9.6 - Product Improvement Round

- Improved robot-head audio continuity by batching short TTS WAV chunks before `tinyplay`, reducing syllable-by-syllable stutter on RK3566 heads.
- Added a head microphone waveform view on `/head-control` so hardware capture can be verified visually instead of only by status text.
- Added Arduino hand demo mode and music-play mode based on the original hand demo: demo action sequence plus the `沧海一声笑` note sequence using 宫商角徵羽 finger patterns.
- Added bridge-side hand motion history as JSONL slices and surfaced recent hand-motion records on `/hand-control` for replay/debug without storing video.
- Added landscape and portrait screen swapping: double-click avatar/camera panes on desktop or tap the portrait picture-in-picture to exchange the main view.
- Added external-camera face tracking settings for the robot head so the laptop camera can gently drive eye direction, with optional neck follow.
- Added more camera particle effects: open palm sparks, fist pulse rings, single-hand heart particles, and two-hand coin-fall effects.
- Hardened repeated local startup by stopping project-owned head bridge processes before reconnecting and by using unique runtime logs.

## 1.9.5 - Head/Hand Customer Delivery Reliability

- Fixed robot-head speaker playback for conversation replies by sending bridge-compatible WAV payloads, deriving mouth motion from the actual audio, and exposing the last playback error in head bridge health.
- Added `/head-control` speaker, microphone, volume, and audio diagnostic tests so customer machines can verify the robot head independently from the main conversation flow.
- Added `/hand-control` for Arduino and ORCA hand testing, including serial-port hints, Arduino action patterns, ORCA 17-joint manual sliders, webcam skeleton preview, hand-motion slice recording, import, and replay.
- Improved customer startup by auto-checking and installing missing hand Python dependencies inside the packaged hand runtime when possible.
- Stopped gesture/particle control cleanly when disabled and added a two-hand heart coin-fall particle effect.
- Added a hot-update package builder for shipping changed app files without resending the full runtime package.

## 1.9.4 - ORCA Hand Direct 17-Joint Mapping

- Added a dependency-light ORCA direct joint mode that maps browser/MediaPipe hand landmarks to the 17 ORCA joints: thumb CMC/abduction/MCP/DIP, four-finger abduction/MCP/PIP, and wrist.
- Added a settings toggle for ORCA wrist following; it is off by default because wrist flexion is estimated from hand landmarks and should be enabled only after field testing confirms stable behavior.
- Sent browser hand landmarks continuously to the local gesture bridge when ORCA direct mode is enabled, so the dexterous hand can mimic finger curl instead of only reacting to six-bit open/close patterns.
- Marked IK-only dependencies (`torch`, `pytorch_kinematics`, `orca_teleop`) as optional in direct mode so customer machines no longer show misleading missing-dependency warnings.

## 1.9.3 - Customer Startup Resilience

- Fixed customer startup so the web UI opens independently of robot-head ADB connection state; head failures are handled in the web settings/reconnect flow instead of closing the launcher.
- Changed startup readiness checks to wait for port 3000 to listen instead of requiring a full page render, avoiding false "operation timed out" failures on slower customer PCs.
- Made the customer launcher prefer the saved `local_hardware_config.json` robot-head IP while still respecting an explicitly edited `customer_config.ps1`.
- Lowered robot-head ADB connect timeout to 8 seconds for faster offline feedback and documented the new reconnect flow.

## 1.9.2 - Gesture Particle Effects

- Added two-hand hand tracking in the browser camera overlay while keeping the first detected hand as the robot-hand control source.
- Added a heart particle effect layer on top of the camera preview: single-hand finger-heart and two-hand heart gestures trigger floating hearts.
- Added a settings drawer toggle for enabling or disabling gesture-driven particle effects during demos.

## 1.9.1 - Colleague Delivery Package

- Added the interactive robot-head volume command flow: the agent acknowledges at the original volume, adjusts volume in 20% steps, then asks for confirmation at the new volume.
- Added colleague/customer usage documentation with screenshots for startup, settings, robot-head control, hand gesture recognition, and LAN mobile access.
- Updated the customer quick-start README for non-technical users.
- Updated customer packaging to include the local HTTPS certificate when present so LAN devices can use camera and microphone through `https://<PC-LAN-IP>:3443/`.

## 1.9.0 - Full Customer Runtime Package

- Changed one-click startup so the web UI still opens if `adb.exe` is missing; robot-head control now reports a clear ADB runtime error instead of stopping the whole app.
- Added robot-head ADB fallback from Wi-Fi TCP debugging to USB debugging when the configured head IP cannot be reached and a USB ADB device is attached.
- Added frontend-side ADB discovery and explicit `/api/local-services/head/start` errors when the packaged `runtime/platform-tools/adb.exe` is unavailable.
- Strengthened the customer-package builder so missing Node.js, Python, ADB, or hand-gesture Python runtimes fail the build before delivery.
- Rebuilt the customer package as the new baseline for sending to customers instead of stacking partial hotfix folders.

## 1.8.9 - Compiled Frontend Hotfix

- Rebuilt the production `.next` frontend bundle so customer production startup includes the latest hand gesture / robot arm settings UI.
- Packaged the compiled frontend output with the startup, log-lock, head-IP, and ADB diagnostics fixes so source changes are visible in customer production mode.
- Added clearer robot-head ADB reachability errors when TCP port `5555` cannot be reached from the customer's PC.

## 1.8.8 - Smart One-Click Launcher Fix

- Fixed installed `app/Start_AI-Lover.bat` and `app/Stop_AI-Lover.bat` paths so they no longer look for a nested `app/app/customer_start.ps1`.
- Made start/stop batch files work from both the package root and the installed app folder.
- Added visible error messages and `pause` when launcher scripts cannot find the startup PowerShell file, preventing silent flash-exit behavior.

## 1.8.7 - Customer OneDrive Log Lock Fix

- Moved customer runtime logs out of the app folder and into `%LOCALAPPDATA%\AI-Lover\local_logs` to avoid OneDrive/Desktop file locks.
- Use unique log filenames for each startup and web-triggered bridge reconnect so an old locked log file cannot block a new launch.
- Force one-click customer startup to run the frontend server in production mode instead of Next.js dev/watch mode.
- Strengthened the customer stop script so replacement updates can close old bridge/server processes before copying files.

## 1.8.6 - Robot Head IP Persistence Fix

- Persist the robot head IP chosen from the web UI into `local_hardware_config.json` so reconnect and future launches use the customer's current LAN address.
- Stopped one-click startup from blocking the main web UI when the previous robot head IP is offline or has changed.
- Removed old migration logic that forced `192.168.110.139` back to the default head IP.

## 1.8.5 - Customer Hand Python Runtime Fix

- Fixed customer-package gesture bridge restarts from the web settings page to prefer `runtime/hand-python/Scripts/python.exe` instead of a clean customer's system Python.
- Passed packaged head Python, hand Python, and ADB paths into the frontend server so reconnect buttons use the same bundled runtimes as one-click startup.

## 1.8.4 - Customer Windows Package

- Added a customer package builder that creates a portable Windows folder with one-click install/start/stop scripts, a desktop launcher exe, bundled Node.js, Python, ADB, frontend dependencies, and hardware bridges.
- Updated local startup to prefer package-relative runtimes under `runtime/` so the app can run from another Windows computer without relying on developer-machine paths.
- Added customer-facing startup, install, uninstall, stop, and configuration scripts with a simple default flow for non-technical users.

## 1.8.3 - Robot Head Speaker Playback Fix

- Auto-detect the RK3566 head speaker sound card from `/proc/asound/cards`, preferring `realtek,rt5651-codec` instead of the HDMI card.
- Replaced the incompatible `tinymix -D 0 0 SPK` route with configurable playback setup, defaulting to `tinymix -D {card} 'OUT Playback Volume' 31 31`.
- Convert head-speaker playback payloads to the board-compatible format before `tinyplay`, including 24-bit PCM to 16-bit PCM and resampling to 16 kHz.
- Added `/audio/diagnose` and richer `/health` audio status so future head swaps can quickly confirm the active card and mixer controls.

## 1.8.2 - Gesture Arm Bridge and Windows Launcher

- Added a local hand-gesture robot arm bridge on port `8791` with MediaPipe/OpenCV recognition, Arduino six-bit serial pattern output, dry-run testing, and optional OrcaHand retargeting hooks.
- Added gesture recognition settings to the main agent settings drawer: bridge endpoint, camera index, serial ports, dry-run, Arduino output, OrcaHand mode, health check, start/stop, and manual action tests.
- Added setup/start scripts for the gesture bridge, documentation for robotic arm testing, and a Windows launcher build path that produces `dist-windows/AI-Lover.exe`.
- Added local head-bridge service management so the frontend server auto-starts port `8787`, and the Settings drawer plus `/head-control` can start/reconnect the head bridge without running `.bat` files.
- Added local gesture-bridge service management so the frontend server auto-starts port `8791`, the Settings drawer can start/reconnect it, and browser calls retry after reconnecting when the bridge is down.
- Expanded the hand gesture setup to install `torch`, `pytorch-kinematics`, and `dynamixel-sdk` by default so OrcaHand/Dynamixel dependency checks pass on a fresh machine.

## 1.8.1 - Local GPU Avatar Preview Worker

- Added a local image-based worker on port `8810` for validating GPU avatar mode before MuseTalk is installed.
- Updated GPU avatar rendering to show worker `posterUrl` images even when no lip-sync video has been returned yet.

## 1.8.0 - GPU Digital Human Mode

- Added a switchable avatar renderer mode: existing Live2D/CPU rendering or a GPU digital-human worker.
- Added GPU avatar health/render proxy APIs and a frontend GPU avatar surface that consumes TTS audio for lip-sync video generation.
- Documented the MuseTalk-first GPU digital-human route and the worker API contract for local or private-LAN deployment.

## 1.7.1 - Secret Management Cleanup

- Replaced committed runtime credentials with environment-variable placeholders in `tenapp/property.json`.
- Added `secrets.env.example` and documented local/server secret handling in `docs/secret-management.md`.
- Added a PowerShell secrets loader and wired local startup scripts plus `tenapp/scripts/start.py` to read private local environment files without committing them.

## 1.7.0 - PSD Layer Package and Cubism Bridge

- Added worker-side PSD layer package generation with ordered PNG layers, layer_manifest.json, cubism_task.json, README.md, and a downloadable zip for manual or automated Cubism rigging.
- Added full-canvas face, mouth, eye, guide, mask, background, and character layers so rigging tools can assemble PSD-quality inputs instead of using a single flattened preview image.
- Added LIVE2D_CUBISM_BRIDGE_COMMAND support so a local Cubism Editor automation bridge can consume cubism_task.json and return a real model3.json URL when ready.
- Updated the Live2D generation page and API to preserve PSD/Cubism artifact links while keeping preview-only jobs out of the avatar registry until a real .moc3 model exists.

## 1.6.0 - Manual Live2D Character Management

- Added /characters for uploading finished Live2D model folders and optional avatar images.
- Added local character metadata: display name, gender, personality, affiliation, ownership, private/shared visibility, voice id, and Live2D framing values.
- Added character APIs and connected the main Settings avatar picker so saved roles become selectable by the existing agent.

## 1.5.1 - Worker Preview UX Fix

- Preserved worker preview image and manifest URLs on Live2D generation jobs.
- Show worker-generated preview images on `/live2d-generate` instead of rendering the built-in template model for preview-only jobs.
- Block preview-only worker outputs from being added as real Live2D avatars until a Cubism rigging provider returns a real `.model3.json`/`.moc3` model.
## 1.5.0 - Local Live2D Worker

- Added a runnable local Live2D worker with a JSON API at `/live2d/generate` and health check at `/health`.
- Added real worker-side photo processing outputs: normalized character plate, transparent person layer, blurred background layer, face region, mouth/eye guide layers, mask, analysis, and manifest.
- Added worker startup script, local/cloud environment documentation, and a clear Cubism rigging provider boundary for returning real `model3.json`/`.moc3` outputs.

## 1.4.1 - Live2D Photo Preprocessing Package

- Added browser-side photo preprocessing for the Live2D generation page: face detection, fallback face estimation, body composition estimation, background complexity scoring, and rigging prompts.
- Stored preprocessing results on generation jobs and forwarded them to the cloud worker alongside the source image.
- Updated the Live2D generation worker protocol to define the preprocessing package and recommended production model replacements.
## 1.4.0 - Cloud Live2D Generation Pipeline

- Added /live2d-generate for uploading a portrait, creating a Live2D generation job, previewing results, and registering a generated avatar.
- Added Live2D generation APIs for job creation, job listing/status, and cloud-worker completion callbacks.
- Added a generated-avatar local registry so completed Live2D models appear in the main Settings avatar picker and can be used by the existing Live2D driver.
- Added a template provider for local end-to-end flow testing, plus documentation and environment variables for connecting a real GPU/cloud worker.
## 1.3.3 - Live2D Standard Parameter Driver

- Expanded the main Live2D renderer from mouth-only lip sync to a standard Cubism parameter driver.
- Added independent runtime control for mouth open, mouth form, eye blink, breath, head angle, and body angle parameters.
- Kept unsupported third-party model parameters non-fatal so older Live2D assets continue to load safely.
## 1.3.2 - Layered Photo Avatar Renderer

- Reworked /photo-avatar-test into a layered 2.5D renderer with separate blurred background, approximate subject cutout, face overlay, and mouth/lower-jaw patch.
- Added breathing micro-motion to the subject layer and kept blink/mouth guides tied to the detected face region.
- Reduced the pasted-mouth look by replacing the large mouth shape with a subtler jaw-drop patch and mouth shadow.
## 1.3.1 - Photo Avatar Auto Mouth Placement

- Added automatic local mouth placement for /photo-avatar-test using the browser FaceDetector API when available.
- Added a CPU-only canvas fallback that estimates the face region from image pixels when FaceDetector is unavailable.
- Moved blink overlays and guide boxes to follow the detected face region, with manual X/Y/Size adjustment still available.

## 1.3.0 - Local Photo Avatar Prototype

- Added /photo-avatar-test for a local CPU-only photo avatar prototype.
- Added single-image upload, browser TTS playback, mouth calibration, subtle head motion, blink animation, and audio-file energy driven mouth movement.
- Added a Settings drawer entry for the local photo avatar test so it can be opened from the main agent UI.

## 1.2.5 - Trulience iFrame Talk State Fix

- Kept iFrame mode active when Trulience reports the monthly conversation quota is exhausted instead of auto-switching to React SDK preview.
- Added a quota-blocked state so Send and Start do not pretend to trigger speech while only avatar preview is available.
- Clarified the test page status copy: avatar preview can load without quota, but live speech requires a usable Trulience API key or restored quota.

## 1.2.4 - Trulience Session and Quota Recovery

- Isolated iFrame and React SDK events so a stale iFrame cannot clear or overwrite the React session.
- Separated the editable token from the active session token and restored the built-in demo JWT when the field is empty.
- Added orderly session shutdown before switching modes or loading again.
- Removed the direct Open action that could accidentally start a second session with the same demo JWT.
- Reported Trulience server errors accurately instead of treating every failure as an invalid token.
- Automatically switched to React avatar preview mode when Trulience reports Free Monthly Limit Exceeded.

## 1.2.3 - Trulience Load Recovery

- Reused the original built-in Trulience demo avatar and long-lived demo token on the test page.
- Defaulted the test page to iframe mode and loaded the demo avatar automatically.
- Disabled React Strict Mode to prevent duplicate single-use authentication during local development.
- Added a one-time automatic iframe reload when the Trulience SDK does not finish its first load.
- Added clear authentication and WebSocket connection status updates.

## 1.2.2 - Trulience API Key Fix

- Corrected Trulience token generation to require the official x-api-key authentication method.
- Added support for the current jwt token response field and a five-minute token expiration.
- Removed the unsupported account email/password inputs from the Trulience test page.
- Added guidance for tru_live_... API keys from Trulience Account > API Keys.

## 1.2.1 - Trulience Authentication Fix

- Added a local Trulience token API route using the current avatar_id request field.
- Added API key or account email/password token generation before loading React SDK and iframe sessions.
- Added clear authentication/connection status messages and automatic handling for single-use invalid tokens.
- Stopped persisting Trulience tokens and credentials in browser local storage.

## 1.2.0 - Avatar Provider Test Pages

- Added `/heygen-test` for HeyGen LiveAvatar iframe testing with a local API route that creates LiveAvatar embed URLs without storing API keys in source.
- Added `/trulience-test` for Trulience testing with both React SDK and iframe modes, event logging, message sending, and iframe control commands.
- Added the `POST /api/heygen/embed` route for local LiveAvatar embed creation using `HEYGEN_LIVEAVATAR_API_KEY`, `LIVEAVATAR_API_KEY`, `HEYGEN_API_KEY`, or a one-time page input.

## 1.1.0 - Silicone Head Integration

- Added a local RK3566 robot head bridge for servo protocol control over `/dev/ttyS4`.
- Added expression/action sequences for blink, smile, sad, kiss, makeface, eye rotation, neck turning, speaking mouth motion, and reset.
- Added a browser control page at `/head-control` for multi-device manual servo/action testing.
- Integrated robot head motion with the voice agent: TTS start/stop drives mouth motion, and user/assistant text can trigger matching expressions.
- Added Settings controls for the silicone head mechanism: bridge endpoint, head IP, connection detection, reset, motion enable, head speaker output, and head microphone input.
- Added head speaker playback through `tinyplay` and head microphone capture through `tinycap`/`tinymix` via ADB transport.
- Fixed RK3566 speaker playback by converting mono TTS/test audio to stereo before `tinyplay`.
- Added separate computer/head microphone source switches and a head microphone test with capture level feedback.
- Added local startup script `start_local_robot_agent.ps1` for local UI + remote TEN backend + local hardware bridge debugging.
- Added hardware protocol tests and documentation for local debugging and future multi-head cloud control.

## 1.0.0 - Server Baseline

- Imported the original TEN-based voice conversation agent from the server export.
- Preserved the web frontend, TEN app configuration, MCP helper services, and deployment scripts.
- Added repository-safe ignore rules so secrets, local databases, build output, and binaries are not committed.

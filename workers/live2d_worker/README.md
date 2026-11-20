# Local Live2D Worker

This worker receives the JSON payload from `POST /api/live2d/generate`, writes real photo-processing artifacts, and returns a worker result that the frontend can track.

It does not pretend to generate proprietary Cubism `.moc3` files. The current worker performs the real local stages that can run today:

- decode and validate the uploaded image
- normalize the image to a Live2D-friendly character plate
- estimate face, mouth, eye, neck, and breath control points
- create a transparent character layer and a separated background layer
- write a PSD/Cubism-ready layer package for manual rigging or automation
- optionally call a Cubism Editor automation bridge or remote rigging provider
- optionally return a template Live2D model URL for frontend flow testing

## Run Locally

```powershell
.\start_live2d_worker.ps1
```

The default server URL is:

```text
http://127.0.0.1:8790/live2d/generate
```

For the running Next.js app, set:

```env
LIVE2D_GENERATOR_ENDPOINT=http://127.0.0.1:8790/live2d/generate
```

If you want the frontend job to become `ready` while the real Cubism rigging provider is not connected yet, start with:

```powershell
$env:LIVE2D_WORKER_RETURN_TEMPLATE="1"
.\start_live2d_worker.ps1
```

That mode still writes the real worker artifacts, but it returns the built-in `/live2d/osagegirl/osagegirl.model3.json` only as a UI integration preview.

## Run With Cubism Editor Open Bridge

When Live2D Cubism Editor is installed locally, use:

```powershell
cd C:\Users\sunat\xiaoling_local_dev\AI-Lover
.\start_live2d_worker_cubism_open.ps1
```

Current verified Cubism Editor path:

```text
C:\Program Files\Live2D Cubism 5.3\CubismEditor5.exe
```

In this mode each `/live2d-generate` job will:

1. decode and normalize the uploaded photo
2. write the PSD layer package
3. write `cubism_task.json`
4. write `cubism_output/cubism_bridge_plan.json`
5. open Cubism Editor with the generated PSD

This is not yet full automatic `.moc3` export. It is the first verified bridge step for manual rigging or the next GUI automation layer.

## Important Environment Variables

```env
LIVE2D_WORKER_HOST=127.0.0.1
LIVE2D_WORKER_PORT=8790
LIVE2D_WORKER_PUBLIC_ROOT=C:\...\frontend\public\generated-live2d
LIVE2D_WORKER_PUBLIC_BASE=/generated-live2d
LIVE2D_WORKER_RETURN_TEMPLATE=0
LIVE2D_WORKER_TEMPLATE_MODEL=/live2d/osagegirl/osagegirl.model3.json
LIVE2D_CUBISM_BRIDGE_COMMAND=
LIVE2D_CUBISM_TEMPLATE_PROJECT=
LIVE2D_CUBISM_BRIDGE_TIMEOUT_SEC=900
LIVE2D_CUBISM_BRIDGE_MODE=plan
LIVE2D_CUBISM_EDITOR_PATH=C:\Program Files\Live2D Cubism 5.3\CubismEditor5.exe
LIVE2D_AUTOMATION_REPO=C:\path\to\live2d-automation
LIVE2D_AUTOMATION_NATIVE_GUI_MODE=dry_run
LIVE2D_RIGGING_ENDPOINT=
LIVE2D_RIGGING_API_KEY=
```

## Worker Outputs

Each successful local generation writes a `worker/` directory under the job folder. The important artifacts are:

```text
manifest.json
normalized_1024x1536.png
person_layer.png
background_layer.png
face_layer.png
mouth_eye_guides.png
mask_person.png
psd_layer_package.zip
psd_layer_package/<job>_cubism_source.psd
psd_layer_package/psd_generation_status.json
psd_layer_package/layer_manifest.json
psd_layer_package/cubism_task.json
psd_layer_package/README.md
```

`psd_layer_package.zip` is the handoff for a rigger or automation worker. It contains a generated layered PSD when `psd-tools` is installed, plus ordered same-size PNG layers:

```text
00_REF_source_plate.png
01_BG_separated_blur.png
10_BODY_character_base.png
20_HEAD_face_reference.png
30_EYE_left_reference.png
31_EYE_right_reference.png
40_MOUTH_reference.png
80_GUIDE_mouth_box.png
81_GUIDE_eye_boxes.png
90_MASK_person_alpha.png
99_PREVIEW_normalized.png
```

The guide layers are intentionally included for alignment. They should be hidden or removed before final Cubism import.

## Cubism Bridge Contract

`LIVE2D_CUBISM_BRIDGE_COMMAND` is the local automation boundary for Cubism Editor or any custom rigging worker. When it is configured, the worker runs the command after the PSD layer package is written.

The command receives both paths through environment variables:

```env
LIVE2D_CUBISM_TASK=C:\...\psd_layer_package\cubism_task.json
LIVE2D_CUBISM_MANIFEST=C:\...\worker\manifest.json
```

If the command string contains `{task}` or `{manifest}`, those placeholders are replaced. Otherwise the absolute `cubism_task.json` path is appended as the last argument.

Expected stdout when a real runtime model is exported:

```json
{"modelUrl":"/generated-live2d/<job>/cubism_output/model.model3.json","message":"Cubism export complete"}
```

The bridge log is written to `psd_layer_package/cubism_bridge.log`. Until this bridge or `LIVE2D_RIGGING_ENDPOINT` returns a real `.model3.json` backed by `.moc3`, the frontend keeps the job in `waiting_provider` and exposes only the preview and PSD/Cubism artifacts.

## Remote Rigging Provider

`LIVE2D_RIGGING_ENDPOINT` remains available as a cloud/GPU provider boundary. It receives the generated `manifest.json` package and should return a real Cubism `model3.json` URL. Use this for a hosted worker if Cubism Editor automation is not running on the same machine.
## Built-in Cubism Bridge CLI

The worker includes a bridge command that can be connected directly:

```powershell
$env:LIVE2D_CUBISM_BRIDGE_COMMAND="python -m live2d_worker.cubism_bridge_cli --mode plan"
.\start_live2d_worker.ps1
```

Bridge modes:

- `plan`: write `cubism_output/cubism_bridge_plan.json` only. This is the safe default.
- `open`: open Cubism Editor with the generated PSD for manual rigging/export.
- `adapter`: call `LIVE2D_NATIVE_GUI_ADAPTER_COMMAND` using the action contract used by `J621111/live2d-automation`.
- `live2d-automation`: call a local checkout or installed copy of `live2d-automation`.

For `live2d-automation` mode:

```powershell
$env:LIVE2D_CUBISM_BRIDGE_COMMAND="python -m live2d_worker.cubism_bridge_cli --mode live2d-automation"
$env:LIVE2D_AUTOMATION_REPO="C:\path\to\live2d-automation"
$env:LIVE2D_AUTOMATION_NATIVE_GUI_MODE="dry_run"
$env:LIVE2D_CUBISM_EDITOR_PATH="C:\Program Files\Live2D\Cubism5\Cubism Editor 5\CubismEditor5.exe"
.\start_live2d_worker.ps1
```

Keep `LIVE2D_AUTOMATION_NATIVE_GUI_MODE=dry_run` until the local Cubism Editor menu profile is calibrated. Switch to `execute` only after import/export has been verified on this machine.

## Troubleshooting

### `localhost:8790` refuses connection

The worker is not running. Start one of:

```powershell
.\start_live2d_worker.ps1
.\start_live2d_worker_cubism_open.ps1
```

Then check:

```powershell
Invoke-WebRequest http://127.0.0.1:8790/health -UseBasicParsing
```

### Cubism does not open

Check that the editor path exists:

```powershell
Test-Path "C:\Program Files\Live2D Cubism 5.3\CubismEditor5.exe"
```

If the path is different, set:

```powershell
$env:LIVE2D_CUBISM_EDITOR_PATH="C:\your\path\CubismEditor5.exe"
```

### Job remains `waiting_provider`

That is expected until the bridge returns a real runtime model URL. The `open` bridge only opens the PSD in Cubism; it does not yet export `.moc3`.

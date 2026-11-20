# Live2D Generation Pipeline

This project treats user photo to Live2D as a staged worker/provider workflow:

1. Browser uploads a portrait from `/live2d-generate`.
2. The browser runs a first-pass preprocessing step: face detection, estimated body composition, background complexity, quality scoring, and a Live2D rigging prompt.
3. `POST /api/live2d/generate` stores the source image under `public/generated-live2d/<jobId>/` and creates a job under `data/live2d-generation/jobs/`.
4. If `LIVE2D_GENERATOR_ENDPOINT` is configured, the API sends the job, base64 image, and preprocessing package to the local or cloud worker.
5. The worker writes normalized assets and either returns a ready `.model3.json` URL, returns a remote job id, or passes the manifest to a Cubism rigging provider.
6. The browser registers completed Cubism models as generated avatars. The main Live2D renderer then drives mouth, blink, breath, head, and body parameters.

## Environment

```env
# Local worker
LIVE2D_GENERATOR_ENDPOINT=http://127.0.0.1:8790/live2d/generate

# Cloud or protected worker
LIVE2D_GENERATOR_API_KEY=optional-provider-token
LIVE2D_GENERATOR_CALLBACK_URL=https://your-site.example.com/api/live2d/jobs/{jobId}/complete
LIVE2D_GENERATOR_CALLBACK_TOKEN=optional-callback-token
```

## Local Worker

The repo now includes a runnable local worker under `workers/live2d_worker`. It can run on this Windows/GPU machine first, then move to the cloud later.

Start it from the repository root:

```powershell
.\start_live2d_worker.ps1
```

The standard endpoint is:

```text
http://127.0.0.1:8790/live2d/generate
```

Health check:

```text
http://127.0.0.1:8790/health
```

Important worker variables:

```env
LIVE2D_WORKER_PUBLIC_ROOT=C:\...\frontend\public\generated-live2d
LIVE2D_WORKER_PUBLIC_BASE=/generated-live2d
LIVE2D_WORKER_RETURN_TEMPLATE=0
LIVE2D_WORKER_TEMPLATE_MODEL=/live2d/osagegirl/osagegirl.model3.json
LIVE2D_RIGGING_ENDPOINT=
LIVE2D_RIGGING_API_KEY=
```

`LIVE2D_WORKER_RETURN_TEMPLATE=1` is only for frontend integration testing. It still writes the real generated assets, but it mounts the built-in `osagegirl` model so the UI can become `ready` before a real Cubism rigging provider is connected.

The local worker currently writes:

- `worker/source_worker.png`
- `worker/normalized_1024x1536.png`
- `worker/layers/person_rgba.png`
- `worker/layers/background_blur.png`
- `worker/layers/face_region.png`
- `worker/layers/mouth_guide.png`
- `worker/layers/eye_guide.png`
- `worker/layers/person_mask.png`
- `worker/analysis.json`
- `worker/manifest.json`

`manifest.json` is the handoff contract for the next stage: a Cubism rigging service, GPU model worker, or manual Cubism Editor workflow.

## Preprocessing Package

The browser-side preprocessor is intentionally lightweight and replaceable. It uses the browser `FaceDetector` API when available, falls back to a canvas skin-cluster heuristic, estimates the body box from the face, scores background complexity, and creates a rigging prompt.

The local worker enriches that package with normalized asset generation and runtime inspection. A production GPU worker should add stronger models:

- MediaPipe Face Landmarker for face landmarks and expression-neutral alignment.
- MediaPipe Pose Landmarker or equivalent for body keypoints.
- SAM/SAM2 or a portrait segmentation model for person/background masks.
- Outpainting/generation for missing torso, arms, or lower body.
- A PSD/layer-generation step for hair, eyes, mouth, neck, torso, arms, and background plate.
- A Cubism rigging provider that returns real `model3.json`, `.moc3`, textures, physics, and expressions.

Example `preprocess` payload sent to the worker:

```json
{
  "version": "1.0",
  "image": { "width": 1024, "height": 1536, "aspect": 0.6667 },
  "face": {
    "box": { "x": 38, "y": 14, "width": 24, "height": 19 },
    "confidence": 0.88,
    "method": "FaceDetector"
  },
  "body": {
    "box": { "x": 21, "y": 9, "width": 58, "height": 91 },
    "composition": "upper_body",
    "estimated": true,
    "missing": ["pose_landmarks_estimated", "lower_body"]
  },
  "background": { "complexity": "complex", "score": 0.72 },
  "quality": {
    "score": 74,
    "issues": ["Lower body is incomplete for full-body rigging."],
    "recommendations": ["Use AI outpainting if a full-body Live2D model is required."]
  },
  "rigging": {
    "target": "live2d-cubism4",
    "requiredLayers": ["transparent full-body character", "eyes separated left/right", "mouth interior and lips separated"],
    "generationPrompt": "Create a clean Live2D-ready character sheet...",
    "negativePrompt": "extra limbs, cropped head, hidden face..."
  }
}
```

## Provider Request

The app sends JSON to `LIVE2D_GENERATOR_ENDPOINT`:

```json
{
  "jobId": "gen_...",
  "name": "My Avatar",
  "output": "live2d-cubism4",
  "sourceImageUrl": "/generated-live2d/gen_.../source.png",
  "preprocess": { "version": "1.0" },
  "callbackUrl": "https://your-site.example.com/api/live2d/jobs/{jobId}/complete",
  "callbackTokenRequired": true,
  "image": {
    "mimeType": "image/png",
    "base64": "..."
  }
}
```

## Worker Response

If the worker or rigging provider finishes immediately, return:

```json
{
  "modelUrl": "/generated-live2d/gen_.../avatar.model3.json",
  "label": "My Avatar",
  "displayName": "My Avatar",
  "intro": "Cloud generated Live2D avatar.",
  "scaleBoost": 1.3,
  "anchorRatio": 0,
  "message": "Live2D model is ready"
}
```

If the worker only produced assets and still needs Cubism rigging, return:

```json
{
  "remoteJobId": "local-worker-gen_...",
  "message": "Local worker wrote Live2D-ready assets. Connect LIVE2D_RIGGING_ENDPOINT to return a real Cubism model.",
  "assetManifestUrl": "/generated-live2d/gen_.../worker/manifest.json",
  "previewImageUrl": "/generated-live2d/gen_.../worker/normalized_1024x1536.png"
}
```

## Async Callback

If the worker needs more time, return a remote job id first:

```json
{
  "remoteJobId": "worker-job-123",
  "message": "accepted"
}
```

Then call:

```http
POST /api/live2d/jobs/<jobId>/complete
x-live2d-callback-token: <LIVE2D_GENERATOR_CALLBACK_TOKEN>
content-type: application/json
```

```json
{
  "modelUrl": "/generated-live2d/gen_.../avatar.model3.json",
  "label": "My Avatar",
  "displayName": "My Avatar",
  "intro": "Cloud generated Live2D avatar.",
  "scaleBoost": 1.3,
  "anchorRatio": 0,
  "message": "Live2D model is ready"
}
```

## Important Boundary

A real Cubism output must include a valid `model3.json`, `.moc3`, textures, physics, and expressions produced by a Live2D-capable rigging pipeline. The frontend and local preprocessing worker do not fabricate `.moc3` files; they prepare and consume finished Cubism models.

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

CANVAS_SIZE = (1024, 1536)
WORKER_VERSION = "1.8.0"


@dataclass(frozen=True)
class WorkerConfig:
    public_root: Path
    public_base: str = "/generated-live2d"
    return_template: bool = False
    template_model: str = "/live2d/osagegirl/osagegirl.model3.json"
    rigging_endpoint: str = ""
    rigging_api_key: str = ""
    cubism_bridge_command: str = ""
    cubism_template_project: str = ""
    cubism_bridge_timeout_sec: int = 900

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        repo_root = Path(__file__).resolve().parents[3]
        default_public_root = repo_root / "frontend" / "public" / "generated-live2d"
        return cls(
            public_root=Path(os.environ.get("LIVE2D_WORKER_PUBLIC_ROOT", default_public_root)).resolve(),
            public_base=os.environ.get("LIVE2D_WORKER_PUBLIC_BASE", "/generated-live2d").rstrip("/"),
            return_template=os.environ.get("LIVE2D_WORKER_RETURN_TEMPLATE", "0").strip().lower() in {"1", "true", "yes"},
            template_model=os.environ.get("LIVE2D_WORKER_TEMPLATE_MODEL", "/live2d/osagegirl/osagegirl.model3.json"),
            rigging_endpoint=os.environ.get("LIVE2D_RIGGING_ENDPOINT", "").strip(),
            rigging_api_key=os.environ.get("LIVE2D_RIGGING_API_KEY", "").strip(),
            cubism_bridge_command=os.environ.get("LIVE2D_CUBISM_BRIDGE_COMMAND", "").strip(),
            cubism_template_project=os.environ.get("LIVE2D_CUBISM_TEMPLATE_PROJECT", "").strip(),
            cubism_bridge_timeout_sec=int(os.environ.get("LIVE2D_CUBISM_BRIDGE_TIMEOUT_SEC", "900")),
        )


def run_generation(payload: dict[str, Any], config: WorkerConfig | None = None) -> dict[str, Any]:
    cfg = config or WorkerConfig.from_env()
    started = time.perf_counter()

    job_id = sanitize_job_id(str(payload.get("jobId") or payload.get("id") or "job"))
    name = sanitize_name(str(payload.get("name") or "My Avatar"))
    image_payload = payload.get("image") or {}
    preprocess = payload.get("preprocess") if isinstance(payload.get("preprocess"), dict) else None

    image = decode_image(image_payload)
    job_dir = cfg.public_root / job_id
    worker_dir = job_dir / "worker"
    layers_dir = worker_dir / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)

    source = ImageOps.exif_transpose(image).convert("RGB")
    source_path = worker_dir / "source_worker.png"
    source.save(source_path)

    face_box = get_preprocess_box(preprocess, "face", source.size) or estimate_face_box(source)
    body_box = get_preprocess_box(preprocess, "body", source.size) or estimate_body_box_from_face(face_box, source.size)
    crop_box = expanded_box(body_box, source.size, x_scale=1.35, y_scale=1.18)
    plate, transform = fit_crop_to_canvas(source, crop_box, CANVAS_SIZE)

    face_plate = transform_box(face_box, transform)
    body_plate = transform_box(body_box, transform)
    mouth_plate = estimate_mouth_box(face_plate)
    eye_boxes = estimate_eye_boxes(face_plate)
    control_points = build_control_points(face_plate, body_plate, mouth_plate, eye_boxes, CANVAS_SIZE)

    person_mask = build_soft_person_mask(CANVAS_SIZE, face_plate, body_plate)
    person_rgba = plate.convert("RGBA")
    person_rgba.putalpha(person_mask)

    background = build_background_layer(plate, person_mask)
    normalized = build_normalized_preview(plate, person_mask)
    face_layer = crop_region(person_rgba, face_plate, pad=0.12)
    mouth_guide = build_mouth_guide(CANVAS_SIZE, mouth_plate)
    eye_guide = build_eye_guide(CANVAS_SIZE, eye_boxes)
    face_reference = extract_region_layer(person_rgba, face_plate, pad=0.12)
    mouth_reference = extract_region_layer(person_rgba, mouth_plate, pad=0.9)
    left_eye_reference = extract_region_layer(person_rgba, eye_boxes["left"], pad=1.0)
    right_eye_reference = extract_region_layer(person_rgba, eye_boxes["right"], pad=1.0)

    artifact_paths = {
        "source": source_path,
        "normalized": worker_dir / "normalized_1024x1536.png",
        "personLayer": layers_dir / "person_rgba.png",
        "backgroundLayer": layers_dir / "background_blur.png",
        "faceLayer": layers_dir / "face_region.png",
        "mouthGuide": layers_dir / "mouth_guide.png",
        "eyeGuide": layers_dir / "eye_guide.png",
        "mask": layers_dir / "person_mask.png",
    }
    normalized.save(artifact_paths["normalized"])
    person_rgba.save(artifact_paths["personLayer"])
    background.save(artifact_paths["backgroundLayer"])
    face_layer.save(artifact_paths["faceLayer"])
    mouth_guide.save(artifact_paths["mouthGuide"])
    eye_guide.save(artifact_paths["eyeGuide"])
    person_mask.save(artifact_paths["mask"])

    analysis = {
        "workerVersion": WORKER_VERSION,
        "sourceSize": {"width": source.width, "height": source.height},
        "canvasSize": {"width": CANVAS_SIZE[0], "height": CANVAS_SIZE[1]},
        "sourceBoxes": {
            "face": box_to_json(face_box),
            "body": box_to_json(body_box),
            "crop": box_to_json(crop_box),
        },
        "canvasBoxes": {
            "face": box_to_json(face_plate),
            "body": box_to_json(body_plate),
            "mouth": box_to_json(mouth_plate),
            "leftEye": box_to_json(eye_boxes["left"]),
            "rightEye": box_to_json(eye_boxes["right"]),
        },
        "controlPoints": control_points,
        "preprocess": preprocess,
        "runtime": inspect_runtime(),
        "quality": estimate_worker_quality(face_plate, body_plate, preprocess),
        "segmentation": {
            "method": "preprocess-guided-soft-mask",
            "note": "This worker creates usable Live2D rigging assets without claiming final neural segmentation. Connect SAM/portrait matting in the same provider slot for production masks.",
        },
    }
    analysis_path = worker_dir / "analysis.json"
    analysis_path.write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")

    package_paths = write_psd_layer_package(
        cfg=cfg,
        job_id=job_id,
        name=name,
        worker_dir=worker_dir,
        plate=plate,
        normalized=normalized,
        background=background,
        person_rgba=person_rgba,
        face_reference=face_reference,
        mouth_reference=mouth_reference,
        left_eye_reference=left_eye_reference,
        right_eye_reference=right_eye_reference,
        mouth_guide=mouth_guide,
        eye_guide=eye_guide,
        person_mask=person_mask,
        control_points=control_points,
        analysis=analysis,
    )

    manifest_path = worker_dir / "manifest.json"
    manifest = build_manifest(
        cfg=cfg,
        job_id=job_id,
        name=name,
        mime_type=str(image_payload.get("mimeType") or "image/png"),
        artifact_paths={**artifact_paths, **package_paths, "analysis": analysis_path, "manifest": manifest_path},
        control_points=control_points,
        analysis=analysis,
    )
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    cubism_result = run_cubism_bridge_if_configured(cfg, manifest)
    if cubism_result.get("modelUrl"):
        rigging_result = cubism_result
    else:
        rigging_result = run_rigging_provider_if_configured(cfg, manifest) or cubism_result
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    manifest_url = public_url(cfg, job_id, "worker/manifest.json")
    preview_url = public_url(cfg, job_id, "worker/normalized_1024x1536.png")
    layer_package_url = public_url(cfg, job_id, "worker/psd_layer_package.zip")
    layer_manifest_url = public_url(cfg, job_id, "worker/psd_layer_package/layer_manifest.json")
    cubism_task_url = public_url(cfg, job_id, "worker/psd_layer_package/cubism_task.json")
    cubism_readme_url = public_url(cfg, job_id, "worker/psd_layer_package/README.md")
    psd_source_url = public_url(cfg, job_id, package_paths["psdSource"].relative_to(cfg.public_root / job_id).as_posix()) if package_paths.get("psdSource") else None

    if rigging_result.get("modelUrl"):
        return {
            **rigging_result,
            "remoteJobId": f"local-worker-{job_id}",
            "message": rigging_result.get("message") or f"Local worker generated assets and rigging provider returned a Cubism model in {elapsed_ms} ms.",
            "providerNote": rigging_result.get("providerNote") or f"Worker manifest: {manifest_url}",
            "assetManifestUrl": rigging_result.get("assetManifestUrl") or manifest_url,
            "layerPackageUrl": rigging_result.get("layerPackageUrl") or layer_package_url,
            "layerManifestUrl": rigging_result.get("layerManifestUrl") or layer_manifest_url,
            "cubismTaskUrl": rigging_result.get("cubismTaskUrl") or cubism_task_url,
            "cubismReadmeUrl": rigging_result.get("cubismReadmeUrl") or cubism_readme_url,
            "psdSourceUrl": rigging_result.get("psdSourceUrl") or psd_source_url,
        }

    if cfg.return_template:
        return {
            "remoteJobId": f"local-worker-{job_id}",
            "modelUrl": cfg.template_model,
            "label": f"{name} (worker preview)",
            "displayName": name,
            "intro": "Local worker produced photo assets. The built-in Cubism model is mounted only to verify frontend integration.",
            "scaleBoost": 1.8,
            "anchorRatio": 0.8,
            "message": f"Local worker wrote Live2D-ready assets in {elapsed_ms} ms. Template model returned for UI testing.",
            "providerNote": f"Real worker assets: {manifest_url}. Preview image: {preview_url}. Cubism rigging provider is not connected yet, so this is not a generated .moc3 model.",
            "templatePreview": True,
            "assetManifestUrl": manifest_url,
            "previewImageUrl": preview_url,
            "layerPackageUrl": layer_package_url,
            "layerManifestUrl": layer_manifest_url,
            "cubismTaskUrl": cubism_task_url,
            "cubismReadmeUrl": cubism_readme_url,
            "psdSourceUrl": psd_source_url,
        }

    return {
        "remoteJobId": f"local-worker-{job_id}",
        "message": rigging_result.get("message") or f"Local worker wrote PSD/Cubism-ready assets in {elapsed_ms} ms. Connect LIVE2D_CUBISM_BRIDGE_COMMAND or LIVE2D_RIGGING_ENDPOINT to return a real Cubism model.",
        "providerNote": rigging_result.get("providerNote") or f"Worker manifest: {manifest_url}. Preview image: {preview_url}.",
        "assetManifestUrl": manifest_url,
        "previewImageUrl": preview_url,
        "layerPackageUrl": layer_package_url,
        "layerManifestUrl": layer_manifest_url,
        "cubismTaskUrl": cubism_task_url,
        "cubismReadmeUrl": cubism_readme_url,
        "psdSourceUrl": psd_source_url,
    }


def decode_image(image_payload: dict[str, Any]) -> Image.Image:
    raw_base64 = image_payload.get("base64")
    if not isinstance(raw_base64, str) or not raw_base64:
        raise ValueError("image.base64 is required")
    try:
        image_bytes = base64.b64decode(raw_base64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("image.base64 is invalid") from exc
    try:
        from io import BytesIO

        return Image.open(BytesIO(image_bytes))
    except Exception as exc:  # noqa: BLE001
        raise ValueError("image payload is not a readable image") from exc


def sanitize_job_id(value: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_-]", "", value)[:96]
    if not clean:
        raise ValueError("invalid job id")
    return clean


def sanitize_name(value: str) -> str:
    clean = re.sub(r"[<>]", "", value).strip()
    return clean[:48] or "My Avatar"


def public_url(cfg: WorkerConfig, job_id: str, relative: str) -> str:
    return f"{cfg.public_base}/{job_id}/{relative.replace(os.sep, '/')}"


def get_preprocess_box(preprocess: dict[str, Any] | None, key: str, image_size: tuple[int, int]) -> tuple[float, float, float, float] | None:
    if not preprocess:
        return None
    box_parent = preprocess.get(key)
    if not isinstance(box_parent, dict):
        return None
    box = box_parent.get("box")
    if not isinstance(box, dict):
        return None
    try:
        x = float(box["x"])
        y = float(box["y"])
        width = float(box["width"])
        height = float(box["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    image_width, image_height = image_size
    if max(x, y, width, height) <= 100.0:
        return clamp_box((x / 100 * image_width, y / 100 * image_height, width / 100 * image_width, height / 100 * image_height), image_size)
    return clamp_box((x, y, width, height), image_size)


def estimate_face_box(image: Image.Image) -> tuple[float, float, float, float]:
    arr = np.asarray(image.convert("RGB")).astype(np.float32)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    maxc = np.maximum.reduce([r, g, b])
    minc = np.minimum.reduce([r, g, b])
    skin = (r > 75) & (g > 40) & (b > 25) & ((maxc - minc) > 15) & (r > g * 0.95) & (r > b * 1.05)
    upper = skin[: max(1, image.height // 2), :]
    ys, xs = np.where(upper)
    if len(xs) < 80:
        side = min(image.width, image.height) * 0.26
        return clamp_box(((image.width - side) / 2, image.height * 0.16, side, side * 1.15), image.size)

    x1, x2 = float(np.percentile(xs, 8)), float(np.percentile(xs, 92))
    y1, y2 = float(np.percentile(ys, 6)), float(np.percentile(ys, 94))
    width = max(80.0, x2 - x1)
    height = max(90.0, y2 - y1)
    return clamp_box((x1, y1, width, height), image.size)


def estimate_body_box_from_face(face_box: tuple[float, float, float, float], image_size: tuple[int, int]) -> tuple[float, float, float, float]:
    x, y, width, height = face_box
    body_width = width * 3.1
    body_height = height * 5.0
    body_x = x + width / 2 - body_width / 2
    body_y = max(0.0, y - height * 0.18)
    return clamp_box((body_x, body_y, body_width, body_height), image_size)


def clamp_box(box: tuple[float, float, float, float], image_size: tuple[int, int]) -> tuple[float, float, float, float]:
    x, y, width, height = box
    image_width, image_height = image_size
    x1 = min(max(0.0, x), image_width - 1.0)
    y1 = min(max(0.0, y), image_height - 1.0)
    x2 = min(max(x1 + 1.0, x + width), float(image_width))
    y2 = min(max(y1 + 1.0, y + height), float(image_height))
    return (x1, y1, x2 - x1, y2 - y1)


def expanded_box(box: tuple[float, float, float, float], image_size: tuple[int, int], x_scale: float, y_scale: float) -> tuple[float, float, float, float]:
    x, y, width, height = box
    center_x = x + width / 2
    center_y = y + height / 2
    next_width = width * x_scale
    next_height = height * y_scale
    return clamp_box((center_x - next_width / 2, center_y - next_height / 2, next_width, next_height), image_size)


def fit_crop_to_canvas(
    image: Image.Image,
    crop_box: tuple[float, float, float, float],
    canvas_size: tuple[int, int],
) -> tuple[Image.Image, dict[str, float]]:
    x, y, width, height = crop_box
    crop = image.crop((round(x), round(y), round(x + width), round(y + height)))
    canvas_width, canvas_height = canvas_size
    scale = min(canvas_width / crop.width, canvas_height / crop.height)
    resized_size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    resized = crop.resize(resized_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", canvas_size, (22, 25, 31))
    offset_x = (canvas_width - resized.width) // 2
    offset_y = (canvas_height - resized.height) // 2
    canvas.paste(resized, (offset_x, offset_y))
    return canvas, {"cropX": x, "cropY": y, "scale": scale, "offsetX": float(offset_x), "offsetY": float(offset_y)}


def transform_box(box: tuple[float, float, float, float], transform: dict[str, float]) -> tuple[float, float, float, float]:
    x, y, width, height = box
    scale = transform["scale"]
    return (
        (x - transform["cropX"]) * scale + transform["offsetX"],
        (y - transform["cropY"]) * scale + transform["offsetY"],
        width * scale,
        height * scale,
    )


def estimate_mouth_box(face_box: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    x, y, width, height = face_box
    mouth_width = width * 0.36
    mouth_height = height * 0.11
    return (x + width * 0.5 - mouth_width / 2, y + height * 0.72, mouth_width, mouth_height)


def estimate_eye_boxes(face_box: tuple[float, float, float, float]) -> dict[str, tuple[float, float, float, float]]:
    x, y, width, height = face_box
    eye_width = width * 0.18
    eye_height = height * 0.08
    eye_y = y + height * 0.39
    return {
        "left": (x + width * 0.32 - eye_width / 2, eye_y, eye_width, eye_height),
        "right": (x + width * 0.68 - eye_width / 2, eye_y, eye_width, eye_height),
    }


def build_soft_person_mask(
    canvas_size: tuple[int, int],
    face_box: tuple[float, float, float, float],
    body_box: tuple[float, float, float, float],
) -> Image.Image:
    mask = Image.new("L", canvas_size, 0)
    draw = ImageDraw.Draw(mask)
    bx, by, bw, bh = body_box
    fx, fy, fw, fh = face_box
    body = (bx, by + fh * 0.25, bx + bw, by + bh)
    head = (fx - fw * 0.28, fy - fh * 0.2, fx + fw * 1.28, fy + fh * 1.22)
    shoulders = (bx - bw * 0.06, fy + fh * 0.78, bx + bw * 1.06, by + bh * 0.62)
    radius = max(24, round(fw * 0.35))
    draw.rounded_rectangle(tuple(round(v) for v in body), radius=radius, fill=255)
    draw.ellipse(tuple(round(v) for v in head), fill=255)
    draw.rounded_rectangle(tuple(round(v) for v in shoulders), radius=radius, fill=255)
    return mask.filter(ImageFilter.GaussianBlur(10))


def build_background_layer(plate: Image.Image, mask: Image.Image) -> Image.Image:
    blurred = plate.filter(ImageFilter.GaussianBlur(18)).convert("RGBA")
    dim = Image.new("RGBA", plate.size, (12, 15, 20, 130))
    blurred.alpha_composite(dim)
    soft_inverse = ImageOps.invert(mask.filter(ImageFilter.GaussianBlur(18)))
    blurred.putalpha(soft_inverse)
    return blurred


def build_normalized_preview(plate: Image.Image, mask: Image.Image) -> Image.Image:
    background = Image.new("RGB", plate.size, (24, 28, 36))
    shaded = plate.copy()
    vignette = Image.new("L", plate.size, 0)
    draw = ImageDraw.Draw(vignette)
    draw.ellipse((-220, -120, plate.width + 220, plate.height + 220), fill=120)
    shaded = Image.composite(shaded, background, vignette)
    person = plate.convert("RGBA")
    person.putalpha(mask)
    out = shaded.convert("RGBA")
    out.alpha_composite(person)
    return out


def crop_region(image: Image.Image, box: tuple[float, float, float, float], pad: float) -> Image.Image:
    x, y, width, height = box
    padding_x = width * pad
    padding_y = height * pad
    x1 = max(0, round(x - padding_x))
    y1 = max(0, round(y - padding_y))
    x2 = min(image.width, round(x + width + padding_x))
    y2 = min(image.height, round(y + height + padding_y))
    return image.crop((x1, y1, x2, y2))


def build_mouth_guide(canvas_size: tuple[int, int], mouth_box: tuple[float, float, float, float]) -> Image.Image:
    layer = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x, y, width, height = mouth_box
    guide = (round(x), round(y), round(x + width), round(y + height))
    draw.rounded_rectangle(guide, radius=max(4, round(height / 2)), outline=(120, 255, 170, 255), width=4, fill=(120, 255, 170, 35))
    center = (round(x + width / 2), round(y + height / 2))
    draw.line((center[0] - 12, center[1], center[0] + 12, center[1]), fill=(255, 255, 255, 220), width=2)
    draw.line((center[0], center[1] - 8, center[0], center[1] + 8), fill=(255, 255, 255, 220), width=2)
    return layer


def build_eye_guide(canvas_size: tuple[int, int], eye_boxes: dict[str, tuple[float, float, float, float]]) -> Image.Image:
    layer = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for box in eye_boxes.values():
        x, y, width, height = box
        draw.rounded_rectangle(
            (round(x), round(y), round(x + width), round(y + height)),
            radius=max(3, round(height / 2)),
            outline=(120, 190, 255, 255),
            width=4,
            fill=(120, 190, 255, 30),
        )
    return layer


def build_control_points(
    face_box: tuple[float, float, float, float],
    body_box: tuple[float, float, float, float],
    mouth_box: tuple[float, float, float, float],
    eye_boxes: dict[str, tuple[float, float, float, float]],
    canvas_size: tuple[int, int],
) -> dict[str, Any]:
    width, height = canvas_size

    def point(label: str, x: float, y: float) -> dict[str, Any]:
        return {"label": label, "x": round(x, 2), "y": round(y, 2), "nx": round(x / width, 5), "ny": round(y / height, 5)}

    fx, fy, fw, fh = face_box
    bx, by, bw, bh = body_box
    mx, my, mw, mh = mouth_box
    left_eye = eye_boxes["left"]
    right_eye = eye_boxes["right"]
    return {
        "faceCenter": point("faceCenter", fx + fw / 2, fy + fh / 2),
        "mouthCenter": point("mouthCenter", mx + mw / 2, my + mh / 2),
        "leftEyeCenter": point("leftEyeCenter", left_eye[0] + left_eye[2] / 2, left_eye[1] + left_eye[3] / 2),
        "rightEyeCenter": point("rightEyeCenter", right_eye[0] + right_eye[2] / 2, right_eye[1] + right_eye[3] / 2),
        "neckPivot": point("neckPivot", fx + fw / 2, fy + fh * 1.08),
        "breathCenter": point("breathCenter", bx + bw / 2, by + bh * 0.55),
        "bodyCenter": point("bodyCenter", bx + bw / 2, by + bh / 2),
    }


def inspect_runtime() -> dict[str, Any]:
    runtime: dict[str, Any] = {
        "gpu": {"available": False, "name": None, "driver": None, "cuda": None},
        "libraries": {"numpy": np.__version__, "pillow": Image.__version__},
    }
    try:
        proc = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            first = [part.strip() for part in proc.stdout.strip().splitlines()[0].split(",")]
            runtime["gpu"] = {
                "available": True,
                "name": first[0] if len(first) > 0 else None,
                "driver": first[1] if len(first) > 1 else None,
                "memory": first[2] if len(first) > 2 else None,
            }
    except Exception:  # noqa: BLE001
        pass

    for library in ("torch", "onnxruntime", "cv2"):
        try:
            module = __import__(library)
            runtime["libraries"][library] = getattr(module, "__version__", "installed")
            if library == "torch":
                runtime["libraries"]["torch_cuda_available"] = bool(module.cuda.is_available())
                runtime["libraries"]["torch_cuda_device"] = module.cuda.get_device_name(0) if module.cuda.is_available() else None
        except Exception:  # noqa: BLE001
            runtime["libraries"][library] = None
    return runtime


def estimate_worker_quality(
    face_box: tuple[float, float, float, float],
    body_box: tuple[float, float, float, float],
    preprocess: dict[str, Any] | None,
) -> dict[str, Any]:
    issues: list[str] = []
    score = 80
    if face_box[2] < 120 or face_box[3] < 120:
        score -= 18
        issues.append("Face is small on the normalized canvas; rigging details may need AI enhancement.")
    if body_box[3] < CANVAS_SIZE[1] * 0.55:
        score -= 12
        issues.append("Body coverage is limited; full-body Live2D needs outpainting or another source image.")
    if preprocess:
        quality = preprocess.get("quality")
        if isinstance(quality, dict):
            for issue in quality.get("issues") or []:
                if isinstance(issue, str) and issue not in issues:
                    issues.append(issue)
    return {"score": max(0, min(100, score)), "issues": issues}


def build_manifest(
    cfg: WorkerConfig,
    job_id: str,
    name: str,
    mime_type: str,
    artifact_paths: dict[str, Path],
    control_points: dict[str, Any],
    analysis: dict[str, Any],
) -> dict[str, Any]:
    artifacts = {
        key: {
            "path": str(path),
            "url": public_url(cfg, job_id, path.relative_to(cfg.public_root / job_id).as_posix()),
        }
        for key, path in artifact_paths.items()
    }
    return {
        "version": WORKER_VERSION,
        "jobId": job_id,
        "name": name,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": {"mimeType": mime_type},
        "target": {
            "format": "live2d-cubism4",
            "canvas": {"width": CANVAS_SIZE[0], "height": CANVAS_SIZE[1]},
            "requiredFinalFiles": ["model3.json", "moc3", "textures", "physics3.json", "expressions"],
        },
        "artifacts": artifacts,
        "controlPoints": control_points,
        "analysis": analysis,
        "rigging": {
            "status": "pending_provider",
            "providerEndpointConfigured": bool(cfg.rigging_endpoint),
            "cubismBridgeConfigured": bool(cfg.cubism_bridge_command),
            "inputManifest": artifacts["manifest"]["url"],
            "psdLayerPackage": artifacts["psdLayerPackage"]["url"],
            "psdLayerManifest": artifacts["psdLayerManifest"]["url"],
            "cubismTask": artifacts["cubismTask"]["url"],
            "psdSource": artifacts.get("psdSource", {}).get("url"),
            "cubismTemplateProject": cfg.cubism_template_project or None,
            "note": "Use this manifest as the contract for a Cubism rigging service, Cubism automation bridge, or manual Cubism Editor handoff.",
        },
    }


def extract_region_layer(image: Image.Image, box: tuple[float, float, float, float], pad: float) -> Image.Image:
    x, y, width, height = box
    padding_x = width * pad
    padding_y = height * pad
    x1 = max(0, round(x - padding_x))
    y1 = max(0, round(y - padding_y))
    x2 = min(image.width, round(x + width + padding_x))
    y2 = min(image.height, round(y + height + padding_y))
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    layer.alpha_composite(image.crop((x1, y1, x2, y2)), (x1, y1))
    return layer


def write_psd_layer_package(
    cfg: WorkerConfig,
    job_id: str,
    name: str,
    worker_dir: Path,
    plate: Image.Image,
    normalized: Image.Image,
    background: Image.Image,
    person_rgba: Image.Image,
    face_reference: Image.Image,
    mouth_reference: Image.Image,
    left_eye_reference: Image.Image,
    right_eye_reference: Image.Image,
    mouth_guide: Image.Image,
    eye_guide: Image.Image,
    person_mask: Image.Image,
    control_points: dict[str, Any],
    analysis: dict[str, Any],
) -> dict[str, Path]:
    package_dir = worker_dir / "psd_layer_package"
    layer_dir = package_dir / "layers"
    layer_dir.mkdir(parents=True, exist_ok=True)

    layer_specs = [
        {
            "name": "00_REF_source_plate",
            "file": "layers/00_REF_source_plate.png",
            "role": "reference",
            "purpose": "Normalized source plate for manual checking. Keep hidden in final PSD.",
            "image": plate.convert("RGBA"),
            "visible": False,
        },
        {
            "name": "01_BG_separated_blur",
            "file": "layers/01_BG_separated_blur.png",
            "role": "background",
            "purpose": "Separated background reference. Not usually rigged as an ArtMesh.",
            "image": background,
            "visible": True,
        },
        {
            "name": "10_BODY_character_base",
            "file": "layers/10_BODY_character_base.png",
            "role": "body_base",
            "purpose": "Current transparent character plate. Rigger should split this into hair, head, torso, arms, and accessories.",
            "image": person_rgba,
            "visible": True,
        },
        {
            "name": "20_HEAD_face_reference",
            "file": "layers/20_HEAD_face_reference.png",
            "role": "face_reference",
            "purpose": "Face area reference for future head, eyes, brows, nose, mouth, and cheek layer separation.",
            "image": face_reference,
            "visible": True,
        },
        {
            "name": "30_EYE_left_reference",
            "file": "layers/30_EYE_left_reference.png",
            "role": "left_eye_reference",
            "purpose": "Left eye reference. Split into white, iris, highlight, upper lid, lower lid, and lash layers before final rigging.",
            "image": left_eye_reference,
            "visible": True,
        },
        {
            "name": "31_EYE_right_reference",
            "file": "layers/31_EYE_right_reference.png",
            "role": "right_eye_reference",
            "purpose": "Right eye reference. Split into white, iris, highlight, upper lid, lower lid, and lash layers before final rigging.",
            "image": right_eye_reference,
            "visible": True,
        },
        {
            "name": "40_MOUTH_reference",
            "file": "layers/40_MOUTH_reference.png",
            "role": "mouth_reference",
            "purpose": "Mouth source patch. Rigger should create closed, open, smile, and vowel mouth drawings from this region.",
            "image": mouth_reference,
            "visible": True,
        },
        {
            "name": "80_GUIDE_mouth_box",
            "file": "layers/80_GUIDE_mouth_box.png",
            "role": "guide_mouth",
            "purpose": "Mouth control guide. Hide before final PSD export if Cubism import should ignore guides.",
            "image": mouth_guide,
            "visible": False,
        },
        {
            "name": "81_GUIDE_eye_boxes",
            "file": "layers/81_GUIDE_eye_boxes.png",
            "role": "guide_eyes",
            "purpose": "Eye control guide. Hide before final PSD export if Cubism import should ignore guides.",
            "image": eye_guide,
            "visible": False,
        },
        {
            "name": "90_MASK_person_alpha",
            "file": "layers/90_MASK_person_alpha.png",
            "role": "mask",
            "purpose": "Alpha mask used to separate the character. Useful for cleanup and QA.",
            "image": person_mask.convert("RGBA"),
            "visible": False,
        },
        {
            "name": "99_PREVIEW_normalized",
            "file": "layers/99_PREVIEW_normalized.png",
            "role": "preview",
            "purpose": "Preview composite only. Keep hidden in final PSD.",
            "image": normalized.convert("RGBA"),
            "visible": False,
        },
    ]

    for spec in layer_specs:
        spec["image"].save(package_dir / str(spec["file"]))

    canvas = {"width": CANVAS_SIZE[0], "height": CANVAS_SIZE[1]}
    layer_manifest = {
        "version": "1.0",
        "kind": "psd-layer-package",
        "jobId": job_id,
        "name": name,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "canvas": canvas,
        "coordinateSystem": "pixel-top-left",
        "psdAssembly": {
            "recommendedFilename": f"{job_id}_{slugify_filename(name)}_cubism_source.psd",
            "instructions": [
                "Import all PNG files as same-size layers in the listed order.",
                "Keep layer names exactly as listed; Cubism and downstream scripts use these names.",
                "Use guide and preview layers for cleanup, then hide or remove them before final Cubism PSD import.",
                "Before final rigging, split BODY/HEAD/EYE/MOUTH reference layers into true art parts.",
            ],
        },
        "layers": [
            {key: value for key, value in spec.items() if key != "image"}
            for spec in layer_specs
        ],
        "requiredManualOrAISeparation": [
            "hair_front", "hair_back", "head", "neck", "torso", "left_arm", "right_arm",
            "left_eye_white", "left_iris", "left_eye_highlight", "left_upper_lid", "left_lower_lid",
            "right_eye_white", "right_iris", "right_eye_highlight", "right_upper_lid", "right_lower_lid",
            "mouth_closed", "mouth_open", "mouth_smile", "mouth_vowel_a", "brows", "nose", "cheeks",
        ],
        "cubismParameterTargets": [
            "ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ",
            "ParamEyeLOpen", "ParamEyeROpen", "ParamEyeBallX", "ParamEyeBallY", "ParamMouthOpenY", "ParamMouthForm", "ParamBreath",
        ],
        "controlPoints": control_points,
        "quality": analysis.get("quality", {}),
        "analysis": {
            "sourceBoxes": analysis.get("sourceBoxes", {}),
            "canvasBoxes": analysis.get("canvasBoxes", {}),
            "segmentation": analysis.get("segmentation", {}),
        },
    }

    layer_manifest_path = package_dir / "layer_manifest.json"
    layer_manifest_path.write_text(json.dumps(layer_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    psd_source_path, psd_status_path = write_psd_source_if_possible(package_dir, layer_specs, layer_manifest)

    cubism_task = {
        "version": "1.0",
        "taskType": "cubism-editor-template-rig",
        "jobId": job_id,
        "name": name,
        "status": "waiting_bridge" if cfg.cubism_bridge_command else "bridge_not_configured",
        "input": {
            "layerManifest": "layer_manifest.json",
            "layerPackageZip": "../psd_layer_package.zip",
            "expectedPsd": layer_manifest["psdAssembly"]["recommendedFilename"],
            "psdSource": psd_source_path.name if psd_source_path else None,
            "psdGenerationStatus": psd_status_path.name,
            "canvas": canvas,
        },
        "cubism": {
            "editor": "Live2D Cubism Editor",
            "templateProject": cfg.cubism_template_project or None,
            "recommendedWorkflow": [
                "Assemble or generate PSD from the PNG layer package.",
                "Open the PSD in Cubism Editor and verify part names/groups.",
                "Apply the selected template rig or copy deformers from a prepared template project.",
                "Bind mouth, eye, breath, head angle, and body angle parameters.",
                "Export runtime model files: .moc3, .model3.json, textures, physics3.json, expressions.",
            ],
            "expectedOutput": {
                "directory": "../cubism_output",
                "model3Json": f"../cubism_output/{slugify_filename(name)}.model3.json",
            },
        },
        "automationBridge": {
            "commandConfigured": bool(cfg.cubism_bridge_command),
            "commandContract": {
                "env": ["LIVE2D_CUBISM_TASK", "LIVE2D_CUBISM_MANIFEST"],
                "argument": "The task path is appended if the command does not contain {task} or {manifest} placeholders.",
                "stdoutJson": {
                    "modelUrl": "/generated-live2d/<job>/cubism_output/model.model3.json",
                    "message": "optional status message",
                    "providerNote": "optional bridge note",
                },
            },
        },
    }
    cubism_task_path = package_dir / "cubism_task.json"
    cubism_task_path.write_text(json.dumps(cubism_task, ensure_ascii=False, indent=2), encoding="utf-8")

    readme_path = package_dir / "README.md"
    readme_path.write_text(build_layer_package_readme(job_id, name, layer_manifest), encoding="utf-8")

    zip_path = worker_dir / "psd_layer_package.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(package_dir.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(package_dir.parent).as_posix())

    result = {
        "psdLayerPackage": zip_path,
        "psdLayerManifest": layer_manifest_path,
        "cubismTask": cubism_task_path,
        "cubismReadme": readme_path,
        "psdGenerationStatus": psd_status_path,
    }
    if psd_source_path:
        result["psdSource"] = psd_source_path
    return result


def write_psd_source_if_possible(
    package_dir: Path,
    layer_specs: list[dict[str, Any]],
    layer_manifest: dict[str, Any],
) -> tuple[Path | None, Path]:
    psd_path = package_dir / str(layer_manifest["psdAssembly"]["recommendedFilename"])
    status_path = package_dir / "psd_generation_status.json"
    status: dict[str, Any] = {
        "ok": False,
        "psdPath": str(psd_path),
        "dependency": "psd-tools>=1.10",
        "layerCount": len(layer_specs),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }

    try:
        from psd_tools import PSDImage  # type: ignore
    except Exception as exc:  # noqa: BLE001 - optional dependency boundary.
        status.update(
            {
                "status": "dependency_missing",
                "message": "Install psd-tools to write a layered PSD source file. PNG layer package is still usable.",
                "error": str(exc),
            }
        )
        status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
        return None, status_path

    try:
        psd = PSDImage.new("RGBA", CANVAS_SIZE, color=0)
        groups: dict[str, Any] = {}
        for spec in layer_specs:
            group_name = psd_group_for_role(str(spec.get("role", "reference")))
            group = groups.get(group_name)
            if group is None:
                group = psd.create_group(name=group_name)
                psd.append(group)
                groups[group_name] = group
            pixel_layer = psd.create_pixel_layer(
                spec["image"].convert("RGBA"),
                name=str(spec["name"]),
                top=0,
                left=0,
            )
            if hasattr(pixel_layer, "visible"):
                pixel_layer.visible = bool(spec.get("visible", True))
            group.append(pixel_layer)

        psd.save(psd_path)
        status.update(
            {
                "ok": True,
                "status": "written",
                "message": "Layered PSD source file was written for Cubism Editor import.",
                "psdFilename": psd_path.name,
                "groups": list(groups.keys()),
            }
        )
        status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
        return psd_path, status_path
    except Exception as exc:  # noqa: BLE001 - generation must not hide PNG package.
        status.update(
            {
                "status": "failed",
                "message": "PSD generation failed; PNG layer package is still usable.",
                "error": str(exc),
            }
        )
        status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
        return None, status_path


def psd_group_for_role(role: str) -> str:
    if role.startswith("guide") or role in {"mask", "preview", "reference"}:
        return "99_REFERENCES_AND_GUIDES"
    if role == "background":
        return "00_BACKGROUND"
    if "eye" in role or "mouth" in role or "face" in role:
        return "20_FACE_PARTS"
    return "10_CHARACTER_BASE"

def build_layer_package_readme(job_id: str, name: str, layer_manifest: dict[str, Any]) -> str:
    return f"""# Live2D PSD Layer Package

Job: `{job_id}`
Name: `{name}`
Canvas: {CANVAS_SIZE[0]} x {CANVAS_SIZE[1]}

This folder is a PSD-ready layer handoff package. It does not claim to be a final Cubism `.moc3` model.

## Files

- `layer_manifest.json`: strict layer order, layer roles, control points, and quality notes.
- `cubism_task.json`: contract for a Cubism Editor automation bridge or manual rigger.
- `<job>_cubism_source.psd`: layered PSD source for direct Cubism Editor import when `psd-tools` is installed.
- `psd_generation_status.json`: tells whether the PSD was written or which dependency/configuration blocked it.
- `layers/*.png`: same-canvas transparent layers that can be stacked into a PSD.

## Manual PSD Assembly

1. If `<job>_cubism_source.psd` exists, open that file directly in Cubism Editor or Photoshop for cleanup.
2. If the PSD is not present, open Photoshop, Krita, Photopea, or another PSD-capable editor.
3. Import every file in `layers/` as a same-size layer, preserving the names and order from `layer_manifest.json`.
4. Use the guide layers to split the reference art into real Cubism parts.
5. Hide or remove guide/preview/mask layers before final Cubism import.
6. Save as `{layer_manifest['psdAssembly']['recommendedFilename']}`.

## Cubism Bridge

If `LIVE2D_CUBISM_BRIDGE_COMMAND` is configured, the worker will execute that command with:

- `LIVE2D_CUBISM_TASK` = absolute path to `cubism_task.json`
- `LIVE2D_CUBISM_MANIFEST` = absolute path to worker `manifest.json`

The bridge should output JSON on stdout when it produces a runtime model, for example:

```json
{{"modelUrl":"/generated-live2d/{job_id}/cubism_output/model.model3.json","message":"Cubism export complete"}}
```
"""


def run_cubism_bridge_if_configured(cfg: WorkerConfig, manifest: dict[str, Any]) -> dict[str, Any]:
    if not cfg.cubism_bridge_command:
        return {}

    task_path = Path(manifest["artifacts"]["cubismTask"]["path"])
    manifest_path = Path(manifest["artifacts"]["manifest"]["path"])
    command = cfg.cubism_bridge_command
    if "{task}" in command or "{manifest}" in command:
        command = command.replace("{task}", str(task_path)).replace("{manifest}", str(manifest_path))
    else:
        command = f'{command} "{task_path}"'

    env = os.environ.copy()
    env["LIVE2D_CUBISM_TASK"] = str(task_path)
    env["LIVE2D_CUBISM_MANIFEST"] = str(manifest_path)
    started = time.perf_counter()
    proc = subprocess.run(
        command,
        cwd=str(task_path.parent),
        env=env,
        shell=True,
        capture_output=True,
        text=True,
        timeout=cfg.cubism_bridge_timeout_sec,
        check=False,
    )
    log_path = task_path.parent / "cubism_bridge.log"
    log_path.write_text(
        json.dumps(
            {
                "command": command,
                "returnCode": proc.returncode,
                "elapsedMs": round((time.perf_counter() - started) * 1000),
                "stdout": proc.stdout,
                "stderr": proc.stderr,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Cubism bridge failed with exit code {proc.returncode}; see {log_path}")
    parsed = parse_last_json_object(proc.stdout)
    if not parsed:
        return {
            "message": "Cubism bridge finished without returning a model URL.",
            "providerNote": f"Cubism bridge log: {log_path}",
        }
    if "providerNote" not in parsed:
        parsed["providerNote"] = f"Cubism bridge log: {log_path}"
    return parsed


def parse_last_json_object(value: str) -> dict[str, Any]:
    text = value.strip()
    if not text:
        return {}
    for start in [index for index, char in enumerate(text) if char == "{"][::-1]:
        candidate = text[start:]
        try:
            parsed = json.loads(candidate)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            continue
    return {}


def slugify_filename(value: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip().lower()).strip("-")
    return clean[:48] or "avatar"

def run_rigging_provider_if_configured(cfg: WorkerConfig, manifest: dict[str, Any]) -> dict[str, Any]:
    if not cfg.rigging_endpoint:
        return {}
    import urllib.error
    import urllib.request

    body = json.dumps({"manifest": manifest}, ensure_ascii=False).encode("utf-8")
    headers = {"content-type": "application/json"}
    if cfg.rigging_api_key:
        headers["authorization"] = f"Bearer {cfg.rigging_api_key}"
    request = urllib.request.Request(cfg.rigging_endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=240) as response:  # noqa: S310 - explicit user configured provider URL.
            raw = response.read().decode("utf-8")
            data = json.loads(raw) if raw else {}
            return data if isinstance(data, dict) else {}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"rigging provider returned {exc.code}") from exc


def box_to_json(box: tuple[float, float, float, float]) -> dict[str, float]:
    x, y, width, height = box
    return {"x": round(x, 2), "y": round(y, 2), "width": round(width, 2), "height": round(height, 2)}

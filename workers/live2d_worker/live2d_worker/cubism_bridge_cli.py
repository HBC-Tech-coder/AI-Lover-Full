from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

DEFAULT_EDITOR_CANDIDATES = [
    # The current Windows installer uses this flatter Cubism 5.3 path.
    r"C:\Program Files\Live2D Cubism 5.3\CubismEditor5.exe",
    r"C:\Program Files\Live2D\Cubism5\Cubism Editor 5\CubismEditor5.exe",
    r"C:\Program Files\Live2D\Cubism4\Cubism Editor 4\CubismEditor4.exe",
]

JsonDict = dict[str, Any]


def main() -> None:
    parser = argparse.ArgumentParser(description="Bridge AI-Lover Live2D layer packages into Cubism automation.")
    parser.add_argument("task", nargs="?", help="Path to cubism_task.json. Defaults to LIVE2D_CUBISM_TASK.")
    parser.add_argument("--manifest", help="Path to worker manifest.json. Defaults to LIVE2D_CUBISM_MANIFEST.")
    parser.add_argument("--mode", choices=["plan", "open", "adapter", "live2d-automation"], default=os.getenv("LIVE2D_CUBISM_BRIDGE_MODE", "plan"))
    parser.add_argument("--editor-path", default=os.getenv("LIVE2D_CUBISM_EDITOR_PATH") or os.getenv("CUBISM_EDITOR_PATH") or "")
    parser.add_argument("--template-id", default=os.getenv("LIVE2D_CUBISM_TEMPLATE_ID", "standard_bust_up"))
    parser.add_argument("--model-name", default=os.getenv("LIVE2D_CUBISM_MODEL_NAME", ""))
    parser.add_argument("--timeout-sec", type=int, default=int(os.getenv("LIVE2D_CUBISM_BRIDGE_ACTION_TIMEOUT_SEC", "900")))
    args = parser.parse_args()

    try:
        result = run_bridge(args)
    except Exception as exc:  # noqa: BLE001 - command boundary serializes failures.
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1) from exc

    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0)


def run_bridge(args: argparse.Namespace) -> JsonDict:
    task_path = Path(args.task or os.getenv("LIVE2D_CUBISM_TASK", "")).expanduser().resolve()
    if not task_path.exists():
        raise FileNotFoundError(f"cubism task not found: {task_path}")
    manifest_path = Path(args.manifest or os.getenv("LIVE2D_CUBISM_MANIFEST", "")).expanduser().resolve()
    if not manifest_path.exists():
        raise FileNotFoundError(f"worker manifest not found: {manifest_path}")

    task = load_json(task_path)
    manifest = load_json(manifest_path)
    package_dir = task_path.parent
    worker_dir = package_dir.parent
    job_dir = worker_dir.parent
    output_dir = job_dir / "cubism_output"
    output_dir.mkdir(parents=True, exist_ok=True)

    model_name = sanitize_model_name(args.model_name or str(task.get("name") or manifest.get("name") or task.get("jobId") or "avatar"))
    psd_path = resolve_psd_path(task, package_dir)
    editor = discover_editor(args.editor_path)
    plan = build_plan(
        task=task,
        manifest=manifest,
        mode=args.mode,
        task_path=task_path,
        manifest_path=manifest_path,
        psd_path=psd_path,
        output_dir=output_dir,
        editor=editor,
        template_id=args.template_id,
        model_name=model_name,
    )
    plan_path = output_dir / "cubism_bridge_plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.mode == "plan":
        return bridge_waiting_result(manifest, plan_path, "Cubism bridge plan was written. Set LIVE2D_CUBISM_BRIDGE_MODE=open, adapter, or live2d-automation to execute it.")
    if args.mode == "open":
        return run_open_mode(manifest, editor, psd_path, plan_path)
    if args.mode == "adapter":
        return run_adapter_mode(manifest, psd_path, output_dir, model_name, args.template_id, editor, plan_path, args.timeout_sec)
    if args.mode == "live2d-automation":
        return run_live2d_automation_mode(manifest, psd_path, output_dir, model_name, args.template_id, editor, plan_path, args.timeout_sec)
    raise ValueError(f"unsupported bridge mode: {args.mode}")


def load_json(path: Path) -> JsonDict:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_psd_path(task: JsonDict, package_dir: Path) -> Path | None:
    input_data = task.get("input") if isinstance(task.get("input"), dict) else {}
    candidates = []
    for key in ("psdSource", "expectedPsd"):
        value = input_data.get(key)
        if isinstance(value, str) and value:
            candidates.append(package_dir / value)
    candidates.extend(sorted(package_dir.glob("*.psd")))
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved.exists() and resolved.is_file():
            return resolved
    return None


def discover_editor(explicit_path: str) -> JsonDict:
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path).expanduser())
    candidates.extend(Path(item) for item in DEFAULT_EDITOR_CANDIDATES)
    checked = []
    for candidate in candidates:
        checked.append(str(candidate))
        if candidate.exists() and candidate.is_file():
            return {"status": "available", "path": str(candidate.resolve()), "checked": checked}
    return {"status": "missing", "path": None, "checked": checked}


def build_plan(**kwargs: Any) -> JsonDict:
    psd_path: Path | None = kwargs["psd_path"]
    editor: JsonDict = kwargs["editor"]
    status = "ready"
    blockers = []
    if psd_path is None:
        status = "blocked"
        blockers.append("No layered PSD source found. Install psd-tools and regenerate the Live2D job, or assemble the PNG layers into the expected PSD.")
    if editor.get("status") != "available" and kwargs["mode"] in {"open", "adapter", "live2d-automation"}:
        status = "blocked"
        blockers.append("Cubism Editor executable was not found. Set LIVE2D_CUBISM_EDITOR_PATH or CUBISM_EDITOR_PATH.")
    return {
        "version": "1.0",
        "status": status,
        "mode": kwargs["mode"],
        "blockers": blockers,
        "taskPath": str(kwargs["task_path"]),
        "manifestPath": str(kwargs["manifest_path"]),
        "psdPath": str(psd_path) if psd_path else None,
        "outputDir": str(kwargs["output_dir"]),
        "modelName": kwargs["model_name"],
        "templateId": kwargs["template_id"],
        "editor": editor,
        "steps": [
            {"action": "import_psd", "status": "pending", "requires": ["psdPath", "editor"]},
            {"action": "apply_template", "status": "pending", "requires": ["templateId"]},
            {"action": "export_embedded_data", "status": "pending", "requires": ["outputDir"]},
            {"action": "validate_runtime_bundle", "status": "pending", "requires": ["model3.json", ".moc3"]},
        ],
    }


def run_open_mode(manifest: JsonDict, editor: JsonDict, psd_path: Path | None, plan_path: Path) -> JsonDict:
    if not psd_path:
        raise FileNotFoundError("PSD source is required for open mode")
    if not editor.get("path"):
        raise FileNotFoundError("Cubism Editor executable is required for open mode")
    # Opening the PSD is the first safe automation boundary. Cubism still needs
    # manual rigging or a calibrated GUI automation adapter before it can export
    # a production .moc3 runtime bundle.
    subprocess.Popen([str(editor["path"]), str(psd_path)], cwd=str(psd_path.parent))  # noqa: S603 - configured local GUI path.
    return bridge_waiting_result(manifest, plan_path, "Cubism Editor was opened with the generated PSD. Export a real runtime model to cubism_output to finish the job.")


def run_adapter_mode(
    manifest: JsonDict,
    psd_path: Path | None,
    output_dir: Path,
    model_name: str,
    template_id: str,
    editor: JsonDict,
    plan_path: Path,
    timeout_sec: int,
) -> JsonDict:
    adapter = os.getenv("LIVE2D_NATIVE_GUI_ADAPTER_COMMAND", "").strip()
    if not adapter:
        raise RuntimeError("LIVE2D_NATIVE_GUI_ADAPTER_COMMAND is required for adapter mode")
    if not psd_path:
        raise FileNotFoundError("PSD source is required for adapter mode")

    logs = []
    for action in ("launch_editor", "import_psd", "apply_template", "export_embedded_data"):
        command = build_adapter_command(adapter, action, output_dir, model_name, template_id, editor.get("path"), psd_path)
        proc = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=timeout_sec, check=False)  # noqa: S602 - explicit local bridge command.
        logs.append({"action": action, "command": command, "returnCode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr})
        if proc.returncode == 64 and action in {"apply_template", "export_embedded_data"}:
            continue
        if proc.returncode != 0:
            raise RuntimeError(f"adapter action failed: {action}; exit {proc.returncode}")
    write_bridge_log(output_dir, "adapter", logs)
    return runtime_result_or_waiting(manifest, output_dir, plan_path, "Native GUI adapter finished, but no validated Cubism runtime bundle was found yet.")


def build_adapter_command(adapter: str, action: str, output_dir: Path, model_name: str, template_id: str, editor_path: str | None, psd_path: Path) -> str:
    args = [action, "--output-dir", str(output_dir), "--model-name", model_name, "--template-id", template_id]
    if editor_path:
        args.extend(["--editor-path", str(Path(editor_path))])
    if action == "import_psd":
        args.extend(["--psd-path", str(psd_path)])
    return f"{adapter} {subprocess.list2cmdline(args)}"


def run_live2d_automation_mode(
    manifest: JsonDict,
    psd_path: Path | None,
    output_dir: Path,
    model_name: str,
    template_id: str,
    editor: JsonDict,
    plan_path: Path,
    timeout_sec: int,
) -> JsonDict:
    if not psd_path:
        raise FileNotFoundError("PSD source is required for live2d-automation mode")
    custom_command = os.getenv("LIVE2D_AUTOMATION_COMMAND", "").strip()
    if custom_command:
        command = custom_command.replace("{psd}", str(psd_path)).replace("{output}", str(output_dir)).replace("{model}", model_name).replace("{template}", template_id)
        if editor.get("path"):
            command = command.replace("{editor}", str(editor["path"]))
        cwd = None
    else:
        repo = os.getenv("LIVE2D_AUTOMATION_REPO", "").strip()
        native_mode = os.getenv("LIVE2D_AUTOMATION_NATIVE_GUI_MODE", "dry_run")
        base = [sys.executable, "-m", "mcp_server.cli", "calibrate-template"]
        command_parts = [
            *base,
            "--output-dir", str(output_dir),
            "--model-name", model_name,
            "--template-id", template_id,
            "--psd-path", str(psd_path),
            "--native-gui-controller-mode", native_mode,
        ]
        if editor.get("path"):
            command_parts.extend(["--editor-path", str(editor["path"])])
        command = subprocess.list2cmdline(command_parts)
        cwd = repo or None

    started = time.perf_counter()
    proc = subprocess.run(command, cwd=cwd, shell=True, capture_output=True, text=True, timeout=timeout_sec, check=False)  # noqa: S602 - configured local automation command.
    write_bridge_log(
        output_dir,
        "live2d_automation",
        [{"command": command, "cwd": cwd, "returnCode": proc.returncode, "elapsedMs": round((time.perf_counter() - started) * 1000), "stdout": proc.stdout, "stderr": proc.stderr}],
    )
    if proc.returncode != 0:
        raise RuntimeError(f"live2d-automation bridge failed with exit code {proc.returncode}")
    return runtime_result_or_waiting(manifest, output_dir, plan_path, "live2d-automation finished, but no validated Cubism runtime bundle was found yet.")


def runtime_result_or_waiting(manifest: JsonDict, output_dir: Path, plan_path: Path, waiting_message: str) -> JsonDict:
    model3_path = find_valid_runtime_model(output_dir)
    if model3_path:
        return {
            "modelUrl": public_url_for_path(manifest, model3_path),
            "message": "Cubism runtime model was validated.",
            "providerNote": f"Cubism bridge plan: {public_url_for_path(manifest, plan_path)}",
            "templatePreview": False,
        }
    return bridge_waiting_result(manifest, plan_path, waiting_message)


def find_valid_runtime_model(output_dir: Path) -> Path | None:
    for model3_path in sorted(output_dir.glob("*.model3.json")):
        try:
            data = load_json(model3_path)
        except Exception:  # noqa: BLE001
            continue
        refs = data.get("FileReferences") if isinstance(data.get("FileReferences"), dict) else data.get("fileReferences", {})
        moc = None
        if isinstance(refs, dict):
            moc = refs.get("Moc") or refs.get("moc")
        if isinstance(moc, str) and (model3_path.parent / moc).exists():
            return model3_path
    return None


def bridge_waiting_result(manifest: JsonDict, plan_path: Path, message: str) -> JsonDict:
    return {
        "message": message,
        "providerNote": f"Cubism bridge plan: {public_url_for_path(manifest, plan_path)}",
        "cubismBridgePlanUrl": public_url_for_path(manifest, plan_path),
    }


def public_url_for_path(manifest: JsonDict, path: Path) -> str:
    manifest_artifact = manifest.get("artifacts", {}).get("manifest", {}) if isinstance(manifest.get("artifacts"), dict) else {}
    manifest_file = Path(str(manifest_artifact.get("path", "")))
    manifest_url = str(manifest_artifact.get("url", ""))
    if manifest_file.exists() and manifest_url:
        job_dir = manifest_file.parent.parent
        base_url = manifest_url.removesuffix("/worker/manifest.json")
        try:
            return f"{base_url}/{path.resolve().relative_to(job_dir.resolve()).as_posix()}"
        except ValueError:
            pass
    return str(path)


def write_bridge_log(output_dir: Path, name: str, records: list[JsonDict]) -> None:
    (output_dir / f"{name}_bridge.log.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


def sanitize_model_name(value: str) -> str:
    clean = "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in value.strip().lower()).strip("-")
    return clean[:48] or "avatar"




if __name__ == "__main__":
    main()

"""Local HTTP bridge for the RK3566 robot head motion controller.

Run in dry-run mode first:

    python hardware/head_motion_bridge.py

Real serial mode:

    pip install pyserial
    set HEAD_MOTION_DRY_RUN=0
    set HEAD_MOTION_SERIAL_PORT=/dev/ttyS4
    python hardware/head_motion_bridge.py

ADB debug mode, useful when the RK3566 head is already on the LAN:

    set HEAD_MOTION_TRANSPORT=adb
    set HEAD_MOTION_DRY_RUN=0
    set HEAD_MOTION_ADB_SERIAL=192.168.3.136:5555
    python hardware/head_motion_bridge.py

The frontend calls POST /action with {"action": "smile"} or
{"action": "servo", "location": 6, "angle": 120, "speed": 5}.
"""

from __future__ import annotations

import json
import io
import os
import random
import re
import shutil
import socket
import subprocess
import threading
import time
import wave
import base64
import audioop
import tempfile
import queue
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional

from head_motion_protocol import (
    ACTION_SEQUENCES,
    RAW,
    Step,
    action_names,
    build_servo_frames,
    hex_frame,
)


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class SerialTransport:
    kind = "serial"

    def __init__(self, port: str, baud: int, dry_run: bool) -> None:
        self.port = port
        self.baud = baud
        self.dry_run = dry_run
        self._serial: Any = None
        self._lock = threading.Lock()

    def _ensure_open(self) -> None:
        if self.dry_run:
            return
        if self._serial is not None:
            return
        try:
            import serial  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "pyserial is required when HEAD_MOTION_DRY_RUN=0"
            ) from exc
        self._serial = serial.Serial(self.port, self.baud, timeout=0.2)

    def send(self, data: bytes) -> None:
        with self._lock:
            self._ensure_open()
            if self.dry_run:
                print(f"[dry-run] {hex_frame(data)}")
                return
            self._serial.write(data)
            self._serial.flush()
            print(f"[serial] {hex_frame(data)}")


def default_adb_path() -> str:
    configured = os.environ.get("HEAD_MOTION_ADB_PATH")
    if configured:
        return configured
    resolved = shutil.which("adb")
    if resolved:
        return resolved
    executable = "adb.exe" if os.name == "nt" else "adb"
    candidates = [
        Path.home() / "xiaoling_local_dev" / "android-platform-tools" / "platform-tools" / executable,
        Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk" / "platform-tools" / executable,
        Path("D:/android-platform-tools/platform-tools") / executable,
        Path("C:/android-platform-tools/platform-tools") / executable,
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return executable


class AdbTransport:
    kind = "adb"

    def __init__(self, adb_path: str, adb_serial: str, port: str, baud: int, dry_run: bool) -> None:
        self.adb_path = adb_path
        self.adb_serial = adb_serial
        self.port = port
        self.baud = baud
        self.dry_run = dry_run
        self._ready = False
        self._lock = threading.Lock()

    def _connect_timeout(self) -> float:
        return float(os.environ.get("HEAD_MOTION_ADB_CONNECT_TIMEOUT_SEC", "20"))

    def _tcp_probe(self) -> None:
        if ":" not in self.adb_serial:
            return
        host, port_text = self.adb_serial.rsplit(":", 1)
        try:
            port = int(port_text)
        except ValueError:
            return
        timeout = float(os.environ.get("HEAD_MOTION_ADB_TCP_PROBE_TIMEOUT_SEC", "3"))
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return
        except OSError as exc:
            raise RuntimeError(
                f"Cannot reach robot head ADB at {host}:{port}. "
                "Check that the PC and head are on the same network, the IP is correct, "
                "and ADB TCP port 5555 is enabled on the head."
            ) from exc

    def _run(self, args: list[str], data: Optional[bytes] = None, timeout: float = 4) -> None:
        proc = subprocess.run(
            [self.adb_path, *args],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        if proc.returncode != 0:
            output = (proc.stderr or proc.stdout).decode("utf-8", errors="replace").strip()
            raise RuntimeError(output or f"adb exited with code {proc.returncode}")

    def _run_capture(self, args: list[str], timeout: float = 8) -> str:
        proc = subprocess.run(
            [self.adb_path, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        output = (proc.stdout + proc.stderr).decode("utf-8", errors="replace").strip()
        if proc.returncode != 0:
            raise RuntimeError(output or f"adb exited with code {proc.returncode}")
        return output

    def _listed_devices(self) -> list[str]:
        output = self._run_capture(["devices"], timeout=8)
        devices: list[str] = []
        for line in output.splitlines():
            line = line.strip()
            if not line or line.lower().startswith("list of devices"):
                continue
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "device":
                devices.append(parts[0])
        return devices

    def _select_usb_device(self) -> str:
        devices = self._listed_devices()
        usb_devices = [
            device
            for device in devices
            if ":" not in device and not device.lower().startswith("emulator-")
        ]
        if not usb_devices:
            raise RuntimeError(
                "No USB ADB device found. Connect the robot head by USB, enable USB debugging, "
                "accept the authorization prompt on the head, then click reconnect."
            )
        if len(usb_devices) > 1:
            print(f"[adb] multiple USB devices found, using first: {usb_devices}")
        return usb_devices[0]

    def _resolve_usb_or_auto_serial(self) -> None:
        value = (self.adb_serial or "").strip().lower()
        if value in {"", "auto", "usb"}:
            self.adb_serial = self._select_usb_device()
            print(f"[adb] using USB device: {self.adb_serial}")

    def _ensure_ready(self) -> None:
        if self.dry_run or self._ready:
            return
        self._resolve_usb_or_auto_serial()
        if ":" in self.adb_serial:
            try:
                self._tcp_probe()
                self._run(["connect", self.adb_serial], timeout=self._connect_timeout())
            except Exception as exc:
                if not env_bool("HEAD_MOTION_ADB_USB_FALLBACK", True):
                    raise
                try:
                    usb_serial = self._select_usb_device()
                except Exception as usb_exc:
                    raise RuntimeError(
                        f"{exc} No USB ADB device was found for fallback."
                    ) from usb_exc
                print(f"[adb] network device {self.adb_serial} unavailable; using USB device {usb_serial}")
                self.adb_serial = usb_serial
        if env_bool("HEAD_MOTION_ADB_ROOT", True):
            try:
                output = self._run_capture(["-s", self.adb_serial, "root"], timeout=8)
                if "restart" in output.lower():
                    time.sleep(1.2)
                    if ":" in self.adb_serial:
                        self._tcp_probe()
                        self._run(["connect", self.adb_serial], timeout=self._connect_timeout())
            except Exception as exc:
                print(f"[adb] root not available, continuing with su 0: {exc}")
        self._run(
            [
                "-s",
                self.adb_serial,
                "shell",
                "stty",
                "-F",
                self.port,
                str(self.baud),
                "raw",
                "-echo",
                "-ixon",
                "-ixoff",
            ],
            timeout=8,
        )
        self._ready = True

    def send(self, data: bytes) -> None:
        with self._lock:
            self._ensure_ready()
            if self.dry_run:
                print(f"[adb dry-run] {self.adb_serial} {hex_frame(data)}")
                return
            self._run(
                ["-s", self.adb_serial, "shell", "-T", f"cat > {self.port}"],
                data=data,
                timeout=4,
            )
            print(f"[adb] {self.adb_serial} {hex_frame(data)}")

    def configure(self, adb_serial: str) -> None:
        adb_serial = adb_serial.strip()
        if not adb_serial:
            adb_serial = "auto"
        with self._lock:
            self.adb_serial = adb_serial
            self._ready = False

    def shell(self, command: str, timeout: float = 8) -> str:
        with self._lock:
            self._ensure_ready()
            return self._run_capture(["-s", self.adb_serial, "shell", command], timeout=timeout)

    def push(self, local_path: str, remote_path: str, timeout: float = 10) -> None:
        with self._lock:
            self._ensure_ready()
            self._run(["-s", self.adb_serial, "push", local_path, remote_path], timeout=timeout)

    def pull(self, remote_path: str, local_path: str, timeout: float = 10) -> None:
        with self._lock:
            self._ensure_ready()
            self._run(["-s", self.adb_serial, "pull", remote_path, local_path], timeout=timeout)


def pcm16_to_wav_bytes(
    pcm: bytes,
    sample_rate: int,
    channels: int,
    bytes_per_sample: int,
) -> bytes:
    channels = max(1, int(channels or 1))
    bytes_per_sample = max(1, int(bytes_per_sample or 2))
    sample_rate = max(1, int(sample_rate or 16000))
    target_sample_rate = int(os.environ.get("HEAD_AUDIO_PLAYBACK_SAMPLE_RATE", "16000"))
    frame_width = channels * bytes_per_sample
    if frame_width > 0 and len(pcm) % frame_width:
        pcm = pcm[: len(pcm) - (len(pcm) % frame_width)]
    if bytes_per_sample != 2 and pcm:
        pcm = audioop.lin2lin(pcm, bytes_per_sample, 2)
        bytes_per_sample = 2
    if pcm and sample_rate != target_sample_rate:
        pcm, _ = audioop.ratecv(
            pcm,
            bytes_per_sample,
            channels,
            sample_rate,
            target_sample_rate,
            None,
        )
        sample_rate = target_sample_rate
    if channels == 1:
        pcm = audioop.tostereo(pcm, bytes_per_sample, 1, 1)
        channels = 2
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        path = tmp.name
    try:
        with wave.open(path, "wb") as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(bytes_per_sample)
            wav.setframerate(sample_rate)
            wav.writeframes(pcm)
        return Path(path).read_bytes()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def decode_audio_payload(
    audio_b64: str,
    sample_rate: int,
    channels: int,
    bytes_per_sample: int,
) -> tuple[bytes, int, int, int, bool]:
    raw = base64.b64decode(audio_b64)
    if raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        with wave.open(io.BytesIO(raw), "rb") as wav:
            return (
                wav.readframes(wav.getnframes()),
                int(wav.getframerate()),
                int(wav.getnchannels()),
                int(wav.getsampwidth()),
                True,
            )
    return (
        raw,
        max(1, int(sample_rate or 16000)),
        max(1, int(channels or 1)),
        max(1, int(bytes_per_sample or 2)),
        False,
    )


def audio_payload_to_wav_bytes(
    audio_b64: str,
    sample_rate: int,
    channels: int,
    bytes_per_sample: int,
) -> tuple[bytes, int]:
    pcm, rate, payload_channels, width, _ = decode_audio_payload(
        audio_b64,
        sample_rate,
        channels,
        bytes_per_sample,
    )
    wav_bytes = pcm16_to_wav_bytes(pcm, rate, payload_channels, width)
    return wav_bytes, len(pcm)


def merge_wav_bytes(chunks: list[bytes]) -> bytes:
    if not chunks:
        return b""
    if len(chunks) == 1:
        return chunks[0]

    frames: list[bytes] = []
    sample_rate: Optional[int] = None
    channels: Optional[int] = None
    sample_width: Optional[int] = None
    for chunk in chunks:
        if not chunk:
            continue
        with wave.open(io.BytesIO(chunk), "rb") as wav:
            rate = int(wav.getframerate())
            channel_count = int(wav.getnchannels())
            width = int(wav.getsampwidth())
            if sample_rate is None:
                sample_rate = rate
                channels = channel_count
                sample_width = width
            if rate != sample_rate or channel_count != channels or width != sample_width:
                continue
            frames.append(wav.readframes(wav.getnframes()))

    if not frames or sample_rate is None or channels is None or sample_width is None:
        return chunks[0]

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        wav.writeframes(b"".join(frames))
    return buffer.getvalue()


def playback_output_failed(output: str) -> bool:
    lowered = (output or "").lower()
    return any(
        marker in lowered
        for marker in (
            "unable to open",
            "cannot set hw params",
            "invalid argument",
            "no such file",
            "not found",
        )
    )


def wav_file_to_pcm16_mono_16k(path: str) -> bytes:
    with wave.open(path, "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        raw = wav.readframes(wav.getnframes())
    if width != 2:
        raw = audioop.lin2lin(raw, width, 2)
        width = 2
    if channels > 1:
        raw = audioop.tomono(raw, width, 0.5, 0.5)
        channels = 1
    if rate != 16000:
        raw, _ = audioop.ratecv(raw, width, channels, rate, 16000, None)
    return raw


MouthEnvelope = list[tuple[float, float]]


def build_mouth_envelope(
    audio_b64: str,
    sample_rate: int,
    channels: int,
    bytes_per_sample: int,
    window_ms: int = 90,
) -> MouthEnvelope:
    pcm, sample_rate, channels, bytes_per_sample, _ = decode_audio_payload(
        audio_b64,
        sample_rate,
        channels,
        bytes_per_sample,
    )
    frame_width = channels * bytes_per_sample
    if frame_width <= 0 or not pcm:
        return []
    if len(pcm) % frame_width:
        pcm = pcm[: len(pcm) - (len(pcm) % frame_width)]
    if not pcm:
        return []
    if bytes_per_sample != 2:
        pcm = audioop.lin2lin(pcm, bytes_per_sample, 2)
        bytes_per_sample = 2
    if channels > 1:
        pcm = audioop.tomono(pcm, bytes_per_sample, 0.5, 0.5)
        channels = 1
    window_bytes = max(2, int(sample_rate * window_ms / 1000) * bytes_per_sample)
    window_bytes -= window_bytes % bytes_per_sample
    rms_values: list[tuple[int, float]] = []
    for start in range(0, len(pcm), window_bytes):
        chunk = pcm[start : start + window_bytes]
        if len(chunk) < bytes_per_sample:
            continue
        rms_values.append((audioop.rms(chunk, bytes_per_sample), len(chunk) / bytes_per_sample / sample_rate))
    if not rms_values:
        return []
    peak = max(rms for rms, _ in rms_values) or 1
    noise_floor = peak * 0.06
    envelope: MouthEnvelope = []
    for rms, duration_s in rms_values:
        if rms <= noise_floor:
            level = 0.0
        else:
            level = min(1.0, max(0.0, (rms - noise_floor) / max(1.0, peak - noise_floor)))
            level = level**0.68
        envelope.append((level, max(0.04, duration_s)))
    return envelope


class HeadAudio:
    def __init__(self, transport: SerialTransport | AdbTransport) -> None:
        self.transport = transport
        self._card_lock = threading.Lock()
        self._audio_card: Optional[int] = None
        self._audio_card_override = os.environ.get("HEAD_AUDIO_CARD", "auto").strip() or "auto"
        self._audio_card_match = os.environ.get(
            "HEAD_AUDIO_CARD_MATCH",
            "realtek,rt5651,codec",
        )
        self._audio_card_fallback = int(os.environ.get("HEAD_AUDIO_CARD_FALLBACK", "1"))
        self._playback_device = int(os.environ.get("HEAD_AUDIO_PLAYBACK_DEVICE", "0"))
        self._capture_device = int(os.environ.get("HEAD_AUDIO_CAPTURE_DEVICE", "0"))
        self._playback_sample_rate = int(os.environ.get("HEAD_AUDIO_PLAYBACK_SAMPLE_RATE", "16000"))
        self._playback_volume = self._coerce_playback_volume(
            os.environ.get("HEAD_AUDIO_PLAYBACK_VOLUME", "31")
        )
        self._playback_setup = os.environ.get(
            "HEAD_AUDIO_PLAYBACK_SETUP",
            "tinymix -D {card} 'OUT Playback Volume' {volume} {volume}",
        )
        self._capture_setup = os.environ.get(
            "HEAD_AUDIO_CAPTURE_SETUP",
            "",
        )
        self._queue: queue.Queue[bytes] = queue.Queue(maxsize=96)
        self._playback_batch_window_ms = int(os.environ.get("HEAD_AUDIO_PLAYBACK_BATCH_WINDOW_MS", "180"))
        self._playback_batch_max = int(os.environ.get("HEAD_AUDIO_PLAYBACK_BATCH_MAX", "10"))
        self._last_playback_error = ""
        self._last_playback_at = 0.0
        self._last_playback_bytes = 0
        self._last_playback_chunks = 0
        self._worker = threading.Thread(
            target=self._play_loop,
            daemon=True,
            name="head-audio-playback",
        )
        self._worker.start()

    def available(self) -> bool:
        return isinstance(self.transport, AdbTransport)

    def _coerce_playback_volume(self, value: str | int | float | None) -> int:
        if value is None:
            return self._playback_volume if hasattr(self, "_playback_volume") else 31
        if isinstance(value, str):
            value = value.strip()
            if not value:
                return self._playback_volume if hasattr(self, "_playback_volume") else 31
        number = float(value)
        if 0 <= number <= 1:
            number *= 31
        return max(0, min(31, int(round(number))))

    def configure(
        self,
        audio_card: str | int | None = None,
        playback_volume: str | int | float | None = None,
    ) -> None:
        with self._card_lock:
            if audio_card is not None:
                value = str(audio_card).strip()
                if value:
                    self._audio_card_override = value
                    self._audio_card = None
            if playback_volume is not None:
                self._playback_volume = self._coerce_playback_volume(playback_volume)

    def _parse_asound_cards(self, text: str) -> list[tuple[int, str]]:
        cards: list[tuple[int, str]] = []
        current: Optional[tuple[int, str]] = None
        for line in text.splitlines():
            match = re.match(r"\s*(\d+)\s+\[.*?\]:\s*(.*)", line)
            if match:
                if current is not None:
                    cards.append(current)
                current = (int(match.group(1)), line.strip())
            elif current is not None and line.strip():
                current = (current[0], f"{current[1]} {line.strip()}")
        if current is not None:
            cards.append(current)
        return cards

    def _detect_audio_card(self) -> int:
        if not isinstance(self.transport, AdbTransport):
            return self._audio_card_fallback
        override = self._audio_card_override.lower()
        if override not in {"", "auto"}:
            return int(override)
        try:
            cards_text = self.transport.shell("cat /proc/asound/cards", timeout=4)
        except Exception as exc:
            print(f"[audio] cannot read /proc/asound/cards, using fallback: {exc}")
            return self._audio_card_fallback
        cards = self._parse_asound_cards(cards_text)
        needles = [
            item.strip().lower()
            for item in self._audio_card_match.split(",")
            if item.strip()
        ]
        for card, description in cards:
            lowered = description.lower()
            if any(needle in lowered for needle in needles):
                return card
        if cards:
            print(
                "[audio] realtek/rt5651 card not found; "
                f"using fallback card {self._audio_card_fallback}. cards={cards}"
            )
        return self._audio_card_fallback

    def audio_card(self) -> int:
        with self._card_lock:
            if self._audio_card is None:
                self._audio_card = self._detect_audio_card()
            return self._audio_card

    def _format_audio_command(self, template: str, card: int) -> str:
        return template.format(
            card=card,
            playback_device=self._playback_device,
            capture_device=self._capture_device,
            volume=self._playback_volume,
        ).strip()

    def status(self) -> Dict[str, Any]:
        card: int | None = None
        if self.available():
            try:
                card = self.audio_card()
            except Exception:
                card = None
        return {
            "playback": self.available(),
            "capture": self.available(),
            "playback_queue": getattr(self._queue, "qsize")(),
            "card": card,
            "card_override": self._audio_card_override,
            "playback_device": self._playback_device,
            "capture_device": self._capture_device,
            "playback_volume": self._playback_volume,
            "playback_volume_percent": round(self._playback_volume / 31 * 100),
            "playback_sample_rate": self._playback_sample_rate,
            "playback_batch_window_ms": self._playback_batch_window_ms,
            "playback_batch_max": self._playback_batch_max,
            "playback_setup": self._playback_setup,
            "capture_setup": self._capture_setup,
            "last_playback_error": self._last_playback_error,
            "last_playback_at": self._last_playback_at,
            "last_playback_bytes": self._last_playback_bytes,
            "last_playback_chunks": self._last_playback_chunks,
        }

    def diagnose(self) -> Dict[str, Any]:
        if not isinstance(self.transport, AdbTransport):
            return {"ok": False, "error": "audio diagnose requires adb transport"}
        result: Dict[str, Any] = {"ok": True}
        try:
            cards_text = self.transport.shell("cat /proc/asound/cards", timeout=4)
            result["cards"] = cards_text
            result["detected_card"] = self.audio_card()
        except Exception as exc:
            result["ok"] = False
            result["cards_error"] = str(exc)
        mixes: Dict[str, str] = {}
        for card in range(4):
            try:
                mixes[str(card)] = self.transport.shell(
                    f"tinymix -D {card} | head -40",
                    timeout=4,
                )
            except Exception as exc:
                mixes[str(card)] = f"ERROR: {exc}"
        result["tinymix"] = mixes
        return result

    def enqueue_playback(
        self,
        audio_b64: str,
        sample_rate: int,
        channels: int,
        bytes_per_sample: int,
    ) -> Dict[str, Any]:
        if not self.available():
            return {"ok": False, "error": "audio playback requires adb transport"}
        wav_bytes, payload_bytes = audio_payload_to_wav_bytes(
            audio_b64,
            sample_rate,
            channels,
            bytes_per_sample,
        )
        try:
            self._queue.put_nowait(wav_bytes)
        except queue.Full:
            return {"ok": False, "error": "audio playback queue is full"}
        return {
            "ok": True,
            "queued": True,
            "bytes": len(wav_bytes),
            "payload_bytes": payload_bytes,
            "queue_size": self._queue.qsize(),
        }

    def play_now(
        self,
        audio_b64: str,
        sample_rate: int,
        channels: int,
        bytes_per_sample: int,
    ) -> Dict[str, Any]:
        if not self.available():
            return {"ok": False, "error": "audio playback requires adb transport"}
        wav_bytes, payload_bytes = audio_payload_to_wav_bytes(
            audio_b64,
            sample_rate,
            channels,
            bytes_per_sample,
        )
        if not payload_bytes:
            return {"ok": False, "error": "empty audio payload"}
        output = self._play_wav_bytes(wav_bytes)
        failed = playback_output_failed(output)
        self._last_playback_error = "tinyplay failed" if failed else ""
        return {
            "ok": not failed,
            "played": not failed,
            "bytes": len(wav_bytes),
            "payload_bytes": payload_bytes,
            "output": output[-500:] if output else "",
            **({"error": "tinyplay failed"} if failed else {}),
        }

    def clear_playback(self) -> int:
        cleared = 0
        while True:
            try:
                self._queue.get_nowait()
                cleared += 1
            except queue.Empty:
                break
        return cleared

    def capture_pcm16_mono_16k(self, duration_s: int = 1) -> bytes:
        if not isinstance(self.transport, AdbTransport):
            raise RuntimeError("audio capture requires adb transport")
        duration_s = max(1, min(5, int(duration_s)))
        remote = f"/data/local/tmp/xiaoling_mic_{int(time.time() * 1000)}.wav"
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            local = tmp.name
        try:
            card = self.audio_card()
            setup = self._format_audio_command(self._capture_setup, card)
            if setup:
                try:
                    self.transport.shell(f"su 0 {setup}", timeout=4)
                except Exception as exc:
                    print(f"[audio] capture setup ignored: {exc}")
            self.transport.shell(
                "su 0 tinycap "
                f"{remote} -D {card} -d {self._capture_device} -c 2 -r 48000 -b 16 -T {duration_s}",
                timeout=duration_s + 5,
            )
            self.transport.pull(remote, local, timeout=8)
            return wav_file_to_pcm16_mono_16k(local)
        finally:
            try:
                self.transport.shell(f"rm -f {remote}", timeout=3)
            except Exception:
                pass
            try:
                os.remove(local)
            except OSError:
                pass

    def _play_loop(self) -> None:
        while True:
            wav_bytes = self._queue.get()
            try:
                chunks = [wav_bytes]
                deadline = time.monotonic() + max(0, self._playback_batch_window_ms) / 1000.0
                while len(chunks) < max(1, self._playback_batch_max):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    try:
                        chunks.append(self._queue.get(timeout=remaining))
                    except queue.Empty:
                        break
                merged = merge_wav_bytes(chunks)
                self._last_playback_chunks = len(chunks)
                output = self._play_wav_bytes(merged)
                if playback_output_failed(output):
                    self._last_playback_error = (output or "tinyplay failed")[-500:]
                    print(f"[audio] playback command failed: {self._last_playback_error}")
                else:
                    self._last_playback_error = ""
            except Exception as exc:
                self._last_playback_error = str(exc)
                print(f"[audio] playback failed: {exc}")

    def _play_wav_bytes(self, wav_bytes: bytes) -> str:
        if not isinstance(self.transport, AdbTransport):
            return ""
        remote = f"/data/local/tmp/xiaoling_tts_{int(time.time() * 1000)}.wav"
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(wav_bytes)
            local = tmp.name
        try:
            self.transport.push(local, remote, timeout=10)
            card = self.audio_card()
            setup = self._format_audio_command(self._playback_setup, card)
            if setup:
                self.transport.shell(f"su 0 {setup}", timeout=4)
            output = self.transport.shell(
                f"su 0 tinyplay {remote} -D {card} -d {self._playback_device}",
                timeout=20,
            )
            self._last_playback_at = time.time()
            self._last_playback_bytes = len(wav_bytes)
            print(f"[audio] played {len(wav_bytes)} bytes on card {card}")
            return output
        finally:
            try:
                self.transport.shell(f"rm -f {remote}", timeout=3)
            except Exception:
                pass
            try:
                os.remove(local)
            except OSError:
                pass


class MotionController:
    def __init__(self, transport: SerialTransport | AdbTransport) -> None:
        self.transport = transport
        self._sequence_lock = threading.Lock()
        self._mouth_lock = threading.Lock()
        self._mouth_stop: Optional[threading.Event] = None
        self._mouth_thread: Optional[threading.Thread] = None
        self._speaking = threading.Event()
        self._blink_stop = threading.Event()
        self._auto_blink_enabled = env_bool("HEAD_AUTO_BLINK_ENABLED", True)
        self._blink_thread: Optional[threading.Thread] = None
        if self._auto_blink_enabled:
            self._blink_thread = threading.Thread(
                target=self._blink_loop,
                daemon=True,
                name="head-auto-blink",
            )
            self._blink_thread.start()

    def perform(self, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        action = (action or "").strip()
        if action == "speak":
            envelope = payload.get("mouth_envelope")
            if not isinstance(envelope, list) and payload.get("audio"):
                envelope = build_mouth_envelope(
                    str(payload.get("audio") or ""),
                    int(payload.get("sample_rate") or 16000),
                    int(payload.get("channels") or 1),
                    int(payload.get("bytes_per_sample") or 2),
                )
            self.start_mouth_loop(envelope if isinstance(envelope, list) else None)
            return {"ok": True, "action": action}
        if action in {"stopspeak", "stop_speak"}:
            self.stop_mouth_loop()
            self.run_sequence(ACTION_SEQUENCES["stopspeak"])
            return {"ok": True, "action": "stopspeak"}
        if action == "servo":
            location = int(payload.get("location", 0))
            angle = int(payload.get("angle", 0))
            speed = int(payload.get("speed", 5))
            frames = build_servo_frames(location, angle, speed)
            for data in frames:
                self.transport.send(data)
            return {
                "ok": True,
                "action": action,
                "frames": [hex_frame(data) for data in frames],
            }
        sequence = ACTION_SEQUENCES.get(action)
        if sequence is None:
            return {
                "ok": False,
                "error": f"unknown action: {action}",
                "available": action_names(),
            }
        threading.Thread(
            target=self.run_sequence,
            args=(sequence,),
            daemon=True,
            name=f"head-motion-{action}",
        ).start()
        return {"ok": True, "action": action, "queued": True}

    def status(self) -> Dict[str, Any]:
        return {
            "speaking": self._speaking.is_set(),
            "auto_blink": self._auto_blink_enabled,
            "blink_interval_s": "4+rand(0..1.2) while speaking, 3+rand(0..1.2) while idle",
        }

    def run_sequence(self, sequence: list[Step]) -> None:
        with self._sequence_lock:
            for step in sequence:
                if step.delay_ms:
                    time.sleep(step.delay_ms / 1000)
                if step.frame is not None:
                    self.transport.send(step.frame)

    def start_mouth_loop(self, envelope: MouthEnvelope | None = None) -> None:
        old_stop: Optional[threading.Event] = None
        old_thread: Optional[threading.Thread] = None
        with self._mouth_lock:
            if self._mouth_thread and self._mouth_thread.is_alive():
                if envelope is None:
                    self._speaking.set()
                    return
                old_stop = self._mouth_stop
                old_thread = self._mouth_thread
        if old_stop is not None:
            old_stop.set()
        if old_thread is not None and old_thread.is_alive():
            old_thread.join(timeout=0.35)

        stop = threading.Event()
        thread = threading.Thread(
            target=self._mouth_loop,
            args=(stop, envelope),
            daemon=True,
            name="head-mouth-loop",
        )
        with self._mouth_lock:
            self._mouth_stop = stop
            self._mouth_thread = thread
            self._speaking.set()
        thread.start()

    def stop_mouth_loop(self, close_mouth: bool = True) -> None:
        with self._mouth_lock:
            stop = self._mouth_stop
            thread = self._mouth_thread
            self._mouth_stop = None
            self._mouth_thread = None
            self._speaking.clear()
        if stop is not None:
            stop.set()
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=0.7)
        if close_mouth:
            self._close_mouth()

    def _mouth_loop(self, stop: threading.Event, envelope: MouthEnvelope | None) -> None:
        try:
            if envelope:
                self._mouth_envelope_loop(stop, envelope)
            else:
                self._mouth_natural_loop(stop)
        finally:
            with self._mouth_lock:
                is_current = self._mouth_stop is stop
                if is_current:
                    self._mouth_stop = None
                    self._mouth_thread = None
                    self._speaking.clear()
            if is_current:
                self._close_mouth()

    def _mouth_natural_loop(self, stop: threading.Event) -> None:
        self._set_mouth_angle(90, speed=15)
        while not stop.is_set():
            phrase_steps = random.randint(4, 9)
            for index in range(phrase_steps):
                if stop.is_set():
                    return
                level = random.triangular(0.18, 0.95, 0.48)
                if index == phrase_steps - 1:
                    level *= random.uniform(0.35, 0.7)
                angle = self._mouth_angle_from_level(level) + random.randint(-3, 3)
                self._set_mouth_angle(angle, speed=random.choice([10, 15]))
                if stop.wait(random.uniform(0.07, 0.16)):
                    return
                self._set_mouth_angle(random.randint(86, 101), speed=15)
                if stop.wait(random.uniform(0.035, 0.09)):
                    return
            self._set_mouth_angle(85, speed=10)
            if stop.wait(random.uniform(0.12, 0.34)):
                return

    def _mouth_envelope_loop(self, stop: threading.Event, envelope: MouthEnvelope) -> None:
        previous_level = 0.0
        previous_angle = 85
        last_sent_at = 0.0
        for level, duration_s in envelope:
            if stop.is_set():
                return
            smoothed = previous_level * 0.42 + level * 0.58
            if level - previous_level > 0.22:
                smoothed = min(1.0, smoothed + 0.08)
            angle = self._mouth_angle_from_level(smoothed)
            now = time.monotonic()
            if abs(angle - previous_angle) >= 4 or now - last_sent_at > 0.22:
                speed = 15 if abs(angle - previous_angle) >= 12 else 10
                self._set_mouth_angle(angle, speed=speed)
                previous_angle = angle
                last_sent_at = now
            previous_level = smoothed
            if stop.wait(max(0.045, min(0.18, duration_s))):
                return

    def _mouth_angle_from_level(self, level: float) -> int:
        level = max(0.0, min(1.0, float(level)))
        if level < 0.045:
            return 85
        return max(85, min(153, int(round(88 + level * 63))))

    def _set_mouth_angle(self, angle: int, speed: int = 10) -> None:
        angle = max(85, min(153, int(angle)))
        for frame in build_servo_frames(6, angle, speed):
            self.transport.send(frame)

    def _close_mouth(self) -> None:
        try:
            self.transport.send(RAW["mouth_speed_20"])
            self.transport.send(RAW["mouth_close"])
        except Exception as exc:
            print(f"[motion] close mouth failed: {exc}")

    def _blink_loop(self) -> None:
        while not self._blink_stop.is_set():
            base = 4.0 if self._speaking.is_set() else 3.0
            if self._blink_stop.wait(base + random.uniform(0.0, 1.2)):
                return
            if not self._should_idle_motion_run():
                continue
            try:
                self.run_sequence(ACTION_SEQUENCES["blink"])
            except Exception as exc:
                print(f"[motion] auto blink failed: {exc}")

    def _should_idle_motion_run(self) -> bool:
        if self.transport.dry_run:
            return True
        if isinstance(self.transport, AdbTransport):
            return self.transport._ready or self._speaking.is_set()
        return True


def json_response(handler: BaseHTTPRequestHandler, status: int, body: Dict[str, Any]) -> None:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Private-Network", "true")
    handler.end_headers()
    handler.wfile.write(data)


def make_handler(controller: MotionController, audio: HeadAudio):
    class Handler(BaseHTTPRequestHandler):
        def do_OPTIONS(self) -> None:  # noqa: N802
            json_response(self, 204, {})

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") == "/health":
                json_response(
                    self,
                    200,
                    {
                        "ok": True,
                        "transport": controller.transport.kind,
                        "dry_run": controller.transport.dry_run,
                        "port": controller.transport.port,
                        "baud": controller.transport.baud,
                        "adb_serial": getattr(controller.transport, "adb_serial", None),
                        "audio": audio.status(),
                        "motion": controller.status(),
                        "actions": action_names(),
                    },
                )
                return
            if self.path.rstrip("/") == "/audio/diagnose":
                json_response(self, 200, audio.diagnose())
                return
            json_response(self, 404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.rstrip("/")
            if path not in {
                "/action",
                "/servo",
                "/config",
                "/audio/play",
                "/audio/stop",
                "/audio/capture",
            }:
                json_response(self, 404, {"ok": False, "error": "not found"})
                return
            length = int(self.headers.get("Content-Length", "0") or "0")
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                json_response(self, 400, {"ok": False, "error": "invalid json"})
                return
            if path == "/config":
                try:
                    adb_serial = str(body.get("adb_serial") or "").strip()
                    head_ip = str(body.get("head_ip") or "").strip()
                    if head_ip and not adb_serial:
                        adb_serial = f"{head_ip}:5555"
                    if adb_serial and isinstance(controller.transport, AdbTransport):
                        controller.transport.configure(adb_serial)
                        controller.transport._ensure_ready()
                    playback_volume = (
                        body.get("playback_volume")
                        if "playback_volume" in body
                        else body.get("volume")
                    )
                    if "audio_card" in body or playback_volume is not None:
                        audio.configure(
                            body.get("audio_card"),
                            playback_volume=playback_volume,
                        )
                    json_response(
                        self,
                        200,
                        {
                            "ok": True,
                            "transport": controller.transport.kind,
                            "adb_serial": getattr(controller.transport, "adb_serial", None),
                            "audio": audio.status(),
                        },
                    )
                except Exception as exc:
                    json_response(self, 500, {"ok": False, "error": str(exc)})
                return
            if path == "/audio/play":
                try:
                    playback_volume = (
                        body.get("playback_volume")
                        if "playback_volume" in body
                        else body.get("volume")
                    )
                    if playback_volume is not None:
                        audio.configure(playback_volume=playback_volume)
                    args = (
                        str(body.get("audio") or ""),
                        int(body.get("sample_rate") or 16000),
                        int(body.get("channels") or 1),
                        int(body.get("bytes_per_sample") or 2),
                    )
                    drive_mouth = body.get("drive_mouth", True) is not False
                    if drive_mouth:
                        envelope = build_mouth_envelope(*args)
                        controller.start_mouth_loop(envelope or None)
                    if body.get("wait") or body.get("sync"):
                        result = audio.play_now(*args)
                    else:
                        result = audio.enqueue_playback(*args)
                    if drive_mouth and not result.get("ok"):
                        controller.stop_mouth_loop()
                    json_response(self, 200 if result.get("ok") else 400, result)
                except Exception as exc:
                    json_response(self, 500, {"ok": False, "error": str(exc)})
                return
            if path == "/audio/stop":
                controller.stop_mouth_loop()
                json_response(self, 200, {"ok": True, "cleared": audio.clear_playback()})
                return
            if path == "/audio/capture":
                try:
                    duration_ms = int(body.get("duration_ms") or 1000)
                    pcm = audio.capture_pcm16_mono_16k(max(1, round(duration_ms / 1000)))
                    json_response(
                        self,
                        200,
                        {
                            "ok": True,
                            "audio": base64.b64encode(pcm).decode("ascii"),
                            "sample_rate": 16000,
                            "channels": 1,
                            "bytes_per_sample": 2,
                            "bytes": len(pcm),
                        },
                    )
                except Exception as exc:
                    json_response(self, 500, {"ok": False, "error": str(exc)})
                return
            device_id = str(body.get("device_id") or "").strip()
            if device_id:
                print(f"[device] {device_id}")
            if path == "/servo":
                body["action"] = "servo"
            action = str(body.get("action", ""))
            try:
                result = controller.perform(action, body)
                json_response(self, 200 if result.get("ok") else 400, result)
            except Exception as exc:  # Keep the browser-side integration simple.
                json_response(self, 500, {"ok": False, "error": str(exc)})

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[http] {self.address_string()} {fmt % args}")

    return Handler


def main() -> None:
    host = os.environ.get("HEAD_MOTION_HOST", "127.0.0.1")
    http_port = int(os.environ.get("HEAD_MOTION_PORT", "8787"))
    serial_port = os.environ.get("HEAD_MOTION_SERIAL_PORT", "/dev/ttyS4")
    baud = int(os.environ.get("HEAD_MOTION_BAUD", "9600"))
    dry_run = env_bool("HEAD_MOTION_DRY_RUN", True)
    transport_kind = os.environ.get("HEAD_MOTION_TRANSPORT", "serial").strip().lower()
    if transport_kind == "adb":
        transport = AdbTransport(
            default_adb_path(),
            os.environ.get("HEAD_MOTION_ADB_SERIAL", "192.168.3.136:5555"),
            serial_port,
            baud,
            dry_run,
        )
    elif transport_kind == "serial":
        transport = SerialTransport(serial_port, baud, dry_run)
    else:
        raise ValueError("HEAD_MOTION_TRANSPORT must be 'serial' or 'adb'")
    controller = MotionController(transport)
    audio = HeadAudio(transport)
    server = ThreadingHTTPServer((host, http_port), make_handler(controller, audio))
    print(
        f"Head motion bridge listening on http://{host}:{http_port} "
        f"(transport={transport.kind}, serial={serial_port}, baud={baud}, dry_run={dry_run})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        controller.stop_mouth_loop()


if __name__ == "__main__":
    main()

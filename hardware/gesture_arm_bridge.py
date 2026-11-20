"""Local HTTP bridge for hand-gesture robot arm control.

The original Co-DexterousHand demo is a PyQt application. This bridge extracts
the useful runtime pieces into a small HTTP service so the Xiaoling web UI can:

  - check whether gesture recognition dependencies are available;
  - start/stop webcam based hand tracking;
  - send six-bit Arduino hand patterns, with optional angle protocol for compatible firmware;
  - optionally dispatch MediaPipe world landmarks to OrcaHand retargeting.

Run in dry-run mode first:

    python hardware/gesture_arm_bridge.py

Install dependencies:

    pip install opencv-python mediapipe pyserial numpy pyyaml

Real Arduino mode:

    set HAND_GESTURE_DRY_RUN=0
    set HAND_GESTURE_ARDUINO_PORTS=COM5
    python hardware/gesture_arm_bridge.py
"""

from __future__ import annotations

import importlib
import json
import math
import os
import sys
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse


ACTION_PATTERNS: Dict[str, str] = {
    "open": "000000",
    "relax": "000000",
    "fist": "011111",
    "full_fist": "111111",
    "point": "001111",
    "two": "000111",
    "three": "000011",
    "four": "000001",
    "thumb": "011101",
    "pinch": "011011",
    "stop": "000000",
}

ARDUINO_DEMO_SEQUENCE: List[str] = [
    "000000",
    "011111",
    "001111",
    "000111",
    "000011",
    "000001",
    "111111",
    "000000",
]

ARDUINO_NOTE_PATTERNS: Dict[int, str] = {
    1: "010000",
    2: "001000",
    3: "000100",
    5: "000010",
    6: "000001",
}
ARDUINO_NOTE_NAMES: Dict[int, str] = {
    1: "gong",
    2: "shang",
    3: "jue",
    5: "zhi",
    6: "yu",
}
ARDUINO_PLAY_NOTES: List[int] = [
    6,
    5,
    3,
    2,
    1,
    3,
    2,
    1,
    6,
    5,
    5,
    6,
    5,
    6,
    1,
    2,
    3,
    5,
    6,
    5,
    3,
    2,
    1,
    2,
]
ARDUINO_PLAY_DURATIONS: List[float] = [
    0.52,
    0.52,
    0.52,
    0.52,
    0.88,
    0.52,
    0.52,
    0.88,
    0.52,
    0.52,
    0.78,
    0.52,
    0.52,
    0.52,
    0.52,
    0.52,
    0.88,
    0.52,
    0.52,
    0.52,
    0.52,
    0.52,
    0.88,
    1.1,
]

ARDUINO_CHANNEL_ORDER: List[str] = ["wrist", "index", "middle", "ring", "thumb", "pinky"]
DEFAULT_ARDUINO_OPEN_ANGLES: List[float] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
DEFAULT_ARDUINO_CLOSED_ANGLES: List[float] = [0.0, 90.0, 90.0, 90.0, 90.0, 90.0]
DEFAULT_ARDUINO_MIN_ANGLES: List[float] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
DEFAULT_ARDUINO_MAX_ANGLES: List[float] = [0.0, 120.0, 120.0, 120.0, 120.0, 120.0]


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def clamp_float(value: float, low: float, high: float) -> float:
    return max(low, min(high, float(value)))


def split_ports(value: str | List[str] | None) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [item.strip() for item in str(value).replace(";", ",").split(",") if item.strip()]


def split_floats(value: Any, default: List[float], length: int = 6) -> List[float]:
    if value is None or value == "":
        return list(default[:length])
    raw_items = value if isinstance(value, list) else str(value).replace(";", ",").split(",")
    values: List[float] = []
    for idx, item in enumerate(list(raw_items)[:length]):
        try:
            values.append(float(item))
        except Exception:
            fallback = default[idx] if idx < len(default) else 0.0
            values.append(float(fallback))
    while len(values) < length:
        fallback = default[len(values)] if len(values) < len(default) else 0.0
        values.append(float(fallback))
    return values


def import_optional(module_name: str) -> Tuple[bool, Optional[Any], str]:
    try:
        module = importlib.import_module(module_name)
        return True, module, ""
    except Exception as exc:
        return False, None, str(exc)


DEPENDENCY_CACHE: Dict[str, Any] = {"package_root": "", "checked_at": 0.0, "data": None}


def dependency_report(package_root: Optional[Path] = None, force: bool = False) -> Dict[str, Any]:
    resolved_root = str((package_root or default_package_root()).resolve())
    ttl = float(os.environ.get("HAND_GESTURE_DEPENDENCY_CACHE_SECONDS", "30"))
    if (
        not force
        and DEPENDENCY_CACHE["data"] is not None
        and DEPENDENCY_CACHE["package_root"] == resolved_root
        and time.time() - float(DEPENDENCY_CACHE["checked_at"]) < ttl
    ):
        return DEPENDENCY_CACHE["data"]

    deps: Dict[str, Any] = {}
    for label, module_name in {
        "opencv": "cv2",
        "mediapipe": "mediapipe",
        "numpy": "numpy",
        "pyserial": "serial",
        "yaml": "yaml",
    }.items():
        ok, module, error = import_optional(module_name)
        deps[label] = {
            "ok": ok,
            "version": getattr(module, "__version__", "") if ok else "",
            "error": error if not ok else "",
        }

    extra_paths = orca_extra_paths(Path(resolved_root))
    inserted: List[str] = []
    for path in extra_paths:
        if path.exists() and str(path) not in sys.path:
            sys.path.insert(0, str(path))
            inserted.append(str(path))
    try:
        for label, module_name in {
            "orca_core": "orca_core",
            "orca_teleop": "orca_teleop",
            "torch": "torch",
            "pytorch_kinematics": "pytorch_kinematics",
            "dynamixel_sdk": "dynamixel_sdk",
        }.items():
            ok, module, error = import_optional(module_name)
            deps[label] = {
                "ok": ok,
                "version": getattr(module, "__version__", "") if ok else "",
                "error": error if not ok else "",
            }
    finally:
        for path in inserted:
            try:
                sys.path.remove(path)
            except ValueError:
                pass
    DEPENDENCY_CACHE.update(
        {"package_root": resolved_root, "checked_at": time.time(), "data": deps}
    )
    return deps


def default_package_root() -> Path:
    return Path(__file__).resolve().parent / "gesture_vendor" / "CoDexterousHand"


def default_model_path(package_root: Path) -> Path:
    return package_root / "hand_landmarker.task"


def default_urdf_path(package_root: Path) -> Path:
    return package_root / "orcahand_desc" / "urdf" / "orcahand_right.urdf"


def orca_extra_paths(package_root: Path) -> List[Path]:
    return [
        package_root,
        package_root / "orca_teleop" / "src",
    ]


def list_serial_ports() -> List[Dict[str, str]]:
    ok, serial_tools, _ = import_optional("serial.tools.list_ports")
    if not ok or serial_tools is None:
        return []
    return [
        {
            "device": str(port.device),
            "description": str(port.description),
            "hwid": str(port.hwid),
        }
        for port in serial_tools.comports()
    ]


def available_serial_port_names() -> List[str]:
    return [str(port.get("device") or "").strip() for port in list_serial_ports() if port.get("device")]


def port_present(port: str, available: Optional[List[str]] = None) -> bool:
    if not port:
        return False
    names = available if available is not None else available_serial_port_names()
    return port.upper() in {name.upper() for name in names}


def read_orca_config_port(package_root: Path) -> str:
    config_path = package_root / "orca_core" / "models" / "v2" / "orcahand_right" / "config.yaml"
    ok, yaml_module, _ = import_optional("yaml")
    if not ok or yaml_module is None or not config_path.exists():
        return ""
    try:
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8")) or {}
        return str(data.get("port") or "").strip()
    except Exception:
        return ""


def orca_config_path(package_root: Path) -> Path:
    return package_root / "orca_core" / "models" / "v2" / "orcahand_right" / "config.yaml"


def candidate_orca_ports(config: "GestureConfig") -> List[str]:
    available = available_serial_port_names()
    available_upper = {port.upper(): port for port in available}
    candidates: List[str] = []
    explicit = (config.orca_port or read_orca_config_port(config.resolved_package_root())).strip()
    if explicit and explicit.upper() in available_upper:
        candidates.append(available_upper[explicit.upper()])
    for port in config.arduino_ports:
        if port.upper() in available_upper and available_upper[port.upper()] not in candidates:
            candidates.append(available_upper[port.upper()])
    for port in available:
        if port not in candidates:
            candidates.append(port)
    return candidates


def active_arduino_ports(config: "GestureConfig") -> List[str]:
    available = available_serial_port_names()
    available_upper = {port.upper(): port for port in available}
    ports = [available_upper[port.upper()] for port in config.arduino_ports if port.upper() in available_upper]
    orca_port = (config.orca_port or read_orca_config_port(config.resolved_package_root())).upper()

    if not ports and config.arduino_enabled and not config.dry_run:
        ports = [port for port in available if not orca_port or port.upper() != orca_port]

    if not config.orca_enabled:
        return ports

    if not orca_port:
        return ports
    return [port for port in ports if port.upper() != orca_port]


@dataclass
class GestureConfig:
    host: str = field(default_factory=lambda: os.environ.get("HAND_GESTURE_HOST", "127.0.0.1"))
    http_port: int = field(default_factory=lambda: int(os.environ.get("HAND_GESTURE_PORT", "8791")))
    camera_index: int = field(default_factory=lambda: int(os.environ.get("HAND_GESTURE_CAMERA_INDEX", "0")))
    baud: int = field(default_factory=lambda: int(os.environ.get("HAND_GESTURE_BAUD", "9600")))
    arduino_ports: List[str] = field(
        default_factory=lambda: split_ports(os.environ.get("HAND_GESTURE_ARDUINO_PORTS", ""))
    )
    dry_run: bool = field(default_factory=lambda: env_bool("HAND_GESTURE_DRY_RUN", True))
    arduino_enabled: bool = field(default_factory=lambda: env_bool("HAND_GESTURE_ARDUINO_ENABLED", True))
    arduino_continuous_enabled: bool = field(
        default_factory=lambda: env_bool("HAND_GESTURE_ARDUINO_CONTINUOUS", True)
    )
    arduino_angle_protocol_enabled: bool = field(
        default_factory=lambda: env_bool("HAND_GESTURE_ARDUINO_ANGLE_PROTOCOL", False)
    )
    arduino_open_angles: List[float] = field(
        default_factory=lambda: split_floats(
            os.environ.get("HAND_GESTURE_ARDUINO_OPEN_ANGLES"),
            DEFAULT_ARDUINO_OPEN_ANGLES,
        )
    )
    arduino_closed_angles: List[float] = field(
        default_factory=lambda: split_floats(
            os.environ.get("HAND_GESTURE_ARDUINO_CLOSED_ANGLES"),
            DEFAULT_ARDUINO_CLOSED_ANGLES,
        )
    )
    arduino_min_angles: List[float] = field(
        default_factory=lambda: split_floats(
            os.environ.get("HAND_GESTURE_ARDUINO_MIN_ANGLES"),
            DEFAULT_ARDUINO_MIN_ANGLES,
        )
    )
    arduino_max_angles: List[float] = field(
        default_factory=lambda: split_floats(
            os.environ.get("HAND_GESTURE_ARDUINO_MAX_ANGLES"),
            DEFAULT_ARDUINO_MAX_ANGLES,
        )
    )
    orca_enabled: bool = field(default_factory=lambda: env_bool("HAND_GESTURE_ORCA_ENABLED", False))
    orca_port: str = field(default_factory=lambda: os.environ.get("HAND_GESTURE_ORCA_PORT", "").strip())
    orca_direct_joint_enabled: bool = field(
        default_factory=lambda: env_bool("HAND_GESTURE_ORCA_DIRECT_JOINT", True)
    )
    orca_wrist_follow_enabled: bool = field(
        default_factory=lambda: env_bool("HAND_GESTURE_ORCA_WRIST_FOLLOW", False)
    )
    orca_pose_smoothing: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_ORCA_POSE_SMOOTHING", "0.35"))
    )
    orca_connect_timeout_sec: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_ORCA_CONNECT_TIMEOUT_SEC", "25"))
    )
    send_interval_ms: int = field(default_factory=lambda: int(os.environ.get("HAND_GESTURE_SEND_INTERVAL_MS", "90")))
    finger_smoothing: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_FINGER_SMOOTHING", "0.68"))
    )
    finger_send_threshold: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_FINGER_SEND_THRESHOLD", "0.035"))
    )
    finger_open_threshold: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_FINGER_OPEN_THRESHOLD", "0.38"))
    )
    finger_closed_threshold: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_FINGER_CLOSED_THRESHOLD", "0.62"))
    )
    finger_max_step: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_FINGER_MAX_STEP", "0.16"))
    )
    continuous_heartbeat_ms: int = field(
        default_factory=lambda: int(os.environ.get("HAND_GESTURE_CONTINUOUS_HEARTBEAT_MS", "450"))
    )
    detection_confidence: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_DETECTION_CONFIDENCE", "0.5"))
    )
    tracking_confidence: float = field(
        default_factory=lambda: float(os.environ.get("HAND_GESTURE_TRACKING_CONFIDENCE", "0.5"))
    )
    package_root: str = field(default_factory=lambda: os.environ.get("HAND_GESTURE_PACKAGE_ROOT", str(default_package_root())))
    model_path: str = field(default_factory=lambda: os.environ.get("HAND_GESTURE_MODEL_PATH", ""))
    urdf_path: str = field(default_factory=lambda: os.environ.get("HAND_GESTURE_URDF_PATH", ""))
    history_path: str = field(
        default_factory=lambda: os.environ.get(
            "HAND_GESTURE_HISTORY_PATH",
            str(Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AI-Lover" / "local_logs" / "hand_motion_history.jsonl"),
        )
    )

    def resolved_package_root(self) -> Path:
        return Path(self.package_root).expanduser().resolve()

    def resolved_model_path(self) -> Path:
        if self.model_path:
            return Path(self.model_path).expanduser().resolve()
        return default_model_path(self.resolved_package_root())

    def resolved_urdf_path(self) -> Path:
        if self.urdf_path:
            return Path(self.urdf_path).expanduser().resolve()
        return default_urdf_path(self.resolved_package_root())

    def resolved_history_path(self) -> Path:
        return Path(self.history_path).expanduser().resolve()


class LandmarkData:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.world_landmarks: Any = None
        self.image_landmarks: List[List[float]] = []
        self.hand_type: Optional[str] = None
        self.timestamp = 0.0

    def update(self, world_landmarks: Any, image_landmarks: List[List[float]], hand_type: Optional[str]) -> None:
        with self._lock:
            self.world_landmarks = world_landmarks.copy() if world_landmarks is not None else None
            self.image_landmarks = list(image_landmarks)
            self.hand_type = hand_type
            self.timestamp = time.time()

    def snapshot(self) -> Tuple[Any, List[List[float]], Optional[str]]:
        with self._lock:
            world = self.world_landmarks.copy() if self.world_landmarks is not None else None
            return world, list(self.image_landmarks), self.hand_type


class GestureDetector:
    def __init__(self, config: GestureConfig) -> None:
        ok, cv2, cv2_error = import_optional("cv2")
        ok_mp, mp, mp_error = import_optional("mediapipe")
        ok_np, np, np_error = import_optional("numpy")
        if not ok:
            raise RuntimeError(f"opencv-python is required: {cv2_error}")
        if not ok_mp:
            raise RuntimeError(f"mediapipe is required: {mp_error}")
        if not ok_np:
            raise RuntimeError(f"numpy is required: {np_error}")

        model_path = config.resolved_model_path()
        if not model_path.exists():
            raise FileNotFoundError(f"hand_landmarker.task not found: {model_path}")

        self.cv2 = cv2
        self.mp = mp
        self.np = np
        options = mp.tasks.vision.HandLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(str(model_path)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=config.detection_confidence,
            min_hand_presence_confidence=config.tracking_confidence,
            min_tracking_confidence=config.tracking_confidence,
        )
        self._landmarker = mp.tasks.vision.HandLandmarker.create_from_options(options)
        self.results: Any = None
        self.handedness: Optional[List[str]] = None
        self._start_monotonic = time.monotonic()

    def detect(self, frame: Any) -> Tuple[List[List[float]], Optional[str], Any]:
        img_rgb = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        mp_img = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=img_rgb)
        timestamp_ms = int((time.monotonic() - self._start_monotonic) * 1000)
        self.results = self._landmarker.detect_for_video(mp_img, timestamp_ms)
        self.handedness = None

        if not self.results.hand_landmarks:
            return [], None, None

        handedness = self.results.handedness[0][0].category_name
        self.handedness = [handedness]
        h, w = frame.shape[:2]
        landmarks = []
        for idx, lm in enumerate(self.results.hand_landmarks[0]):
            landmarks.append([idx, int(lm.x * w), int(lm.y * h), lm.x, lm.y, lm.z])

        world = None
        if self.results.hand_world_landmarks:
            world = self.np.array(
                [[lm.x, lm.y, lm.z] for lm in self.results.hand_world_landmarks[0]],
                dtype=self.np.float32,
            )
        return landmarks, handedness, world


@dataclass
class FingerControlState:
    pattern: str
    bends: List[float]
    angles: List[float]
    changed: bool


class FingerStateEstimator:
    LONG_FINGERS: Dict[str, Tuple[int, int, int, int, int]] = {
        "index": (5, 6, 7, 8, 1),
        "middle": (9, 10, 11, 12, 2),
        "ring": (13, 14, 15, 16, 3),
        "pinky": (17, 18, 19, 20, 5),
    }

    def __init__(self, config: Optional[GestureConfig] = None, smoothing: Optional[float] = None) -> None:
        self.config = config
        configured_smoothing = config.finger_smoothing if config is not None else 0.68
        self.smoothing = clamp_float(smoothing if smoothing is not None else configured_smoothing, 0.0, 0.95)
        configured_threshold = config.finger_send_threshold if config is not None else 0.035
        self.send_threshold = clamp_float(configured_threshold, 0.005, 0.2)
        self.bends = [0.0] * 6
        self.angles = self.angles_from_bends(self.bends, config)
        self.pattern = "000000"
        self._initialized = False

    def update(self, lm_list: List[List[float]]) -> FingerControlState:
        raw_bends = self.raw_bends_from_landmarks(lm_list)
        if raw_bends is None:
            return FingerControlState(self.pattern, list(self.bends), list(self.angles), False)

        if self._initialized:
            keep = self.smoothing
            smoothed = [
                clamp_float(previous * keep + current * (1.0 - keep), 0.0, 1.0)
                for previous, current in zip(self.bends, raw_bends)
            ]
            max_step = clamp_float(
                self.config.finger_max_step if self.config is not None else 0.16,
                0.03,
                0.5,
            )
            bends = [
                clamp_float(
                    previous + clamp_float(current - previous, -max_step, max_step),
                    0.0,
                    1.0,
                )
                for previous, current in zip(self.bends, smoothed)
            ]
        else:
            bends = [clamp_float(value, 0.0, 1.0) for value in raw_bends]

        angles = self.angles_from_bends(bends, self.config)
        pattern = self.pattern_from_bends(bends, self.pattern if self._initialized else "", self.config)
        bend_delta = max(abs(a - b) for a, b in zip(bends, self.bends))
        angle_delta = max(abs(a - b) for a, b in zip(angles, self.angles))
        changed = (
            not self._initialized
            or pattern != self.pattern
            or bend_delta >= self.send_threshold
            or angle_delta >= 1.0
        )

        self._initialized = True
        self.bends = bends
        self.angles = angles
        self.pattern = pattern
        return FingerControlState(pattern, list(bends), list(angles), changed)

    @classmethod
    def raw_bends_from_landmarks(cls, lm_list: List[List[float]]) -> Optional[List[float]]:
        points = cls._points_by_index(lm_list)
        if not points:
            return None

        bends = [0.0] * 6
        for _, (mcp, pip, dip, tip, state_index) in cls.LONG_FINGERS.items():
            bends[state_index] = cls._long_finger_bend(points, mcp, pip, dip, tip)
        bends[4] = cls._thumb_bend(points)
        return [clamp_float(value, 0.0, 1.0) for value in bends]

    @staticmethod
    def pattern_from_bends(
        bends: List[float],
        previous_pattern: str = "",
        config: Optional[GestureConfig] = None,
    ) -> str:
        normalized = list(bends[:6]) + [0.0] * max(0, 6 - len(bends))
        open_threshold = clamp_float(
            config.finger_open_threshold if config is not None else 0.38,
            0.05,
            0.9,
        )
        closed_threshold = clamp_float(
            config.finger_closed_threshold if config is not None else 0.62,
            open_threshold + 0.02,
            0.98,
        )
        previous = (previous_pattern or "000000")[:6].ljust(6, "0")
        result: List[str] = []
        for idx, value in enumerate(normalized[:6]):
            if value >= closed_threshold:
                result.append("1")
            elif value <= open_threshold:
                result.append("0")
            else:
                result.append(previous[idx])
        return "".join(result)

    @staticmethod
    def angles_from_bends(bends: List[float], config: Optional[GestureConfig] = None) -> List[float]:
        open_angles = config.arduino_open_angles if config is not None else DEFAULT_ARDUINO_OPEN_ANGLES
        closed_angles = config.arduino_closed_angles if config is not None else DEFAULT_ARDUINO_CLOSED_ANGLES
        min_angles = config.arduino_min_angles if config is not None else DEFAULT_ARDUINO_MIN_ANGLES
        max_angles = config.arduino_max_angles if config is not None else DEFAULT_ARDUINO_MAX_ANGLES
        normalized_bends = list(bends[:6]) + [0.0] * max(0, 6 - len(bends))
        angles: List[float] = []
        for idx, bend in enumerate(normalized_bends[:6]):
            open_angle = float(open_angles[idx] if idx < len(open_angles) else 0.0)
            closed_angle = float(closed_angles[idx] if idx < len(closed_angles) else open_angle)
            low = float(min_angles[idx] if idx < len(min_angles) else min(open_angle, closed_angle))
            high = float(max_angles[idx] if idx < len(max_angles) else max(open_angle, closed_angle))
            if low > high:
                low, high = high, low
            target = open_angle + clamp_float(bend, 0.0, 1.0) * (closed_angle - open_angle)
            angles.append(clamp_float(target, low, high))
        return angles

    @staticmethod
    def _points_by_index(lm_list: List[List[float]]) -> Dict[int, List[float]]:
        if len(lm_list) < 21:
            return {}
        points: Dict[int, List[float]] = {}
        for idx, landmark in enumerate(lm_list):
            if len(landmark) < 6:
                continue
            try:
                points[int(landmark[0])] = list(landmark)
            except Exception:
                points[idx] = list(landmark)
        return points if all(idx in points for idx in range(21)) else {}

    @staticmethod
    def calculate_angle_3d(p1: List[float], p2: List[float], p3: List[float]) -> float:
        v1 = (float(p1[3]) - float(p2[3]), float(p1[4]) - float(p2[4]), float(p1[5]) - float(p2[5]))
        v2 = (float(p3[3]) - float(p2[3]), float(p3[4]) - float(p2[4]), float(p3[5]) - float(p2[5]))
        norm1 = math.sqrt(v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2])
        norm2 = math.sqrt(v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2])
        if norm1 <= 1e-8 or norm2 <= 1e-8:
            return 180.0
        dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]
        return math.degrees(math.acos(clamp_float(dot / (norm1 * norm2), -1.0, 1.0)))

    @staticmethod
    def _distance(a: List[float], b: List[float]) -> float:
        return math.sqrt(
            (float(a[3]) - float(b[3])) ** 2
            + (float(a[4]) - float(b[4])) ** 2
            + (float(a[5]) - float(b[5])) ** 2
        )

    @staticmethod
    def _angle_to_bend(angle: float, open_angle: float = 168.0, closed_angle: float = 78.0) -> float:
        if open_angle <= closed_angle:
            return 0.0
        return clamp_float((open_angle - angle) / (open_angle - closed_angle), 0.0, 1.0) ** 0.9

    @classmethod
    def _chord_to_bend(cls, points: Dict[int, List[float]], joints: Tuple[int, int, int, int]) -> float:
        mcp, pip, dip, tip = joints
        folded_length = (
            cls._distance(points[mcp], points[pip])
            + cls._distance(points[pip], points[dip])
            + cls._distance(points[dip], points[tip])
        )
        if folded_length <= 1e-8:
            return 0.0
        extension_ratio = cls._distance(points[mcp], points[tip]) / folded_length
        return clamp_float((0.98 - extension_ratio) / 0.48, 0.0, 1.0)

    @classmethod
    def _long_finger_bend(cls, points: Dict[int, List[float]], mcp: int, pip: int, dip: int, tip: int) -> float:
        mcp_fraction = cls._angle_to_bend(cls.calculate_angle_3d(points[0], points[mcp], points[pip]), 160.0, 90.0)
        pip_fraction = cls._angle_to_bend(cls.calculate_angle_3d(points[mcp], points[pip], points[dip]), 170.0, 82.0)
        dip_fraction = cls._angle_to_bend(cls.calculate_angle_3d(points[pip], points[dip], points[tip]), 176.0, 92.0)
        chord_fraction = cls._chord_to_bend(points, (mcp, pip, dip, tip))
        return clamp_float(
            pip_fraction * 0.50 + dip_fraction * 0.25 + mcp_fraction * 0.15 + chord_fraction * 0.10,
            0.0,
            1.0,
        )

    @classmethod
    def _thumb_bend(cls, points: Dict[int, List[float]]) -> float:
        cmc_fraction = cls._angle_to_bend(cls.calculate_angle_3d(points[0], points[1], points[2]), 150.0, 75.0)
        mcp_fraction = cls._angle_to_bend(cls.calculate_angle_3d(points[1], points[2], points[3]), 160.0, 82.0)
        ip_fraction = cls._angle_to_bend(cls.calculate_angle_3d(points[2], points[3], points[4]), 172.0, 96.0)
        chord_fraction = cls._chord_to_bend(points, (1, 2, 3, 4))
        palm_width = max(cls._distance(points[5], points[17]), 1e-4)
        thumb_tip_to_palm = cls._distance(points[4], points[9]) / palm_width
        tuck_fraction = clamp_float((1.12 - thumb_tip_to_palm) / 0.72, 0.0, 1.0)
        return clamp_float(
            ip_fraction * 0.38
            + mcp_fraction * 0.26
            + cmc_fraction * 0.14
            + max(chord_fraction, tuck_fraction) * 0.22,
            0.0,
            1.0,
        )


class DirectOrcaPoseMapper:
    """Map MediaPipe hand landmarks directly to ORCA's 17 physical joints.

    This mode is intentionally dependency-light: it does not require the IK
    retargeter stack (`torch` / `pytorch_kinematics`). It is less exact than a
    calibrated kinematic retargeter, but it gives a stable full-hand demo on
    customer machines and lets every ORCA joint participate.
    """

    FINGERS: Dict[str, Dict[str, Any]] = {
        "index": {
            "mcp": 5,
            "pip": 6,
            "dip": 7,
            "tip": 8,
            "mcp_joint": "index_mcp",
            "pip_joint": "index_pip",
            "abd_joint": "index_abd",
            "abd_scale": 0.72,
        },
        "middle": {
            "mcp": 9,
            "pip": 10,
            "dip": 11,
            "tip": 12,
            "mcp_joint": "middle_mcp",
            "pip_joint": "middle_pip",
            "abd_joint": "middle_abd",
            "abd_scale": 0.42,
        },
        "ring": {
            "mcp": 13,
            "pip": 14,
            "dip": 15,
            "tip": 16,
            "mcp_joint": "ring_mcp",
            "pip_joint": "ring_pip",
            "abd_joint": "ring_abd",
            "abd_scale": 0.46,
        },
        "pinky": {
            "mcp": 17,
            "pip": 18,
            "dip": 19,
            "tip": 20,
            "mcp_joint": "pinky_mcp",
            "pip_joint": "pinky_pip",
            "abd_joint": "pinky_abd",
            "abd_scale": 0.78,
        },
    }

    def __init__(self, hand_config: Any) -> None:
        self.roms: Dict[str, List[float]] = hand_config.joint_roms_dict
        self.neutral: Dict[str, float] = dict(hand_config.neutral_position or {})
        self.joint_ids: List[str] = list(hand_config.joint_ids or self.roms.keys())

    def pose_from_landmarks(
        self,
        image_landmarks: List[List[float]],
        world_landmarks: Any,
        hand_type: Optional[str],
        wrist_follow: bool,
    ) -> Optional[Dict[str, float]]:
        points = self._points_by_index(image_landmarks, hand_type)
        if not points:
            return None

        pose = {joint: float(self.neutral.get(joint, 0.0)) for joint in self.joint_ids}
        palm_width = max(self._distance(points[5], points[17]), 1e-4)
        palm_axis = (
            points[9][3] - points[0][3],
            points[9][4] - points[0][4],
        )

        for spec in self.FINGERS.values():
            mcp_idx = int(spec["mcp"])
            pip_idx = int(spec["pip"])
            dip_idx = int(spec["dip"])
            tip_idx = int(spec["tip"])
            mcp_fraction = self._curl_fraction(points[0], points[mcp_idx], points[pip_idx])
            pip_fraction = self._curl_fraction(points[mcp_idx], points[pip_idx], points[dip_idx])
            dip_fraction = self._curl_fraction(points[pip_idx], points[dip_idx], points[tip_idx])
            pip_fraction = clamp_float(pip_fraction * 0.72 + dip_fraction * 0.28, 0.0, 1.0)
            self._set_neutral_to_max(pose, str(spec["mcp_joint"]), mcp_fraction)
            self._set_neutral_to_max(pose, str(spec["pip_joint"]), pip_fraction)

            spread = self._finger_abduction(
                palm_axis,
                points[mcp_idx],
                points[tip_idx],
                max(mcp_fraction, pip_fraction),
                float(spec["abd_scale"]),
            )
            self._set_signed_from_neutral(pose, str(spec["abd_joint"]), spread)

        self._set_thumb_pose(pose, points, palm_width)
        if wrist_follow:
            self._set_wrist_pose(pose, world_landmarks)
        elif "wrist" in pose:
            pose["wrist"] = float(self.neutral.get("wrist", 0.0))

        return self._clamp_pose(pose)

    def _points_by_index(
        self, image_landmarks: List[List[float]], hand_type: Optional[str]
    ) -> Dict[int, List[float]]:
        if len(image_landmarks) < 21:
            return {}
        mirror_left = bool(hand_type and hand_type.lower() == "left")
        points: Dict[int, List[float]] = {}
        for landmark in image_landmarks:
            if len(landmark) < 6:
                continue
            idx = int(landmark[0])
            copied = list(landmark)
            if mirror_left:
                copied[3] = 1.0 - float(copied[3])
            points[idx] = copied
        return points if all(idx in points for idx in range(21)) else {}

    @staticmethod
    def _distance(a: List[float], b: List[float]) -> float:
        return math.sqrt(
            (float(a[3]) - float(b[3])) ** 2
            + (float(a[4]) - float(b[4])) ** 2
            + (float(a[5]) - float(b[5])) ** 2
        )

    @staticmethod
    def _angle(a: List[float], b: List[float], c: List[float]) -> float:
        v1 = (float(a[3]) - float(b[3]), float(a[4]) - float(b[4]), float(a[5]) - float(b[5]))
        v2 = (float(c[3]) - float(b[3]), float(c[4]) - float(b[4]), float(c[5]) - float(b[5]))
        n1 = math.sqrt(v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2])
        n2 = math.sqrt(v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2])
        if n1 <= 1e-8 or n2 <= 1e-8:
            return 180.0
        dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]
        return math.degrees(math.acos(clamp_float(dot / (n1 * n2), -1.0, 1.0)))

    def _curl_fraction(self, a: List[float], b: List[float], c: List[float]) -> float:
        angle = self._angle(a, b, c)
        fraction = (168.0 - angle) / 96.0
        return clamp_float(fraction, 0.0, 1.0) ** 0.92

    @staticmethod
    def _signed_angle_2d(axis: Tuple[float, float], vector: Tuple[float, float]) -> float:
        axis_len = math.hypot(axis[0], axis[1])
        vector_len = math.hypot(vector[0], vector[1])
        if axis_len <= 1e-8 or vector_len <= 1e-8:
            return 0.0
        dot = axis[0] * vector[0] + axis[1] * vector[1]
        cross = axis[0] * vector[1] - axis[1] * vector[0]
        return math.degrees(math.atan2(cross, dot))

    def _finger_abduction(
        self,
        palm_axis: Tuple[float, float],
        mcp: List[float],
        tip: List[float],
        curl_fraction: float,
        scale: float,
    ) -> float:
        vector = (float(tip[3]) - float(mcp[3]), float(tip[4]) - float(mcp[4]))
        angle = self._signed_angle_2d(palm_axis, vector)
        open_weight = clamp_float(1.0 - curl_fraction * 1.35, 0.0, 1.0)
        return clamp_float((angle / 38.0) * scale * open_weight, -0.75, 0.75)

    def _set_thumb_pose(self, pose: Dict[str, float], points: Dict[int, List[float]], palm_width: float) -> None:
        thumb_mcp = self._curl_fraction(points[1], points[2], points[3])
        thumb_dip = self._curl_fraction(points[2], points[3], points[4])
        thumb_tip_to_palm = self._distance(points[4], points[9]) / palm_width
        thumb_in = clamp_float((1.16 - thumb_tip_to_palm) / 0.72, 0.0, 1.0)
        thumb_spread = clamp_float((thumb_tip_to_palm - 0.46) / 0.94, 0.0, 1.0)

        self._set_neutral_to_max(pose, "thumb_mcp", thumb_mcp)
        self._set_neutral_to_max(pose, "thumb_dip", thumb_dip)
        self._set_neutral_to_max(pose, "thumb_cmc", max(thumb_in, thumb_mcp * 0.45))
        self._set_signed_from_neutral(pose, "thumb_abd", thumb_spread * 0.72)

    def _set_wrist_pose(self, pose: Dict[str, float], world_landmarks: Any) -> None:
        if "wrist" not in pose or world_landmarks is None:
            return
        try:
            wrist = world_landmarks[0]
            middle = world_landmarks[9]
            index = world_landmarks[5]
            pinky = world_landmarks[17]
            palm_width = math.sqrt(
                float((index[0] - pinky[0]) ** 2 + (index[1] - pinky[1]) ** 2 + (index[2] - pinky[2]) ** 2)
            )
            if palm_width <= 1e-6:
                return
            depth = float(middle[2] - wrist[2]) / palm_width
            self._set_signed_from_neutral(pose, "wrist", clamp_float(depth * 1.15, -0.62, 0.62))
        except Exception:
            return

    def _set_neutral_to_max(self, pose: Dict[str, float], joint: str, fraction: float) -> None:
        if joint not in self.roms:
            return
        joint_min, joint_max = self.roms[joint]
        neutral = float(self.neutral.get(joint, 0.0))
        target = neutral + clamp_float(fraction, 0.0, 1.0) * (float(joint_max) - neutral)
        pose[joint] = clamp_float(target, float(joint_min), float(joint_max))

    def _set_signed_from_neutral(self, pose: Dict[str, float], joint: str, signed_fraction: float) -> None:
        if joint not in self.roms:
            return
        joint_min, joint_max = self.roms[joint]
        neutral = float(self.neutral.get(joint, 0.0))
        fraction = clamp_float(signed_fraction, -1.0, 1.0)
        if fraction >= 0:
            target = neutral + fraction * (float(joint_max) - neutral)
        else:
            target = neutral + (-fraction) * (float(joint_min) - neutral)
        pose[joint] = clamp_float(target, float(joint_min), float(joint_max))

    def _clamp_pose(self, pose: Dict[str, float]) -> Dict[str, float]:
        clamped: Dict[str, float] = {}
        for joint, value in pose.items():
            if joint not in self.roms:
                continue
            joint_min, joint_max = self.roms[joint]
            clamped[joint] = clamp_float(float(value), float(joint_min), float(joint_max))
        return clamped


class SerialPatternSender:
    def __init__(
        self,
        ports: List[str],
        baud: int,
        dry_run: bool,
        enabled: bool,
        requested_enabled: bool = True,
        configured_ports: Optional[List[str]] = None,
    ) -> None:
        self.ports = ports
        self.configured_ports = list(configured_ports or ports)
        self.baud = baud
        self.dry_run = dry_run
        self.enabled = enabled
        self.requested_enabled = requested_enabled
        self._serials: List[Any] = []
        self._lock = threading.RLock()

    def open(self) -> List[str]:
        if self.dry_run or not self.requested_enabled:
            return []
        if not self.ports:
            configured = ", ".join(self.configured_ports) or "-"
            detected = ", ".join(available_serial_port_names()) or "-"
            raise RuntimeError(
                "No available Arduino serial port. "
                f"Configured: {configured}; detected: {detected}"
            )
        ok, serial_module, error = import_optional("serial")
        if not ok or serial_module is None:
            raise RuntimeError(f"pyserial is required: {error}")
        opened = []
        errors = []
        with self._lock:
            self.close()
            for port in self.ports:
                try:
                    ser = serial_module.Serial(port, self.baud, timeout=1, write_timeout=0.25)
                    self._serials.append(ser)
                    opened.append(port)
                except Exception as exc:
                    errors.append(f"{port}: {exc}")
            if not opened:
                raise RuntimeError(
                    "No configured Arduino serial port could be opened"
                    + (f" ({'; '.join(errors)})" if errors else "")
                )
            open_delay_ms = max(0, int(os.environ.get("HAND_GESTURE_SERIAL_OPEN_DELAY_MS", "1200")))
            if open_delay_ms:
                for ser in self._serials:
                    try:
                        ser.reset_input_buffer()
                        ser.reset_output_buffer()
                    except Exception:
                        pass
                time.sleep(open_delay_ms / 1000.0)
        return opened

    def close(self) -> None:
        with self._lock:
            for ser in self._serials:
                try:
                    ser.close()
                except Exception:
                    pass
            self._serials = []

    def send(self, pattern: str) -> Dict[str, Any]:
        if len(pattern) != 6 or any(ch not in "01" for ch in pattern):
            raise ValueError("pattern must be a six-character 0/1 string")
        return self._send_payload(
            pattern,
            {
                "pattern": pattern,
                "continuous": False,
                "payload": pattern,
            },
        )

    def send_continuous(self, pattern: str, bends: List[float], angles: List[float]) -> Dict[str, Any]:
        if len(pattern) != 6 or any(ch not in "01" for ch in pattern):
            raise ValueError("pattern must be a six-character 0/1 string")
        if len(bends) != 6 or len(angles) != 6:
            raise ValueError("continuous hand output requires six bends and six angles")
        safe_angles = [clamp_float(float(angle), 0.0, 180.0) for angle in angles]
        payload = "A:" + ",".join(str(int(round(angle))) for angle in safe_angles)
        return self._send_payload(
            payload,
            {
                "pattern": pattern,
                "continuous": True,
                "payload": payload,
                "channel_order": list(ARDUINO_CHANNEL_ORDER),
                "bends": [round(clamp_float(value, 0.0, 1.0), 3) for value in bends],
                "angles": [round(angle, 1) for angle in safe_angles],
            },
        )

    def _send_payload(self, line: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            if self.dry_run:
                return {
                    **metadata,
                    "ok": True,
                    "dry_run": True,
                    "delivered": False,
                    "ports": self.ports,
                }
            if not self.requested_enabled:
                return {
                    **metadata,
                    "ok": True,
                    "skipped": True,
                    "reason": "arduino_disabled",
                    "dry_run": False,
                    "delivered": False,
                    "ports": [],
                }
            if not self.enabled or not self.ports:
                configured = ", ".join(self.configured_ports) or "-"
                detected = ", ".join(available_serial_port_names()) or "-"
                return {
                    **metadata,
                    "ok": False,
                    "error": (
                        "No available Arduino serial port. "
                        f"Configured: {configured}; detected: {detected}"
                    ),
                    "dry_run": False,
                    "delivered": False,
                    "ports": list(self.ports),
                }
            if not self._serials:
                self.open()
            payload = (line + "\n").encode("ascii")
            sent_ports = []
            errors = []
            for ser in self._serials:
                port = getattr(ser, "port", "serial")
                try:
                    ser.write(payload)
                    ser.flush()
                    sent_ports.append(port)
                except Exception as exc:
                    errors.append(f"{port}: {exc}")
            if not sent_ports:
                raise RuntimeError(
                    "No Arduino serial port accepted the gesture payload"
                    + (f" ({'; '.join(errors)})" if errors else "")
                )
            return {
                **metadata,
                "ok": True,
                "dry_run": False,
                "delivered": True,
                "ports": sent_ports,
            }


def normalize_external_landmarks(raw: Any) -> List[List[float]]:
    if not isinstance(raw, list):
        return []
    normalized: List[List[float]] = []
    for idx, item in enumerate(raw[:21]):
        try:
            if isinstance(item, dict):
                x = float(item.get("x", 0.0))
                y = float(item.get("y", 0.0))
                z = float(item.get("z", 0.0))
                px = int(item.get("px", x * 640))
                py = int(item.get("py", y * 480))
                landmark_idx = int(item.get("idx", item.get("index", idx)))
            else:
                values = list(item)
                landmark_idx = int(values[0]) if len(values) >= 6 else idx
                if len(values) >= 6:
                    px = int(values[1])
                    py = int(values[2])
                    x = float(values[3])
                    y = float(values[4])
                    z = float(values[5])
                else:
                    x = float(values[0])
                    y = float(values[1])
                    z = float(values[2] if len(values) > 2 else 0.0)
                    px = int(x * 640)
                    py = int(y * 480)
            normalized.append([landmark_idx, px, py, x, y, z])
        except Exception:
            continue
    normalized.sort(key=lambda item: int(item[0]))
    return normalized if len(normalized) >= 21 else []


class OrcaRunner:
    def __init__(self, config: GestureConfig, landmark_data: LandmarkData) -> None:
        self.config = config
        self.landmark_data = landmark_data
        self.running = False
        self.error = ""
        self.status = "idle"
        self._thread: Optional[threading.Thread] = None
        self._hand: Any = None
        self._retargeter: Any = None
        self._command_lock = threading.RLock()
        self._queue_lock = threading.Lock()
        self._queued_pattern = ""
        self._queued_pose: Optional[Dict[str, float]] = None
        self.last_pattern = ""
        self.last_pose_mode = "idle"
        self.last_joint_count = 0
        self.last_wrist_angle: Optional[float] = None
        self._last_direct_pose: Optional[Dict[str, float]] = None

    def start(self) -> None:
        if not self.config.orca_enabled or self.running:
            return
        for path in orca_extra_paths(self.config.resolved_package_root()):
            if path.exists() and str(path) not in sys.path:
                sys.path.insert(0, str(path))
        self.error = ""
        self.status = "connecting"
        self.running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="gesture-orcahand")
        self._thread.start()

    def stop(self) -> None:
        self.running = False
        self.status = "stopping" if self._thread and self._thread.is_alive() else self.status
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=max(2.0, float(self.config.orca_connect_timeout_sec) + 3.0))
        self._thread = None
        try:
            if self._hand is not None:
                with self._command_lock:
                    self._hand.set_zero_position()
                    self._hand.disable_torque()
                    self._hand.disconnect()
        except Exception as exc:
            self.error = str(exc)
        finally:
            self._hand = None
            self._retargeter = None
            self.status = "idle"

    def _loop(self) -> None:
        hand = None
        try:
            from orca_core import OrcaHand  # type: ignore
            from orca_core.hand_config import OrcaHandConfig  # type: ignore
            if self.config.orca_direct_joint_enabled:
                Retargeter = None
                TargetPose = None
            else:
                from orca_teleop.retargeting.retargeter import Retargeter, TargetPose  # type: ignore

            self.status = "connecting"
            config_path = orca_config_path(self.config.resolved_package_root())
            base_config = OrcaHandConfig.from_config_path(str(config_path))
            candidates = candidate_orca_ports(self.config) or [base_config.port or ""]
            last_message = ""
            for candidate in candidates:
                if not self.running:
                    return
                try:
                    trial_config = replace(base_config, port=candidate or None)
                    hand = OrcaHand(config=trial_config)
                    ok, message = hand.connect()
                    last_message = message
                    if ok:
                        self.config.orca_port = candidate
                        self.error = ""
                        break
                    try:
                        hand.disconnect()
                    except Exception:
                        pass
                    hand = None
                except Exception as exc:
                    last_message = str(exc)
                    try:
                        if hand is not None:
                            hand.disconnect()
                    except Exception:
                        pass
                    hand = None
            if hand is None:
                raise RuntimeError(last_message or "OrcaHand did not find a usable serial port")
            if not self.running:
                return
            hand.enable_torque()
            hand.set_control_mode(hand.config.control_mode)
            hand.set_max_current(hand.config.max_current)
            hand.set_neutral_position()
            direct_mapper = DirectOrcaPoseMapper(hand.config)
            retargeter = None
            if not self.config.orca_direct_joint_enabled:
                retargeter = Retargeter.from_paths(urdf_path=str(self.config.resolved_urdf_path()))
            self._hand = hand
            self._retargeter = retargeter
            self.error = ""
            self.status = "tracking"
            self.last_pose_mode = "direct_joint" if self.config.orca_direct_joint_enabled else "ik_retarget"
            last_tracking_send_at = 0.0

            while self.running:
                queued_pattern = ""
                queued_pose: Optional[Dict[str, float]] = None
                with self._queue_lock:
                    if self._queued_pose:
                        queued_pose = self._queued_pose
                        self._queued_pose = None
                    if self._queued_pattern:
                        queued_pattern = self._queued_pattern
                        self._queued_pattern = ""
                if queued_pose:
                    try:
                        pose = self._clamp_custom_pose(queued_pose)
                        with self._command_lock:
                            hand.set_joint_positions(pose, num_steps=2, step_size=0.02)
                        self.last_pose_mode = "manual_pose"
                        self.last_joint_count = len(pose)
                        self.last_wrist_angle = pose.get("wrist")
                        self._last_direct_pose = pose
                        self.error = ""
                        self.status = "tracking"
                    except Exception as exc:
                        self.error = str(exc)
                    time.sleep(0.01)
                    continue
                if queued_pattern:
                    try:
                        pose = self._pose_from_pattern(queued_pattern)
                        with self._command_lock:
                            hand.set_joint_positions(pose, num_steps=2, step_size=0.02)
                        self.last_pattern = queued_pattern
                        self.last_pose_mode = "pattern"
                        self.last_joint_count = len(pose)
                        self.last_wrist_angle = pose.get("wrist")
                        self._last_direct_pose = pose
                        self.error = ""
                        self.status = "tracking"
                    except Exception as exc:
                        self.error = str(exc)
                    time.sleep(0.01)
                    continue

                interval = max(0.015, self.config.send_interval_ms / 1000.0)
                now = time.time()
                if now - last_tracking_send_at < interval:
                    time.sleep(0.005)
                    continue

                world_lm, image_lm, hand_type = self.landmark_data.snapshot()
                if self.config.orca_direct_joint_enabled:
                    pose = direct_mapper.pose_from_landmarks(
                        image_lm,
                        world_lm,
                        hand_type,
                        self.config.orca_wrist_follow_enabled,
                    )
                    if pose is None:
                        time.sleep(0.01)
                        continue
                    try:
                        smoothed_pose = self._smooth_direct_pose(pose)
                        with self._command_lock:
                            hand.set_joint_positions(smoothed_pose, num_steps=1)
                        self.last_pose_mode = "direct_joint"
                        self.last_joint_count = len(smoothed_pose)
                        self.last_wrist_angle = smoothed_pose.get("wrist")
                        self.error = ""
                        last_tracking_send_at = now
                    except Exception as exc:
                        self.error = str(exc)
                        time.sleep(0.05)
                    continue

                if world_lm is None or retargeter is None or TargetPose is None:
                    time.sleep(0.01)
                    continue
                if hand_type and hand_type.lower() == "left":
                    world_lm = world_lm.copy()
                    world_lm[:, 0] = -world_lm[:, 0]
                try:
                    target = TargetPose(joint_positions=world_lm, source="mediapipe")
                    result = retargeter.retarget(target)
                    if result is not None:
                        with self._command_lock:
                            hand.set_joint_positions(result, num_steps=1)
                        self.last_pose_mode = "ik_retarget"
                        self.last_joint_count = len(result.as_dict()) if hasattr(result, "as_dict") else 0
                        self.last_wrist_angle = None
                        last_tracking_send_at = now
                except (ValueError, AssertionError):
                    time.sleep(0.005)
                except Exception as exc:
                    self.error = str(exc)
                    time.sleep(0.05)
        except Exception as exc:
            self.error = str(exc)
            self.status = "error"
            self.running = False
        finally:
            if not self.running and hand is not None:
                try:
                    with self._command_lock:
                        hand.disconnect()
                except Exception:
                    pass
                if self._hand is hand:
                    self._hand = None
                    self._retargeter = None

    def _smooth_direct_pose(self, pose: Dict[str, float]) -> Dict[str, float]:
        smoothing = clamp_float(self.config.orca_pose_smoothing, 0.0, 0.92)
        if self._last_direct_pose is None or smoothing <= 0:
            self._last_direct_pose = dict(pose)
            return dict(pose)
        smoothed: Dict[str, float] = {}
        for joint, value in pose.items():
            previous = float(self._last_direct_pose.get(joint, value))
            smoothed[joint] = previous * smoothing + float(value) * (1.0 - smoothing)
        self._last_direct_pose = dict(smoothed)
        return smoothed

    def _pose_from_pattern(self, pattern: str) -> Dict[str, float]:
        if self._hand is None:
            raise RuntimeError("OrcaHand is not connected")

        pose = dict(self._hand.config.neutral_position)
        roms = self._hand.config.joint_roms_dict
        bits = {
            "wrist": pattern[0] == "1",
            "index": pattern[1] == "1",
            "middle": pattern[2] == "1",
            "ring": pattern[3] == "1",
            "thumb": pattern[4] == "1",
            "pinky": pattern[5] == "1",
        }

        def set_fraction(joints: List[str], fraction: float) -> None:
            for joint in joints:
                if joint not in roms:
                    continue
                joint_min, joint_max = roms[joint]
                pose[joint] = float(joint_min) + fraction * (float(joint_max) - float(joint_min))

        # Keep the wrist at neutral for safety. The first bit is still accepted
        # so the six-bit protocol remains compatible with the Arduino hand.
        if bits["index"]:
            set_fraction(["index_mcp", "index_pip"], 0.82)
        if bits["middle"]:
            set_fraction(["middle_mcp", "middle_pip"], 0.82)
        if bits["ring"]:
            set_fraction(["ring_mcp", "ring_pip"], 0.82)
        if bits["pinky"]:
            set_fraction(["pinky_mcp", "pinky_pip"], 0.82)
        if bits["thumb"]:
            set_fraction(["thumb_cmc", "thumb_mcp", "thumb_dip"], 0.76)
            set_fraction(["thumb_abd"], 0.35)
        return pose

    def send_pattern(self, pattern: str) -> Dict[str, Any]:
        if not self.config.orca_enabled:
            return {"ok": True, "skipped": True, "delivered": False, "reason": "orca_disabled"}
        if self.config.dry_run:
            self.last_pattern = pattern
            return {"ok": True, "dry_run": True, "delivered": False, "pattern": pattern}

        with self._queue_lock:
            self._queued_pattern = pattern
        self.last_pattern = pattern

        if not self.running:
            self.start()

        if self._hand is None:
            error = self.error or "OrcaHand did not connect before timeout"
            return {
                "ok": False,
                "pending": True,
                "delivered": False,
                "pattern": pattern,
                "error": error,
                "status": self.status,
            }

        self.error = ""
        return {"ok": True, "pattern": pattern, "queued": True, "delivered": True, "status": self.status}

    def send_pose(self, pose: Dict[str, Any]) -> Dict[str, Any]:
        if not self.config.orca_enabled:
            return {"ok": False, "error": "orca_disabled"}
        numeric_pose = {
            str(joint): float(value)
            for joint, value in pose.items()
            if isinstance(value, (int, float)) or str(value).strip()
        }
        if self.config.dry_run:
            self.last_pose_mode = "manual_pose"
            self.last_joint_count = len(numeric_pose)
            return {
                "ok": True,
                "dry_run": True,
                "delivered": False,
                "mode": "manual_pose",
                "joints": len(numeric_pose),
            }

        with self._queue_lock:
            self._queued_pose = numeric_pose
        if not self.running:
            self.start()
        if self._hand is None:
            return {
                "ok": False,
                "pending": True,
                "delivered": False,
                "mode": "manual_pose",
                "joints": len(numeric_pose),
                "status": self.status,
                "error": self.error,
            }
        return {"ok": True, "queued": True, "delivered": True, "mode": "manual_pose", "joints": len(numeric_pose)}

    def _clamp_custom_pose(self, pose: Dict[str, float]) -> Dict[str, float]:
        if self._hand is None:
            raise RuntimeError("OrcaHand is not connected")
        roms = self._hand.config.joint_roms_dict
        base = dict(self._hand.config.neutral_position)
        for joint, value in pose.items():
            if joint not in roms:
                continue
            joint_min, joint_max = roms[joint]
            base[joint] = clamp_float(float(value), float(joint_min), float(joint_max))
        return base


class GestureController:
    def __init__(self, config: GestureConfig) -> None:
        self.config = config
        self.landmark_data = LandmarkData()
        sender_ports = active_arduino_ports(config)
        self.sender = SerialPatternSender(
            sender_ports,
            config.baud,
            config.dry_run,
            config.arduino_enabled and bool(sender_ports),
            config.arduino_enabled,
            config.arduino_ports,
        )
        self.orca = OrcaRunner(config, self.landmark_data)
        self.external_estimator = FingerStateEstimator(config)
        self.running = False
        self.error = ""
        self.last_pattern = "000000"
        self.last_bends = [0.0] * 6
        self.last_angles = FingerStateEstimator.angles_from_bends(self.last_bends, config)
        self.last_sent_at = 0.0
        self.hand_type: Optional[str] = None
        self.detected = False
        self.landmark_count = 0
        self.frames = 0
        self.fps = 0.0
        self.stage = "idle"
        self.started_at = 0.0
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.RLock()
        self._snapshot_lock = threading.Lock()
        self._snapshot_jpeg: Optional[bytes] = None
        self._snapshot_at = 0.0
        self._history_lock = threading.Lock()
        self._history: deque[Dict[str, Any]] = deque(maxlen=360)
        self._demo_stop = threading.Event()
        self._demo_thread: Optional[threading.Thread] = None
        self._play_stop = threading.Event()
        self._play_thread: Optional[threading.Thread] = None

    def configure(self, patch: Dict[str, Any]) -> None:
        with self._lock:
            was_running = self.running
            if was_running:
                self.stop()
            else:
                self.orca.stop()
                self.sender.close()
            if "camera_index" in patch:
                self.config.camera_index = int(patch["camera_index"])
            if "baud" in patch:
                self.config.baud = int(patch["baud"])
            if "arduino_ports" in patch:
                self.config.arduino_ports = split_ports(patch["arduino_ports"])
            if "dry_run" in patch:
                self.config.dry_run = bool(patch["dry_run"])
            if "arduino_enabled" in patch:
                self.config.arduino_enabled = bool(patch["arduino_enabled"])
            if "arduino_continuous_enabled" in patch:
                self.config.arduino_continuous_enabled = bool(patch["arduino_continuous_enabled"])
            if "arduino_angle_protocol_enabled" in patch:
                self.config.arduino_angle_protocol_enabled = bool(patch["arduino_angle_protocol_enabled"])
            if "arduino_open_angles" in patch:
                self.config.arduino_open_angles = split_floats(
                    patch["arduino_open_angles"],
                    DEFAULT_ARDUINO_OPEN_ANGLES,
                )
            if "arduino_closed_angles" in patch:
                self.config.arduino_closed_angles = split_floats(
                    patch["arduino_closed_angles"],
                    DEFAULT_ARDUINO_CLOSED_ANGLES,
                )
            if "arduino_min_angles" in patch:
                self.config.arduino_min_angles = split_floats(
                    patch["arduino_min_angles"],
                    DEFAULT_ARDUINO_MIN_ANGLES,
                )
            if "arduino_max_angles" in patch:
                self.config.arduino_max_angles = split_floats(
                    patch["arduino_max_angles"],
                    DEFAULT_ARDUINO_MAX_ANGLES,
                )
            if "orca_enabled" in patch:
                self.config.orca_enabled = bool(patch["orca_enabled"])
            if "orca_port" in patch:
                self.config.orca_port = str(patch["orca_port"]).strip()
            if "orca_direct_joint_enabled" in patch:
                self.config.orca_direct_joint_enabled = bool(patch["orca_direct_joint_enabled"])
            if "orca_wrist_follow_enabled" in patch:
                self.config.orca_wrist_follow_enabled = bool(patch["orca_wrist_follow_enabled"])
            if "orca_pose_smoothing" in patch:
                self.config.orca_pose_smoothing = float(patch["orca_pose_smoothing"])
            if "orca_connect_timeout_sec" in patch:
                self.config.orca_connect_timeout_sec = float(patch["orca_connect_timeout_sec"])
            if "send_interval_ms" in patch:
                self.config.send_interval_ms = int(patch["send_interval_ms"])
            if "finger_smoothing" in patch:
                self.config.finger_smoothing = float(patch["finger_smoothing"])
            if "finger_send_threshold" in patch:
                self.config.finger_send_threshold = float(patch["finger_send_threshold"])
            if "finger_open_threshold" in patch:
                self.config.finger_open_threshold = float(patch["finger_open_threshold"])
            if "finger_closed_threshold" in patch:
                self.config.finger_closed_threshold = float(patch["finger_closed_threshold"])
            if "finger_max_step" in patch:
                self.config.finger_max_step = float(patch["finger_max_step"])
            if "continuous_heartbeat_ms" in patch:
                self.config.continuous_heartbeat_ms = int(patch["continuous_heartbeat_ms"])
            if "detection_confidence" in patch:
                self.config.detection_confidence = float(patch["detection_confidence"])
            if "tracking_confidence" in patch:
                self.config.tracking_confidence = float(patch["tracking_confidence"])
            if "package_root" in patch and str(patch["package_root"]).strip():
                self.config.package_root = str(patch["package_root"]).strip()
            if "model_path" in patch:
                self.config.model_path = str(patch["model_path"]).strip()
            if "urdf_path" in patch:
                self.config.urdf_path = str(patch["urdf_path"]).strip()
            if "history_path" in patch:
                self.config.history_path = str(patch["history_path"]).strip()
            sender_ports = active_arduino_ports(self.config)
            self.sender = SerialPatternSender(
                sender_ports,
                self.config.baud,
                self.config.dry_run,
                self.config.arduino_enabled and bool(sender_ports),
                self.config.arduino_enabled,
                self.config.arduino_ports,
            )
            self.orca = OrcaRunner(self.config, self.landmark_data)
            self.external_estimator = FingerStateEstimator(self.config)
            self.last_angles = FingerStateEstimator.angles_from_bends(self.last_bends, self.config)

    def start(self, patch: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if patch:
            self.configure(patch)
        with self._lock:
            if self.running:
                return self.status()
            self.error = ""
            self.running = True
            self.started_at = time.time()
            self.frames = 0
            self.fps = 0.0
            self._thread = threading.Thread(target=self._run, daemon=True, name="gesture-camera")
            self._thread.start()
            if self.config.orca_enabled and self.config.dry_run:
                self.orca.status = "dry_run"
                self.orca.error = ""
            else:
                self.orca.start()
            return self.status()

    def stop(self) -> Dict[str, Any]:
        with self._lock:
            self.running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        self._thread = None
        self.orca.stop()
        self.sender.close()
        return self.status()

    def _record_history(
        self,
        source: str,
        pattern: str,
        landmarks: Any = None,
        hand_type: Optional[str] = None,
        note: Optional[Dict[str, Any]] = None,
        finger_bends: Optional[List[float]] = None,
        arduino_angles: Optional[List[float]] = None,
    ) -> None:
        normalized = normalize_external_landmarks(landmarks)
        entry: Dict[str, Any] = {
            "ts": time.time(),
            "source": source,
            "pattern": pattern,
            "hand_type": hand_type or self.hand_type,
            "detected": bool(normalized) or self.detected,
            "landmark_count": len(normalized) if normalized else self.landmark_count,
        }
        if normalized:
            entry["landmarks"] = normalized
        if finger_bends is not None:
            entry["finger_bends"] = [round(clamp_float(value, 0.0, 1.0), 3) for value in finger_bends[:6]]
        if arduino_angles is not None:
            entry["arduino_angles"] = [round(float(value), 1) for value in arduino_angles[:6]]
        if note:
            entry["note"] = note
        with self._history_lock:
            self._history.append(entry)
        try:
            path = self.config.resolved_history_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        except Exception as exc:
            self.error = f"history write failed: {exc}"

    def history(self, limit: int = 120) -> Dict[str, Any]:
        limit = max(1, min(1000, int(limit or 120)))
        with self._history_lock:
            items = list(self._history)[-limit:]
        return {
            "ok": True,
            "path": str(self.config.resolved_history_path()),
            "items": items,
        }

    def send_action(
        self,
        action: str = "",
        pattern: str = "",
        landmarks: Any = None,
        hand_type: Optional[str] = None,
        source: str = "manual",
        note: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        action = action.strip().lower()
        external_landmarks = normalize_external_landmarks(landmarks)
        continuous_state: Optional[FingerControlState] = None
        if external_landmarks:
            self.landmark_data.update(None, external_landmarks, hand_type)
            self.detected = True
            self.landmark_count = len(external_landmarks)
            self.hand_type = hand_type
            if self.config.arduino_continuous_enabled:
                continuous_state = self.external_estimator.update(external_landmarks)
                pattern = continuous_state.pattern
        if not pattern:
            pattern = ACTION_PATTERNS.get(action, "")
        if not pattern:
            raise ValueError(f"unknown action: {action}")

        now = time.time()
        angle_protocol = bool(self.config.arduino_angle_protocol_enabled)
        continuous_serial = (
            continuous_state is not None
            and self.config.arduino_continuous_enabled
            and angle_protocol
        )
        min_interval = max(float(self.config.send_interval_ms) / 1000.0, 0.05)
        heartbeat_interval = max(float(self.config.continuous_heartbeat_ms) / 1000.0, min_interval)
        elapsed = now - self.last_sent_at if self.last_sent_at else heartbeat_interval
        pattern_changed = pattern != self.last_pattern
        state_changed = pattern_changed or bool(angle_protocol and continuous_state is not None and continuous_state.changed)
        skip_output = False
        skip_reason = ""
        if external_landmarks:
            if elapsed < min_interval:
                skip_output = True
                skip_reason = "rate_limited"
            elif not state_changed and elapsed < heartbeat_interval:
                skip_output = True
                skip_reason = "unchanged"

        if skip_output:
            orca_result = {
                "ok": True,
                "skipped": True,
                "delivered": False,
                "reason": skip_reason,
            }
        elif self.config.orca_enabled:
            if self.config.orca_direct_joint_enabled and external_landmarks:
                if self.config.dry_run:
                    orca_result = {"ok": True, "dry_run": True, "mode": "direct_joint"}
                else:
                    self.orca.start()
                    orca_result = {
                        "ok": True,
                        "mode": "direct_joint",
                        "landmarks": len(external_landmarks),
                        "status": self.orca.status,
                    }
            else:
                orca_result = self.orca.send_pattern(pattern)
            refreshed_ports = active_arduino_ports(self.config)
            if refreshed_ports != self.sender.ports:
                self.sender.close()
                self.sender = SerialPatternSender(
                    refreshed_ports,
                    self.config.baud,
                    self.config.dry_run,
                    self.config.arduino_enabled and bool(refreshed_ports),
                    self.config.arduino_enabled,
                    self.config.arduino_ports,
                )
        else:
            orca_result = self.orca.send_pattern(pattern)
        try:
            if skip_output:
                serial_result = {
                    "ok": True,
                    "skipped": True,
                    "reason": skip_reason,
                    "dry_run": self.config.dry_run,
                    "delivered": False,
                    "pattern": pattern,
                    "continuous": continuous_serial,
                    "ports": list(self.sender.ports),
                }
            elif continuous_serial:
                serial_result = self.sender.send_continuous(
                    continuous_state.pattern,
                    continuous_state.bends,
                    continuous_state.angles,
                )
            else:
                serial_result = self.sender.send(pattern)
        except Exception as exc:
            serial_result = {
                "ok": False,
                "error": str(exc),
                "dry_run": self.config.dry_run,
                "delivered": False,
                "pattern": pattern,
                "continuous": continuous_serial,
                "ports": list(self.sender.ports),
            }
        serial_delivered = bool(
            serial_result.get("delivered")
            or serial_result.get("dry_run")
            or serial_result.get("skipped")
        )
        orca_delivered = bool(
            orca_result.get("delivered")
            or orca_result.get("dry_run")
            or orca_result.get("skipped")
        )
        if not serial_delivered and not orca_delivered:
            self.error = str(
                orca_result.get("error")
                or serial_result.get("error")
                or "No robot hand output is active. Disable dry-run and select an available serial port."
            )
            raise RuntimeError(self.error)
        if not serial_result.get("ok", False) or not orca_result.get("ok", True):
            self.error = str(serial_result.get("error") or orca_result.get("error") or "")
        if continuous_state is not None:
            self.last_bends = list(continuous_state.bends)
            self.last_angles = list(continuous_state.angles)
        else:
            pattern_bends = [1.0 if ch == "1" else 0.0 for ch in pattern[:6]]
            self.last_bends = pattern_bends
            self.last_angles = FingerStateEstimator.angles_from_bends(pattern_bends, self.config)
            self.external_estimator.pattern = pattern
            self.external_estimator.bends = list(self.last_bends)
            self.external_estimator.angles = list(self.last_angles)
            self.external_estimator._initialized = True
        if not skip_output:
            self.last_pattern = pattern
            self.last_sent_at = now
            self._record_history(
                source,
                pattern,
                external_landmarks,
                hand_type,
                note,
                continuous_state.bends if continuous_state is not None else None,
                continuous_state.angles if continuous_state is not None else None,
            )
        return {
            "ok": True,
            "pattern": pattern,
            "finger_bends": [round(value, 3) for value in self.last_bends],
            "arduino_angles": [round(value, 1) for value in self.last_angles],
            "dry_run": self.config.dry_run,
            "delivered": bool(serial_result.get("delivered") or orca_result.get("delivered")),
            "skipped": bool(skip_output),
            "skip_reason": skip_reason or None,
            "ports": list(serial_result.get("ports") or []),
            "serial": serial_result,
            "action": action or None,
            "orca": orca_result,
            "landmarks": len(external_landmarks),
        }

    def start_arduino_demo(self) -> Dict[str, Any]:
        self.stop_arduino_play()
        if self._demo_thread and self._demo_thread.is_alive():
            return {"ok": True, "running": True, "mode": "demo"}
        self._demo_stop.clear()

        def run_demo() -> None:
            index = 0
            while not self._demo_stop.is_set():
                pattern = ARDUINO_DEMO_SEQUENCE[index % len(ARDUINO_DEMO_SEQUENCE)]
                try:
                    self.send_action(pattern=pattern, source="arduino_demo")
                except Exception as exc:
                    self.error = str(exc)
                index += 1
                self._demo_stop.wait(1.5)
            try:
                self.send_action(action="open", source="arduino_demo")
            except Exception:
                pass

        self._demo_thread = threading.Thread(target=run_demo, daemon=True, name="arduino-demo")
        self._demo_thread.start()
        return {"ok": True, "running": True, "mode": "demo", "sequence": ARDUINO_DEMO_SEQUENCE}

    def stop_arduino_demo(self) -> Dict[str, Any]:
        self._demo_stop.set()
        if self._demo_thread and self._demo_thread.is_alive():
            self._demo_thread.join(timeout=2)
        self._demo_thread = None
        return {"ok": True, "running": False, "mode": "demo"}

    def start_arduino_play(self) -> Dict[str, Any]:
        self.stop_arduino_demo()
        if self._play_thread and self._play_thread.is_alive():
            return {"ok": True, "running": True, "mode": "play"}
        self._play_stop.clear()

        def run_play() -> None:
            for index, note in enumerate(ARDUINO_PLAY_NOTES):
                if self._play_stop.is_set():
                    break
                pattern = ARDUINO_NOTE_PATTERNS.get(note, "000000")
                duration = ARDUINO_PLAY_DURATIONS[min(index, len(ARDUINO_PLAY_DURATIONS) - 1)]
                try:
                    self.send_action(
                        pattern=pattern,
                        source="arduino_play",
                        note={
                            "index": index,
                            "value": note,
                            "name": ARDUINO_NOTE_NAMES.get(note, str(note)),
                            "duration": duration,
                        },
                    )
                except Exception as exc:
                    self.error = str(exc)
                self._play_stop.wait(duration)
            try:
                self.send_action(action="open", source="arduino_play")
            except Exception:
                pass

        self._play_thread = threading.Thread(target=run_play, daemon=True, name="arduino-play")
        self._play_thread.start()
        return {"ok": True, "running": True, "mode": "play", "notes": ARDUINO_PLAY_NOTES}

    def stop_arduino_play(self) -> Dict[str, Any]:
        self._play_stop.set()
        if self._play_thread and self._play_thread.is_alive():
            self._play_thread.join(timeout=2)
        self._play_thread = None
        return {"ok": True, "running": False, "mode": "play"}

    def send_orca_pose(self, pose: Dict[str, Any]) -> Dict[str, Any]:
        return self.orca.send_pose(pose)

    def snapshot_jpeg(self) -> Tuple[Optional[bytes], float]:
        with self._snapshot_lock:
            return self._snapshot_jpeg, self._snapshot_at

    def status(self) -> Dict[str, Any]:
        deps = dependency_report(self.config.resolved_package_root())
        if self.config.orca_direct_joint_enabled:
            for name in ("orca_teleop", "torch", "pytorch_kinematics"):
                if name in deps:
                    deps[name] = {**deps[name], "optional": True}
        bridge_error = self.error
        orca_error = self.orca.error
        if self.orca.running and self.orca.status in {"tracking", "pattern"}:
            bridge_error = ""
            orca_error = ""
        return {
            "ok": True,
            "worker": "gesture-arm-bridge",
            "running": self.running,
            "error": bridge_error,
            "config": {
                **asdict(self.config),
                "model_path": str(self.config.resolved_model_path()),
                "urdf_path": str(self.config.resolved_urdf_path()),
                "history_path": str(self.config.resolved_history_path()),
                "active_arduino_ports": list(self.sender.ports),
                "orca_config_port": read_orca_config_port(self.config.resolved_package_root()),
                "orca_runtime_port": self.config.orca_port,
            },
            "last_pattern": self.last_pattern,
            "last_bends": [round(value, 3) for value in self.last_bends],
            "last_angles": [round(value, 1) for value in self.last_angles],
            "last_sent_at": self.last_sent_at,
            "detected": self.detected,
            "hand_type": self.hand_type,
            "landmark_count": self.landmark_count,
            "frames": self.frames,
            "fps": round(self.fps, 1),
            "stage": self.stage,
            "snapshot_at": self._snapshot_at,
            "history_count": len(self._history),
            "history_path": str(self.config.resolved_history_path()),
            "demo": {
                "running": bool(self._demo_thread and self._demo_thread.is_alive()),
            },
            "play": {
                "running": bool(self._play_thread and self._play_thread.is_alive()),
            },
            "dependencies": deps,
            "serial_ports": list_serial_ports(),
            "actions": sorted(ACTION_PATTERNS.keys()),
            "pattern_order": list(ARDUINO_CHANNEL_ORDER),
            "orca": {
                "enabled": self.config.orca_enabled and not self.config.dry_run,
                "requested_enabled": self.config.orca_enabled,
                "running": self.orca.running,
                "status": self.orca.status,
                "error": orca_error,
                "last_pattern": self.orca.last_pattern,
                "mode": self.orca.last_pose_mode,
                "last_joint_count": self.orca.last_joint_count,
                "last_wrist_angle": self.orca.last_wrist_angle,
            },
        }

    def _run(self) -> None:
        cap = None
        try:
            self.stage = "loading_mediapipe"
            detector = GestureDetector(self.config)
            estimator = FingerStateEstimator(self.config)
            cv2 = detector.cv2
            self.stage = "opening_camera"
            if os.name == "nt" and hasattr(cv2, "CAP_DSHOW"):
                cap = cv2.VideoCapture(self.config.camera_index, cv2.CAP_DSHOW)
                if not cap.isOpened():
                    cap.release()
                    cap = cv2.VideoCapture(self.config.camera_index)
            else:
                cap = cv2.VideoCapture(self.config.camera_index)
            if not cap.isOpened():
                raise RuntimeError(f"camera {self.config.camera_index} open failed")
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cap.set(cv2.CAP_PROP_FPS, 30)
            self.stage = "opening_serial"
            self.sender.open()
            last_fps_at = time.time()
            frames_since_fps = 0

            while self.running:
                self.stage = "reading_camera"
                ok, frame = cap.read()
                if not ok:
                    raise RuntimeError("camera frame read failed")
                self.stage = "detecting"
                landmarks, hand_type, world = detector.detect(frame)
                self.stage = "tracking"
                self.detected = bool(landmarks)
                self.landmark_count = len(landmarks)
                self.hand_type = hand_type
                self.landmark_data.update(world, landmarks, hand_type)
                state = estimator.update(landmarks)
                pattern = state.pattern
                now = time.time()
                if now - self._snapshot_at >= 0.2:
                    preview = frame.copy()
                    color = (80, 220, 120) if landmarks else (70, 70, 255)
                    for landmark in landmarks:
                        self.cv2_circle(cv2, preview, landmark[1], landmark[2], color)
                    angle_text = ",".join(str(int(round(angle))) for angle in state.angles[1:])
                    cv2.putText(
                        preview,
                        f"detected={bool(landmarks)} pattern={pattern} angles={angle_text} fps={self.fps:.1f}",
                        (12, 28),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,
                        color,
                        2,
                        cv2.LINE_AA,
                    )
                    ok_jpeg, encoded = cv2.imencode(
                        ".jpg",
                        preview,
                        [int(cv2.IMWRITE_JPEG_QUALITY), 75],
                    )
                    if ok_jpeg:
                        with self._snapshot_lock:
                            self._snapshot_jpeg = encoded.tobytes()
                            self._snapshot_at = now
                interval = max(0.05, self.config.send_interval_ms / 1000.0)
                heartbeat_interval = max(float(self.config.continuous_heartbeat_ms) / 1000.0, interval)
                elapsed = now - self.last_sent_at if self.last_sent_at else heartbeat_interval
                angle_protocol = bool(self.config.arduino_angle_protocol_enabled)
                pattern_changed = pattern != self.last_pattern
                state_changed = pattern_changed or bool(angle_protocol and state.changed)
                should_send = landmarks and elapsed >= interval and (
                    state_changed or elapsed >= heartbeat_interval
                )
                if should_send:
                    if self.config.arduino_continuous_enabled and angle_protocol:
                        self.sender.send_continuous(pattern, state.bends, state.angles)
                    else:
                        self.sender.send(pattern)
                    self._record_history("camera", pattern, landmarks, hand_type, None, state.bends, state.angles)
                    self.last_pattern = pattern
                    self.last_bends = list(state.bends)
                    self.last_angles = list(state.angles)
                    self.last_sent_at = now

                self.frames += 1
                frames_since_fps += 1
                if now - last_fps_at >= 1.0:
                    self.fps = frames_since_fps / (now - last_fps_at)
                    frames_since_fps = 0
                    last_fps_at = now
        except Exception as exc:
            self.error = str(exc)
            self.running = False
            self.stage = "error"
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            self.sender.close()
            if self.stage != "error":
                self.stage = "idle"

    @staticmethod
    def cv2_circle(cv2: Any, frame: Any, x: int, y: int, color: Tuple[int, int, int]) -> None:
        try:
            cv2.circle(frame, (int(x), int(y)), 4, color, -1)
        except Exception:
            pass


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


def bytes_response(handler: BaseHTTPRequestHandler, status: int, content_type: str, data: bytes) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Private-Network", "true")
    handler.end_headers()
    handler.wfile.write(data)


def read_json(handler: BaseHTTPRequestHandler) -> Dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length) or b"{}")


def make_handler(controller: GestureController):
    class Handler(BaseHTTPRequestHandler):
        def do_OPTIONS(self) -> None:  # noqa: N802
            json_response(self, 204, {})

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if path in {"/", "/health", "/status"}:
                json_response(self, 200, controller.status())
                return
            if path == "/ports":
                json_response(self, 200, {"ok": True, "ports": list_serial_ports()})
                return
            if path == "/history":
                query = parse_qs(urlparse(self.path).query)
                limit = int((query.get("limit") or ["120"])[0] or "120")
                json_response(self, 200, controller.history(limit))
                return
            if path == "/snapshot":
                jpeg, timestamp = controller.snapshot_jpeg()
                if not jpeg:
                    json_response(
                        self,
                        404,
                        {
                            "ok": False,
                            "error": "no camera snapshot yet; start gesture recognition first",
                        },
                    )
                    return
                bytes_response(self, 200, "image/jpeg", jpeg)
                return
            json_response(self, 404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            try:
                body = read_json(self)
                if path == "/start":
                    json_response(self, 200, controller.start(body))
                    return
                if path == "/stop":
                    json_response(self, 200, controller.stop())
                    return
                if path == "/config":
                    controller.configure(body)
                    json_response(self, 200, controller.status())
                    return
                if path == "/action":
                    result = controller.send_action(
                        action=str(body.get("action") or ""),
                        pattern=str(body.get("pattern") or ""),
                        landmarks=body.get("landmarks"),
                        hand_type=str(body.get("hand_type") or "") or None,
                        source=str(body.get("source") or "manual"),
                    )
                    json_response(self, 200, result)
                    return
                if path == "/orca/pose":
                    result = controller.send_orca_pose(body.get("pose") or body)
                    json_response(self, 200 if result.get("ok") else 400, result)
                    return
                if path == "/arduino/demo/start":
                    json_response(self, 200, controller.start_arduino_demo())
                    return
                if path == "/arduino/demo/stop":
                    json_response(self, 200, controller.stop_arduino_demo())
                    return
                if path == "/arduino/play/start":
                    json_response(self, 200, controller.start_arduino_play())
                    return
                if path == "/arduino/play/stop":
                    json_response(self, 200, controller.stop_arduino_play())
                    return
                json_response(self, 404, {"ok": False, "error": "not found"})
            except json.JSONDecodeError:
                json_response(self, 400, {"ok": False, "error": "invalid json"})
            except Exception as exc:
                json_response(self, 500, {"ok": False, "error": str(exc)})

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[http] {self.address_string()} {fmt % args}")

    return Handler


def main() -> None:
    config = GestureConfig()
    controller = GestureController(config)
    server = ThreadingHTTPServer((config.host, config.http_port), make_handler(controller))
    print(
        f"Gesture arm bridge listening on http://{config.host}:{config.http_port} "
        f"(camera={config.camera_index}, dry_run={config.dry_run}, "
        f"arduino_ports={','.join(config.arduino_ports) or '-'}, orca={config.orca_enabled})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        controller.stop()


if __name__ == "__main__":
    main()

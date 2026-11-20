"""Head motion protocol helpers for the RK3566 robot head.

The vendor Android demo sends five-byte frames over /dev/ttyS4 at 9600 baud:

    FF 01 <channel> <speed> 00
    FF 02 <channel> <pulse_low> <pulse_high>

For custom servo moves the Android demo uses:

    pulse = angle * 11 + 500

This module keeps the protocol pure and dependency-free so it can be tested on
Windows before we touch either the robot hardware or the production server.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple


@dataclass(frozen=True)
class ServoSpec:
    location: int
    name: str
    channel: int
    min_angle: int
    max_angle: int
    neutral_angle: int


@dataclass(frozen=True)
class Step:
    frame: Optional[bytes] = None
    delay_ms: int = 0


SERVO_SPECS: Dict[int, ServoSpec] = {
    1: ServoSpec(1, "right_eyelid", 0x02, 90, 126, 126),
    2: ServoSpec(2, "left_eyelid", 0x04, 54, 90, 54),
    3: ServoSpec(3, "eyes", 0x06, 72, 108, 90),
    4: ServoSpec(4, "left_cheek", 0x0C, 58, 140, 90),
    5: ServoSpec(5, "right_cheek", 0x0D, 45, 120, 90),
    6: ServoSpec(6, "mouth", 0x00, 85, 153, 85),
    7: ServoSpec(7, "neck", 0x08, 63, 117, 90),
}

ALLOWED_SPEEDS = {5, 10, 15}


def frame(hex_string: str) -> bytes:
    return bytes.fromhex(hex_string.replace(" ", ""))


RAW = {
    # Direct copies of EngineParameter.java.
    "mouth_speed_5": frame("FF 01 00 05 00"),
    "mouth_speed_20": frame("FF 01 00 14 00"),
    "mouth_neutral": frame("FF 02 00 08 07"),
    "mouth_close": frame("FF 02 00 AA 05"),
    "mouth_open": frame("FF 02 00 D0 07"),
    "mouth_open_wide": frame("FF 02 00 98 08"),
    "right_eyelid_speed_5": frame("FF 01 02 05 00"),
    "right_eyelid_speed_10": frame("FF 01 02 0A 00"),
    "right_eyelid_open": frame("FF 02 02 6C 07"),
    "right_eyelid_close": frame("FF 02 02 DC 05"),
    "right_eyelid_wide": frame("FF 02 02 D0 07"),
    "left_eyelid_speed_5": frame("FF 01 04 05 00"),
    "left_eyelid_speed_10": frame("FF 01 04 0A 00"),
    "left_eyelid_open": frame("FF 02 04 4C 04"),
    "left_eyelid_close": frame("FF 02 04 DC 05"),
    "left_eyelid_wide": frame("FF 02 04 E8 03"),
    "eyes_speed_5": frame("FF 01 06 05 00"),
    "eyes_center": frame("FF 02 06 DC 05"),
    "eyes_right": frame("FF 02 06 A4 06"),
    "eyes_left": frame("FF 02 06 14 05"),
    "neck_speed_5": frame("FF 01 08 05 00"),
    "neck_center": frame("FF 02 08 DC 05"),
    "neck_left": frame("FF 02 08 08 07"),
    "neck_right": frame("FF 02 08 B0 04"),
    "left_cheek_speed_5": frame("FF 01 0C 05 00"),
    "left_cheek_speed_10": frame("FF 01 0C 0A 00"),
    "left_cheek_center": frame("FF 02 0C DC 05"),
    "left_cheek_up": frame("FF 02 0C D0 07"),
    "left_cheek_down": frame("FF 02 0C E2 04"),
    "right_cheek_speed_5": frame("FF 01 0D 05 00"),
    "right_cheek_speed_10": frame("FF 01 0D 0A 00"),
    "right_cheek_center": frame("FF 02 0D DC 05"),
    "right_cheek_up": frame("FF 02 0D E8 03"),
    "right_cheek_down": frame("FF 02 0D D6 06"),
}


def clamp_angle(location: int, angle: int) -> int:
    spec = SERVO_SPECS.get(location)
    if spec is None:
        raise ValueError(f"unknown servo location: {location}")
    return max(spec.min_angle, min(spec.max_angle, int(angle)))


def normalize_speed(speed: int) -> int:
    speed = int(speed)
    if speed not in ALLOWED_SPEEDS:
        raise ValueError(f"speed must be one of {sorted(ALLOWED_SPEEDS)}")
    return speed


def angle_to_pulse(angle: int) -> int:
    return int(angle) * 11 + 500


def build_speed_frame(channel: int, speed: int) -> bytes:
    return bytes([0xFF, 0x01, channel & 0xFF, normalize_speed(speed) & 0xFF, 0x00])


def build_position_frame(channel: int, angle: int) -> bytes:
    pulse = angle_to_pulse(angle)
    return bytes([0xFF, 0x02, channel & 0xFF, pulse & 0xFF, (pulse >> 8) & 0xFF])


def build_servo_frames(location: int, angle: int, speed: int = 5) -> List[bytes]:
    spec = SERVO_SPECS.get(int(location))
    if spec is None:
        raise ValueError(f"unknown servo location: {location}")
    angle = clamp_angle(spec.location, int(angle))
    return [
        build_speed_frame(spec.channel, speed),
        build_position_frame(spec.channel, angle),
    ]


def steps(*items: Tuple[Optional[bytes], int] | bytes) -> List[Step]:
    out: List[Step] = []
    for item in items:
        if isinstance(item, bytes):
            out.append(Step(item, 0))
        else:
            out.append(Step(item[0], item[1]))
    return out


ACTION_SEQUENCES: Dict[str, List[Step]] = {
    "init": steps(
        RAW["mouth_speed_5"],
        RAW["mouth_neutral"],
        RAW["right_eyelid_speed_5"],
        RAW["right_eyelid_open"],
        RAW["left_eyelid_speed_5"],
        RAW["left_eyelid_open"],
        RAW["eyes_speed_5"],
        RAW["eyes_center"],
        RAW["neck_speed_5"],
        RAW["neck_center"],
        RAW["left_cheek_speed_5"],
        RAW["left_cheek_center"],
        RAW["right_cheek_speed_5"],
        RAW["right_cheek_center"],
    ),
    "stopspeak": steps(RAW["mouth_speed_20"], RAW["mouth_close"]),
    "blink": steps(
        RAW["right_eyelid_speed_10"],
        RAW["left_eyelid_speed_10"],
        RAW["right_eyelid_close"],
        RAW["left_eyelid_close"],
        (None, 160),
        RAW["right_eyelid_speed_10"],
        RAW["left_eyelid_speed_10"],
        RAW["right_eyelid_open"],
        RAW["left_eyelid_open"],
    ),
    "blink_left": steps(
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_close"],
        (None, 220),
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_open"],
    ),
    "blink_right": steps(
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_close"],
        (None, 220),
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_open"],
    ),
    "turn_neck": steps(
        RAW["neck_speed_5"],
        RAW["neck_left"],
        (None, 500),
        RAW["neck_speed_5"],
        RAW["neck_center"],
        (None, 500),
        RAW["neck_speed_5"],
        RAW["neck_right"],
        (None, 500),
        RAW["neck_speed_5"],
        RAW["neck_center"],
    ),
    "eyes_rotate": steps(
        RAW["eyes_speed_5"],
        RAW["eyes_left"],
        (None, 350),
        RAW["eyes_speed_5"],
        RAW["eyes_center"],
        (None, 350),
        RAW["eyes_speed_5"],
        RAW["eyes_right"],
        (None, 350),
        RAW["eyes_speed_5"],
        RAW["eyes_center"],
    ),
    "smile": steps(
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_wide"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_wide"],
        RAW["left_cheek_speed_10"],
        RAW["left_cheek_up"],
        RAW["right_cheek_speed_10"],
        RAW["right_cheek_up"],
        (None, 1200),
        RAW["left_cheek_speed_5"],
        RAW["left_cheek_center"],
        RAW["right_cheek_speed_5"],
        RAW["right_cheek_center"],
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_open"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_open"],
    ),
    "sad": steps(
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_close"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_close"],
        RAW["left_cheek_speed_10"],
        RAW["left_cheek_down"],
        RAW["right_cheek_speed_10"],
        RAW["right_cheek_down"],
        (None, 1200),
        RAW["left_cheek_speed_5"],
        RAW["left_cheek_center"],
        RAW["right_cheek_speed_5"],
        RAW["right_cheek_center"],
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_open"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_open"],
    ),
    "kiss": steps(
        RAW["left_cheek_speed_10"],
        RAW["left_cheek_down"],
        RAW["right_cheek_speed_10"],
        RAW["right_cheek_down"],
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_close"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_close"],
        (None, 800),
        RAW["left_cheek_speed_5"],
        RAW["left_cheek_center"],
        RAW["right_cheek_speed_5"],
        RAW["right_cheek_center"],
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_open"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_open"],
    ),
    "makeface": steps(
        RAW["left_cheek_speed_5"],
        RAW["left_cheek_up"],
        RAW["right_cheek_speed_5"],
        RAW["right_cheek_center"],
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_close"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_wide"],
        (None, 600),
        RAW["left_cheek_speed_5"],
        RAW["left_cheek_center"],
        RAW["right_cheek_speed_5"],
        RAW["right_cheek_up"],
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_wide"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_close"],
        (None, 600),
        RAW["left_cheek_speed_5"],
        RAW["left_cheek_center"],
        RAW["right_cheek_speed_5"],
        RAW["right_cheek_center"],
        RAW["right_eyelid_speed_10"],
        RAW["right_eyelid_open"],
        RAW["left_eyelid_speed_10"],
        RAW["left_eyelid_open"],
    ),
}


def action_names() -> List[str]:
    return sorted(["speak", "servo", *ACTION_SEQUENCES.keys()])


def iter_frames(sequence: Iterable[Step]) -> Iterable[bytes]:
    for step in sequence:
        if step.frame is not None:
            yield step.frame


def hex_frame(data: bytes) -> str:
    return data.hex(" ").upper()

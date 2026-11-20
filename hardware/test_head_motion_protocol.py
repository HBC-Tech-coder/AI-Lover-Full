import unittest

from head_motion_protocol import (
    build_position_frame,
    build_servo_frames,
    build_speed_frame,
    clamp_angle,
    hex_frame,
)


class HeadMotionProtocolTest(unittest.TestCase):
    def test_position_frame_matches_vendor_formula(self):
        self.assertEqual(hex_frame(build_position_frame(0x00, 90)), "FF 02 00 D2 05")
        self.assertEqual(hex_frame(build_position_frame(0x08, 117)), "FF 02 08 FB 06")

    def test_servo_frame_clamps_angle_and_validates_speed(self):
        frames = build_servo_frames(location=6, angle=200, speed=5)
        self.assertEqual(hex_frame(frames[0]), "FF 01 00 05 00")
        self.assertEqual(hex_frame(frames[1]), "FF 02 00 87 08")
        self.assertEqual(clamp_angle(6, 200), 153)

    def test_speed_frame_uses_documented_speed_byte(self):
        self.assertEqual(hex_frame(build_speed_frame(0x02, 10)), "FF 01 02 0A 00")
        with self.assertRaises(ValueError):
            build_speed_frame(0x02, 7)


if __name__ == "__main__":
    unittest.main()

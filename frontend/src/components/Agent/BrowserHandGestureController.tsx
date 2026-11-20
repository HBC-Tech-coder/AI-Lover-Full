"use client";

import { useEffect, useRef } from "react";
import {
  sendHandGestureAction,
  startLocalHandGestureBridge,
} from "@/lib/handGesture";
import { browserMediaUnavailableReason } from "@/lib/audioUtils";
import { useSettings } from "@/lib/settingsStore";

type Landmark = {
  x: number;
  y: number;
  z?: number;
};

function distance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isFingerFolded(points: Landmark[], tip: number, pip: number): boolean {
  return points[tip].y > points[pip].y + 0.025;
}

function estimatePattern(points: Landmark[]): string {
  if (points.length < 21) return "000000";

  const palmWidth = Math.max(distance(points[5], points[17]), 0.001);
  const wristFolded = false;
  const indexFolded = isFingerFolded(points, 8, 6);
  const middleFolded = isFingerFolded(points, 12, 10);
  const ringFolded = isFingerFolded(points, 16, 14);
  const pinkyFolded = isFingerFolded(points, 20, 18);
  const thumbTipToIndexMcp = distance(points[4], points[5]);
  const thumbFolded =
    thumbTipToIndexMcp < palmWidth * 0.62 || points[4].y > points[3].y + 0.035;

  return [
    wristFolded,
    indexFolded,
    middleFolded,
    ringFolded,
    thumbFolded,
    pinkyFolded,
  ]
    .map((value) => (value ? "1" : "0"))
    .join("");
}

function handTypeFromResult(result: any, index = 0): string | null {
  const item = result?.handednesses?.[index]?.[0] || result?.handedness?.[index]?.[0];
  return item?.categoryName || item?.category_name || item?.displayName || null;
}

function parsePortList(value: string): string[] {
  return value
    .replace(/[;\uff1b\uff0c\s]+/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return value
    .replaceAll("，", ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clampInterval(value: number, fallback: number, min = 50, max = 1000): number {
  const numeric = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function BrowserHandGestureController() {
  const [settings] = useSettings();
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastSentRef = useRef("");
  const candidateRef = useRef("000000");
  const candidateCountRef = useRef(0);
  const lastSentAtRef = useRef(0);
  const lastRecognizedAtRef = useRef(0);

  useEffect(() => {
    if (
      !settings.consentAccepted ||
      !settings.cameraEnabled ||
      !settings.handGestureEnabled
    ) {
      return;
    }

    let cancelled = false;
    let landmarker: any = null;
    let video: HTMLVideoElement | null = null;

    const stop = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (landmarker?.close) landmarker.close();
    };

    const start = async () => {
      try {
        await startLocalHandGestureBridge({
          camera_index: settings.handGestureCameraIndex,
          arduino_ports: parsePortList(settings.handGestureArduinoPorts),
          baud: settings.handGestureBaud,
          dry_run: settings.handGestureDryRun,
          arduino_enabled: settings.handGestureArduinoEnabled,
          send_interval_ms: clampInterval(settings.handGestureSendIntervalMs, 120),
          orca_enabled: settings.handGestureOrcaEnabled,
          orca_port: settings.handGestureOrcaPort,
          orca_direct_joint_enabled: settings.handGestureOrcaDirectJointEnabled,
          orca_wrist_follow_enabled: settings.handGestureOrcaWristFollowEnabled,
        });
        lastSentRef.current = "";
        lastSentAtRef.current = 0;
        lastRecognizedAtRef.current = 0;

        const unavailable = browserMediaUnavailableReason("camera");
        if (unavailable) throw new Error(unavailable);

        const [{ FilesetResolver, HandLandmarker }, stream] = await Promise.all([
          import("@mediapipe/tasks-vision"),
          navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 30 },
            },
            audio: false,
          }),
        ]);
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();

        const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "/mediapipe/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        const tick = async () => {
          if (cancelled || !video || !landmarker) return;
          const now = performance.now();
          const recognitionInterval = clampInterval(
            settings.handGestureRecognitionIntervalMs,
            90,
          );
          const sendInterval = clampInterval(settings.handGestureSendIntervalMs, 120);
          if (now - lastRecognizedAtRef.current < recognitionInterval) {
            rafRef.current = requestAnimationFrame(tick);
            return;
          }
          lastRecognizedAtRef.current = now;
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const result = landmarker.detectForVideo(video, now);
            const points = result.landmarks?.[0] as Landmark[] | undefined;
            const pattern = points ? estimatePattern(points) : "000000";
            const handType = points ? handTypeFromResult(result, 0) : null;

            if (pattern === candidateRef.current) {
              candidateCountRef.current += 1;
            } else {
              candidateRef.current = pattern;
              candidateCountRef.current = 1;
            }

            const continuousHand = Boolean(points) && settings.handGestureEnabled;

            if (continuousHand && points && now - lastSentAtRef.current >= sendInterval) {
              lastSentRef.current = pattern;
              lastSentAtRef.current = now;
              sendHandGestureAction("", pattern, points, handType, "camera").catch((error) => {
                console.warn("Browser hand gesture landmarks failed:", error);
              });
            } else if (
              candidateCountRef.current >= 2 &&
              pattern !== lastSentRef.current &&
              now - lastSentAtRef.current >= sendInterval
            ) {
              lastSentRef.current = pattern;
              lastSentAtRef.current = now;
              sendHandGestureAction("", pattern, points, handType, "camera").catch((error) => {
                console.warn("Browser hand gesture action failed:", error);
              });
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
      } catch (error) {
        console.error("Browser hand gesture failed:", error);
        stop();
      }
    };

    start();

    return () => {
      cancelled = true;
      stop();
    };
  }, [
    settings.consentAccepted,
    settings.cameraEnabled,
    settings.handGestureEnabled,
    settings.handGestureCameraIndex,
    settings.handGestureArduinoPorts,
    settings.handGestureBaud,
    settings.handGestureRecognitionIntervalMs,
    settings.handGestureSendIntervalMs,
    settings.handGestureDryRun,
    settings.handGestureArduinoEnabled,
    settings.handGestureOrcaEnabled,
    settings.handGestureOrcaPort,
    settings.handGestureOrcaDirectJointEnabled,
    settings.handGestureOrcaWristFollowEnabled,
  ]);

  return null;
}

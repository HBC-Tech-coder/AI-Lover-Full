"use client";

/**
 * Persistent user settings — backgrounds, voice volume, etc.
 *
 * Stored in `localStorage['xiaoling_settings']` as a single JSON blob so we
 * don't keep adding storage keys per setting. Reading is sync (zero-flash
 * on mount); writing also updates a tiny in-process listener set so the
 * UI reacts without prop-drilling.
 */

import { useEffect, useState } from "react";

export type BackgroundPresetId =
  | "default"
  | "dawn"
  | "forest"
  | "ocean"
  | "dusk"
  | "night"
  | "warm";

export interface BackgroundPreset {
  id: BackgroundPresetId;
  label: string;
  /** Tailwind / CSS background value applied to the page root. */
  css: string;
}

export type SubtitleRenderMode = "word" | "text_sync" | "text_once";
export type VoiceLockMode = "off" | "auto_learning" | "manual";
export type CameraQuality = "standard" | "high" | "ultra";

export const CAMERA_QUALITY_PRESETS: Record<
  CameraQuality,
  { label: string; width: number; height: number; frameRate: number }
> = {
  standard: { label: "标准 480p", width: 640, height: 480, frameRate: 30 },
  high: { label: "高清 720p", width: 1280, height: 720, frameRate: 30 },
  ultra: { label: "超清 1080p", width: 1920, height: 1080, frameRate: 30 },
};

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: "default",
    label: "默认",
    css: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
  },
  {
    id: "dawn",
    label: "黎明",
    css: "linear-gradient(180deg, #1e1b4b 0%, #fb923c 100%)",
  },
  {
    id: "forest",
    label: "森林",
    css: "linear-gradient(180deg, #052e16 0%, #166534 100%)",
  },
  {
    id: "ocean",
    label: "海洋",
    css: "linear-gradient(180deg, #082f49 0%, #0c4a6e 100%)",
  },
  {
    id: "dusk",
    label: "黄昏",
    css: "linear-gradient(180deg, #4a044e 0%, #f97316 100%)",
  },
  {
    id: "night",
    label: "夜空",
    css: "linear-gradient(180deg, #020617 0%, #1e1b4b 100%)",
  },
  {
    id: "warm",
    label: "暖光",
    css: "linear-gradient(180deg, #422006 0%, #facc15 100%)",
  },
];

export interface XiaolingSettings {
  /** Either a preset id, or `custom:<dataURL>` for user-uploaded image. */
  background: string;
  /** Master TTS volume, 0..1. */
  voiceVolume: number;
  /** Whether transcript subtitles are overlaid on the avatar stage. */
  subtitlesEnabled: boolean;
  /** UI-side subtitle rendering mode. Backend word timing can refine this. */
  subtitleRenderMode: SubtitleRenderMode;
  /** Desired voice-lock mode; sent with audio metadata for backend/worker use. */
  voiceLockMode: VoiceLockMode;
  /** Use the TEN Speechmatics diarization graph instead of the default ASR graph. */
  speakerDiarizationEnabled: boolean;
  /** Turn the robot head and eyes toward the active diarized speaker. */
  speakerFocusHeadEnabled: boolean;
  /** Assign stable demo seats to S1/S2/S3 when no physical angle is available. */
  speakerFocusFallbackSeatsEnabled: boolean;
  /** Max neck turn used by speaker focus, in degrees from neutral. */
  speakerFocusMaxHeadAngle: number;
  /** Max eye turn used by speaker focus, in degrees from neutral. */
  speakerFocusMaxEyeAngle: number;
  /** Reserved for M3.2 — only "kei" exists today. */
  selectedAvatar: string;
  /** Avatar renderer: Live2D is CPU/browser-side; GPU uses a local video worker. */
  avatarRendererMode: "live2d" | "gpu";
  /** Local/private-LAN GPU avatar worker endpoint. */
  gpuAvatarEndpoint: string;
  /** Worker-side avatar id, e.g. a MuseTalk prepared avatar. */
  gpuAvatarId: string;
  /** Whether the local webcam preview is on. Off stops the MediaStream
   *  so the OS camera indicator turns off. */
  cameraEnabled: boolean;
  /** Browser camera deviceId. Empty means browser/default camera. */
  cameraDeviceId: string;
  /** Browser camera capture quality for preview and gesture effects. */
  cameraQuality: CameraQuality;
  /** Optional second-screen camera deviceId. Empty means browser/default camera. */
  stageCameraDeviceId: string;
  /** Second-screen camera quality, usually high/ultra for demos. */
  stageCameraQuality: CameraQuality;
  /** UI language. zh by default — product mother tongue. en/ja for
   *  international users; switchable from the settings drawer. */
  language: "zh" | "en" | "ja";
  /** Preferred reply language for the persona. "auto" follows the current
   *  conversation naturally; concrete values like "en" are sticky. */
  preferredReplyLanguage: string;
  /** First-run consent (mic/camera/data usage). Gates mic+camera
   *  auto-start until the user accepts. */
  consentAccepted: boolean;
  /** First-run guided tour shown once after consent. */
  tourCompleted: boolean;
  /** Local robot head bridge endpoint. Usually the Python bridge on this PC. */
  robotHeadEndpoint: string;
  /** RK3566 head IP on the LAN, used to configure the local bridge. */
  robotHeadIp: string;
  /** Whether assistant text/audio should drive head expressions and servos. */
  robotHeadMotionEnabled: boolean;
  /** Track a visible face in the laptop camera and gently turn head eyes. */
  robotHeadEyeTrackingEnabled: boolean;
  /** Mirror/invert the horizontal eye tracking direction. */
  robotHeadEyeTrackingInvertX: boolean;
  /** Let the neck servo follow larger horizontal offsets. */
  robotHeadEyeTrackingNeckFollow: boolean;
  /** Max eye servo delta from neutral, in degrees. */
  robotHeadEyeTrackingMaxEyeAngle: number;
  /** Max neck servo delta from neutral, in degrees. */
  robotHeadEyeTrackingMaxNeckAngle: number;
  /** Whether TTS chunks should also be played through the head speaker. */
  robotHeadSpeakerEnabled: boolean;
  /** Head speaker volume, 0..1, mapped to the RK3566 mixer range. */
  robotHeadVolume: number;
  /** Whether recording should use the browser/computer microphone. */
  computerMicEnabled: boolean;
  /** Whether recording should use the head microphone through the bridge. */
  robotHeadMicEnabled: boolean;
  /** Local hand-gesture/robot arm bridge endpoint. */
  handGestureEndpoint: string;
  /** Whether gesture recognition should be enabled from the settings panel. */
  handGestureEnabled: boolean;
  /** Dry-run keeps recognition active without opening robot arm serial ports. */
  handGestureDryRun: boolean;
  /** Webcam index used by the local gesture bridge. */
  handGestureCameraIndex: number;
  /** Comma-separated Arduino serial ports for six-bit finger patterns. */
  handGestureArduinoPorts: string;
  /** Arduino serial baud rate. */
  handGestureBaud: number;
  /** Browser-side MediaPipe recognition interval, in milliseconds. */
  handGestureRecognitionIntervalMs: number;
  /** Minimum interval between hand commands sent to the local bridge. */
  handGestureSendIntervalMs: number;
  /** Whether Arduino serial output is enabled. */
  handGestureArduinoEnabled: boolean;
  /** Whether optional OrcaHand/Dynamixel retargeting is enabled. */
  handGestureOrcaEnabled: boolean;
  /** Optional OrcaHand/Dynamixel serial port. Blank means auto-detect. */
  handGestureOrcaPort: string;
  /** Use dependency-light continuous 17-joint ORCA mapping. */
  handGestureOrcaDirectJointEnabled: boolean;
  /** Follow estimated human wrist flexion/extension on ORCA wrist. */
  handGestureOrcaWristFollowEnabled: boolean;
  /** Browser-side particle overlay driven by recognized hand gestures. */
  handGestureParticleEffectsEnabled: boolean;
  /** Route local hardware calls through the cloud /device-bridge relay. */
  localConnectorEnabled: boolean;
  /** Pairing code shared by the browser and AI-Lover Local Connector. */
  localConnectorPairingCode: string;
  /** Optional local device label shown in the cloud connection wizard. */
  localConnectorDeviceName: string;
  /** Optional WebSocket bridge URL. Empty means current site /device-bridge. */
  localConnectorBridgeUrl: string;
}

const DEFAULT_SETTINGS: XiaolingSettings = {
  background: "default",
  voiceVolume: 0.85,
  subtitlesEnabled: true,
  subtitleRenderMode: "word",
  voiceLockMode: "off",
  speakerDiarizationEnabled: false,
  speakerFocusHeadEnabled: true,
  speakerFocusFallbackSeatsEnabled: true,
  speakerFocusMaxHeadAngle: 22,
  speakerFocusMaxEyeAngle: 14,
  selectedAvatar: "osagegirl",
  avatarRendererMode: "live2d",
  gpuAvatarEndpoint: "http://127.0.0.1:8810",
  gpuAvatarId: "default",
  cameraEnabled: true,
  cameraDeviceId: "",
  cameraQuality: "high",
  stageCameraDeviceId: "",
  stageCameraQuality: "ultra",
  language: "zh",
  preferredReplyLanguage: "auto",
  consentAccepted: false,
  tourCompleted: false,
  robotHeadEndpoint: "http://127.0.0.1:8787",
  robotHeadIp: "192.168.110.63",
  robotHeadMotionEnabled: true,
  robotHeadEyeTrackingEnabled: false,
  robotHeadEyeTrackingInvertX: false,
  robotHeadEyeTrackingNeckFollow: false,
  robotHeadEyeTrackingMaxEyeAngle: 14,
  robotHeadEyeTrackingMaxNeckAngle: 12,
  robotHeadSpeakerEnabled: false,
  robotHeadVolume: 1,
  computerMicEnabled: true,
  robotHeadMicEnabled: false,
  handGestureEndpoint: "http://127.0.0.1:8791",
  handGestureEnabled: false,
  handGestureDryRun: true,
  handGestureCameraIndex: 0,
  handGestureArduinoPorts: "",
  handGestureBaud: 9600,
  handGestureRecognitionIntervalMs: 90,
  handGestureSendIntervalMs: 120,
  handGestureArduinoEnabled: true,
  handGestureOrcaEnabled: false,
  handGestureOrcaPort: "",
  handGestureOrcaDirectJointEnabled: true,
  handGestureOrcaWristFollowEnabled: false,
  handGestureParticleEffectsEnabled: true,
  localConnectorEnabled: false,
  localConnectorPairingCode: "",
  localConnectorDeviceName: "",
  localConnectorBridgeUrl: "",
};

const STORAGE_KEY = "xiaoling_settings";
const MIC_DEFAULT_MIGRATION_KEY = "xiaoling_computer_mic_default_v1";

function loadFromStorage(): XiaolingSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      window.localStorage.setItem(MIC_DEFAULT_MIGRATION_KEY, "1");
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // 小灵(kei) was retired from the picker — migrate anyone still on it.
    if (merged.selectedAvatar === "kei") {
      merged.selectedAvatar = DEFAULT_SETTINGS.selectedAvatar;
    }
    // Existing browsers may have persisted the head microphone as their input.
    // Reset that choice once so users without a connected head can speak on
    // first open; subsequent explicit choices remain untouched.
    if (window.localStorage.getItem(MIC_DEFAULT_MIGRATION_KEY) !== "1") {
      merged.computerMicEnabled = true;
      merged.robotHeadMicEnabled = false;
      window.localStorage.setItem(MIC_DEFAULT_MIGRATION_KEY, "1");
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } else if (merged.robotHeadMicEnabled) {
      merged.computerMicEnabled = false;
    }
    if (
      merged.cameraQuality !== "standard" &&
      merged.cameraQuality !== "high" &&
      merged.cameraQuality !== "ultra"
    ) {
      merged.cameraQuality = DEFAULT_SETTINGS.cameraQuality;
    }
    if (typeof merged.cameraDeviceId !== "string") {
      merged.cameraDeviceId = "";
    }
    if (typeof merged.stageCameraDeviceId !== "string") {
      merged.stageCameraDeviceId = "";
    }
    if (
      merged.stageCameraQuality !== "standard" &&
      merged.stageCameraQuality !== "high" &&
      merged.stageCameraQuality !== "ultra"
    ) {
      merged.stageCameraQuality = DEFAULT_SETTINGS.stageCameraQuality;
    }
    if (typeof merged.localConnectorPairingCode !== "string") {
      merged.localConnectorPairingCode = "";
    }
    if (typeof merged.localConnectorDeviceName !== "string") {
      merged.localConnectorDeviceName = "";
    }
    if (typeof merged.localConnectorBridgeUrl !== "string") {
      merged.localConnectorBridgeUrl = "";
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveToStorage(settings: XiaolingSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage full or disabled — settings won't persist this session
  }
}

// ---- Tiny pub-sub so components react to updates ---------------------------
type Listener = (s: XiaolingSettings) => void;
const listeners = new Set<Listener>();
let cached: XiaolingSettings | null = null;

/** Read the current settings snapshot (sync). Exported so non-React code
 *  paths — e.g. the i18n `translate()` helper called from event handlers —
 *  can read the active language without a hook. */
export function getSettings(): XiaolingSettings {
  if (!cached) cached = loadFromStorage();
  return cached;
}

/** Mutate settings + persist + notify all subscribers. Exported so other
 *  modules (e.g. i18n's setLanguage) can flip a single field without
 *  duplicating the broadcast logic. */
export function setSettings(patch: Partial<XiaolingSettings>) {
  const next = { ...getSettings(), ...patch };
  if (patch.robotHeadMicEnabled === true) {
    next.computerMicEnabled = false;
  }
  if (patch.computerMicEnabled === true) {
    next.robotHeadMicEnabled = false;
  }
  cached = next;
  saveToStorage(cached);
  listeners.forEach((fn) => fn(cached!));
}

/** React hook — returns current settings + a setter that persists & broadcasts.
 *
 *  Hydration-safety: the very first render (SSR + the client’s initial
 *  pre-hydration render) MUST produce the same HTML. localStorage only
 *  exists in the browser, so the initial state is always DEFAULT_SETTINGS;
 *  we switch to the persisted values inside useEffect, which runs only
 *  after hydration completes. This intentionally accepts a one-frame
 *  flash of defaults on mobile to avoid the React hydration error. */
export function useSettings(): [
  XiaolingSettings,
  (patch: Partial<XiaolingSettings>) => void,
] {
  const [state, setState] = useState<XiaolingSettings>(DEFAULT_SETTINGS);
  useEffect(() => {
    // Snapshot localStorage into the cache + state on mount.
    setState(getSettings());
    const fn: Listener = (s) => setState(s);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      cached = loadFromStorage();
      setState(cached);
    };
    listeners.add(fn);
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [state, setSettings];
}

/** Resolve a background id (or custom:* string) into a CSS `background` value. */
export function resolveBackgroundCss(value: string): string {
  if (value.startsWith("custom:")) {
    const url = value.slice("custom:".length);
    return `center/cover no-repeat url("${url}"), #0f172a`;
  }
  const preset = BACKGROUND_PRESETS.find((p) => p.id === value);
  return preset?.css ?? BACKGROUND_PRESETS[0].css;
}

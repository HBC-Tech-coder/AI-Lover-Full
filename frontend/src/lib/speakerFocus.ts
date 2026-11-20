"use client";

import { sendHeadAction } from "@/lib/headMotion";
import { getSettings } from "@/lib/settingsStore";

type AnyRecord = Record<string, unknown>;

const EYE_SERVO_LOCATION = 3;
const NECK_SERVO_LOCATION = 7;
const EYE_NEUTRAL = 90;
const NECK_NEUTRAL = 90;
const EYE_MIN = 72;
const EYE_MAX = 108;
const NECK_MIN = 63;
const NECK_MAX = 117;

const fallbackSeatAngles = [0, -22, 22, -12, 12, -30, 30];
const speakerSeatMap = new Map<string, number>();
let focusQueue: Promise<void> = Promise.resolve();
let lastFocusKey = "";
let lastFocusAt = 0;

export function resetSpeakerFocusAssignments(): void {
  speakerSeatMap.clear();
  lastFocusKey = "";
  lastFocusAt = 0;
}

export function focusRobotHeadOnSpeaker(
  payload: unknown,
  source = "speaker_focus",
): void {
  if (typeof window === "undefined" || !isRecord(payload)) return;

  const settings = getSettings();
  if (!settings.robotHeadMotionEnabled || !settings.speakerFocusHeadEnabled) {
    return;
  }

  const speaker = normalizeSpeakerLabel(
    readSpeaker(payload) ?? readSpeakerFromText(readText(payload)),
  );
  if (!speaker) return;

  const angle = resolveSpeakerAngle(
    payload,
    speaker,
    settings.speakerFocusFallbackSeatsEnabled,
  );
  if (angle === null) return;

  const now = Date.now();
  const roundedAngle = Math.round(angle);
  const focusKey = `${speaker}:${roundedAngle}`;
  if (focusKey === lastFocusKey && now - lastFocusAt < 1600) return;
  if (now - lastFocusAt < 450) return;
  lastFocusKey = focusKey;
  lastFocusAt = now;

  focusQueue = focusQueue
    .catch(() => {})
    .then(() =>
      runSpeakerFocus(
        angle,
        source,
        settings.speakerFocusMaxEyeAngle,
        settings.speakerFocusMaxHeadAngle,
      ),
    );
}

function resolveSpeakerAngle(
  payload: AnyRecord,
  speaker: string,
  allowFallbackSeats: boolean,
): number | null {
  const explicit = readSpeakerAngle(payload);
  if (explicit !== null) {
    return clamp(explicit, -45, 45);
  }
  if (!allowFallbackSeats) return null;

  const normalized = speaker.toUpperCase();
  const numeric = /^S(\d+)$/.exec(normalized);
  if (numeric) {
    const index = Math.max(0, Number.parseInt(numeric[1], 10) - 1);
    return fallbackSeatAngles[index % fallbackSeatAngles.length];
  }

  if (!speakerSeatMap.has(normalized)) {
    speakerSeatMap.set(
      normalized,
      fallbackSeatAngles[speakerSeatMap.size % fallbackSeatAngles.length],
    );
  }
  return speakerSeatMap.get(normalized) ?? 0;
}

async function runSpeakerFocus(
  speakerAngle: number,
  source: string,
  maxEyeAngle: number,
  maxHeadAngle: number,
): Promise<void> {
  const eyeDelta = (clamp(speakerAngle, -45, 45) / 45) * maxEyeAngle;
  const neckDelta = (clamp(speakerAngle, -45, 45) / 45) * maxHeadAngle;
  const eyeAngle = Math.round(clamp(EYE_NEUTRAL + eyeDelta, EYE_MIN, EYE_MAX));
  const neckAngle = Math.round(
    clamp(NECK_NEUTRAL + neckDelta, NECK_MIN, NECK_MAX),
  );

  try {
    // Human-like sequence: the eyes catch the speaker first, then the neck
    // follows. Once the head faces the speaker, eyes return to straight ahead.
    await sendHeadAction("servo", {
      location: EYE_SERVO_LOCATION,
      angle: eyeAngle,
      speed: 14,
      source,
    });
    await wait(90);
    await sendHeadAction("servo", {
      location: NECK_SERVO_LOCATION,
      angle: neckAngle,
      speed: 9,
      source,
    });
    await wait(260);
    await sendHeadAction("servo", {
      location: EYE_SERVO_LOCATION,
      angle: EYE_NEUTRAL,
      speed: 10,
      source,
    });
  } catch {
    // Physical focus is an enhancement. It must never break conversation.
  }
}

function readSpeaker(payload: AnyRecord): string | null {
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const value = readFirst(payload, [
    "speaker_label",
    "speaker_name",
    "speaker_id",
    "speaker",
    "speakerLabel",
    "speakerId",
  ]) ?? readFirst(metadata, [
    "speaker_label",
    "speaker_name",
    "speaker_id",
    "speaker",
    "speakerLabel",
    "speakerId",
  ]);
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text || null;
}

function readSpeakerAngle(payload: AnyRecord): number | null {
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const value = readFirst(payload, [
    "speaker_angle",
    "speaker_angle_deg",
    "speakerDirection",
    "speaker_direction",
    "angle",
    "azimuth",
    "direction",
  ]) ?? readFirst(metadata, [
    "speaker_angle",
    "speaker_angle_deg",
    "speakerDirection",
    "speaker_direction",
    "angle",
    "azimuth",
    "direction",
  ]);

  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (/left|左/.test(text)) return -24;
  if (/right|右/.test(text)) return 24;
  if (/center|middle|front|中|正/.test(text)) return 0;
  const numeric = Number.parseFloat(text.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function readText(payload: AnyRecord): string {
  const value = readFirst(payload, ["text", "transcript", "content"]);
  return typeof value === "string" ? value : "";
}

function readSpeakerFromText(text: string): string | null {
  const match = /^\s*\[([^\]]{1,32})\]\s*/.exec(text);
  return match?.[1]?.trim() || null;
}

function normalizeSpeakerLabel(value: string | null): string | null {
  if (!value) return null;
  const label = value.trim();
  if (!label) return null;
  return /^s\d+$/i.test(label) ? label.toUpperCase() : label;
}

function readFirst(record: AnyRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

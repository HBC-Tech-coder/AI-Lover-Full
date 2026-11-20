/**
 * Lightweight Web Audio chime — no asset file needed.
 *
 * Two-note (E5 → A5) 180ms blip used to signal "小灵 is now actually
 * listening". Kept private to the UI layer; no dependency on the TTS
 * playback graph.
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  // Browsers suspend AC until first user gesture. Resume best-effort; if
  // it stays suspended, playReadyChime() will silently no-op rather than
  // throw.
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

function blip(freq: number, startAt: number, durMs: number, peak = 0.18): void {
  const ac = getCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // Short attack/decay envelope so it sounds like a soft "ding", not a click.
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durMs / 1000);
  osc.connect(gain).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + durMs / 1000 + 0.02);
}

/** Plays the "ready to listen" two-note chime. Safe to call repeatedly. */
export function playReadyChime(): void {
  const ac = getCtx();
  if (!ac) return;
  const t0 = ac.currentTime;
  blip(659.25, t0, 110); // E5
  blip(880.0, t0 + 0.09, 160); // A5
}

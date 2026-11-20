"use client";

/**
 * Avatar thumbnail cache.
 *
 * Live2D renders to a <canvas>; once a model has fully loaded + painted
 * its first frame, AvatarLive2D snapshots `canvas.toDataURL()` and saves
 * the dataURL here keyed by avatar id. SettingsDrawer reads back the
 * cached dataURL to show a real preview of each character.
 *
 * Storage: localStorage. Each thumbnail is a 256-512 KB base64 PNG, so
 * even with 11 avatars we stay well under localStorage's typical 5 MB
 * quota. Bumping STORAGE_VERSION invalidates the cache (e.g. after
 * tweaking AvatarLive2D's fit / capture timing).
 */

const STORAGE_VERSION = 2;
const STORAGE_KEY = `xiaoling_avatar_thumbs_v${STORAGE_VERSION}`;

interface ThumbnailMap {
  [avatarId: string]: string; // dataURL
}

function load(): ThumbnailMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ThumbnailMap;
  } catch {
    return {};
  }
}

function save(map: ThumbnailMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota exceeded or disabled — silently drop. We can always recapture.
  }
}

/** Tiny pub-sub so SettingsDrawer can re-render when a new thumb lands. */
type Listener = () => void;
const listeners = new Set<Listener>();

export function getAvatarThumbnail(avatarId: string): string | null {
  const map = load();
  return map[avatarId] ?? null;
}

export function saveAvatarThumbnail(
  avatarId: string,
  dataURL: string,
): void {
  if (!avatarId || !dataURL) return;
  const map = load();
  if (map[avatarId] === dataURL) return; // no-op
  map[avatarId] = dataURL;
  save(map);
  listeners.forEach((fn) => fn());
}

export function subscribeAvatarThumbnails(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Crop the Live2D canvas to a face-forward square thumbnail.
 *
 * Finds the bounding box of non-transparent pixels (the rendered model),
 * then crops a square from the TOP of that bbox so we always get the
 * face + shoulders regardless of whether the rig is head-only or full
 * body. Returns a PNG dataURL at the requested output size, or null on
 * failure (zero-size canvas, all-transparent, unsupported environment).
 */
export function makeFaceThumbnail(
  src: HTMLCanvasElement,
  outSize = 256,
): string | null {
  const w = src.width;
  const h = src.height;
  if (!w || !h) return null;

  // PIXI runs on WebGL; we can\'t getImageData directly off a WebGL
  // canvas, so blit it onto a fresh 2D canvas first.
  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const wctx = work.getContext("2d");
  if (!wctx) return null;
  try {
    wctx.drawImage(src, 0, 0);
  } catch {
    // Tainted-canvas guard. Same-origin assets only, so this should not
    // fire — but bail cleanly if a browser quirks out.
    return null;
  }

  let data: Uint8ClampedArray;
  try {
    data = wctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }

  // Scan for alpha bbox. Sample every 4th pixel — accurate enough for
  // a thumbnail crop and keeps the scan under 5ms on a typical canvas.
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  const step = 4;
  const alphaThreshold = 16;
  for (let y = 0; y < h; y += step) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += step) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null; // nothing drawn

  // Add a tiny padding so the model isn\'t flush against the thumbnail
  // edge. Clamp to canvas bounds.
  const pad = Math.max(4, Math.floor(Math.min(w, h) * 0.01));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;

  // Square side: usually bboxW (full-body rigs are taller than wide,
  // so the square fits horizontally and we crop the upper torso).
  // For chibi rigs where bboxW > bboxH, fall back to bboxH so the
  // square still fits vertically.
  const side = Math.min(bboxW, bboxH);
  const cropX = minX + Math.floor((bboxW - side) / 2); // center horizontally
  const cropY = minY; // anchor TOP so face is in the frame

  const out = document.createElement("canvas");
  out.width = outSize;
  out.height = outSize;
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(work, cropX, cropY, side, side, 0, 0, outSize, outSize);
  return out.toDataURL("image/png");
}

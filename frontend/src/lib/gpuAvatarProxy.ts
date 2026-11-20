import { NextResponse } from "next/server";

const DEFAULT_TIMEOUT_MS = 45000;

export function normalizeGpuAvatarEndpoint(raw: string | null | undefined) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("GPU avatar endpoint is required");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("GPU avatar endpoint must be http or https");
  }
  if (!isAllowedGpuAvatarHost(url)) {
    throw new Error("GPU avatar endpoint must be localhost or private LAN");
  }
  return url;
}

export function appendGpuAvatarPath(endpoint: URL, pathname: string) {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(`${endpoint.pathname.replace(/\/+$/, "")}${path}`, endpoint);
}

export function toGpuAvatarAssetUrl(endpoint: URL, value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return new URL(value).toString();
  } catch {
    return new URL(value.startsWith("/") ? value : `/${value}`, endpoint).toString();
  }
}

export async function fetchGpuAvatarJson(
  url: URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `GPU avatar worker returned ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function gpuAvatarJsonError(error: unknown, status = 500) {
  return NextResponse.json(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

function isAllowedGpuAvatarHost(url: URL) {
  if (process.env.GPU_AVATAR_ALLOW_REMOTE === "true") return true;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const match = host.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

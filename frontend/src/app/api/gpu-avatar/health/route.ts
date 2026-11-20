import { NextRequest, NextResponse } from "next/server";
import {
  appendGpuAvatarPath,
  fetchGpuAvatarJson,
  gpuAvatarJsonError,
  normalizeGpuAvatarEndpoint,
  toGpuAvatarAssetUrl,
} from "@/lib/gpuAvatarProxy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const endpoint = normalizeGpuAvatarEndpoint(
      request.nextUrl.searchParams.get("endpoint") ||
        process.env.GPU_AVATAR_ENDPOINT ||
        "http://127.0.0.1:8810",
    );
    const data = await fetchGpuAvatarJson(appendGpuAvatarPath(endpoint, "/health"), {
      method: "GET",
    }, 6000);
    return NextResponse.json({
      ok: Boolean(data.ok ?? true),
      provider: data.provider || data.worker || "gpu-avatar-worker",
      mode: data.mode || "gpu",
      tier: data.tier || "",
      streaming: Boolean(data.streaming || data.realtime || data.stream),
      gpu: data.gpu || data.runtime?.gpu || null,
      backend: data.backend || null,
      message: data.message || "",
      avatars: Array.isArray(data.avatars)
        ? data.avatars.map((avatar: any) => ({
            ...avatar,
            posterUrl: toGpuAvatarAssetUrl(endpoint, avatar.posterUrl || avatar.poster_url),
          }))
        : [],
    });
  } catch (error) {
    return gpuAvatarJsonError(error, 502);
  }
}

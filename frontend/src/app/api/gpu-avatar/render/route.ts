import { NextRequest, NextResponse } from "next/server";
import {
  appendGpuAvatarPath,
  fetchGpuAvatarJson,
  gpuAvatarJsonError,
  normalizeGpuAvatarEndpoint,
  toGpuAvatarAssetUrl,
} from "@/lib/gpuAvatarProxy";

export const runtime = "nodejs";

const MAX_AUDIO_BASE64_CHARS = 12 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const endpoint = normalizeGpuAvatarEndpoint(
      body.endpoint || process.env.GPU_AVATAR_ENDPOINT || "http://127.0.0.1:8810",
    );
    const audio = String(body.audio || "");
    if (!audio) {
      return NextResponse.json({ ok: false, error: "audio is required" }, { status: 400 });
    }
    if (audio.length > MAX_AUDIO_BASE64_CHARS) {
      return NextResponse.json({ ok: false, error: "audio is too large" }, { status: 413 });
    }

    const data = await fetchGpuAvatarJson(appendGpuAvatarPath(endpoint, "/render"), {
      method: "POST",
      body: JSON.stringify({
        avatarId: String(body.avatarId || "default"),
        audio,
        metadata: body.metadata || null,
        output: "mp4",
      }),
    }, Number(process.env.GPU_AVATAR_RENDER_TIMEOUT_MS || 180000));

    const videoUrl = toGpuAvatarAssetUrl(endpoint, data.videoUrl || data.video_url || data.url);
    const streamUrl = toGpuAvatarAssetUrl(endpoint, data.streamUrl || data.stream_url);
    const posterUrl = toGpuAvatarAssetUrl(endpoint, data.posterUrl || data.poster_url);
    const statusUrl = toGpuAvatarAssetUrl(endpoint, data.statusUrl || data.status_url);
    return NextResponse.json({
      ok: Boolean(data.ok ?? true),
      provider: data.provider || data.worker || "gpu-avatar-worker",
      avatarId: data.avatarId || data.avatar_id || body.avatarId || "default",
      videoUrl,
      streamUrl,
      posterUrl,
      jobId: data.jobId || data.job_id || "",
      statusUrl,
      durationMs: data.durationMs || data.duration_ms || null,
      message: data.message || "",
    });
  } catch (error) {
    return gpuAvatarJsonError(error, 502);
  }
}

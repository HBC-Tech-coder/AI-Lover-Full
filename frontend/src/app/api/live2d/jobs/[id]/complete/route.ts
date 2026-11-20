import { NextRequest, NextResponse } from "next/server";
import { completeGenerationJob, readGenerationJob, sanitizeDisplayName } from "@/lib/live2dGenerationStore";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const callbackToken = process.env.LIVE2D_GENERATOR_CALLBACK_TOKEN;
    if (callbackToken) {
      const provided = request.headers.get("x-live2d-callback-token") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (provided !== callbackToken) {
        return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
    }

    const { id } = await context.params;
    const body = await request.json();
    const job = await readGenerationJob(id);
    const modelUrl = String(body.modelUrl || "").trim();
    if (!modelUrl.endsWith(".model3.json")) {
      return NextResponse.json({ ok: false, error: "modelUrl must point to a .model3.json file" }, { status: 400 });
    }

    const displayName = sanitizeDisplayName(body.displayName || body.label || job.name);
    const updated = await completeGenerationJob(id, {
      avatarId: `generated-${job.id}`,
      label: sanitizeDisplayName(body.label || displayName),
      displayName,
      modelUrl,
      intro: String(body.intro || "云端生成的 Live2D 数字人。"),
      sourceImageUrl: job.sourceImageUrl,
      scaleBoost: Number.isFinite(Number(body.scaleBoost)) ? Number(body.scaleBoost) : 1.3,
      anchorRatio: Number.isFinite(Number(body.anchorRatio)) ? Number(body.anchorRatio) : 0,
      providerNote: body.providerNote ? String(body.providerNote) : undefined,
    }, String(body.message || "云端 Live2D 模型已生成。"));

    return NextResponse.json({ ok: true, job: updated });
  } catch (error) {
    console.error("/api/live2d/jobs/[id]/complete error", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "internal" }, { status: 500 });
  }
}
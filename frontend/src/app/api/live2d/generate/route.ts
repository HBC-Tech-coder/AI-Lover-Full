import { NextRequest, NextResponse } from "next/server";
import type { Live2DPreprocessResult } from "@/lib/live2dPreprocess";
import {
  createJobId,
  getGenerationProvider,
  type Live2DGenerationJob,
  type Live2DGenerationProvider,
  sanitizeDisplayName,
  saveUploadedSource,
  writeGenerationJob,
} from "@/lib/live2dGenerationStore";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const photo = form.get("photo");
    const provider = normalizeProvider(String(form.get("provider") || "cloud"));
    const name = sanitizeDisplayName(String(form.get("name") || "My Avatar"));
    const preprocess = parsePreprocess(form.get("preprocess"));

    if (!(photo instanceof File)) {
      return NextResponse.json({ ok: false, error: "photo is required" }, { status: 400 });
    }
    if (!photo.type.startsWith("image/")) {
      return NextResponse.json({ ok: false, error: "photo must be an image" }, { status: 400 });
    }
    if (photo.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ ok: false, error: "photo is larger than 12MB" }, { status: 400 });
    }

    const id = createJobId();
    const uploaded = await saveUploadedSource(id, photo);
    let job: Live2DGenerationJob = {
      id,
      name,
      provider,
      status: "queued",
      sourceImageUrl: uploaded.sourceImageUrl,
      sourceImagePath: uploaded.sourceImagePath,
      sourceMimeType: uploaded.sourceMimeType,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: "Generation job created.",
      preprocess,
    };

    if (provider === "template") {
      job = await writeGenerationJob({
        ...job,
        status: "ready",
        message: "Local flow test completed. An existing Live2D model is mounted to validate upload, job, registry, and driver integration.",
        result: {
          avatarId: `generated-${id}`,
          label: `${name} (flow test)`,
          displayName: name,
          modelUrl: "/live2d/osagegirl/osagegirl.model3.json",
          sourceImageUrl: uploaded.sourceImageUrl,
          previewImageUrl: uploaded.sourceImageUrl,
          templatePreview: true,
          intro: "Local flow-test model for validating upload, task, avatar registry, and Live2D driver integration.",
          scaleBoost: 1.8,
          anchorRatio: 0.8,
          providerNote: "template provider does not convert the uploaded photo into a new Cubism model.",
        },
      });
      return NextResponse.json({ ok: true, job, generator: getGenerationProvider() });
    }

    const endpoint = process.env.LIVE2D_GENERATOR_ENDPOINT;
    if (!endpoint) {
      job = await writeGenerationJob({
        ...job,
        status: "waiting_provider",
        message: "Photo and preprocessing package were saved. Configure LIVE2D_GENERATOR_ENDPOINT to send this job to a cloud Live2D worker.",
      });
      return NextResponse.json({ ok: true, job, generator: "missing" });
    }

    job = await writeGenerationJob({
      ...job,
      status: "processing",
      message: "Sent to cloud Live2D generation worker.",
    });

    const remote = await sendToGeneratorEndpoint({
      endpoint,
      job,
      imageBase64: uploaded.bytes.toString("base64"),
    });

    if (remote.modelUrl) {
      job = await writeGenerationJob({
        ...job,
        status: "ready",
        message: remote.message || "Cloud Live2D model is ready.",
        remoteJobId: remote.remoteJobId,
        result: {
          avatarId: `generated-${id}`,
          label: remote.label || name,
          displayName: remote.displayName || name,
          modelUrl: remote.modelUrl,
          sourceImageUrl: remote.previewImageUrl || uploaded.sourceImageUrl,
          previewImageUrl: remote.previewImageUrl,
          assetManifestUrl: remote.assetManifestUrl,
          layerPackageUrl: remote.layerPackageUrl,
          psdSourceUrl: remote.psdSourceUrl,
          layerManifestUrl: remote.layerManifestUrl,
          cubismTaskUrl: remote.cubismTaskUrl,
          cubismReadmeUrl: remote.cubismReadmeUrl,
          templatePreview: Boolean(remote.templatePreview || remote.providerNote?.includes("not a generated .moc3")),
          intro: remote.intro || "Cloud generated Live2D avatar.",
          scaleBoost: remote.scaleBoost ?? 1.3,
          anchorRatio: remote.anchorRatio ?? 0,
          providerNote: remote.providerNote,
        },
      });
    } else {
      const hasWorkerAssets = Boolean(remote.previewImageUrl || remote.assetManifestUrl || remote.layerPackageUrl || remote.psdSourceUrl || remote.cubismTaskUrl);
      job = await writeGenerationJob({
        ...job,
        status: hasWorkerAssets ? "waiting_provider" : "processing",
        message: remote.message || (hasWorkerAssets ? "Worker assets are ready. Waiting for Cubism rigging or template bridge." : "Cloud worker accepted the job. Waiting for callback or manual completion."),
        remoteJobId: remote.remoteJobId,
        result: hasWorkerAssets
          ? {
              avatarId: `generated-${id}`,
              label: remote.label || `${name} (layer package)`,
              displayName: remote.displayName || name,
              modelUrl: remote.modelUrl || "",
              sourceImageUrl: uploaded.sourceImageUrl,
              previewImageUrl: remote.previewImageUrl || uploaded.sourceImageUrl,
              assetManifestUrl: remote.assetManifestUrl,
              layerPackageUrl: remote.layerPackageUrl,
              psdSourceUrl: remote.psdSourceUrl,
              layerManifestUrl: remote.layerManifestUrl,
              cubismTaskUrl: remote.cubismTaskUrl,
              cubismReadmeUrl: remote.cubismReadmeUrl,
              templatePreview: true,
              intro: remote.intro || "Worker generated PSD-ready Live2D layer assets. Cubism rigging is still pending.",
              scaleBoost: remote.scaleBoost ?? 1.3,
              anchorRatio: remote.anchorRatio ?? 0,
              providerNote: remote.providerNote,
            }
          : undefined,
      });
    }

    return NextResponse.json({ ok: true, job, generator: "configured" });
  } catch (error) {
    console.error("/api/live2d/generate error", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "internal" }, { status: 500 });
  }
}

function normalizeProvider(value: string): Live2DGenerationProvider {
  return value === "template" ? "template" : "cloud";
}

function parsePreprocess(value: FormDataEntryValue | null): Live2DPreprocessResult | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as Live2DPreprocessResult;
    if (parsed?.version === "1.0" && parsed?.image && parsed?.body && parsed?.quality && parsed?.rigging) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

async function sendToGeneratorEndpoint({ endpoint, job, imageBase64 }: { endpoint: string; job: Live2DGenerationJob; imageBase64: string }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.LIVE2D_GENERATOR_API_KEY ? { authorization: `Bearer ${process.env.LIVE2D_GENERATOR_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        jobId: job.id,
        name: job.name,
        output: "live2d-cubism4",
        sourceImageUrl: job.sourceImageUrl,
        preprocess: job.preprocess || null,
        callbackUrl: process.env.LIVE2D_GENERATOR_CALLBACK_URL || null,
        callbackTokenRequired: Boolean(process.env.LIVE2D_GENERATOR_CALLBACK_TOKEN),
        image: {
          mimeType: job.sourceMimeType,
          base64: imageBase64,
        },
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `generator returned ${response.status}`);
    }
    return data as {
      modelUrl?: string;
      remoteJobId?: string;
      label?: string;
      displayName?: string;
      intro?: string;
      message?: string;
      scaleBoost?: number;
      anchorRatio?: number;
      providerNote?: string;
      previewImageUrl?: string;
      assetManifestUrl?: string;
      layerPackageUrl?: string;
      psdSourceUrl?: string;
      layerManifestUrl?: string;
      cubismTaskUrl?: string;
      cubismReadmeUrl?: string;
      templatePreview?: boolean;
    };
  } finally {
    clearTimeout(timeout);
  }
}

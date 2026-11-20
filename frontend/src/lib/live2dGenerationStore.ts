import type { Live2DPreprocessResult } from "@/lib/live2dPreprocess";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type Live2DGenerationProvider = "cloud" | "template";
export type Live2DGenerationStatus = "queued" | "processing" | "waiting_provider" | "ready" | "failed";

export interface Live2DGenerationResult {
  avatarId: string;
  label: string;
  displayName: string;
  modelUrl: string;
  intro: string;
  sourceImageUrl?: string;
  previewImageUrl?: string;
  assetManifestUrl?: string;
  layerPackageUrl?: string;
  psdSourceUrl?: string;
  layerManifestUrl?: string;
  cubismTaskUrl?: string;
  cubismReadmeUrl?: string;
  templatePreview?: boolean;
  scaleBoost?: number;
  anchorRatio?: number;
  providerNote?: string;
}

export interface Live2DGenerationJob {
  id: string;
  name: string;
  provider: Live2DGenerationProvider;
  status: Live2DGenerationStatus;
  sourceImageUrl: string;
  sourceImagePath: string;
  sourceMimeType: string;
  createdAt: string;
  updatedAt: string;
  message: string;
  remoteJobId?: string;
  error?: string;
  preprocess?: Live2DPreprocessResult;
  result?: Live2DGenerationResult;
}

export function createJobId() {
  return `gen_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function publicUrlForGeneratedAsset(jobId: string, filename: string) {
  return `/generated-live2d/${jobId}/${filename}`;
}

export function getGeneratedJobPublicDir(jobId: string) {
  return path.join(process.cwd(), "public", "generated-live2d", jobId);
}

export function getGenerationProvider(): "configured" | "missing" {
  return process.env.LIVE2D_GENERATOR_ENDPOINT ? "configured" : "missing";
}

export async function ensureGeneratedDirs(jobId?: string) {
  await fs.mkdir(getJobsDir(), { recursive: true });
  await fs.mkdir(path.join(process.cwd(), "public", "generated-live2d"), { recursive: true });
  if (jobId) await fs.mkdir(getGeneratedJobPublicDir(jobId), { recursive: true });
}

export async function writeGenerationJob(job: Live2DGenerationJob) {
  await ensureGeneratedDirs();
  const next = { ...job, updatedAt: new Date().toISOString() };
  await fs.writeFile(getJobPath(job.id), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function readGenerationJob(id: string) {
  const safeId = sanitizeJobId(id);
  const raw = await fs.readFile(getJobPath(safeId), "utf8");
  return JSON.parse(raw) as Live2DGenerationJob;
}

export async function listGenerationJobs() {
  await ensureGeneratedDirs();
  const files = await fs.readdir(getJobsDir()).catch(() => []);
  const jobs: Live2DGenerationJob[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(getJobsDir(), file), "utf8");
      jobs.push(JSON.parse(raw) as Live2DGenerationJob);
    } catch {
      // Ignore a partially-written or manually edited job file.
    }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveUploadedSource(jobId: string, file: File) {
  await ensureGeneratedDirs(jobId);
  const ext = extensionForMime(file.type);
  const filename = `source${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const fullPath = path.join(getGeneratedJobPublicDir(jobId), filename);
  await fs.writeFile(fullPath, bytes);
  return {
    sourceImagePath: fullPath,
    sourceImageUrl: publicUrlForGeneratedAsset(jobId, filename),
    sourceMimeType: file.type || "application/octet-stream",
    bytes,
  };
}

export async function completeGenerationJob(id: string, result: Live2DGenerationResult, message = "Live2D model is ready") {
  const job = await readGenerationJob(id);
  return writeGenerationJob({
    ...job,
    status: "ready",
    message,
    error: undefined,
    result: {
      ...result,
      avatarId: result.avatarId || `generated-${job.id}`,
      sourceImageUrl: result.sourceImageUrl || job.sourceImageUrl,
    },
  });
}

export function sanitizeDisplayName(value: string | null | undefined) {
  const text = (value || "").replace(/[<>]/g, "").trim();
  return text.slice(0, 32) || "My Avatar";
}

export function sanitizeJobId(id: string) {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) throw new Error("invalid job id");
  return clean;
}

function getJobsDir() {
  return path.join(process.cwd(), "data", "live2d-generation", "jobs");
}

function getJobPath(id: string) {
  return path.join(getJobsDir(), `${sanitizeJobId(id)}.json`);
}

function extensionForMime(mime: string) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".jpg";
}

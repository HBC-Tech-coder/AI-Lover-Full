"use client";

import { ArrowLeft, CheckCircle2, Cloud, ImagePlus, Loader2, Play, RefreshCw, ScanFace, Upload } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AvatarLive2D } from "@/components/Agent/AvatarLive2D";
import { makeGeneratedAvatarIdentity, registerGeneratedLive2DAvatar } from "@/lib/generatedLive2DAvatars";
import { type Live2DPreprocessResult, preprocessLive2DPhoto } from "@/lib/live2dPreprocess";
import { setSettings } from "@/lib/settingsStore";

type Provider = "cloud" | "template";
type JobStatus = "queued" | "processing" | "waiting_provider" | "ready" | "failed";

type GenerationJob = {
  id: string;
  name: string;
  provider: Provider;
  status: JobStatus;
  sourceImageUrl: string;
  createdAt: string;
  updatedAt: string;
  message: string;
  remoteJobId?: string;
  error?: string;
  preprocess?: Live2DPreprocessResult;
  result?: {
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
  };
};

const UI = {
  title: "Live2D \u751f\u6210",
  subtitle: "\u4e0a\u4f20\u7167\u7247\uff0c\u5148\u505a\u4eba\u8138/\u8eab\u4f53/\u80cc\u666f\u9884\u5904\u7406\uff0c\u518d\u63a5\u5165\u4e91\u7aef Cubism \u751f\u6210",
  back: "\u8fd4\u56de\u4e3b\u9875",
  upload: "\u4e0a\u4f20\u7167\u7247",
  noFile: "\u672a\u9009\u62e9\u7167\u7247",
  cloud: "\u4e91\u7aef GPU",
  template: "\u6d41\u7a0b\u8054\u8c03",
  create: "\u521b\u5efa\u751f\u6210\u4efb\u52a1",
  tasks: "\u4efb\u52a1",
  refresh: "\u5237\u65b0",
  emptyTasks: "\u8fd8\u6ca1\u6709\u4efb\u52a1",
  uploadOne: "\u4e0a\u4f20\u4e00\u5f20\u7167\u7247",
  addAvatar: "\u52a0\u5165\u5934\u50cf\u5e76\u4f7f\u7528",
  waitCubism: "\u7b49\u5f85 Cubism \u6a21\u578b",
  workerPreview: "Worker \u8d44\u4ea7\u9884\u89c8\uff0c\u4e0d\u662f\u771f\u6b63\u7684 Cubism Live2D \u6a21\u578b",
  openPreview: "\u6253\u5f00\u9884\u89c8\u56fe",
  openManifest: "\u6253\u5f00 manifest",
  openLayerPackage: "PSD \u56fe\u5c42\u5305",
  openPsdSource: "PSD \u6e90\u6587\u4ef6",
  openLayerManifest: "Layer manifest",
  openCubismTask: "Cubism task",
  openCubismReadme: "\u4f7f\u7528\u8bf4\u660e",
  waitCreate: "\u7b49\u5f85\u521b\u5efa\u4efb\u52a1",
  myAvatar: "\u6211\u7684\u6570\u5b57\u4eba",
  preTitle: "AI \u9884\u5904\u7406",
  preIdle: "\u4e0a\u4f20\u540e\u4f1a\u81ea\u52a8\u5206\u6790\u4eba\u8138\u3001\u8eab\u4f53\u6784\u56fe\u548c\u80cc\u666f\u590d\u6742\u5ea6",
  preRunning: "\u6b63\u5728\u505a\u672c\u5730\u9884\u5904\u7406...",
  preError: "\u9884\u5904\u7406\u5931\u8d25",
  generatorConfigured: "\u5df2\u914d\u7f6e\u4e91\u7aef worker\u3002",
  generatorMissing: "\u672a\u914d\u7f6e LIVE2D_GENERATOR_ENDPOINT\uff1b\u4e91\u7aef\u6a21\u5f0f\u4f1a\u7b49\u5f85 worker\u3002",
  readyForWorker: "\u9884\u5904\u7406\u7ed3\u679c\u4f1a\u968f\u4efb\u52a1\u53d1\u7ed9\u4e91\u7aef worker\u3002",
};

export default function Live2DGeneratePage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<Provider>("cloud");
  const [name, setName] = useState(UI.myAvatar);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [preprocess, setPreprocess] = useState<Live2DPreprocessResult | null>(null);
  const [preprocessError, setPreprocessError] = useState("");
  const [preprocessing, setPreprocessing] = useState(false);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [activeJobId, setActiveJobId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generator, setGenerator] = useState<"configured" | "missing" | "unknown">("unknown");
  const activeJob = useMemo(() => jobs.find((job) => job.id === activeJobId) ?? jobs[0] ?? null, [activeJobId, jobs]);
  const visibleAnalysis = activeJob?.preprocess ?? preprocess;

  useEffect(() => {
    void refreshJobs();
  }, []);

  useEffect(() => {
    if (!activeJob || activeJob.status === "ready" || activeJob.status === "failed") return;
    const timer = window.setInterval(() => void refreshJob(activeJob.id), 2500);
    return () => window.clearInterval(timer);
  }, [activeJob?.id, activeJob?.status]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function refreshJobs() {
    const response = await fetch("/api/live2d/jobs", { cache: "no-store" });
    const data = await response.json();
    if (data.ok) {
      setJobs(data.jobs || []);
      setGenerator(data.generator || "unknown");
      if (!activeJobId && data.jobs?.[0]) setActiveJobId(data.jobs[0].id);
    }
  }

  async function refreshJob(id: string) {
    const response = await fetch(`/api/live2d/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await response.json();
    if (!data.ok) return;
    setJobs((current) => [data.job, ...current.filter((job) => job.id !== data.job.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  function pickFile(nextFile: File | undefined) {
    if (!nextFile) return;
    if (!nextFile.type.startsWith("image/")) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(nextFile);
    setPreviewUrl(URL.createObjectURL(nextFile));
    setPreprocess(null);
    setPreprocessError("");
    const cleanName = nextFile.name.replace(/\.[^.]+$/, "").replace(/[\-_]+/g, " ").trim();
    if (cleanName) setName(cleanName.slice(0, 24));
    void runPreprocess(nextFile);
  }

  async function runPreprocess(targetFile = file) {
    if (!targetFile) return;
    setPreprocessing(true);
    setPreprocessError("");
    try {
      setPreprocess(await preprocessLive2DPhoto(targetFile));
    } catch (error) {
      setPreprocessError(error instanceof Error ? error.message : UI.preError);
    } finally {
      setPreprocessing(false);
    }
  }

  async function submitJob() {
    if (!file) return;
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("photo", file);
      form.append("name", name.trim() || UI.myAvatar);
      form.append("provider", provider);
      if (preprocess) form.append("preprocess", JSON.stringify(preprocess));
      const response = await fetch("/api/live2d/generate", { method: "POST", body: form });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "create job failed");
      setGenerator(data.generator || "unknown");
      setJobs((current) => [data.job, ...current.filter((job) => job.id !== data.job.id)]);
      setActiveJobId(data.job.id);
    } finally {
      setSubmitting(false);
    }
  }

  function registerResult(job: GenerationJob) {
    if (!job.result?.modelUrl || isTemplatePreviewJob(job)) return;
    const avatar = {
      id: job.result.avatarId,
      label: job.result.label,
      displayName: job.result.displayName,
      modelUrl: job.result.modelUrl,
      intro: job.result.intro,
      identity: makeGeneratedAvatarIdentity(job.result.displayName),
      createdAt: job.createdAt,
      sourceImageUrl: job.result.previewImageUrl || job.result.sourceImageUrl || job.sourceImageUrl,
      scaleBoost: job.result.scaleBoost,
      anchorRatio: job.result.anchorRatio,
      generated: true,
    };
    registerGeneratedLive2DAvatar(avatar);
    setSettings({ selectedAvatar: avatar.id });
  }

  return (
    <main className="min-h-screen bg-[#0f1419] text-zinc-100">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl gap-5 px-4 py-5 lg:grid-cols-[390px_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col gap-4">
          <header className="flex items-start justify-between gap-3 border-zinc-800 border-b pb-4">
            <div>
              <h1 className="font-semibold text-2xl tracking-normal">{UI.title}</h1>
              <p className="mt-1 text-sm text-zinc-400">{UI.subtitle}</p>
            </div>
            <Link className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" href="/" title={UI.back}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </header>

          <section className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <input ref={fileInputRef} accept="image/*" className="hidden" onChange={(event) => pickFile(event.target.files?.[0])} type="file" />
            <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 font-medium text-zinc-950 hover:bg-emerald-300" onClick={() => fileInputRef.current?.click()} type="button">
              <Upload className="h-4 w-4" />
              {UI.upload}
            </button>
            <div className="min-h-5 truncate text-zinc-500 text-xs">{file?.name || UI.noFile}</div>
            <label className="grid gap-1.5 text-sm text-zinc-300">
              <span className="text-zinc-500 text-xs uppercase">Name</span>
              <input className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 outline-none focus:border-emerald-400" onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <ProviderButton active={provider === "cloud"} icon={<Cloud className="h-4 w-4" />} label={UI.cloud} onClick={() => setProvider("cloud")} />
              <ProviderButton active={provider === "template"} icon={<Play className="h-4 w-4" />} label={UI.template} onClick={() => setProvider("template")} />
            </div>
            <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 font-medium text-zinc-950 hover:bg-white disabled:opacity-50" disabled={!file || submitting || preprocessing} onClick={() => void submitJob()} type="button">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              {UI.create}
            </button>
            <p className="text-zinc-500 text-xs">{generator === "configured" ? UI.generatorConfigured : UI.generatorMissing}</p>
          </section>

          <PreprocessPanel analysis={visibleAnalysis} error={preprocessError} processing={preprocessing} onRetry={() => void runPreprocess()} />

          <section className="grid min-h-0 gap-2 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium text-sm">{UI.tasks}</h2>
              <button className="inline-flex h-8 items-center gap-1 rounded-md border border-zinc-700 px-2 text-xs hover:bg-zinc-900" onClick={() => void refreshJobs()} type="button">
                <RefreshCw className="h-3.5 w-3.5" />{UI.refresh}
              </button>
            </div>
            <div className="grid max-h-[320px] gap-2 overflow-auto pr-1">
              {jobs.length ? jobs.map((job) => (
                <button className={`rounded-md border p-2 text-left text-sm ${activeJob?.id === job.id ? "border-emerald-400 bg-emerald-400/10" : "border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900"}`} key={job.id} onClick={() => setActiveJobId(job.id)} type="button">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{job.name}</span>
                    <StatusPill status={job.status} />
                  </div>
                  <div className="mt-1 line-clamp-2 text-zinc-500 text-xs">{job.message}</div>
                </button>
              )) : <div className="rounded-md border border-zinc-800 p-3 text-zinc-500 text-sm">{UI.emptyTasks}</div>}
            </div>
          </section>
        </section>

        <section className="grid min-h-[680px] gap-3 lg:grid-rows-[minmax(520px,1fr)_auto]">
          <div className="relative overflow-hidden rounded-md border border-zinc-800 bg-[#080b0f]">
            {activeJob?.result?.modelUrl && !isTemplatePreviewJob(activeJob) ? (
              <AvatarLive2D analyser={null} anchorRatio={activeJob.result.anchorRatio ?? 0} avatarId={activeJob.result.avatarId} modelUrl={activeJob.result.modelUrl} scaleBoost={activeJob.result.scaleBoost ?? 1.3} />
            ) : previewForJob(activeJob, previewUrl) ? (
              <div className="relative flex h-full min-h-[520px] items-center justify-center bg-zinc-950 p-6">
                <img alt="Worker preview" className="max-h-[720px] max-w-full rounded-md object-contain" src={previewForJob(activeJob, previewUrl)} />
                {activeJob?.result && isTemplatePreviewJob(activeJob) ? <div className="absolute left-4 top-4 rounded-md border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-amber-100 text-xs">{UI.workerPreview}</div> : null}
              </div>
            ) : (
              <button className="flex h-full min-h-[520px] w-full flex-col items-center justify-center gap-3 text-zinc-500 hover:text-zinc-300" onClick={() => fileInputRef.current?.click()} type="button">
                <ImagePlus className="h-12 w-12" />
                <span className="text-sm">{UI.uploadOne}</span>
              </button>
            )}
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            {activeJob ? (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <StatusPill status={activeJob.status} />
                    <span className="truncate text-sm text-zinc-300">{activeJob.id}</span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-400">{activeJob.message}</p>
                  {activeJob.result?.providerNote && <p className="mt-1 text-xs text-amber-300/90">{activeJob.result.providerNote}</p>}
                  {activeJob.result ? <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {activeJob.result.previewImageUrl ? <a className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900" href={activeJob.result.previewImageUrl} rel="noreferrer" target="_blank">{UI.openPreview}</a> : null}
                    {activeJob.result.assetManifestUrl ? <a className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900" href={activeJob.result.assetManifestUrl} rel="noreferrer" target="_blank">{UI.openManifest}</a> : null}
                    {activeJob.result.layerPackageUrl ? <a className="rounded-md border border-emerald-500/60 px-2 py-1 text-emerald-200 hover:bg-emerald-500/10" href={activeJob.result.layerPackageUrl} rel="noreferrer" target="_blank">{UI.openLayerPackage}</a> : null}
                    {activeJob.result.psdSourceUrl ? <a className="rounded-md border border-emerald-500/60 px-2 py-1 text-emerald-200 hover:bg-emerald-500/10" href={activeJob.result.psdSourceUrl} rel="noreferrer" target="_blank">{UI.openPsdSource}</a> : null}
                    {activeJob.result.layerManifestUrl ? <a className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900" href={activeJob.result.layerManifestUrl} rel="noreferrer" target="_blank">{UI.openLayerManifest}</a> : null}
                    {activeJob.result.cubismTaskUrl ? <a className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900" href={activeJob.result.cubismTaskUrl} rel="noreferrer" target="_blank">{UI.openCubismTask}</a> : null}
                    {activeJob.result.cubismReadmeUrl ? <a className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-900" href={activeJob.result.cubismReadmeUrl} rel="noreferrer" target="_blank">{UI.openCubismReadme}</a> : null}
                  </div> : null}
                </div>
                <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 font-medium text-zinc-950 hover:bg-emerald-300 disabled:opacity-50" disabled={!activeJob.result?.modelUrl || isTemplatePreviewJob(activeJob)} onClick={() => registerResult(activeJob)} type="button">
                  <CheckCircle2 className="h-4 w-4" />{!activeJob.result?.modelUrl || isTemplatePreviewJob(activeJob) ? UI.waitCubism : UI.addAvatar}
                </button>
              </div>
            ) : (
              <div className="text-zinc-500 text-sm">{UI.waitCreate}</div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function isTemplatePreviewJob(job: GenerationJob | null) {
  if (!job?.result) return false;
  return Boolean(!job.result.modelUrl || job.result.templatePreview || job.result.providerNote?.includes("not a generated .moc3") || job.result.providerNote?.includes("does not convert"));
}

function previewForJob(job: GenerationJob | null, fallback: string) {
  return job?.result?.previewImageUrl || job?.result?.sourceImageUrl || job?.sourceImageUrl || fallback;
}

function PreprocessPanel({ analysis, error, onRetry, processing }: { analysis: Live2DPreprocessResult | null; error: string; onRetry: () => void; processing: boolean }) {
  return (
    <section className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 font-medium text-sm"><ScanFace className="h-4 w-4" />{UI.preTitle}</h2>
        <button className="inline-flex h-8 items-center gap-1 rounded-md border border-zinc-700 px-2 text-xs hover:bg-zinc-900 disabled:opacity-50" disabled={processing} onClick={onRetry} type="button">
          {processing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{UI.refresh}
        </button>
      </div>
      {processing ? <div className="text-zinc-400 text-sm">{UI.preRunning}</div> : error ? <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-red-200 text-sm">{UI.preError}: {error}</div> : analysis ? (
        <div className="grid gap-2 text-sm">
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Score" value={`${analysis.quality.score}/100`} />
            <Metric label="Body" value={compositionLabel(analysis.body.composition)} />
            <Metric label="BG" value={backgroundLabel(analysis.background.complexity)} />
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300 text-xs">
            <div>Face: {analysis.face ? `${analysis.face.method} ${Math.round(analysis.face.confidence * 100)}%` : "missing"}</div>
            <div>Body box: {formatBox(analysis.body.box)}</div>
            <div>{UI.readyForWorker}</div>
          </div>
          {(analysis.quality.issues.length || analysis.quality.recommendations.length) ? (
            <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-xs">
              {analysis.quality.issues.map((issue) => <div className="text-amber-200" key={issue}>- {issue}</div>)}
              {analysis.quality.recommendations.map((rec) => <div className="text-zinc-400" key={rec}>- {rec}</div>)}
            </div>
          ) : null}
        </div>
      ) : <div className="text-zinc-500 text-sm">{UI.preIdle}</div>}
    </section>
  );
}

function ProviderButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`inline-flex h-10 items-center justify-center gap-2 rounded-md border text-sm ${active ? "border-emerald-400 bg-emerald-400/15 text-emerald-100" : "border-zinc-700 text-zinc-300 hover:bg-zinc-900"}`} onClick={onClick} type="button">
      {icon}
      {label}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2"><div className="text-zinc-500 text-xs uppercase">{label}</div><div className="mt-1 truncate font-medium text-zinc-100">{value}</div></div>;
}

function StatusPill({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, string> = {
    queued: "\u6392\u961f",
    processing: "\u751f\u6210\u4e2d",
    waiting_provider: "\u5f85\u63a5\u5165",
    ready: "\u5b8c\u6210",
    failed: "\u5931\u8d25",
  };
  const tone = status === "ready" ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : status === "failed" ? "border-red-400/50 bg-red-400/10 text-red-200" : "border-zinc-700 bg-zinc-800 text-zinc-300";
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${tone}`}>{map[status]}</span>;
}

function compositionLabel(value: Live2DPreprocessResult["body"]["composition"]) {
  const map = {
    headshot: "Headshot",
    upper_body: "Upper",
    full_body: "Full",
    needs_regeneration: "Regen",
  };
  return map[value];
}

function backgroundLabel(value: Live2DPreprocessResult["background"]["complexity"]) {
  const map = { simple: "Simple", medium: "Medium", complex: "Complex" };
  return map[value];
}

function formatBox(box: { x: number; y: number; width: number; height: number }) {
  return `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}%`;
}

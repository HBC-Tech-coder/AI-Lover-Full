"use client";

import { Cpu, Loader2, MonitorPlay, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hardwareFetch } from "@/lib/deviceBridge";
import {
  GPU_AVATAR_TTS_AUDIO_EVENT,
  type GpuAvatarTtsAudioPayload,
} from "@/lib/gpuAvatarEvents";

interface AvatarGpuDigitalHumanProps {
  analyser: AnalyserNode | null;
  endpoint: string;
  backendEndpoint?: string;
  avatarId: string;
  transparent?: boolean;
}

type WorkerStatus =
  | { state: "checking" }
  | { state: "ready"; provider: string; gpu?: { name?: string; memory?: string } | null }
  | { state: "offline"; message: string };

function normalizeEndpointText(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isLocalServiceGpuEndpoint(value: string) {
  return normalizeEndpointText(value).startsWith("/api/local-services/gpu-avatar");
}

function unwrapLocalServiceHealth(data: any) {
  return data?.health && typeof data.health === "object" ? data.health : data;
}

function addCacheBuster(url: string) {
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

function toLocalServiceMediaPath(raw: string, endpoint: string, backendEndpoint = "") {
  const base = normalizeEndpointText(endpoint);
  const value = raw.trim();
  const addBackend = (path: string) => {
    if (!backendEndpoint.trim()) return path;
    const url = new URL(path, window.location.href);
    url.searchParams.set("backendEndpoint", backendEndpoint.trim());
    return `${url.pathname}${url.search}`;
  };
  if (value.startsWith("/api/local-services/gpu-avatar")) return addBackend(value);
  if (value.startsWith("/")) return addBackend(`${base}${value}`);
  try {
    const url = new URL(value);
    return addBackend(`${base}${url.pathname}${url.search}`);
  } catch {
    return addBackend(`${base}/${value.replace(/^\/+/, "")}`);
  }
}

export function AvatarGpuDigitalHuman({
  analyser,
  endpoint,
  backendEndpoint = "",
  avatarId,
  transparent = false,
}: AvatarGpuDigitalHumanProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const renderQueueRef = useRef(Promise.resolve());
  const objectUrlsRef = useRef<string[]>([]);
  const [status, setStatus] = useState<WorkerStatus>({ state: "checking" });
  const [videoUrl, setVideoUrl] = useState("");
  const [posterUrl, setPosterUrl] = useState("");
  const [rendering, setRendering] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const posterUrlRef = useRef("");

  useEffect(() => {
    posterUrlRef.current = posterUrl;
  }, [posterUrl]);

  const releaseObjectUrls = () => {
    for (const objectUrl of objectUrlsRef.current) {
      URL.revokeObjectURL(objectUrl);
    }
    objectUrlsRef.current = [];
  };

  const materializeMediaUrl = async (raw: string, localServiceEndpoint: boolean) => {
    if (!raw) return "";
    if (!localServiceEndpoint) return addCacheBuster(raw);
    if (raw.startsWith("blob:") || raw.startsWith("data:")) return raw;

    const mediaPath = toLocalServiceMediaPath(raw, endpoint, backendEndpoint);
    const response = await hardwareFetch(mediaPath);
    if (!response.ok) {
      throw new Error(`GPU media fetch failed: ${response.status}`);
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    objectUrlsRef.current.push(objectUrl);
    return objectUrl;
  };

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      setStatus((current) => current.state === "ready" ? current : { state: "checking" });
      try {
        const localServiceEndpoint = isLocalServiceGpuEndpoint(endpoint);
        const healthPath = `${normalizeEndpointText(endpoint)}/health${
          localServiceEndpoint && backendEndpoint.trim()
            ? `?backendEndpoint=${encodeURIComponent(backendEndpoint.trim())}`
            : ""
        }`;
        const response = localServiceEndpoint
          ? await hardwareFetch(healthPath)
          : await fetch(`/api/gpu-avatar/health?endpoint=${encodeURIComponent(endpoint)}`);
        const data = await response.json();
        const workerData = unwrapLocalServiceHealth(data);
        if (!response.ok || !data.ok || workerData?.ok === false) {
          throw new Error(data.error || workerData?.error || "GPU worker offline");
        }
        if (cancelled) return;
        setStatus({
          state: "ready",
          provider: workerData.provider || "gpu-avatar-worker",
          gpu: workerData.gpu || null,
        });
        const first = Array.isArray(workerData.avatars)
          ? workerData.avatars.find((item: any) => item.id === avatarId) || workerData.avatars[0]
          : null;
        if (first?.posterUrl && !posterUrlRef.current) {
          const materialized = await materializeMediaUrl(first.posterUrl, localServiceEndpoint);
          if (!cancelled) setPosterUrl(materialized);
        }
      } catch (error) {
        if (cancelled) return;
        setStatus({
          state: "offline",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    check();
    const timer = window.setInterval(check, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarId, endpoint]);

  useEffect(() => {
    return () => releaseObjectUrls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!analyser) {
      setAudioLevel(0);
      return;
    }
    let raf = 0;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }
      setAudioLevel(Math.min(1, Math.sqrt(sum / data.length) * 5));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  useEffect(() => {
    const handleAudio = (event: Event) => {
      const payload = (event as CustomEvent<GpuAvatarTtsAudioPayload>).detail;
      if (!payload?.audio || status.state !== "ready") return;
      renderQueueRef.current = renderQueueRef.current
        .catch(() => {})
        .then(() => renderAudio(payload));
    };
    window.addEventListener(GPU_AVATAR_TTS_AUDIO_EVENT, handleAudio);
    return () => window.removeEventListener(GPU_AVATAR_TTS_AUDIO_EVENT, handleAudio);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarId, endpoint, status.state]);

  const renderAudio = async (payload: GpuAvatarTtsAudioPayload) => {
    setRendering(true);
    try {
      const localServiceEndpoint = isLocalServiceGpuEndpoint(endpoint);
      const body = {
        endpoint,
        avatarId,
        audio: payload.audio,
        metadata: payload.metadata || null,
      };
      const response = localServiceEndpoint
        ? await hardwareFetch(`${normalizeEndpointText(endpoint)}/render`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              avatarId,
              audio: payload.audio,
              metadata: payload.metadata || null,
              output: "mp4",
              backendEndpoint: backendEndpoint.trim() || undefined,
            }),
          })
        : await fetch("/api/gpu-avatar/render", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "GPU render failed");
      }
      releaseObjectUrls();
      if (data.posterUrl) {
        const nextPosterUrl = await materializeMediaUrl(data.posterUrl, localServiceEndpoint);
        setPosterUrl(nextPosterUrl);
      }
      const rawVideoUrl = data.videoUrl || data.streamUrl || "";
      if (rawVideoUrl) {
        const nextVideoUrl = await materializeMediaUrl(rawVideoUrl, localServiceEndpoint);
        setVideoUrl(nextVideoUrl);
        window.setTimeout(() => {
          videoRef.current?.play().catch(() => {});
        }, 50);
      }
    } catch (error) {
      setStatus({
        state: "offline",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRendering(false);
    }
  };

  return (
    <div
      className={
        "relative flex h-full min-h-[260px] w-full overflow-hidden rounded-md " +
        (transparent ? "bg-transparent" : "bg-slate-950")
      }
    >
      {videoUrl ? (
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          src={videoUrl}
          poster={posterUrl || undefined}
          autoPlay
          playsInline
          muted
        />
      ) : posterUrl ? (
        <div className="relative h-full w-full overflow-hidden bg-slate-950">
          <img
            className="h-full w-full object-cover"
            src={posterUrl}
            alt="GPU avatar poster"
            draggable={false}
          />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_25%,transparent,rgba(2,6,23,0.32)_70%)]" />
          <div
            className="absolute left-1/2 top-[53%] h-2 w-16 -translate-x-1/2 rounded-full border border-cyan-100/50 bg-black/70 shadow-[0_0_18px_rgba(125,211,252,0.3)] transition-all duration-75"
            style={{
              height: `${8 + audioLevel * 24}px`,
              transform: `translateX(-50%) scaleX(${1 + audioLevel * 0.45})`,
            }}
          />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_50%_30%,rgba(35,92,128,0.48),rgba(2,6,23,0.94)_62%)]">
          <div
            className="relative flex aspect-[3/4] h-[82%] max-h-[560px] min-h-[220px] items-center justify-center rounded-full border border-cyan-200/20 bg-slate-900/80 shadow-2xl shadow-cyan-900/20 transition-transform duration-75"
            style={{ transform: `scale(${1 + audioLevel * 0.025})` }}
          >
            <div className="absolute top-[23%] flex gap-10">
              <span className="h-5 w-5 rounded-full bg-cyan-100 shadow-[0_0_18px_rgba(165,243,252,0.75)]" />
              <span className="h-5 w-5 rounded-full bg-cyan-100 shadow-[0_0_18px_rgba(165,243,252,0.75)]" />
            </div>
            <div
              className="absolute top-[52%] h-4 w-24 rounded-full border border-cyan-100/50 bg-black/60 transition-all duration-75"
              style={{
                height: `${14 + audioLevel * 36}px`,
                borderRadius: `${18 + audioLevel * 16}px`,
              }}
            />
          </div>
        </div>
      )}

      <div className="absolute left-3 top-3 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1 text-xs text-white shadow backdrop-blur-md">
        {status.state === "ready" ? (
          <Cpu className="h-3.5 w-3.5 text-emerald-300" />
        ) : status.state === "checking" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-200" />
        ) : (
          <WifiOff className="h-3.5 w-3.5 text-rose-300" />
        )}
        <span className="truncate">
          {status.state === "ready"
            ? `${status.provider}${status.gpu?.name ? ` · ${status.gpu.name}` : ""}`
            : status.state === "checking"
              ? "GPU worker checking"
              : status.message}
        </span>
      </div>

      {rendering && (
        <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1 text-xs text-white shadow backdrop-blur-md">
          <MonitorPlay className="h-3.5 w-3.5" />
          <span>Rendering lips</span>
        </div>
      )}
    </div>
  );
}

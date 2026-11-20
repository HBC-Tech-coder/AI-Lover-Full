const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const host = process.env.GPU_AVATAR_WORKER_HOST || "127.0.0.1";
const port = Number(process.env.GPU_AVATAR_WORKER_PORT || 8810);
const avatarId = process.env.GPU_AVATAR_ID || "default";
const avatarName = process.env.GPU_AVATAR_NAME || "Xingye GPU avatar";
const backendBase = normalizeOptionalUrl(process.env.GPU_AVATAR_BACKEND_URL);
const backendHealthPath = process.env.GPU_AVATAR_BACKEND_HEALTH_PATH || "/health";
const backendRenderPath = process.env.GPU_AVATAR_BACKEND_RENDER_PATH || "/render";
const workerTier = process.env.GPU_AVATAR_TIER || (backendBase ? "lipsync" : "preview");
const renderTimeoutMs = Number(process.env.GPU_AVATAR_RENDER_TIMEOUT_MS || 180000);
const healthTimeoutMs = Number(process.env.GPU_AVATAR_HEALTH_TIMEOUT_MS || 6000);
const imagePath =
  process.env.GPU_AVATAR_IMAGE_PATH ||
  firstExistingPath([
    path.resolve(__dirname, "..", "..", "local_runtime", "gpu_avatar", "avatar.png"),
    path.resolve(__dirname, "..", "..", "local_runtime", "gpu_avatar", "avatar.jpg"),
    path.resolve(__dirname, "..", "..", "frontend", "public", "gpu-avatar", "xingye-avatar.png"),
  ]);

function firstExistingPath(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function normalizeOptionalUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("GPU_AVATAR_BACKEND_URL must be http or https");
  }
  return url;
}

function appendPath(base, pathname) {
  const url = new URL(base.toString());
  const currentPath = url.pathname.replace(/\/+$/, "");
  const nextPath = String(pathname || "").replace(/^\/+/, "");
  url.pathname = `${currentPath}/${nextPath}`;
  return url;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(text);
}

function contentTypeForImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function streamAvatarImage(res) {
  if (!fs.existsSync(imagePath)) {
    return sendJson(res, 404, {
      ok: false,
      error: `avatar image not found: ${imagePath}`,
    });
  }
  res.writeHead(200, {
    "content-type": contentTypeForImage(imagePath),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  fs.createReadStream(imagePath).pipe(res);
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) {
        req.destroy();
        reject(new Error("request body is too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { ok: false, error: text.slice(0, 800) || "non-json backend response" };
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMediaUrl(value, upstreamBase) {
  if (typeof value !== "string" || !value.trim()) return "";
  const raw = value.trim();
  if (raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
  try {
    return new URL(raw).toString();
  } catch {
    return new URL(raw.startsWith("/") ? raw : `/${raw}`, upstreamBase).toString();
  }
}

function normalizeRenderPayload(data, upstreamBase) {
  return {
    ok: Boolean(data.ok ?? true),
    provider: data.provider || data.worker || "gpu-avatar-backend",
    avatarId: data.avatarId || data.avatar_id || avatarId,
    videoUrl: normalizeMediaUrl(data.videoUrl || data.video_url || data.url, upstreamBase),
    streamUrl: normalizeMediaUrl(data.streamUrl || data.stream_url, upstreamBase),
    posterUrl: normalizeMediaUrl(data.posterUrl || data.poster_url, upstreamBase),
    jobId: data.jobId || data.job_id || "",
    statusUrl: normalizeMediaUrl(data.statusUrl || data.status_url, upstreamBase),
    durationMs: data.durationMs || data.duration_ms || null,
    message: data.message || "",
    raw: data.raw || undefined,
  };
}

function normalizeHealthPayload(data, upstreamBase) {
  const avatars = Array.isArray(data.avatars)
    ? data.avatars.map((avatar) => ({
        ...avatar,
        posterUrl: normalizeMediaUrl(avatar.posterUrl || avatar.poster_url, upstreamBase),
      }))
    : [];
  return {
    ok: Boolean(data.ok ?? true),
    provider: data.provider || data.worker || "gpu-avatar-backend",
    mode: data.mode || "gpu",
    tier: data.tier || workerTier,
    streaming: Boolean(data.streaming || data.realtime || data.stream),
    gpu: data.gpu || data.runtime?.gpu || null,
    backend: {
      configured: true,
      url: backendBase?.toString() || "",
    },
    avatars,
    message: data.message || "GPU avatar backend is online.",
  };
}

function detectGpuInfo() {
  return {
    available: true,
    name: process.env.GPU_AVATAR_GPU_NAME || "local GPU worker placeholder",
  };
}

function previewHealthPayload(req) {
  const base = `http://${req.headers.host || `${host}:${port}`}`;
  return {
    ok: true,
    provider: "ai-lover-gpu-avatar-adapter",
    mode: "image-preview",
    tier: workerTier,
    streaming: false,
    message:
      "Preview worker is online. Set GPU_AVATAR_BACKEND_URL to a MuseTalk, SoulX-LiveAct, or compatible renderer for real lip-sync video.",
    gpu: detectGpuInfo(),
    backend: {
      configured: false,
      url: "",
    },
    avatars: [
      {
        id: avatarId,
        name: avatarName,
        posterUrl: `${base}/assets/avatar.jpg`,
      },
    ],
  };
}

async function backendHealthPayload() {
  if (!backendBase) return null;
  const target = appendPath(backendBase, backendHealthPath);
  const { response, data } = await fetchJsonWithTimeout(target, { method: "GET" }, healthTimeoutMs);
  if (!response.ok) {
    return {
      status: response.status,
      payload: {
        ok: false,
        provider: "ai-lover-gpu-avatar-adapter",
        mode: "backend-adapter",
        tier: workerTier,
        backend: { configured: true, url: backendBase.toString() },
        error: data.error || `GPU backend returned ${response.status}`,
      },
    };
  }
  return { status: 200, payload: normalizeHealthPayload(data, backendBase) };
}

async function renderViaBackend(body) {
  const target = appendPath(backendBase, backendRenderPath);
  const { response, data } = await fetchJsonWithTimeout(
    target,
    {
      method: "POST",
      body: JSON.stringify({
        avatarId: body.avatarId || body.avatar_id || avatarId,
        audio: body.audio || "",
        metadata: body.metadata || null,
        output: body.output || "mp4",
      }),
    },
    renderTimeoutMs,
  );
  return {
    status: response.ok ? 200 : response.status,
    payload: response.ok
      ? normalizeRenderPayload(data, backendBase)
      : {
          ok: false,
          provider: "ai-lover-gpu-avatar-adapter",
          error: data.error || `GPU backend returned ${response.status}`,
        },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendText(res, 204, "");
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method === "GET" && url.pathname === "/") {
    return sendText(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><title>AI-Lover GPU Avatar Worker</title><body style="font-family:sans-serif;background:#0f172a;color:#e5e7eb;padding:32px"><h1>AI-Lover GPU Avatar Worker</h1><p>Health: <a style="color:#86efac" href="/health">/health</a></p><p>Avatar: ${avatarName}</p><p>Backend: ${backendBase ? backendBase.toString() : "preview only"}</p><img src="/assets/avatar.jpg" style="max-width:360px;border-radius:12px"></body>`,
      "text/html; charset=utf-8",
    );
  }

  if (req.method === "GET" && url.pathname === "/health") {
    try {
      const backend = await backendHealthPayload();
      if (backend) return sendJson(res, backend.status, backend.payload);
      return sendJson(res, 200, previewHealthPayload(req));
    } catch (error) {
      return sendJson(res, 200, {
        ok: false,
        provider: "ai-lover-gpu-avatar-adapter",
        mode: "backend-adapter",
        tier: workerTier,
        backend: { configured: Boolean(backendBase), url: backendBase?.toString() || "" },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/assets/avatar.jpg") {
    return streamAvatarImage(res);
  }

  if (req.method === "POST" && url.pathname === "/render") {
    try {
      const body = await readRequestJson(req);
      if (backendBase) {
        const backend = await renderViaBackend(body);
        return sendJson(res, backend.status, backend.payload);
      }
      return sendJson(res, 200, {
        ok: true,
        provider: "ai-lover-gpu-avatar-adapter",
        avatarId: body.avatarId || avatarId,
        posterUrl: "/assets/avatar.jpg",
        videoUrl: "",
        streamUrl: "",
        durationMs: 0,
        message:
          "Preview worker accepted the TTS audio. Configure GPU_AVATAR_BACKEND_URL for real GPU lip-sync video.",
      });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(port, host, () => {
  console.log(`AI-Lover GPU avatar worker ready on http://${host}:${port}`);
  console.log(`avatar image: ${imagePath}`);
  console.log(`backend: ${backendBase ? backendBase.toString() : "preview only"}`);
});

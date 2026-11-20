const express = require("express");
const next = require("next");
const { createProxyMiddleware } = require("http-proxy-middleware");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { parse } = require("node:url");
const { WebSocket, WebSocketServer } = require("ws");

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();

const dev = process.env.NODE_ENV !== "production";
const bindHost = process.env.BIND_HOST || process.env.HOST || "0.0.0.0";
const hostname = bindHost === "0.0.0.0" ? "localhost" : bindHost;
const port = parseInt(process.env.PORT || "3000", 10);
const httpsPort = parseInt(
  process.env.AI_LOVER_HTTPS_PORT || process.env.HTTPS_PORT || "3443",
  10
);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const projectRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(projectRoot, "runtime");
function defaultLocalLogsDir() {
  if (process.env.AI_LOVER_LOG_DIR) return process.env.AI_LOVER_LOG_DIR;
  if (process.env.LOCAL_LOGS_DIR) return process.env.LOCAL_LOGS_DIR;
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "AI-Lover", "local_logs");
  }
  return path.join(projectRoot, "local_logs");
}
const localLogsDir = defaultLocalLogsDir();
const localHardwareConfigPath = path.join(projectRoot, "local_hardware_config.json");
const headBridgePort = parseInt(process.env.HEAD_MOTION_PORT || "8787", 10);
const gestureBridgePort = parseInt(process.env.HAND_GESTURE_PORT || "8791", 10);
const gpuAvatarWorkerPort = parseInt(process.env.GPU_AVATAR_WORKER_PORT || "8810", 10);
let headBridgeProcess = null;
let gestureBridgeProcess = null;
let gpuAvatarWorkerProcess = null;
let headBridgeEnsurePromise = null;
let gestureBridgeEnsurePromise = null;
let gpuAvatarWorkerEnsurePromise = null;

// Cache proxy instances per port to prevent memory leaks
const proxyCache = new Map();
const deviceBridgeSessions = new Map();
const deviceBridgeWss = new WebSocketServer({
  noServer: true,
  maxPayload: parseInt(process.env.DEVICE_BRIDGE_MAX_PAYLOAD || "67108864", 10),
});
const DEVICE_BRIDGE_REQUEST_TIMEOUT_MS = parseInt(
  process.env.DEVICE_BRIDGE_REQUEST_TIMEOUT_MS || "30000",
  10
);

/**
 * Get or create a WebSocket proxy for a specific port.
 * Reuses existing proxy instances to prevent memory leaks.
 *
 * By default the websocket server is local: ws://127.0.0.1:{port}.
 * For "local UI + remote TEN backend + local hardware head" debugging, set:
 *   AGENT_WS_PROXY_URL=wss://ai.vituralmodel.com
 * Then /ws/{port} is forwarded to the remote site's /ws/{port} proxy.
 */
function getOrCreateProxy(wsPort, devMode) {
  const remoteWsProxyUrl = process.env.AGENT_WS_PROXY_URL || "";
  const cacheKey = `${remoteWsProxyUrl || "local"}:${wsPort}`;

  if (!proxyCache.has(cacheKey)) {
    const target = remoteWsProxyUrl || `ws://127.0.0.1:${wsPort}`;
    proxyCache.set(
      cacheKey,
      createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        logLevel: devMode ? "debug" : "warn",
        pathRewrite: remoteWsProxyUrl
          ? (path) => (path.startsWith("/ws/") ? path : `/ws${path}`)
          : undefined,
        onError: (err, _req, _res) => {
          console.error(`WebSocket proxy error (port ${wsPort}):`, err.message);
        },
        onProxyReqWs: (_proxyReq, req, _socket, _options, _head) => {
          console.log(
            `WebSocket proxy request: ${req.url} -> ${target}`
          );
        },
      })
    );
  }
  return proxyCache.get(cacheKey);
}

function normalizePairingCode(value) {
  const code = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) return "";
  return code;
}

function getDeviceBridgeSession(pairingCode) {
  let session = deviceBridgeSessions.get(pairingCode);
  if (!session) {
    session = {
      pairingCode,
      connector: null,
      connectorInfo: null,
      browsers: new Set(),
      pending: new Map(),
      createdAt: Date.now(),
    };
    deviceBridgeSessions.set(pairingCode, session);
  }
  return session;
}

function wsSendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function sendBridgeResponse(browser, id, payload) {
  wsSendJson(browser, {
    type: "bridge.response",
    id,
    status: payload.status || 502,
    headers: payload.headers || { "content-type": "application/json" },
    bodyBase64: payload.bodyBase64 || "",
    error: payload.error || null,
  });
}

function sendBridgeError(browser, id, status, message) {
  const body = Buffer.from(
    JSON.stringify({ ok: false, error: message }),
    "utf8"
  ).toString("base64");
  sendBridgeResponse(browser, id, {
    status,
    headers: { "content-type": "application/json" },
    bodyBase64: body,
    error: message,
  });
}

function broadcastDeviceBridgeStatus(session) {
  const connected =
    Boolean(session.connector) && session.connector.readyState === WebSocket.OPEN;
  const payload = {
    type: "device.status",
    connected,
    pairingCode: session.pairingCode,
    deviceName: session.connectorInfo?.deviceName || "",
    connectedAt: session.connectorInfo?.connectedAt || null,
    browsers: session.browsers.size,
  };
  for (const browser of session.browsers) {
    wsSendJson(browser, payload);
  }
}

function clearPendingForBrowser(session, browser) {
  for (const [id, pending] of session.pending.entries()) {
    if (pending.browser !== browser) continue;
    clearTimeout(pending.timer);
    session.pending.delete(id);
  }
}

function failPendingForConnector(session, message) {
  for (const [id, pending] of session.pending.entries()) {
    clearTimeout(pending.timer);
    sendBridgeError(pending.browser, pending.clientRequestId, 503, message);
    session.pending.delete(id);
  }
}

function isAllowedDeviceBridgePath(pathname) {
  return (
    typeof pathname === "string" &&
    pathname.startsWith("/api/local-services/") &&
    pathname.length <= 2048
  );
}

function isAllowedDeviceBridgeMethod(method) {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(
    String(method || "").toUpperCase()
  );
}

function createDeviceBridgeHealth() {
  const sessions = [];
  let connectors = 0;
  let browsers = 0;
  let pending = 0;
  for (const session of deviceBridgeSessions.values()) {
    const connected =
      Boolean(session.connector) &&
      session.connector.readyState === WebSocket.OPEN;
    if (connected) connectors += 1;
    browsers += session.browsers.size;
    pending += session.pending.size;
    sessions.push({
      pairingCode: `${session.pairingCode.slice(0, 2)}***`,
      connected,
      deviceName: session.connectorInfo?.deviceName || "",
      connectedAt: session.connectorInfo?.connectedAt || null,
      browsers: session.browsers.size,
      pending: session.pending.size,
    });
  }
  return { ok: true, sessions, connectors, browsers, pending };
}

function handleBrowserBridgeMessage(ws, session, message) {
  if (message.type === "bridge.ping") {
    const connected =
      Boolean(session.connector) && session.connector.readyState === WebSocket.OPEN;
    wsSendJson(ws, {
      type: "bridge.pong",
      id: message.id || null,
      connected,
      deviceName: session.connectorInfo?.deviceName || "",
      connectedAt: session.connectorInfo?.connectedAt || null,
    });
    return;
  }

  if (message.type !== "bridge.request") return;
  const clientRequestId = String(message.id || crypto.randomUUID());
  const method = String(message.method || "GET").toUpperCase();
  const pathname = String(message.path || "");
  if (!isAllowedDeviceBridgeMethod(method)) {
    sendBridgeError(ws, clientRequestId, 405, "Device bridge method not allowed");
    return;
  }
  if (!isAllowedDeviceBridgePath(pathname)) {
    sendBridgeError(ws, clientRequestId, 400, "Device bridge path not allowed");
    return;
  }
  if (!session.connector || session.connector.readyState !== WebSocket.OPEN) {
    sendBridgeError(ws, clientRequestId, 503, "Local connector is not online");
    return;
  }

  const routeId = crypto.randomUUID();
  const timer = setTimeout(() => {
    session.pending.delete(routeId);
    sendBridgeError(ws, clientRequestId, 504, "Local connector request timed out");
  }, DEVICE_BRIDGE_REQUEST_TIMEOUT_MS);
  session.pending.set(routeId, { browser: ws, clientRequestId, timer });
  wsSendJson(session.connector, {
    type: "bridge.request",
    id: routeId,
    clientRequestId,
    method,
    path: pathname,
    headers: message.headers || {},
    bodyBase64: message.bodyBase64 || "",
  });
}

function handleConnectorBridgeMessage(_ws, session, message) {
  if (message.type !== "bridge.response") return;
  const pending = session.pending.get(String(message.id || ""));
  if (!pending) return;
  clearTimeout(pending.timer);
  session.pending.delete(String(message.id || ""));
  sendBridgeResponse(pending.browser, pending.clientRequestId, {
    status: Number(message.status) || 502,
    headers: message.headers || { "content-type": "application/json" },
    bodyBase64: message.bodyBase64 || "",
    error: message.error || null,
  });
}

function handleDeviceBridgeConnection(ws, req, query) {
  const pairingCode = normalizePairingCode(query.pairingCode || query.code);
  const role = String(query.role || "").toLowerCase();
  if (!pairingCode || (role !== "connector" && role !== "browser")) {
    ws.close(1008, "Invalid device bridge pairing request");
    return;
  }

  const session = getDeviceBridgeSession(pairingCode);
  ws.deviceBridgeRole = role;
  ws.deviceBridgePairingCode = pairingCode;
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  if (role === "connector") {
    if (session.connector && session.connector.readyState === WebSocket.OPEN) {
      session.connector.close(4001, "Replaced by a new local connector");
      failPendingForConnector(session, "Local connector was replaced");
    }
    session.connector = ws;
    session.connectorInfo = {
      deviceName: String(query.deviceName || os.hostname()).slice(0, 96),
      remoteAddress: req.socket?.remoteAddress || "",
      connectedAt: new Date().toISOString(),
    };
    wsSendJson(ws, {
      type: "connector.ready",
      pairingCode,
      requestTimeoutMs: DEVICE_BRIDGE_REQUEST_TIMEOUT_MS,
    });
    broadcastDeviceBridgeStatus(session);
  } else {
    session.browsers.add(ws);
    const connected =
      Boolean(session.connector) && session.connector.readyState === WebSocket.OPEN;
    wsSendJson(ws, {
      type: "device.status",
      connected,
      pairingCode,
      deviceName: session.connectorInfo?.deviceName || "",
      connectedAt: session.connectorInfo?.connectedAt || null,
      browsers: session.browsers.size,
    });
  }

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      wsSendJson(ws, { type: "bridge.error", error: "Invalid JSON message" });
      return;
    }

    if (role === "connector") {
      handleConnectorBridgeMessage(ws, session, message);
    } else {
      handleBrowserBridgeMessage(ws, session, message);
    }
  });

  ws.on("close", () => {
    if (role === "connector" && session.connector === ws) {
      session.connector = null;
      session.connectorInfo = null;
      failPendingForConnector(session, "Local connector disconnected");
      broadcastDeviceBridgeStatus(session);
    } else if (role === "browser") {
      session.browsers.delete(ws);
      clearPendingForBrowser(session, ws);
    }
    if (!session.connector && session.browsers.size === 0 && session.pending.size === 0) {
      deviceBridgeSessions.delete(pairingCode);
    }
  });

  ws.on("error", (error) => {
    console.error(`Device bridge ${role} error:`, error.message);
  });
}

deviceBridgeWss.on("connection", handleDeviceBridgeConnection);

setInterval(() => {
  for (const ws of deviceBridgeWss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function envEnabled(name) {
  const value = process.env[name];
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function createOptionalHttpsServer(handler) {
  const certRoot = process.env.AI_LOVER_CERT_DIR || path.join(projectRoot, "certs");
  const pfxFile = process.env.SSL_PFX_FILE || path.join(certRoot, "ai-lover-local.pfx");
  const keyFile = process.env.SSL_KEY_FILE || path.join(certRoot, "ai-lover-local-key.pem");
  const certFile = process.env.SSL_CERT_FILE || path.join(certRoot, "ai-lover-local-cert.pem");
  const requested = envEnabled("AI_LOVER_HTTPS") || envEnabled("HTTPS");

  try {
    if (fileExists(pfxFile)) {
      return https.createServer(
        {
          pfx: fs.readFileSync(pfxFile),
          passphrase:
            process.env.SSL_PFX_PASSPHRASE ||
            process.env.AI_LOVER_SSL_PASSPHRASE ||
            "ai-lover-local",
        },
        handler
      );
    }
    if (fileExists(keyFile) && fileExists(certFile)) {
      return https.createServer(
        {
          key: fs.readFileSync(keyFile),
          cert: fs.readFileSync(certFile),
        },
        handler
      );
    }
  } catch (error) {
    console.warn(`Failed to create HTTPS server: ${error.message}`);
  }

  if (requested) {
    console.warn(
      `AI_LOVER_HTTPS is enabled but no certificate was found. Expected ${pfxFile} or ${keyFile} + ${certFile}.`
    );
  }
  return null;
}

function lanAddresses() {
  const addresses = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  return addresses;
}

function logReachableUrls(protocol, portNumber) {
  const loopback = protocol === "https" ? "127.0.0.1" : "localhost";
  console.log(`> ${protocol.toUpperCase()} UI: ${protocol}://${loopback}:${portNumber}/`);
  for (const address of lanAddresses()) {
    console.log(`> ${protocol.toUpperCase()} LAN: ${protocol}://${address}:${portNumber}/`);
  }
}

function findExecutableOnPath(name) {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout) return "";
  const firstMatch = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstMatch && fileExists(firstMatch) ? firstMatch : "";
}

function readLocalHardwareConfig() {
  try {
    if (!fileExists(localHardwareConfigPath)) return {};
    return JSON.parse(fs.readFileSync(localHardwareConfigPath, "utf8"));
  } catch (error) {
    console.warn(`Failed to read local hardware config: ${error.message}`);
    return {};
  }
}

function writeLocalHardwareConfig(patch) {
  try {
    const next = { ...readLocalHardwareConfig(), ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(localHardwareConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  } catch (error) {
    console.warn(`Failed to write local hardware config: ${error.message}`);
    return null;
  }
}

function normalizeHeadIp(value) {
  return String(value || "").trim();
}

function defaultHeadIp() {
  const localConfig = readLocalHardwareConfig();
  return normalizeHeadIp(
    process.env.HEAD_MOTION_HEAD_IP ||
      process.env.HEAD_IP ||
      localConfig.robotHeadIp ||
      "192.168.110.63"
  );
}

function findAdbPath() {
  if (process.env.HEAD_MOTION_ADB_PATH && fileExists(process.env.HEAD_MOTION_ADB_PATH)) {
    return process.env.HEAD_MOTION_ADB_PATH;
  }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(runtimeRoot, "platform-tools", "adb.exe"),
    path.join(home, "xiaoling_local_dev", "android-platform-tools", "platform-tools", "adb.exe"),
    path.join(localAppData, "Android", "Sdk", "platform-tools", "adb.exe"),
    "D:\\android-platform-tools\\platform-tools\\adb.exe",
    "C:\\android-platform-tools\\platform-tools\\adb.exe",
  ];
  return candidates.find(fileExists) || findExecutableOnPath("adb.exe") || findExecutableOnPath("adb");
}

function findPythonPath() {
  if (process.env.HEAD_MOTION_PYTHON && fileExists(process.env.HEAD_MOTION_PYTHON)) {
    return process.env.HEAD_MOTION_PYTHON;
  }
  const runtimeCandidates = [
    path.join(runtimeRoot, "python311", "python.exe"),
    path.join(runtimeRoot, "python", "python.exe"),
  ];
  const runtimePython = runtimeCandidates.find(fileExists);
  if (runtimePython) return runtimePython;

  const home = process.env.USERPROFILE || process.env.HOME || "";
  const bundled = path.join(
    home,
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe"
  );
  if (fileExists(bundled)) return bundled;
  return "python";
}

function findHandGesturePythonPath() {
  if (process.env.HAND_GESTURE_PYTHON && fileExists(process.env.HAND_GESTURE_PYTHON)) {
    return process.env.HAND_GESTURE_PYTHON;
  }
  const packagedPython = path.join(runtimeRoot, "hand-python", "Scripts", "python.exe");
  if (fileExists(packagedPython)) return packagedPython;

  const venvPython = path.join(projectRoot, ".venv-hand-gesture", "Scripts", "python.exe");
  if (fileExists(venvPython)) return venvPython;
  return findPythonPath();
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 2500);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { ok: false, error: text.slice(0, 300) || "non-json response" };
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function getHeadBridgeHealth() {
  try {
    const { response, data } = await fetchJson(`http://127.0.0.1:${headBridgePort}/health`);
    return { reachable: response.ok && data?.ok !== false, data };
  } catch (error) {
    return { reachable: false, data: { ok: false, error: error.message } };
  }
}

async function getGestureBridgeHealth() {
  try {
    const { response, data } = await fetchJson(`http://127.0.0.1:${gestureBridgePort}/health`, {
      timeoutMs: 12000,
    });
    return { reachable: response.ok && data?.ok !== false, data };
  } catch (error) {
    return { reachable: false, data: { ok: false, error: error.message } };
  }
}

async function getGpuAvatarWorkerHealth() {
  try {
    const { response, data } = await fetchJson(`http://127.0.0.1:${gpuAvatarWorkerPort}/health`, {
      timeoutMs: 7000,
    });
    return { reachable: response.ok && data?.ok !== false, data };
  } catch (error) {
    return { reachable: false, data: { ok: false, error: error.message } };
  }
}

function isAllowedGpuAvatarBackend(url) {
  if (process.env.GPU_AVATAR_ALLOW_REMOTE === "true") return true;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const match = host.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function normalizeGpuAvatarBackendEndpoint(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("GPU avatar backend endpoint must be http or https");
  }
  if (!isAllowedGpuAvatarBackend(url)) {
    throw new Error("GPU avatar backend endpoint must be localhost or private LAN");
  }
  return url.toString().replace(/\/+$/, "");
}

function resolveGpuAvatarBackendUrl(endpoint, targetPath) {
  const pathWithSearch = String(targetPath || "/");
  const base = new URL(endpoint);
  const sanitized = pathWithSearch.startsWith("/") ? pathWithSearch : `/${pathWithSearch}`;
  const target = new URL(`${base.pathname.replace(/\/+$/, "")}${sanitized}`, base);
  target.searchParams.delete("backendEndpoint");
  target.searchParams.delete("_gpuBackend");
  return target.toString();
}

function stopGpuAvatarWorkerPortOwner() {
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${gpuAvatarWorkerPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true }
  );
}

function stopProjectGpuAvatarWorkerProcesses() {
  if (process.platform !== "win32") return;
  const root = psQuote(projectRoot);
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$root = ${root}; Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*.exe' -and $_.CommandLine -and $_.CommandLine.Contains('local_image_worker.js') -and $_.CommandLine.Contains($root) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true }
  );
}

function startGpuAvatarWorkerProcess() {
  fs.mkdirSync(localLogsDir, { recursive: true });
  const workerPath = path.join(projectRoot, "workers", "gpu_avatar_worker", "local_image_worker.js");
  if (!fileExists(workerPath)) {
    throw new Error(`GPU avatar worker file not found: ${workerPath}`);
  }

  const logId = `${Date.now()}-${process.pid}`;
  const outPath = path.join(localLogsDir, `gpu_avatar_worker.${logId}.out.log`);
  const errPath = path.join(localLogsDir, `gpu_avatar_worker.${logId}.err.log`);
  const out = fs.openSync(outPath, "a");
  const err = fs.openSync(errPath, "a");

  gpuAvatarWorkerProcess = spawn(process.execPath, [workerPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      GPU_AVATAR_WORKER_HOST: process.env.GPU_AVATAR_WORKER_HOST || "127.0.0.1",
      GPU_AVATAR_WORKER_PORT: String(gpuAvatarWorkerPort),
    },
    windowsHide: true,
    stdio: ["ignore", out, err],
  });

  gpuAvatarWorkerProcess.on("exit", (code, signal) => {
    console.log(`GPU avatar worker exited: code=${code} signal=${signal || ""}`);
    if (gpuAvatarWorkerProcess?.exitCode === code) {
      gpuAvatarWorkerProcess = null;
    }
  });

  return { pid: gpuAvatarWorkerProcess.pid, workerPath, outPath, errPath };
}

async function ensureGpuAvatarWorkerUnlocked({ restart = false } = {}) {
  let health = await getGpuAvatarWorkerHealth();
  let processInfo = null;
  if (!health.reachable || restart) {
    if (gpuAvatarWorkerProcess && !gpuAvatarWorkerProcess.killed) {
      gpuAvatarWorkerProcess.kill();
      gpuAvatarWorkerProcess = null;
    }
    stopGpuAvatarWorkerPortOwner();
    stopProjectGpuAvatarWorkerProcesses();
    await new Promise((resolve) => setTimeout(resolve, 400));
    processInfo = startGpuAvatarWorkerProcess();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      health = await getGpuAvatarWorkerHealth();
      if (health.reachable) break;
    }
  }

  return {
    ok: health.reachable,
    endpoint: `http://127.0.0.1:${gpuAvatarWorkerPort}`,
    started: Boolean(processInfo),
    process: processInfo,
    health: health.data,
  };
}

async function ensureGpuAvatarWorker(args = {}) {
  while (gpuAvatarWorkerEnsurePromise) {
    await gpuAvatarWorkerEnsurePromise;
  }
  const promise = ensureGpuAvatarWorkerUnlocked(args);
  gpuAvatarWorkerEnsurePromise = promise;
  try {
    return await promise;
  } finally {
    if (gpuAvatarWorkerEnsurePromise === promise) gpuAvatarWorkerEnsurePromise = null;
  }
}

function startHeadBridgeProcess(headIp) {
  fs.mkdirSync(localLogsDir, { recursive: true });
  const bridgePath = path.join(projectRoot, "hardware", "head_motion_bridge.py");
  const protocolPath = path.join(projectRoot, "hardware", "head_motion_protocol.py");
  if (!fileExists(bridgePath) || !fileExists(protocolPath)) {
    throw new Error(`head bridge files not found under ${path.join(projectRoot, "hardware")}`);
  }

  const adbPath = findAdbPath();
  const pythonPath = findPythonPath();
  if (!adbPath) {
    throw new Error(
      `adb.exe not found. Please use the full customer package with runtime\\platform-tools\\adb.exe, then start again.`
    );
  }
  const adbSerial = `${headIp}:5555`;
  const logId = `${Date.now()}-${process.pid}`;
  const outPath = path.join(localLogsDir, `head_motion_bridge.${logId}.out.log`);
  const errPath = path.join(localLogsDir, `head_motion_bridge.${logId}.err.log`);
  const out = fs.openSync(outPath, "a");
  const err = fs.openSync(errPath, "a");

  headBridgeProcess = spawn(pythonPath, ["-u", bridgePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HEAD_MOTION_TRANSPORT: "adb",
      HEAD_MOTION_DRY_RUN: "0",
      HEAD_MOTION_ADB_SERIAL: adbSerial,
      HEAD_MOTION_ADB_PATH: adbPath,
      HEAD_MOTION_SERIAL_PORT: "/dev/ttyS4",
      HEAD_MOTION_BAUD: "9600",
      HEAD_MOTION_HOST: "127.0.0.1",
      HEAD_MOTION_PORT: String(headBridgePort),
      HEAD_MOTION_ADB_ROOT: process.env.HEAD_MOTION_ADB_ROOT || "1",
      HEAD_MOTION_ADB_USB_FALLBACK: process.env.HEAD_MOTION_ADB_USB_FALLBACK || "1",
      HEAD_MOTION_ADB_CONNECT_TIMEOUT_SEC:
        process.env.HEAD_MOTION_ADB_CONNECT_TIMEOUT_SEC || "8",
      HEAD_AUDIO_CARD: process.env.HEAD_AUDIO_CARD || "auto",
      HEAD_AUDIO_CARD_MATCH: process.env.HEAD_AUDIO_CARD_MATCH || "realtek,rt5651,codec",
      HEAD_AUDIO_CARD_FALLBACK: process.env.HEAD_AUDIO_CARD_FALLBACK || "1",
      HEAD_AUDIO_PLAYBACK_DEVICE: process.env.HEAD_AUDIO_PLAYBACK_DEVICE || "0",
      HEAD_AUDIO_CAPTURE_DEVICE: process.env.HEAD_AUDIO_CAPTURE_DEVICE || "0",
      HEAD_AUDIO_PLAYBACK_VOLUME: process.env.HEAD_AUDIO_PLAYBACK_VOLUME || "31",
      HEAD_AUDIO_PLAYBACK_SAMPLE_RATE: process.env.HEAD_AUDIO_PLAYBACK_SAMPLE_RATE || "16000",
      HEAD_AUDIO_PLAYBACK_SETUP:
        process.env.HEAD_AUDIO_PLAYBACK_SETUP ||
        "tinymix -D {card} 'OUT Playback Volume' {volume} {volume}",
      HEAD_AUDIO_CAPTURE_SETUP: process.env.HEAD_AUDIO_CAPTURE_SETUP || "",
      HEAD_AUDIO_PLAYBACK_BATCH_WINDOW_MS:
        process.env.HEAD_AUDIO_PLAYBACK_BATCH_WINDOW_MS || "180",
      HEAD_AUDIO_PLAYBACK_BATCH_MAX: process.env.HEAD_AUDIO_PLAYBACK_BATCH_MAX || "10",
    },
    windowsHide: true,
    stdio: ["ignore", out, err],
  });

  headBridgeProcess.on("exit", (code, signal) => {
    console.log(`Head bridge exited: code=${code} signal=${signal || ""}`);
    if (headBridgeProcess?.exitCode === code) {
      headBridgeProcess = null;
    }
  });

  return { pid: headBridgeProcess.pid, adbPath, pythonPath, adbSerial, outPath, errPath };
}

async function configureHeadBridge(headIp) {
  const { response, data } = await fetchJson(`http://127.0.0.1:${headBridgePort}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ head_ip: headIp }),
    timeoutMs: 9000,
  });
  return { ok: response.ok && data?.ok !== false, data };
}

async function ensureHeadBridgeUnlocked({ headIp, restart = false } = {}) {
  const ip = normalizeHeadIp(headIp || defaultHeadIp());
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    throw new Error(`Invalid head IP: ${ip}`);
  }
  if (headIp) {
    writeLocalHardwareConfig({ robotHeadIp: ip });
  }

  let health = await getHeadBridgeHealth();
  let processInfo = null;
  if (!health.reachable || restart) {
    if (headBridgeProcess && !headBridgeProcess.killed) {
      headBridgeProcess.kill();
      headBridgeProcess = null;
    }
    stopHeadBridgePortOwner();
    stopProjectHeadBridgeProcesses();
    await new Promise((resolve) => setTimeout(resolve, 500));
    processInfo = startHeadBridgeProcess(ip);
    for (let i = 0; i < 24; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      health = await getHeadBridgeHealth();
      if (health.reachable) break;
    }
  }

  const config = health.reachable ? await configureHeadBridge(ip) : { ok: false, data: health.data };
  return {
    ok: health.reachable && config.ok,
    head_ip: ip,
    endpoint: `http://127.0.0.1:${headBridgePort}`,
    started: Boolean(processInfo),
    process: processInfo,
    health: health.data,
    config: config.data,
  };
}

async function ensureHeadBridge(args = {}) {
  while (headBridgeEnsurePromise) {
    await headBridgeEnsurePromise;
  }
  const promise = ensureHeadBridgeUnlocked(args);
  headBridgeEnsurePromise = promise;
  try {
    return await promise;
  } finally {
    if (headBridgeEnsurePromise === promise) headBridgeEnsurePromise = null;
  }
}

async function ensureHeadBridgeService() {
  const health = await getHeadBridgeHealth();
  if (health.reachable) return health;
  const started = await ensureHeadBridge();
  if (!started.ok) {
    throw new Error(started.config?.error || started.health?.error || "Head bridge unavailable");
  }
  return { reachable: true, data: started.health };
}

function toPortListValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(",");
  return value ? String(value) : "";
}

function boolEnvValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return value ? "1" : "0";
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stopProjectHeadBridgeProcesses() {
  if (process.platform !== "win32") return;
  const root = psQuote(projectRoot);
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$root = ${root}; Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*.exe' -and $_.CommandLine -and $_.CommandLine.Contains('head_motion_bridge.py') -and $_.CommandLine.Contains($root) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true }
  );
}

function stopHeadBridgePortOwner() {
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${headBridgePort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true }
  );
}

function stopProjectGestureBridgeProcesses() {
  if (process.platform !== "win32") return;
  const root = psQuote(projectRoot);
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$root = ${root}; Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*.exe' -and $_.CommandLine -and $_.CommandLine.Contains('gesture_arm_bridge.py') -and $_.CommandLine.Contains($root) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true }
  );
}

function stopGestureBridgePortOwner() {
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${gestureBridgePort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true }
  );
}

function startGestureBridgeProcess(config = {}) {
  fs.mkdirSync(localLogsDir, { recursive: true });
  const bridgePath = path.join(projectRoot, "hardware", "gesture_arm_bridge.py");
  const packageRoot = path.join(projectRoot, "hardware", "gesture_vendor", "CoDexterousHand");
  if (!fileExists(bridgePath)) {
    throw new Error(`gesture bridge file not found: ${bridgePath}`);
  }

  const pythonPath = findHandGesturePythonPath();
  const logId = `${Date.now()}-${process.pid}`;
  const outPath = path.join(localLogsDir, `gesture_arm_bridge.${logId}.out.log`);
  const errPath = path.join(localLogsDir, `gesture_arm_bridge.${logId}.err.log`);
  const out = fs.openSync(outPath, "a");
  const err = fs.openSync(errPath, "a");
  const localConfig = readLocalHardwareConfig();
  const arduinoPorts = toPortListValue(
    config.arduino_ports ??
      process.env.HAND_GESTURE_ARDUINO_PORTS ??
      localConfig.handArduinoPorts ??
      localConfig.handArduinoPort ??
      ""
  );
  const defaultDryRun =
    process.env.HAND_GESTURE_DRY_RUN !== undefined
      ? process.env.HAND_GESTURE_DRY_RUN
      : arduinoPorts
        ? "0"
        : "1";
  const dryRun =
    config.dry_run === undefined
      ? defaultDryRun
      : boolEnvValue(config.dry_run, "1");
  const arduinoEnabled =
    config.arduino_enabled === undefined
      ? process.env.HAND_GESTURE_ARDUINO_ENABLED || "1"
      : boolEnvValue(config.arduino_enabled, "1");
  const orcaEnabled =
    config.orca_enabled === undefined
      ? process.env.HAND_GESTURE_ORCA_ENABLED || "0"
      : boolEnvValue(config.orca_enabled, "0");
  const orcaDirectJoint =
    config.orca_direct_joint_enabled === undefined
      ? process.env.HAND_GESTURE_ORCA_DIRECT_JOINT || "1"
      : boolEnvValue(config.orca_direct_joint_enabled, "1");
  const orcaWristFollow =
    config.orca_wrist_follow_enabled === undefined
      ? process.env.HAND_GESTURE_ORCA_WRIST_FOLLOW || "0"
      : boolEnvValue(config.orca_wrist_follow_enabled, "0");

  gestureBridgeProcess = spawn(pythonPath, ["-u", bridgePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HAND_GESTURE_HOST: "127.0.0.1",
      HAND_GESTURE_PORT: String(gestureBridgePort),
      HAND_GESTURE_CAMERA_INDEX: String(
        config.camera_index ?? process.env.HAND_GESTURE_CAMERA_INDEX ?? "0"
      ),
      HAND_GESTURE_ARDUINO_PORTS: arduinoPorts,
      HAND_GESTURE_BAUD: String(config.baud ?? process.env.HAND_GESTURE_BAUD ?? "9600"),
      HAND_GESTURE_DRY_RUN: dryRun,
      HAND_GESTURE_ARDUINO_ENABLED: arduinoEnabled,
      HAND_GESTURE_ORCA_ENABLED: orcaEnabled,
      HAND_GESTURE_ORCA_PORT: String(
        config.orca_port ?? process.env.HAND_GESTURE_ORCA_PORT ?? ""
      ),
      HAND_GESTURE_ORCA_DIRECT_JOINT: orcaDirectJoint,
      HAND_GESTURE_ORCA_WRIST_FOLLOW: orcaWristFollow,
      HAND_GESTURE_ORCA_POSE_SMOOTHING: String(
        config.orca_pose_smoothing ??
          process.env.HAND_GESTURE_ORCA_POSE_SMOOTHING ??
          "0.35"
      ),
      HAND_GESTURE_ORCA_CONNECT_TIMEOUT_SEC: String(
        config.orca_connect_timeout_sec ??
          process.env.HAND_GESTURE_ORCA_CONNECT_TIMEOUT_SEC ??
          "25"
      ),
      HAND_GESTURE_PACKAGE_ROOT: packageRoot,
    },
    windowsHide: true,
    stdio: ["ignore", out, err],
  });

  gestureBridgeProcess.on("exit", (code, signal) => {
    console.log(`Gesture bridge exited: code=${code} signal=${signal || ""}`);
    if (gestureBridgeProcess?.exitCode === code) {
      gestureBridgeProcess = null;
    }
  });

  return { pid: gestureBridgeProcess.pid, pythonPath, outPath, errPath };
}

async function configureGestureBridge(config = {}) {
  const { response, data } = await fetchJson(`http://127.0.0.1:${gestureBridgePort}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
    timeoutMs: 12000,
  });
  return { ok: response.ok && data?.ok !== false, data };
}

async function ensureGestureBridgeUnlocked({ config = {}, restart = false } = {}) {
  let health = await getGestureBridgeHealth();
  let processInfo = null;
  if (!health.reachable || restart) {
    if (gestureBridgeProcess && !gestureBridgeProcess.killed) {
      gestureBridgeProcess.kill();
      gestureBridgeProcess = null;
    }
    stopGestureBridgePortOwner();
    stopProjectGestureBridgeProcesses();
    await new Promise((resolve) => setTimeout(resolve, 500));
    processInfo = startGestureBridgeProcess(config);
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      health = await getGestureBridgeHealth();
      if (health.reachable) break;
    }
  }

  const configured =
    health.reachable && Object.keys(config).length
      ? await configureGestureBridge(config)
      : { ok: health.reachable, data: health.data };

  return {
    ok: health.reachable && configured.ok,
    endpoint: `http://127.0.0.1:${gestureBridgePort}`,
    started: Boolean(processInfo),
    process: processInfo,
    health: health.data,
    config: configured.data,
  };
}

async function ensureGestureBridge(args = {}) {
  while (gestureBridgeEnsurePromise) {
    await gestureBridgeEnsurePromise;
  }
  const promise = ensureGestureBridgeUnlocked(args);
  gestureBridgeEnsurePromise = promise;
  try {
    return await promise;
  } finally {
    if (gestureBridgeEnsurePromise === promise) gestureBridgeEnsurePromise = null;
  }
}

function localJsonStatus(response, data) {
  if (!response.ok || data?.ok === false) return response.status >= 400 ? response.status : 502;
  return response.status || 200;
}

async function proxyJson(res, url, options = {}) {
  const { response, data } = await fetchJson(url, options);
  res.status(localJsonStatus(response, data)).json(data);
}

async function proxyLocalBytes(res, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const body = Buffer.from(await response.arrayBuffer());
    res.status(response.status).set("Content-Type", contentType).send(body);
  } finally {
    clearTimeout(timer);
  }
}

app.prepare().then(() => {
  const server = express();
  const httpServer = http.createServer(server);
  const httpsServer = createOptionalHttpsServer(server);

  const agentServerUrl =
    process.env.AGENT_SERVER_URL || "http://localhost:8080";

  // API proxy configuration for agent control endpoints
  const apiProxy = createProxyMiddleware({
    target: agentServerUrl,
    changeOrigin: true,
    timeout: 60000,
    proxyTimeout: 60000,
    pathRewrite: {
      "^/api/agents": "", // Remove /api/agents prefix
    },
    onProxyReq: (proxyReq, req) => {
      // express.json() consumes POST bodies before http-proxy-middleware sees
      // them. Re-stream JSON control requests so /start, /stop, and /ping do
      // not arrive at the TEN agent server with an empty body.
      const bodyData = JSON.stringify(req.body || {});
      proxyReq.setHeader("Content-Type", "application/json");
      proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    },
    onError: (err, _req, res) => {
      console.error("Agent API proxy error:", err.message);

      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }

      res.end(
        JSON.stringify({
          code: 502,
          msg: `Agent server unavailable: ${agentServerUrl}`,
          error: err.message,
        })
      );
    },
    logLevel: dev ? "debug" : "warn",
  });

  // Only parse request bodies for Express-owned endpoints. Passing a parsed
  // body into Next.js route handlers disturbs the request stream and can break
  // routes such as /api/log/event, character uploads, and Live2D jobs.
  server.use(["/api/local-services", "/api/agents"], express.json({ limit: "32mb" }));

  server.get("/api/device-bridge/health", (_req, res) => {
    res.json(createDeviceBridgeHealth());
  });

  server.get("/api/local-services/gpu-avatar/health", async (req, res) => {
    try {
      const backendEndpoint = normalizeGpuAvatarBackendEndpoint(
        req.query.backendEndpoint || req.query._gpuBackend
      );
      if (backendEndpoint) {
        const { response, data } = await fetchJson(
          resolveGpuAvatarBackendUrl(backendEndpoint, "/health"),
          { timeoutMs: parseInt(process.env.GPU_AVATAR_HEALTH_TIMEOUT_MS || "7000", 10) }
        );
        res.status(response.ok && data?.ok !== false ? 200 : 503).json({
          ok: response.ok && data?.ok !== false,
          endpoint: backendEndpoint,
          health: data,
        });
        return;
      }

      const health = await ensureGpuAvatarWorker();
      res.status(health.ok ? 200 : 503).json({
        ok: health.ok,
        endpoint: `http://127.0.0.1:${gpuAvatarWorkerPort}`,
        started: health.started,
        health: health.health,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/gpu-avatar/start", async (req, res) => {
    try {
      const result = await ensureGpuAvatarWorker({
        restart: Boolean(req.body?.restart),
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/gpu-avatar/render", async (req, res) => {
    try {
      const backendEndpoint = normalizeGpuAvatarBackendEndpoint(req.body?.backendEndpoint);
      if (backendEndpoint) {
        const body = { ...(req.body || {}) };
        delete body.backendEndpoint;
        await proxyJson(res, resolveGpuAvatarBackendUrl(backendEndpoint, "/render"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          timeoutMs: parseInt(process.env.GPU_AVATAR_RENDER_TIMEOUT_MS || "180000", 10),
        });
        return;
      }

      await ensureGpuAvatarWorker();
      await proxyJson(res, `http://127.0.0.1:${gpuAvatarWorkerPort}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: parseInt(process.env.GPU_AVATAR_RENDER_TIMEOUT_MS || "180000", 10),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/local-services/gpu-avatar/assets/*", async (req, res) => {
    try {
      const targetPath = req.originalUrl.replace(/^\/api\/local-services\/gpu-avatar/, "");
      const backendEndpoint = normalizeGpuAvatarBackendEndpoint(
        req.query.backendEndpoint || req.query._gpuBackend
      );
      const targetUrl = backendEndpoint
        ? resolveGpuAvatarBackendUrl(backendEndpoint, targetPath)
        : `http://127.0.0.1:${gpuAvatarWorkerPort}${targetPath}`;
      if (!backendEndpoint) await ensureGpuAvatarWorker();
      await proxyLocalBytes(res, targetUrl, {
        timeoutMs: 30000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/local-services/gpu-avatar/*", async (req, res) => {
    try {
      const targetPath = req.originalUrl.replace(/^\/api\/local-services\/gpu-avatar/, "");
      const backendEndpoint = normalizeGpuAvatarBackendEndpoint(
        req.query.backendEndpoint || req.query._gpuBackend
      );
      const targetUrl = backendEndpoint
        ? resolveGpuAvatarBackendUrl(backendEndpoint, targetPath)
        : `http://127.0.0.1:${gpuAvatarWorkerPort}${targetPath}`;
      if (!backendEndpoint) await ensureGpuAvatarWorker();
      await proxyLocalBytes(res, targetUrl, {
        timeoutMs: parseInt(process.env.GPU_AVATAR_MEDIA_TIMEOUT_MS || "180000", 10),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/local-services/head/health", async (_req, res) => {
    const health = await getHeadBridgeHealth();
    res.status(health.reachable ? 200 : 503).json({
      ok: health.reachable,
      endpoint: `http://127.0.0.1:${headBridgePort}`,
      health: health.data,
    });
  });

  server.post("/api/local-services/head/start", async (req, res) => {
    try {
      const result = await ensureHeadBridge({
        headIp: req.body?.head_ip || req.body?.headIp,
        restart: Boolean(req.body?.restart),
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/head/config", async (req, res) => {
    try {
      const headIp = req.body?.head_ip || req.body?.headIp;
      await ensureHeadBridge({ headIp });
      await proxyJson(res, `http://127.0.0.1:${headBridgePort}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: 9000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/head/action", async (req, res) => {
    try {
      await ensureHeadBridgeService();
      await proxyJson(res, `http://127.0.0.1:${headBridgePort}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: 4000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/head/audio/play", async (req, res) => {
    try {
      await ensureHeadBridgeService();
      await proxyJson(res, `http://127.0.0.1:${headBridgePort}/audio/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/head/audio/capture", async (req, res) => {
    try {
      await ensureHeadBridgeService();
      await proxyJson(res, `http://127.0.0.1:${headBridgePort}/audio/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/head/audio/stop", async (_req, res) => {
    try {
      await ensureHeadBridgeService();
      await proxyJson(res, `http://127.0.0.1:${headBridgePort}/audio/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 5000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/local-services/hand/health", async (_req, res) => {
    const health = await getGestureBridgeHealth();
    res.status(health.reachable ? 200 : 503).json({
      ok: health.reachable,
      endpoint: `http://127.0.0.1:${gestureBridgePort}`,
      health: health.data,
    });
  });

  server.post("/api/local-services/hand/start", async (req, res) => {
    try {
      const { restart, ...config } = req.body || {};
      const result = await ensureGestureBridge({
        config,
        restart: Boolean(restart),
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/local-services/hand/ports", async (_req, res) => {
    try {
      await ensureGestureBridge();
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/ports`, {
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/local-services/hand/snapshot", async (_req, res) => {
    try {
      await ensureGestureBridge();
      await proxyLocalBytes(res, `http://127.0.0.1:${gestureBridgePort}/snapshot`, {
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/config", async (req, res) => {
    try {
      await ensureGestureBridge({ config: req.body || {} });
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/recognition/start", async (req, res) => {
    try {
      await ensureGestureBridge({ config: req.body || {} });
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/recognition/stop", async (_req, res) => {
    try {
      await ensureGestureBridge();
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/action", async (req, res) => {
    try {
      await ensureGestureBridge();
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: 30000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/local-services/hand/history", async (req, res) => {
    try {
      await ensureGestureBridge();
      const limit = Number(req.query?.limit || 120);
      await proxyJson(
        res,
        `http://127.0.0.1:${gestureBridgePort}/history?limit=${encodeURIComponent(limit)}`,
        { timeoutMs: 12000 }
      );
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/demo/start", async (_req, res) => {
    try {
      await ensureGestureBridge();
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/arduino/demo/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/demo/stop", async (_req, res) => {
    try {
      await ensureGestureBridge();
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/arduino/demo/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/play/start", async (_req, res) => {
    try {
      await ensureGestureBridge();
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/arduino/play/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/play/stop", async (_req, res) => {
    try {
      await ensureGestureBridge();
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/arduino/play/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 12000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post("/api/local-services/hand/orca/pose", async (req, res) => {
    try {
      await ensureGestureBridge();
      await proxyJson(res, `http://127.0.0.1:${gestureBridgePort}/orca/pose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
        timeoutMs: 30000,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // WebSocket proxy with dynamic port support
  // Matches /ws or /ws/{port}
  server.use("/ws", (req, res, next) => {
    // Prevent ReDoS - validate URL length
    if (req.url.length > 50) {
      return res.status(400).json({ error: "Invalid request" });
    }

    // Extract port from path if provided (e.g., /8765)
    // Note: Express middleware strips '/ws' prefix, so req.url is '/8765' not '/ws/8765'
    const portMatch = req.url.match(/^\/(\d+)/);
    const wsPort = portMatch ? portMatch[1] : "8765";

    // Validate port range (8000-9000)
    const portNum = parseInt(wsPort, 10);
    if (portNum < 8000 || portNum > 9000) {
      console.error(
        `Invalid WebSocket port: ${wsPort}. Must be between 8000-9000.`
      );
      return res.status(400).json({ error: "Invalid port number" });
    }

    // Reuse cached proxy instance
    return getOrCreateProxy(wsPort, dev)(req, res, next);
  });

  // Proxy /api/agents/* to the agent server
  server.use("/api/agents", apiProxy);

  // Handle all other requests with Next.js
  server.all("*", (req, res) => {
    return handle(req, res);
  });

  // Listen for upgrade events (WebSocket handshake)
  const handleUpgrade = (req, socket, head) => {
    const parsedUrl = parse(req.url || "/", true);
    const { pathname } = parsedUrl;

    // Allow Next.js HMR WebSocket connection
    if (pathname === "/_next/webpack-hmr") {
      const upgradeHandler = app.getUpgradeHandler();
      return upgradeHandler(req, socket, head);
    }

    if (pathname === "/device-bridge") {
      deviceBridgeWss.handleUpgrade(req, socket, head, (ws) => {
        deviceBridgeWss.emit("connection", ws, req, parsedUrl.query || {});
      });
      return;
    }

    // Handle custom WebSocket proxy to backend
    if (req.url.startsWith("/ws")) {
      // Prevent ReDoS - validate URL length
      if (req.url.length > 50) {
        console.error("Invalid WebSocket upgrade request: URL too long");
        socket.destroy();
        return;
      }

      // Extract port from URL (e.g., /ws/8765)
      // Note: Upgrade handler receives full URL including '/ws' prefix
      const portMatch = req.url.match(/^\/ws\/(\d+)/);
      const wsPort = portMatch ? portMatch[1] : "8765";
      const portNum = parseInt(wsPort, 10);

      if (portNum < 8000 || portNum > 9000) {
        console.error(`Invalid WebSocket port on upgrade: ${wsPort}`);
        socket.destroy();
        return;
      }

      console.log(`WebSocket upgrade: ${req.url} -> ws://localhost:${wsPort}`);

      // Reuse cached proxy instance
      const wsProxy = getOrCreateProxy(wsPort, dev);
      wsProxy.upgrade(req, socket, head);
    } else {
      // Unknown WebSocket path - destroy connection
      socket.destroy();
    }
  };

  httpServer.on("upgrade", handleUpgrade);
  if (httpsServer) {
    httpsServer.on("upgrade", handleUpgrade);
  }

  httpServer.listen(port, bindHost, (err) => {
    if (err) throw err;
    logReachableUrls("http", port);
    if (httpsServer) {
      httpsServer.listen(httpsPort, bindHost, (httpsErr) => {
        if (httpsErr) throw httpsErr;
        logReachableUrls("https", httpsPort);
      });
    }
    console.log(
      process.env.AGENT_WS_PROXY_URL
        ? `> WebSocket proxy: /ws/{port} -> ${process.env.AGENT_WS_PROXY_URL}/ws/{port} (8000-9000)`
        : "> WebSocket proxy: /ws/{port} -> ws://127.0.0.1:{port} (8000-9000)"
    );
    console.log("> Device bridge: /device-bridge (browser <-> local connector)");
    console.log(`> API proxy: /api/agents -> ${agentServerUrl}`);
    if (process.env.AUTO_START_LOCAL_HARDWARE !== "false") {
      ensureHeadBridge()
        .then((result) => {
          console.log(
            result.ok
              ? `> Head bridge ready: ${result.endpoint} (${result.head_ip})`
              : `> Head bridge not ready: ${result.config?.error || result.health?.error || "unknown error"}`
          );
        })
        .catch((error) => {
          console.error("> Head bridge auto-start failed:", error.message);
        });
      if (process.env.AUTO_START_HAND_GESTURE !== "false") {
        ensureGestureBridge()
          .then((result) => {
            console.log(
              result.ok
                ? `> Gesture bridge ready: ${result.endpoint}`
                : `> Gesture bridge not ready: ${result.config?.error || result.health?.error || "unknown error"}`
            );
          })
          .catch((error) => {
            console.error("> Gesture bridge auto-start failed:", error.message);
          });
      }
    }
  });
});

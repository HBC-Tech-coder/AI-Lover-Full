#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function loadWs() {
  try {
    return require("ws");
  } catch {
    const bundled = path.resolve(__dirname, "..", "..", "frontend", "node_modules", "ws");
    return require(bundled);
  }
}

const WebSocket = loadWs();

const projectRoot = path.resolve(__dirname, "..", "..");
const frontendDir = path.join(projectRoot, "frontend");
const runtimeDir = path.join(projectRoot, "runtime");
const configPath = path.join(projectRoot, "local_connector_config.json");
const DEFAULT_BRIDGE_URL = "wss://ai.vituralmodel.com/device-bridge";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = Number(process.env.AI_LOVER_CONNECTOR_REQUEST_TIMEOUT_MS || 45000);

let localServerProcess = null;
let reconnectTimer = null;
let stopped = false;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {
    // Best effort; the connector can still run from command-line arguments.
  }
}

function generatePairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function normalizeBridgeUrl(raw, code, deviceName) {
  const url = new URL(raw || DEFAULT_BRIDGE_URL);
  url.searchParams.set("role", "connector");
  url.searchParams.set("pairingCode", code);
  url.searchParams.set("deviceName", deviceName);
  return url.toString();
}

function envFlag(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function createOptions() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig();
  const pairingCode =
    args.code ||
    args.pairingCode ||
    process.env.AI_LOVER_PAIRING_CODE ||
    config.pairingCode ||
    generatePairingCode();
  const nextConfig = {
    ...config,
    pairingCode,
    bridgeUrl:
      args.bridge ||
      process.env.AI_LOVER_DEVICE_BRIDGE_URL ||
      config.bridgeUrl ||
      DEFAULT_BRIDGE_URL,
    localBaseUrl:
      args.local ||
      process.env.AI_LOVER_LOCAL_BASE_URL ||
      config.localBaseUrl ||
      DEFAULT_LOCAL_BASE_URL,
    deviceName:
      args.name ||
      process.env.AI_LOVER_DEVICE_NAME ||
      config.deviceName ||
      `${os.hostname()} Local Connector`,
  };
  writeConfig(nextConfig);
  return {
    ...nextConfig,
    startLocalServer:
      args["start-local-server"] === "false"
        ? false
        : envFlag("AI_LOVER_CONNECTOR_START_LOCAL_SERVER", true),
  };
}

const options = createOptions();

function log(message) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${message}`);
}

function fileExists(value) {
  try {
    return Boolean(value && fs.existsSync(value));
  } catch {
    return false;
  }
}

function prependPath(env, dir) {
  if (!dir || !fileExists(dir)) return;
  const key = process.platform === "win32" ? "Path" : "PATH";
  const existing = env[key] || env.PATH || "";
  env[key] = existing ? `${dir}${path.delimiter}${existing}` : dir;
}

function repairPackagedHandPython() {
  const venvDir = path.join(runtimeDir, "hand-python");
  const cfgPath = path.join(venvDir, "pyvenv.cfg");
  const runtimePython = path.join(runtimeDir, "python311", "python.exe");
  if (!fileExists(cfgPath) || !fileExists(runtimePython)) return;
  const pythonHome = path.dirname(runtimePython);
  const version = process.env.AI_LOVER_PACKAGED_PYTHON_VERSION || "3.11";
  const content = [
    `home = ${pythonHome}`,
    "include-system-site-packages = false",
    `version = ${version}`,
    `executable = ${runtimePython}`,
    `command = ${runtimePython} -m venv ${venvDir}`,
    "",
  ].join("\n");
  try {
    fs.writeFileSync(cfgPath, content, "utf8");
    log("Packaged hand Python environment is ready.");
  } catch (error) {
    log(`Could not repair packaged hand Python environment: ${error.message}`);
  }
}

function buildLocalServerEnv(localUrl) {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: localUrl.port || "3000",
    BIND_HOST: localUrl.hostname || "127.0.0.1",
    AUTO_START_LOCAL_HARDWARE: process.env.AUTO_START_LOCAL_HARDWARE || "true",
    AUTO_START_HAND_GESTURE: process.env.AUTO_START_HAND_GESTURE || "true",
  };

  const runtimePython = path.join(runtimeDir, "python311", "python.exe");
  const handPython = path.join(runtimeDir, "hand-python", "Scripts", "python.exe");
  const adbPath = path.join(runtimeDir, "platform-tools", "adb.exe");

  if (!env.HEAD_MOTION_PYTHON && fileExists(runtimePython)) {
    env.HEAD_MOTION_PYTHON = runtimePython;
  }
  if (!env.HAND_GESTURE_PYTHON && fileExists(handPython)) {
    env.HAND_GESTURE_PYTHON = handPython;
  }
  if (!env.HEAD_MOTION_ADB_PATH && fileExists(adbPath)) {
    env.HEAD_MOTION_ADB_PATH = adbPath;
  }

  prependPath(env, path.join(runtimeDir, "nodejs"));
  prependPath(env, path.dirname(runtimePython));
  prependPath(env, path.dirname(adbPath));
  return env;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function localServiceReachable() {
  try {
    const response = await fetchWithTimeout(
      new URL("/api/device-bridge/health", options.localBaseUrl),
      {},
      1800,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForLocalService(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await localServiceReachable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

function startLocalServerIfNeeded() {
  if (!options.startLocalServer) {
    log(`Local server auto-start disabled; using ${options.localBaseUrl}`);
    return Promise.resolve();
  }
  return localServiceReachable().then((reachable) => {
    if (reachable) {
      log(`Local AI-Lover server already reachable: ${options.localBaseUrl}`);
      return;
    }
    const serverJs = path.join(frontendDir, "server.js");
    if (!fs.existsSync(serverJs)) {
      log(`Local server not found: ${serverJs}`);
      return;
    }
    const localUrl = new URL(options.localBaseUrl);
    repairPackagedHandPython();
    const env = buildLocalServerEnv(localUrl);
    localServerProcess = spawn(process.execPath, [serverJs], {
      cwd: frontendDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    localServerProcess.stdout.on("data", (data) =>
      process.stdout.write(`[local] ${data}`),
    );
    localServerProcess.stderr.on("data", (data) =>
      process.stderr.write(`[local] ${data}`),
    );
    localServerProcess.on("exit", (code, signal) => {
      log(`Local AI-Lover server exited: code=${code ?? ""} signal=${signal ?? ""}`);
      localServerProcess = null;
    });
    log(`Started local AI-Lover server on ${options.localBaseUrl}`);
    return waitForLocalService().then((ready) => {
      if (ready) {
        log("Local AI-Lover server health check passed.");
      } else {
        log(
          "Local AI-Lover server did not become ready. Head/hand requests will show 502 until it starts.",
        );
        log("Check frontend/server.js output above and keep this window open for support.");
      }
    });
  });
}

function safeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "transfer-encoding"
    ) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

function base64ToBuffer(value) {
  return value ? Buffer.from(String(value), "base64") : undefined;
}

function ensureAllowedPath(requestPath) {
  if (typeof requestPath !== "string" || requestPath.length > 2048) {
    throw new Error("Invalid local service path");
  }
  if (!requestPath.startsWith("/api/local-services/")) {
    throw new Error("Only /api/local-services/* can be relayed");
  }
  return requestPath;
}

async function handleBridgeRequest(ws, message) {
  const id = String(message.id || "");
  try {
    const requestPath = ensureAllowedPath(message.path);
    const method = String(message.method || "GET").toUpperCase();
    const localUrl = new URL(requestPath, options.localBaseUrl);
    const body = ["GET", "HEAD"].includes(method)
      ? undefined
      : base64ToBuffer(message.bodyBase64);
    const response = await fetchWithTimeout(localUrl, {
      method,
      headers: safeHeaders(message.headers),
      body,
    });
    const bodyBuffer = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    ws.send(
      JSON.stringify({
        type: "bridge.response",
        id,
        status: response.status,
        headers,
        bodyBase64: bodyBuffer.toString("base64"),
      }),
    );
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: "bridge.response",
        id,
        status: 502,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
          "utf8",
        ).toString("base64"),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function connect() {
  if (stopped) return;
  const wsUrl = normalizeBridgeUrl(
    options.bridgeUrl,
    options.pairingCode,
    options.deviceName,
  );
  log(`Connecting to ${wsUrl.replace(options.pairingCode, "***")}`);
  const ws = new WebSocket(wsUrl, { handshakeTimeout: 12000 });
  ws.on("open", () => {
    log(`Connected. Pairing code: ${options.pairingCode}`);
  });
  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === "connector.ready") {
      log("Cloud bridge accepted this connector.");
      return;
    }
    if (message.type === "bridge.request") {
      void handleBridgeRequest(ws, message);
    }
  });
  ws.on("close", (code, reason) => {
    log(`Disconnected from cloud bridge: ${code} ${String(reason || "")}`);
    if (!stopped) {
      reconnectTimer = setTimeout(connect, 2500);
    }
  });
  ws.on("error", (error) => {
    log(`Cloud bridge error: ${error.message}`);
  });
}

process.on("SIGINT", () => {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (localServerProcess) localServerProcess.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (localServerProcess) localServerProcess.kill();
  process.exit(0);
});

log("AI-Lover Local Connector starting...");
log(`Device name: ${options.deviceName}`);
log(`Pairing code: ${options.pairingCode}`);
log(`Local services: ${options.localBaseUrl}`);

startLocalServerIfNeeded()
  .then(() => connect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

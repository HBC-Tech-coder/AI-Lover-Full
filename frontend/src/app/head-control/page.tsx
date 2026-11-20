"use client";

import {
  Eye,
  Frown,
  Heart,
  Mic,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  SlidersHorizontal,
  Smile,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  checkHeadBridge,
  configureHeadBridge,
  decodePcm16Base64,
  playHeadTestTone,
  setHeadSpeakerVolume,
  startLocalHeadBridge,
  testHeadMicrophone,
} from "@/lib/headMotion";

type HeadAction =
  | "init"
  | "speak"
  | "stopspeak"
  | "smile"
  | "sad"
  | "kiss"
  | "makeface"
  | "blink"
  | "blink_left"
  | "blink_right"
  | "eyes_rotate"
  | "turn_neck";

type DeviceConfig = {
  id: string;
  name: string;
  endpoint: string;
};

type ServoConfig = {
  location: number;
  name: string;
  min: number;
  max: number;
  neutral: number;
};

const STORAGE_KEY = "xiaoling-head-control-devices";
const HEAD_IP_STORAGE_KEY = "xiaoling-head-control-ip";
const HEAD_VOLUME_STORAGE_KEY = "xiaoling-head-control-volume";
const DEFAULT_HEAD_IP = "192.168.110.63";

const DEFAULT_DEVICE: DeviceConfig = {
  id: "local-head-01",
  name: "本地机械芯",
  endpoint: "http://127.0.0.1:8787",
};

const ACTIONS: Array<{
  action: HeadAction;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { action: "init", label: "复位", icon: Power },
  { action: "speak", label: "说话", icon: Play },
  { action: "stopspeak", label: "停嘴", icon: Square },
  { action: "smile", label: "微笑", icon: Smile },
  { action: "sad", label: "伤心", icon: Frown },
  { action: "kiss", label: "亲吻", icon: Heart },
  { action: "makeface", label: "鬼脸", icon: RefreshCw },
  { action: "blink", label: "眨眼", icon: Eye },
  { action: "blink_left", label: "左眨", icon: Eye },
  { action: "blink_right", label: "右眨", icon: Eye },
  { action: "eyes_rotate", label: "转眼", icon: RotateCcw },
  { action: "turn_neck", label: "转头", icon: RotateCcw },
];

const SERVOS: ServoConfig[] = [
  { location: 1, name: "右眼皮", min: 90, max: 126, neutral: 126 },
  { location: 2, name: "左眼皮", min: 54, max: 90, neutral: 54 },
  { location: 3, name: "眼球", min: 72, max: 108, neutral: 90 },
  { location: 4, name: "左脸", min: 58, max: 140, neutral: 90 },
  { location: 5, name: "右脸", min: 45, max: 120, neutral: 90 },
  { location: 6, name: "嘴巴", min: 85, max: 153, neutral: 85 },
  { location: 7, name: "脖子", min: 63, max: 117, neutral: 90 },
];

function sanitizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/$/, "");
}

function loadDevices(): DeviceConfig[] {
  if (typeof window === "undefined") return [DEFAULT_DEVICE];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [DEFAULT_DEVICE];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [DEFAULT_DEVICE];
    return parsed
      .map((item) => ({
        id: String(item.id || "").trim(),
        name: String(item.name || "").trim(),
        endpoint: String(item.endpoint || "").trim(),
      }))
      .filter((item) => item.id && item.endpoint);
  } catch {
    return [DEFAULT_DEVICE];
  }
}

export default function HeadControlPage() {
  const [devices, setDevices] = useState<DeviceConfig[]>([DEFAULT_DEVICE]);
  const [selectedId, setSelectedId] = useState(DEFAULT_DEVICE.id);
  const [servoAngles, setServoAngles] = useState<Record<number, number>>(() =>
    Object.fromEntries(SERVOS.map((servo) => [servo.location, servo.neutral])),
  );
  const [speed, setSpeed] = useState(5);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [status, setStatus] = useState("未连接");
  const [audioStatus, setAudioStatus] = useState("");
  const micWaveformRef = useRef<HTMLCanvasElement>(null);
  const [lastFrames, setLastFrames] = useState<string[]>([]);
  const [headIp, setHeadIp] = useState(DEFAULT_HEAD_IP);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    const stored = loadDevices();
    setDevices(stored);
    setSelectedId(stored[0]?.id ?? DEFAULT_DEVICE.id);
    const storedHeadIp = window.localStorage.getItem(HEAD_IP_STORAGE_KEY);
    if (storedHeadIp) setHeadIp(storedHeadIp);
    const storedVolume = Number(window.localStorage.getItem(HEAD_VOLUME_STORAGE_KEY));
    if (Number.isFinite(storedVolume)) setVolume(Math.max(0, Math.min(1, storedVolume)));
  }, []);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedId) ?? devices[0],
    [devices, selectedId],
  );

  function persist(next: DeviceConfig[]) {
    setDevices(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  function updateDevice(id: string, patch: Partial<DeviceConfig>) {
    const next = devices.map((device) =>
      device.id === id ? { ...device, ...patch } : device,
    );
    persist(next);
  }

  function renameDevice(id: string, nextId: string) {
    const cleanId = nextId.trim() || id;
    updateDevice(id, { id: cleanId });
    setSelectedId(cleanId);
  }

  function addDevice() {
    const index = devices.length + 1;
    const nextDevice = {
      id: `head-${String(index).padStart(2, "0")}`,
      name: `机械芯 ${index}`,
      endpoint: "http://127.0.0.1:8787",
    };
    persist([...devices, nextDevice]);
    setSelectedId(nextDevice.id);
  }

  function removeDevice(id: string) {
    const next = devices.filter((device) => device.id !== id);
    const safeNext = next.length ? next : [DEFAULT_DEVICE];
    persist(safeNext);
    setSelectedId(safeNext[0].id);
  }

  async function sendToDevice(body: Record<string, unknown>) {
    if (!selectedDevice) return;
    const endpoint = sanitizeEndpoint(selectedDevice.endpoint);
    const response = await fetch(`${endpoint}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: selectedDevice.id,
        ...body,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(String(data?.error || `HTTP ${response.status}`));
    }
    setLastFrames(Array.isArray(data?.frames) ? data.frames : []);
  }

  async function runAction(action: HeadAction) {
    setBusyAction(action);
    setStatus(`发送 ${action}`);
    try {
      await sendToDevice({ action });
      setStatus(`${selectedDevice?.name ?? "设备"} 已执行 ${action}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function runServo(location: number) {
    const angle = servoAngles[location];
    setBusyAction(`servo-${location}`);
    setStatus(`发送舵机 ${location}`);
    try {
      await sendToDevice({ action: "servo", location, angle, speed });
      setStatus(`舵机 ${location} 已到 ${angle} 度`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function checkHealth() {
    if (!selectedDevice) return;
    setBusyAction("health");
    try {
      const response = await fetch(`${sanitizeEndpoint(selectedDevice.endpoint)}/health`);
      const data = await response.json();
      setStatus(
        data?.ok
          ? `在线：${data.dry_run ? "dry-run" : data.transport || "hardware"}，声卡 ${data.audio?.card ?? "?"}`
          : "不可用",
      );
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function startOrReconnectBridge() {
    if (!selectedDevice) return;
    const ip = headIp.trim();
    setBusyAction("start-head-bridge");
    setStatus(`启动/重连头部 bridge ${ip}`);
    try {
      window.localStorage.setItem(HEAD_IP_STORAGE_KEY, ip);
      const result = await startLocalHeadBridge(ip, true);
      if (!result.ok) {
        throw new Error(
          result.error ||
            result.config?.error ||
            result.health?.error ||
            "Head bridge unavailable",
        );
      }
      updateDevice(selectedDevice.id, { endpoint: result.endpoint });
      setStatus(`头部 bridge 已连接：${result.endpoint} / ${result.head_ip}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function runSpeakerTest() {
    setBusyAction("speaker-test");
    setAudioStatus("正在测试头部喇叭...");
    try {
      await playHeadTestTone();
      setAudioStatus("头部喇叭测试完成：如果头部发出两声提示音，说明音箱链路正常。");
    } catch (error) {
      setAudioStatus(`头部喇叭测试失败：${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  function drawMicWaveform(base64: string) {
    const canvas = micWaveformRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 72;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const samples = decodePcm16Base64(base64);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(8, 47, 73, 0.55)";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(103, 232, 249, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(samples.length / width));
    const mid = height / 2;
    for (let x = 0; x < width; x += 1) {
      let peak = 0;
      const start = x * step;
      const end = Math.min(samples.length, start + step);
      for (let i = start; i < end; i += 1) {
        const value = Math.abs(samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff));
        if (value > peak) peak = value;
      }
      const y = mid - peak * (height * 0.44);
      const y2 = mid + peak * (height * 0.44);
      if (x === 0) ctx.moveTo(x, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();
  }

  async function runMicTest() {
    setBusyAction("mic-test");
    setAudioStatus("正在录制头部麦克风 2 秒...");
    try {
      const result = await testHeadMicrophone(2000, true);
      drawMicWaveform(result.chunk.audio);
      setAudioStatus(
        `头部麦克风测试完成：电平 ${result.levelPercent}%，RMS ${result.rms.toFixed(3)}，已在电脑上回放录音。`,
      );
    } catch (error) {
      setAudioStatus(`头部麦克风测试失败：${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function updateVolume(nextVolume: number) {
    const safeVolume = Math.max(0, Math.min(1, nextVolume));
    setVolume(safeVolume);
    window.localStorage.setItem(HEAD_VOLUME_STORAGE_KEY, String(safeVolume));
    try {
      await setHeadSpeakerVolume(safeVolume);
      await configureHeadBridge(headIp, { playbackVolume: safeVolume });
      setAudioStatus(`头部音量已设置为 ${Math.round(safeVolume * 100)}%`);
    } catch (error) {
      setAudioStatus(`音量设置失败：${String(error)}`);
    }
  }

  async function runDiagnose() {
    setBusyAction("diagnose");
    setAudioStatus("正在读取头部声卡诊断...");
    try {
      const health = await checkHeadBridge();
      setAudioStatus(
        `头部在线：声卡 ${health.audio?.playback ? "可播放" : "不可播放"}，队列 ${
          health.audio?.playback_queue ?? 0
        }，音量 ${health.audio?.playback_volume_percent ?? "?"}%`,
      );
    } catch (error) {
      setAudioStatus(`诊断失败：${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">机械芯控制台</h1>
            <p className="mt-1 text-sm text-zinc-400">{status}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="h-10 w-40 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400"
              onChange={(event) => setHeadIp(event.target.value)}
              placeholder="192.168.x.x"
              value={headIp}
            />
            <button
              className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-100 hover:bg-zinc-900 disabled:opacity-50"
              disabled={busyAction !== null}
              onClick={startOrReconnectBridge}
              type="button"
            >
              <Power className="h-4 w-4" />
              启动/重连
            </button>
            <button
              className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-100 hover:bg-zinc-900 disabled:opacity-50"
              disabled={busyAction !== null}
              onClick={checkHealth}
              type="button"
            >
              <RefreshCw className="h-4 w-4" />
              检测
            </button>
          </div>
        </header>

        <section className="grid gap-3 border-b border-zinc-800 pb-5 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div className="grid gap-3 md:grid-cols-3">
            {devices.map((device) => (
              <button
                className={`h-[88px] rounded-md border p-3 text-left transition ${
                  device.id === selectedId
                    ? "border-cyan-400 bg-cyan-950/35"
                    : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600"
                }`}
                key={device.id}
                onClick={() => setSelectedId(device.id)}
                type="button"
              >
                <div className="truncate text-sm font-medium">{device.name}</div>
                <div className="mt-1 truncate text-xs text-zinc-400">{device.id}</div>
                <div className="mt-2 truncate text-xs text-zinc-500">{device.endpoint}</div>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
            <button
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white"
              onClick={addDevice}
              type="button"
            >
              <Plus className="h-4 w-4" />
              添加
            </button>
            <button
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-100 hover:bg-zinc-900"
              onClick={() => selectedDevice && removeDevice(selectedDevice.id)}
              type="button"
            >
              <Trash2 className="h-4 w-4" />
              删除
            </button>
          </div>
        </section>

        {selectedDevice && (
          <section className="grid gap-3 border-b border-zinc-800 pb-5 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1.4fr)]">
            <label className="flex flex-col gap-2 text-sm text-zinc-300">
              设备 ID
              <input
                className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-zinc-100 outline-none focus:border-cyan-400"
                onChange={(event) => renameDevice(selectedDevice.id, event.target.value)}
                value={selectedDevice.id}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-zinc-300">
              名称
              <input
                className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-zinc-100 outline-none focus:border-cyan-400"
                onChange={(event) =>
                  updateDevice(selectedDevice.id, { name: event.target.value })
                }
                value={selectedDevice.name}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-zinc-300">
              控制端点
              <div className="flex gap-2">
                <input
                  className="h-10 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-zinc-100 outline-none focus:border-cyan-400"
                  onChange={(event) =>
                    updateDevice(selectedDevice.id, { endpoint: event.target.value })
                  }
                  value={selectedDevice.endpoint}
                />
                <button
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-700 hover:bg-zinc-900"
                  onClick={() => persist(devices)}
                  type="button"
                >
                  <Save className="h-4 w-4" />
                </button>
              </div>
            </label>
          </section>
        )}

        <section className="grid gap-3 border-b border-zinc-800 pb-5">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Volume2 className="h-4 w-4 text-cyan-300" />
            头部音频测试
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1.2fr]">
            <button
              className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 text-sm text-zinc-100 hover:border-cyan-400 hover:bg-cyan-950/30 disabled:opacity-50"
              disabled={busyAction !== null}
              onClick={runSpeakerTest}
              type="button"
            >
              <Volume2 className="h-4 w-4" />
              测试头部喇叭
            </button>
            <button
              className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 text-sm text-zinc-100 hover:border-cyan-400 hover:bg-cyan-950/30 disabled:opacity-50"
              disabled={busyAction !== null}
              onClick={runMicTest}
              type="button"
            >
              <Mic className="h-4 w-4" />
              测试头部麦克风
            </button>
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-3">
              <Volume2 className="h-4 w-4 text-cyan-300" />
              <input
                className="accent-cyan-400"
                max={100}
                min={0}
                onChange={(event) => updateVolume(Number(event.target.value) / 100)}
                type="range"
                value={Math.round(volume * 100)}
              />
              <span className="w-12 text-right text-sm tabular-nums text-zinc-300">
                {Math.round(volume * 100)}%
              </span>
            </div>
          </div>
          <button
            className="inline-flex h-10 w-fit items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-100 hover:bg-zinc-900 disabled:opacity-50"
            disabled={busyAction !== null}
            onClick={runDiagnose}
            type="button"
          >
            <RefreshCw className="h-4 w-4" />
            查看音频诊断
          </button>
          {audioStatus && (
            <p className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300">
              {audioStatus}
            </p>
          )}
          <canvas
            ref={micWaveformRef}
            className="h-20 w-full rounded-md border border-zinc-800 bg-sky-950/30"
          />
        </section>

        <section className="grid gap-3 border-b border-zinc-800 pb-5">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Send className="h-4 w-4 text-cyan-300" />
            动作
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {ACTIONS.map(({ action, label, icon: Icon }) => (
              <button
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 text-sm text-zinc-100 hover:border-cyan-400 hover:bg-cyan-950/30 disabled:opacity-50"
                disabled={busyAction !== null}
                key={action}
                onClick={() => runAction(action)}
                type="button"
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
              <SlidersHorizontal className="h-4 w-4 text-cyan-300" />
              舵机
            </div>
            <div className="inline-grid grid-cols-3 overflow-hidden rounded-md border border-zinc-700">
              {[5, 10, 15].map((value) => (
                <button
                  className={`h-9 px-4 text-sm ${
                    speed === value
                      ? "bg-cyan-500 text-zinc-950"
                      : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                  }`}
                  key={value}
                  onClick={() => setSpeed(value)}
                  type="button"
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {SERVOS.map((servo) => (
              <div
                className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3"
                key={servo.location}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{servo.name}</div>
                    <div className="text-xs text-zinc-500">
                      {servo.min}-{servo.max} 度
                    </div>
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-cyan-300">
                    {servoAngles[servo.location]}
                  </div>
                </div>
                <div className="grid grid-cols-[1fr_88px_88px] gap-2">
                  <input
                    className="min-w-0 accent-cyan-400"
                    max={servo.max}
                    min={servo.min}
                    onChange={(event) =>
                      setServoAngles((state) => ({
                        ...state,
                        [servo.location]: Number(event.target.value),
                      }))
                    }
                    type="range"
                    value={servoAngles[servo.location]}
                  />
                  <button
                    className="h-10 rounded-md border border-zinc-700 text-sm hover:bg-zinc-800"
                    onClick={() =>
                      setServoAngles((state) => ({
                        ...state,
                        [servo.location]: servo.neutral,
                      }))
                    }
                    type="button"
                  >
                    中位
                  </button>
                  <button
                    className="inline-flex h-10 items-center justify-center gap-1 rounded-md bg-cyan-400 px-3 text-sm font-medium text-zinc-950 hover:bg-cyan-300 disabled:opacity-50"
                    disabled={busyAction !== null}
                    onClick={() => runServo(servo.location)}
                    type="button"
                  >
                    <Send className="h-3.5 w-3.5" />
                    发送
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {lastFrames.length > 0 && (
          <section className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="text-xs text-zinc-500">最近串口帧</div>
            <pre className="mt-2 overflow-x-auto text-sm text-cyan-200">
              {lastFrames.join("\n")}
            </pre>
          </section>
        )}
      </div>
    </main>
  );
}

"use client";

import {
  Camera,
  CameraOff,
  CheckCircle2,
  Eye,
  Frown,
  Hand,
  Heart,
  Mic,
  Music,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  Smile,
  Square,
  Volume2,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkHandGestureBridge,
  listHandGesturePorts,
  sendHandGestureAction,
  startArduinoHandDemo,
  startArduinoHandPlay,
  startLocalHandGestureBridge,
  stopArduinoHandDemo,
  stopArduinoHandPlay,
  type HandGestureHealth,
  type HandGesturePort,
} from "@/lib/handGesture";
import {
  checkHeadBridge,
  configureHeadBridge,
  playHeadTestTone,
  sendHeadAction,
  setHeadSpeakerVolume,
  startLocalHeadBridge,
  testHeadMicrophone,
  type HeadBridgeHealth,
} from "@/lib/headMotion";
import {
  CAMERA_QUALITY_PRESETS,
  getSettings,
  setSettings,
  useSettings,
} from "@/lib/settingsStore";

type Landmark = { x: number; y: number; z?: number };
type CameraDevice = { deviceId: string; label: string };
type NoticeType = "ok" | "warn" | "error" | "info";
type Notice = { type: NoticeType; text: string };
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  kind: "heart" | "coin";
  size: number;
};

const HAND_CONNECTIONS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

const COMMON_HAND_ACTIONS = [
  ["open", "张开"],
  ["fist", "握拳"],
  ["point", "食指"],
  ["two", "二指"],
  ["three", "三指"],
  ["pinch", "捏合"],
  ["thumb", "拇指"],
  ["stop", "停止"],
] as const;

const HEAD_ACTIONS = [
  ["init", "复位", Power],
  ["blink", "眨眼", Eye],
  ["smile", "微笑", Smile],
  ["sad", "伤心", Frown],
  ["kiss", "亲吻", Heart],
  ["makeface", "鬼脸", Smile],
  ["turn_neck", "转头", RotateCcw],
  ["stopspeak", "停嘴", Square],
] as const;

function parsePorts(value: string): string[] {
  return value
    .split(/[,;，；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function distance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function estimatePattern(points: Landmark[]): string {
  if (points.length < 21) return "000000";
  const palm = Math.max(0.04, distance(points[0], points[9]));
  const thumbOpen = distance(points[4], points[9]) > palm * 0.72;
  const fingerOpen = (tip: number, pip: number, mcp: number) =>
    distance(points[tip], points[0]) > distance(points[pip], points[0]) * 1.05 &&
    points[tip].y < points[mcp].y + palm * 0.35;
  const index = fingerOpen(8, 6, 5);
  const middle = fingerOpen(12, 10, 9);
  const ring = fingerOpen(16, 14, 13);
  const pinky = fingerOpen(20, 18, 17);
  const allOpen = [thumbOpen, index, middle, ring, pinky]
    .map((open) => (open ? "1" : "0"))
    .join("");
  return `${allOpen}0`;
}

function isHeartGesture(pattern: string): boolean {
  return pattern === "011000" || pattern === "011100" || pattern === "001100";
}

function isTwoHandSpecial(patterns: string[]): boolean {
  return patterns.filter(isHeartGesture).length >= 2;
}

function handCenter(points: Landmark[]): { x: number; y: number } {
  if (!points.length) return { x: 0.5, y: 0.5 };
  const sum = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function summarizeHead(health: HeadBridgeHealth | null): string {
  if (!health) return "未检测";
  if (!health.ok) return health.error || "异常";
  const audio = health.audio;
  const volume =
    typeof audio?.playback_volume_percent === "number"
      ? `，音量 ${audio.playback_volume_percent}%`
      : "";
  return `${health.transport || "bridge"} 在线${volume}`;
}

function summarizeHand(health: HandGestureHealth | null): string {
  if (!health) return "未检测";
  if (!health.ok) return health.error || "异常";
  const active = health.config?.active_arduino_ports?.length
    ? `，Arduino ${health.config.active_arduino_ports.join(",")}`
    : "";
  const dry = health.config?.dry_run ? "，dry-run" : "";
  const orca = health.orca?.enabled ? `，ORCA ${health.orca.status || "-"}` : "";
  return `bridge 在线${active}${orca}${dry}`;
}

export default function LocalControlPage() {
  const [settings, updateSettings] = useSettings();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const effectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<{
    detectForVideo: (
      video: HTMLVideoElement,
      timestamp: number,
    ) => {
      landmarks?: Landmark[][];
      handednesses?: Array<Array<{ categoryName?: string }>>;
    };
    close?: () => void;
  } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastSentAtRef = useRef(0);
  const particlesRef = useRef<Particle[]>([]);

  const [notice, setNotice] = useState<Notice>({
    type: "info",
    text: "本地控制台已准备好。这里不依赖云端，可离线测试头部和手臂。",
  });
  const [cameraDevices, setCameraDevices] = useState<CameraDevice[]>([]);
  const [cameraRunning, setCameraRunning] = useState(false);
  const [cameraStatus, setCameraStatus] = useState("未开启");
  const [pattern, setPattern] = useState("000000");
  const [hands, setHands] = useState(0);
  const [fps, setFps] = useState(0);
  const [headHealth, setHeadHealth] = useState<HeadBridgeHealth | null>(null);
  const [handHealth, setHandHealth] = useState<HandGestureHealth | null>(null);
  const [ports, setPorts] = useState<HandGesturePort[]>([]);
  const [busy, setBusy] = useState("");

  const arduinoPorts = useMemo(
    () => parsePorts(settings.handGestureArduinoPorts),
    [settings.handGestureArduinoPorts],
  );

  const showNotice = useCallback((type: NoticeType, text: string) => {
    setNotice({ type, text });
  }, []);

  const run = useCallback(
    async (label: string, task: () => Promise<string | void>) => {
      setBusy(label);
      try {
        const result = await task();
        if (result) showNotice("ok", result);
      } catch (error) {
        showNotice(
          "error",
          `${label}失败：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setBusy("");
      }
    },
    [showNotice],
  );

  const refreshCameras = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      setCameraStatus("当前浏览器不支持摄像头 API。请使用 Chrome/Edge，并用 127.0.0.1 或 HTTPS 打开。");
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    setCameraDevices(
      devices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `摄像头 ${index}`,
        })),
    );
  }, []);

  const startBridgeForBrowserDriving = useCallback(async () => {
    const result = await startLocalHandGestureBridge(
      {
        camera_index: settings.handGestureCameraIndex,
        arduino_ports: arduinoPorts,
        baud: settings.handGestureBaud,
        dry_run: settings.handGestureDryRun,
        arduino_enabled: settings.handGestureArduinoEnabled,
        send_interval_ms: settings.handGestureSendIntervalMs,
        orca_enabled: settings.handGestureOrcaEnabled,
        orca_port: settings.handGestureOrcaPort,
        orca_direct_joint_enabled: settings.handGestureOrcaDirectJointEnabled,
        orca_wrist_follow_enabled: settings.handGestureOrcaWristFollowEnabled,
      },
      false,
    );
    setHandHealth(result.health ?? result.config ?? null);
    return result;
  }, [arduinoPorts, settings]);

  const drawFrame = useCallback(
    (detectedHands: Landmark[][], patterns: string[]) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const fx = effectCanvasRef.current;
      if (!video || !canvas || !fx) return;
      const rect = video.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        fx.width = width;
        fx.height = height;
      }
      const ctx = canvas.getContext("2d");
      const fxCtx = fx.getContext("2d");
      if (!ctx || !fxCtx) return;
      ctx.clearRect(0, 0, width, height);
      fxCtx.clearRect(0, 0, width, height);

      detectedHands.forEach((points) => {
        ctx.lineWidth = Math.max(3, width * 0.004);
        ctx.strokeStyle = "rgba(67, 221, 255, 0.92)";
        ctx.fillStyle = "rgba(143, 255, 196, 0.95)";
        ctx.shadowColor = "rgba(67, 221, 255, 0.5)";
        ctx.shadowBlur = 10;
        for (const [from, to] of HAND_CONNECTIONS) {
          const a = points[from];
          const b = points[to];
          if (!a || !b) continue;
          ctx.beginPath();
          ctx.moveTo(a.x * width, a.y * height);
          ctx.lineTo(b.x * width, b.y * height);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        for (const point of points) {
          ctx.beginPath();
          ctx.arc(point.x * width, point.y * height, Math.max(4, width * 0.005), 0, Math.PI * 2);
          ctx.fill();
        }
        const wrist = points[0];
        if (wrist) {
          ctx.fillStyle = "rgba(255, 222, 94, 0.95)";
          ctx.beginPath();
          ctx.arc(wrist.x * width, wrist.y * height, Math.max(8, width * 0.008), 0, Math.PI * 2);
          ctx.fill();
        }
      });

      if (settings.handGestureParticleEffectsEnabled) {
        const nowPatterns = patterns.filter(Boolean);
        if (isTwoHandSpecial(nowPatterns)) {
          for (let i = 0; i < 5; i += 1) {
            particlesRef.current.push({
              x: Math.random() * width,
              y: -20 - Math.random() * 50,
              vx: (Math.random() - 0.5) * 0.5,
              vy: 2 + Math.random() * 2.5,
              life: 80,
              maxLife: 80,
              kind: "coin",
              size: 18 + Math.random() * 14,
            });
          }
        } else {
          detectedHands.forEach((points, index) => {
            if (!isHeartGesture(nowPatterns[index] || "")) return;
            const center = handCenter(points);
            for (let i = 0; i < 3; i += 1) {
              particlesRef.current.push({
                x: center.x * width + (Math.random() - 0.5) * 80,
                y: center.y * height + (Math.random() - 0.5) * 60,
                vx: (Math.random() - 0.5) * 2.5,
                vy: -1.6 - Math.random() * 2.4,
                life: 42,
                maxLife: 42,
                kind: "heart",
                size: 16 + Math.random() * 16,
              });
            }
          });
        }
      }

      particlesRef.current = particlesRef.current
        .map((particle) => ({
          ...particle,
          x: particle.x + particle.vx,
          y: particle.y + particle.vy,
          vy: particle.kind === "coin" ? particle.vy + 0.04 : particle.vy + 0.02,
          life: particle.life - 1,
        }))
        .filter((particle) => particle.life > 0 && particle.y < height + 80);

      for (const particle of particlesRef.current) {
        const alpha = Math.max(0, particle.life / particle.maxLife);
        fxCtx.globalAlpha = alpha;
        fxCtx.font = `${particle.size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
        fxCtx.textAlign = "center";
        fxCtx.fillText(particle.kind === "coin" ? "¥" : "♥", particle.x, particle.y);
      }
      fxCtx.globalAlpha = 1;
    },
    [settings.handGestureParticleEffectsEnabled],
  );

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    landmarkerRef.current?.close?.();
    landmarkerRef.current = null;
    setCameraRunning(false);
    setCameraStatus("已关闭");
    setHands(0);
  }, []);

  const startCamera = useCallback(async () => {
    await startBridgeForBrowserDriving();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("浏览器不支持摄像头。请使用 Chrome/Edge，并从 127.0.0.1 或 HTTPS 打开。");
    }

    const quality = CAMERA_QUALITY_PRESETS[settings.cameraQuality || "high"];
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: settings.cameraDeviceId
          ? { exact: settings.cameraDeviceId }
          : undefined,
        width: { ideal: quality.width },
        height: { ideal: quality.height },
        frameRate: { ideal: quality.frameRate },
      },
      audio: false,
    });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    const { FilesetResolver, HandLandmarker } = await import(
      "@mediapipe/tasks-vision"
    );
    const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "/mediapipe/hand_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
    }).catch(() =>
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "/mediapipe/hand_landmarker.task",
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
      }),
    );
    await refreshCameras();
    setCameraRunning(true);
    setCameraStatus("浏览器手势识别运行中");
    showNotice("ok", "摄像头已开启，本地页面会直接把手势发送到本机机械手 bridge。");

    let frames = 0;
    let lastFpsAt = performance.now();
    const loop = () => {
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      const result = landmarker.detectForVideo(video, performance.now());
      const detected = result.landmarks || [];
      const patterns = detected.map((points) => estimatePattern(points));
      const primaryPattern = patterns[0] || "000000";
      setPattern(primaryPattern);
      setHands(detected.length);
      drawFrame(detected, patterns);

      const now = Date.now();
      const interval = Math.max(60, settings.handGestureSendIntervalMs || 120);
      if (detected[0] && now - lastSentAtRef.current >= interval) {
        lastSentAtRef.current = now;
        const handType = result.handednesses?.[0]?.[0]?.categoryName || null;
        void sendHandGestureAction(
          "",
          primaryPattern,
          detected[0],
          handType,
          "local-control-browser-camera",
        ).catch((error) => {
          setCameraStatus(
            `手势已识别，但下发失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }

      frames += 1;
      if (performance.now() - lastFpsAt >= 1000) {
        setFps(frames);
        frames = 0;
        lastFpsAt = performance.now();
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [
    drawFrame,
    refreshCameras,
    settings.cameraDeviceId,
    settings.cameraQuality,
    settings.handGestureSendIntervalMs,
    showNotice,
    startBridgeForBrowserDriving,
  ]);

  useEffect(() => {
    void refreshCameras().catch(() => {});
    void checkHeadBridge()
      .then(setHeadHealth)
      .catch(() => {});
    void checkHandGestureBridge()
      .then(setHandHealth)
      .catch(() => {});
    void listHandGesturePorts()
      .then(setPorts)
      .catch(() => {});
    return () => stopCamera();
  }, [refreshCameras, stopCamera]);

  return (
    <main className="min-h-screen bg-[#080b12] text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-slate-800 border-b px-4 py-3">
        <div>
          <h1 className="font-semibold text-xl">AI-Lover 本地离线控制台</h1>
          <p className="text-slate-400 text-sm">
            不经过云端，不含 AI 对话；用于低延迟测试仿生头、Arduino 手、ORCA 手和手势特效。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge label="头部" value={summarizeHead(headHealth)} ok={headHealth?.ok} />
          <StatusBadge label="手臂" value={summarizeHand(handHealth)} ok={handHealth?.ok} />
          <a
            className="rounded-md border border-slate-700 px-3 py-2 text-slate-200 hover:bg-slate-800"
            href="/"
          >
            返回首页
          </a>
        </div>
      </header>

      <section className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_430px]">
        <div className="min-h-[calc(100vh-96px)] overflow-hidden rounded-md border border-slate-800 bg-black">
          <div className="relative h-[calc(100vh-96px)] min-h-[620px]">
            <video
              ref={videoRef}
              muted
              playsInline
              className="absolute inset-0 h-full w-full scale-x-[-1] object-cover"
            />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_45%,rgba(2,6,23,.45))]" />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full scale-x-[-1]"
            />
            <canvas ref={effectCanvasRef} className="absolute inset-0 h-full w-full" />
            {!cameraRunning && (
              <div className="absolute inset-0 grid place-items-center text-center">
                <div className="max-w-sm rounded-md border border-slate-700 bg-slate-950/80 p-5">
                  <CameraOff className="mx-auto mb-3 h-10 w-10 text-slate-400" />
                  <p className="font-medium">摄像头未开启</p>
                  <p className="mt-1 text-slate-400 text-sm">
                    点击右侧“启动摄像头和手势控制”，这里会显示最大化手势画面、骨架和粒子特效。
                  </p>
                </div>
              </div>
            )}
            <div className="absolute top-3 left-3 flex flex-wrap gap-2">
              <Pill icon={<Hand className="h-4 w-4" />} text={`手势 ${pattern}`} />
              <Pill text={`${hands} 只手`} />
              <Pill text={`${fps} FPS`} />
              <Pill text={cameraStatus} />
            </div>
            <div className="absolute right-3 bottom-3 rounded-md bg-slate-950/80 px-3 py-2 text-slate-300 text-sm">
              多 Arduino：在右侧填入 <code>COM5,COM6</code>，会同步广播同一动作。
            </div>
          </div>
        </div>

        <aside className="max-h-[calc(100vh-96px)] overflow-y-auto rounded-md border border-slate-800 bg-slate-950 p-4">
          <NoticeBox notice={notice} />

          <Panel title="本地摄像头 / 手势驱动">
            <label className="block space-y-1">
              <span className="text-slate-400 text-xs">浏览器摄像头</span>
              <select
                value={settings.cameraDeviceId}
                onChange={(event) =>
                  updateSettings({ cameraDeviceId: event.target.value })
                }
                className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3"
              >
                <option value="">浏览器默认摄像头</option>
                {cameraDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn" type="button" onClick={() => void refreshCameras()}>
                <RefreshCw className="h-4 w-4" />
                刷新摄像头
              </button>
              <select
                value={settings.cameraQuality}
                onChange={(event) =>
                  updateSettings({
                    cameraQuality: event.target.value as typeof settings.cameraQuality,
                  })
                }
                className="h-10 rounded-md border border-slate-700 bg-slate-900 px-3"
              >
                {Object.entries(CAMERA_QUALITY_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn primary"
                disabled={Boolean(busy) || cameraRunning}
                onClick={() => void run("启动摄像头", startCamera)}
              >
                <Camera className="h-4 w-4" />
                启动摄像头和手势控制
              </button>
              <button type="button" className="btn" onClick={stopCamera}>
                <CameraOff className="h-4 w-4" />
                停止摄像头
              </button>
            </div>
          </Panel>

          <Panel title="机械手连接">
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-slate-400 text-xs">Arduino 串口，可多个</span>
                <input
                  value={settings.handGestureArduinoPorts}
                  placeholder="例如 COM5,COM6"
                  onChange={(event) =>
                    updateSettings({ handGestureArduinoPorts: event.target.value })
                  }
                  className="input"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-400 text-xs">ORCA / Dynamixel 串口</span>
                <input
                  value={settings.handGestureOrcaPort}
                  placeholder="例如 COM4"
                  onChange={(event) =>
                    updateSettings({ handGestureOrcaPort: event.target.value })
                  }
                  className="input"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-slate-400 text-xs">Bridge 摄像头编号</span>
                <input
                  type="number"
                  value={settings.handGestureCameraIndex}
                  onChange={(event) =>
                    updateSettings({ handGestureCameraIndex: Number(event.target.value) || 0 })
                  }
                  className="input"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-400 text-xs">Baud</span>
                <input
                  type="number"
                  value={settings.handGestureBaud}
                  onChange={(event) =>
                    updateSettings({ handGestureBaud: Number(event.target.value) || 9600 })
                  }
                  className="input"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Toggle
                label="Dry-run 调试"
                checked={settings.handGestureDryRun}
                onChange={(checked) => updateSettings({ handGestureDryRun: checked })}
              />
              <Toggle
                label="启用 Arduino 输出"
                checked={settings.handGestureArduinoEnabled}
                onChange={(checked) =>
                  updateSettings({ handGestureArduinoEnabled: checked })
                }
              />
              <Toggle
                label="启用 ORCA 输出"
                checked={settings.handGestureOrcaEnabled}
                onChange={(checked) => updateSettings({ handGestureOrcaEnabled: checked })}
              />
              <Toggle
                label="ORCA 腕部跟随"
                checked={settings.handGestureOrcaWristFollowEnabled}
                onChange={(checked) =>
                  updateSettings({ handGestureOrcaWristFollowEnabled: checked })
                }
              />
            </div>
            <button
              type="button"
              className="btn primary w-full"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("启动机械手 bridge", async () => {
                  const result = await startBridgeForBrowserDriving();
                  const portsText = arduinoPorts.length
                    ? `；Arduino 同步端口：${arduinoPorts.join(", ")}`
                    : "";
                  return `机械手 bridge 已连接${portsText}`;
                })
              }
            >
              <RefreshCw className="h-4 w-4" />
              启动/重连机械手 bridge
            </button>
            <button
              type="button"
              className="btn w-full"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("检测机械手", async () => {
                  const [health, detectedPorts] = await Promise.all([
                    checkHandGestureBridge(),
                    listHandGesturePorts(),
                  ]);
                  setHandHealth(health);
                  setPorts(detectedPorts);
                  return summarizeHand(health);
                })
              }
            >
              <CheckCircle2 className="h-4 w-4" />
              检测机械手状态和串口
            </button>
            <PortList ports={ports} active={handHealth?.config?.active_arduino_ports || []} />
          </Panel>

          <Panel title="手部动作">
            <div className="grid grid-cols-4 gap-2">
              {COMMON_HAND_ACTIONS.map(([action, label]) => (
                <button
                  key={action}
                  type="button"
                  className="btn"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(label, async () => {
                      const result = await sendHandGestureAction(
                        action,
                        undefined,
                        undefined,
                        null,
                        "local-control-button",
                      );
                      return `${label}已发送：${result.pattern || action}`;
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("演示模式", async () => {
                    await startArduinoHandDemo();
                    return "Arduino 演示模式已启动。";
                  })
                }
              >
                <Play className="h-4 w-4" />
                演示模式
              </button>
              <button
                type="button"
                className="btn"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("停止演示", async () => {
                    await stopArduinoHandDemo();
                    return "演示模式已停止。";
                  })
                }
              >
                <Pause className="h-4 w-4" />
                停止演示
              </button>
              <button
                type="button"
                className="btn"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("演奏模式", async () => {
                    await startArduinoHandPlay();
                    return "演奏模式已启动：手指对应宫商角徵羽。";
                  })
                }
              >
                <Music className="h-4 w-4" />
                演奏模式
              </button>
              <button
                type="button"
                className="btn"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("停止演奏", async () => {
                    await stopArduinoHandPlay();
                    return "演奏模式已停止。";
                  })
                }
              >
                <Square className="h-4 w-4" />
                停止演奏
              </button>
            </div>
          </Panel>

          <Panel title="仿生头">
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-slate-400 text-xs">头部 IP</span>
                <input
                  value={settings.robotHeadIp}
                  placeholder="192.168.110.139"
                  onChange={(event) => updateSettings({ robotHeadIp: event.target.value })}
                  className="input"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-400 text-xs">头部音量</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings.robotHeadVolume * 100)}
                  onChange={(event) => {
                    const volume = Number(event.target.value) / 100;
                    updateSettings({ robotHeadVolume: volume });
                    void setHeadSpeakerVolume(volume).catch(() => {});
                  }}
                  className="w-full accent-blue-500"
                />
              </label>
            </div>
            <button
              type="button"
              className="btn primary w-full"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("启动头部 bridge", async () => {
                  const result = await startLocalHeadBridge(settings.robotHeadIp, true);
                  setHeadHealth(result.health ?? result.config ?? null);
                  await configureHeadBridge(settings.robotHeadIp, {
                    playbackVolume: settings.robotHeadVolume,
                  });
                  return `头部 bridge 已连接：${settings.robotHeadIp}`;
                })
              }
            >
              <RefreshCw className="h-4 w-4" />
              启动/重连头部 bridge
            </button>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                className="btn"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("检测头部", async () => {
                    const health = await checkHeadBridge();
                    setHeadHealth(health);
                    return summarizeHead(health);
                  })
                }
              >
                <CheckCircle2 className="h-4 w-4" />
                检测
              </button>
              <button
                type="button"
                className="btn"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("测试喇叭", async () => {
                    await playHeadTestTone();
                    return "已发送头部喇叭测试音。";
                  })
                }
              >
                <Volume2 className="h-4 w-4" />
                喇叭
              </button>
              <button
                type="button"
                className="btn"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("测试麦克风", async () => {
                    const result = await testHeadMicrophone(2000, true);
                    return `头部麦克风音量约 ${result.levelPercent}%`;
                  })
                }
              >
                <Mic className="h-4 w-4" />
                麦克风
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {HEAD_ACTIONS.map(([action, label, Icon]) => (
                <button
                  key={action}
                  type="button"
                  className="btn"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(label, async () => {
                      await sendHeadAction(action, { source: "local-control" });
                      return `${label}已发送。`;
                    })
                  }
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="离线使用提示">
            <div className="space-y-2 text-slate-300 text-sm">
              <p>
                1. 本页地址是 <code>http://127.0.0.1:3000/local-control</code>，断网也能打开。
              </p>
              <p>
                2. 如果要控制多个 Arduino 手臂，把串口写成 <code>COM5,COM6</code>；bridge 会向所有端口发送同一手势。
              </p>
              <p>
                3. 真实控制硬件时请关闭 Dry-run，并确认外接电源、USB 数据线和 Windows 设备管理器里的 COM 口。
              </p>
            </div>
          </Panel>
        </aside>
      </section>

      <style jsx>{`
        .btn {
          display: inline-flex;
          min-height: 40px;
          align-items: center;
          justify-content: center;
          gap: 8px;
          border-radius: 6px;
          border: 1px solid rgb(51 65 85);
          background: rgb(15 23 42);
          padding: 8px 10px;
          color: rgb(226 232 240);
          font-size: 13px;
          transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
        }
        .btn:hover {
          background: rgb(30 41 59);
          border-color: rgb(71 85 105);
        }
        .btn:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }
        .btn.primary {
          border-color: rgb(37 99 235);
          background: rgb(37 99 235);
          color: white;
        }
        .btn.primary:hover {
          background: rgb(29 78 216);
        }
        .input {
          height: 40px;
          width: 100%;
          border-radius: 6px;
          border: 1px solid rgb(51 65 85);
          background: rgb(15 23 42);
          padding: 0 10px;
          color: rgb(226 232 240);
          outline: none;
        }
        .input:focus {
          border-color: rgb(96 165 250);
        }
      `}</style>
    </main>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 space-y-3 rounded-md border border-slate-800 bg-slate-900/45 p-3">
      <h2 className="font-semibold text-base">{title}</h2>
      {children}
    </section>
  );
}

function Pill({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-slate-950/80 px-3 py-1 text-slate-100 text-xs">
      {icon}
      {text}
    </span>
  );
}

function StatusBadge({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <span
      className={`rounded-full border px-3 py-1 ${
        ok
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-amber-500/40 bg-amber-500/10 text-amber-200"
      }`}
      title={value}
    >
      {label}：{value}
    </span>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-blue-500"
      />
    </label>
  );
}

function NoticeBox({ notice }: { notice: Notice }) {
  const styles: Record<NoticeType, string> = {
    ok: "border-emerald-500/50 bg-emerald-500/10 text-emerald-100",
    warn: "border-amber-500/50 bg-amber-500/10 text-amber-100",
    error: "border-red-500/50 bg-red-500/10 text-red-100",
    info: "border-blue-500/50 bg-blue-500/10 text-blue-100",
  };
  const Icon =
    notice.type === "error" ? WifiOff : notice.type === "ok" ? CheckCircle2 : RefreshCw;
  return (
    <div className={`mb-4 flex gap-2 rounded-md border p-3 text-sm ${styles[notice.type]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{notice.text}</p>
    </div>
  );
}

function PortList({
  ports,
  active,
}: {
  ports: HandGesturePort[];
  active: string[];
}) {
  if (!ports.length) {
    return (
      <p className="rounded-md bg-slate-950 px-3 py-2 text-slate-400 text-xs">
        暂未检测到串口。请检查 USB 数据线、驱动和设备管理器里的“端口(COM 和 LPT)”。
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-slate-400 text-xs">
        检测到 {ports.length} 个串口；当前 Arduino 输出端口：{active.join(", ") || "未启用"}
      </p>
      <div className="max-h-36 overflow-auto rounded-md border border-slate-800">
        {ports.map((port) => (
          <div
            key={port.device}
            className="border-slate-800 border-b px-3 py-2 text-sm last:border-b-0"
          >
            <span className="font-medium text-slate-100">{port.device}</span>
            <span className="ml-2 text-slate-400">{port.description || port.hwid}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import {
  Download,
  Hand,
  History,
  Music,
  Pause,
  Play,
  RefreshCw,
  Save,
  Send,
  Square,
  Upload,
  Video,
  VideoOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  checkHandGestureBridge,
  listHandMotionHistory,
  listHandGesturePorts,
  sendHandGestureAction,
  sendOrcaPose,
  startArduinoHandDemo,
  startArduinoHandPlay,
  startHandGestureBridge,
  startLocalHandGestureBridge,
  stopArduinoHandDemo,
  stopArduinoHandPlay,
  stopHandGestureBridge,
  type HandGestureHealth,
  type HandGesturePort,
  type HandMotionHistoryItem,
} from "@/lib/handGesture";
import { browserMediaUnavailableReason } from "@/lib/audioUtils";
import { useSettings } from "@/lib/settingsStore";

type Landmark = { x: number; y: number; z?: number };
type MotionFrame = { t: number; hands: Landmark[][]; pattern: string; handType?: string | null };
type MotionSlice = {
  version: 1;
  createdAt: string;
  source: "ai-lover-hand-control";
  frames: MotionFrame[];
};

type OrcaJoint = {
  id: string;
  label: string;
  min: number;
  max: number;
  neutral: number;
};

function clampInterval(value: number, fallback: number, min = 50, max = 1000): number {
  const numeric = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}

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

const COMMON_ACTIONS = [
  ["open", "张开"],
  ["fist", "握拳"],
  ["point", "食指"],
  ["two", "二指"],
  ["three", "三指"],
  ["pinch", "捏合"],
  ["thumb", "拇指"],
  ["stop", "停止"],
] as const;

const ORCA_JOINTS: OrcaJoint[] = [
  { id: "middle_pip", label: "中指 PIP", min: -15, max: 107, neutral: 9.16 },
  { id: "pinky_mcp", label: "小指 MCP", min: -25, max: 100, neutral: 4.09 },
  { id: "pinky_pip", label: "小指 PIP", min: -15, max: 107, neutral: -2.37 },
  { id: "pinky_abd", label: "小指展开", min: -30, max: 30, neutral: -6.06 },
  { id: "middle_abd", label: "中指展开", min: -27, max: 27, neutral: 4.91 },
  { id: "index_abd", label: "食指展开", min: -30, max: 25, neutral: -8.06 },
  { id: "index_mcp", label: "食指 MCP", min: -25, max: 100, neutral: 5.21 },
  { id: "index_pip", label: "食指 PIP", min: -15, max: 107, neutral: 21.75 },
  { id: "thumb_mcp", label: "拇指 MCP", min: -25, max: 100, neutral: 34.92 },
  { id: "thumb_dip", label: "拇指 DIP", min: -15, max: 107, neutral: 7.5 },
  { id: "thumb_abd", label: "拇指展开", min: -18, max: 55, neutral: 3.7 },
  { id: "thumb_cmc", label: "拇指 CMC", min: -45, max: 33, neutral: -43.76 },
  { id: "ring_abd", label: "无名指展开", min: -27, max: 27, neutral: 1.26 },
  { id: "ring_pip", label: "无名指 PIP", min: -15, max: 107, neutral: 10.7 },
  { id: "ring_mcp", label: "无名指 MCP", min: -25, max: 100, neutral: 16.95 },
  { id: "middle_mcp", label: "中指 MCP", min: -25, max: 100, neutral: 12.2 },
  { id: "wrist", label: "手腕", min: -65, max: 35, neutral: -25.33 },
];

function distance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function estimatePattern(points: Landmark[]): string {
  if (points.length < 21) return "000000";
  const width = Math.max(distance(points[5], points[17]), 0.001);
  const folded = (tip: number, pip: number) => points[tip].y > points[pip].y + 0.025;
  const index = folded(8, 6);
  const middle = folded(12, 10);
  const ring = folded(16, 14);
  const pinky = folded(20, 18);
  const thumb =
    distance(points[4], points[5]) < width * 0.62 || points[4].y > points[3].y + 0.035;
  return [false, index, middle, ring, thumb, pinky].map((value) => (value ? "1" : "0")).join("");
}

function drawSkeleton(
  canvas: HTMLCanvasElement,
  hands: Landmark[][],
  pattern = "000000",
  video?: HTMLVideoElement | null,
) {
  const width = video?.videoWidth || canvas.clientWidth || 640;
  const height = video?.videoHeight || canvas.clientHeight || 480;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  hands.forEach((points, index) => {
    const stroke = index === 0 ? "rgba(118, 214, 255, 0.96)" : "rgba(255, 160, 220, 0.94)";
    const fill = index === 0 ? "rgba(110, 255, 180, 1)" : "rgba(255, 190, 230, 1)";
    for (const [from, to] of HAND_CONNECTIONS) {
      const a = points[from];
      const b = points[to];
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(3, width * 0.005);
      ctx.stroke();
    }
    points.forEach((point, pointIndex) => {
      ctx.beginPath();
      ctx.arc(
        point.x * width,
        point.y * height,
        pointIndex === 0 ? Math.max(5, width * 0.009) : Math.max(3.5, width * 0.006),
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = pointIndex === 0 ? "rgba(255, 230, 120, 1)" : fill;
      ctx.fill();
    });
  });
  ctx.font = `${Math.max(14, Math.round(width * 0.035))}px sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fillText(`${pattern}${hands.length > 1 ? ` x${hands.length}` : ""}`, 12, 32);
}

function parsePorts(value: string): string[] {
  return value
    .replace(/[;；，\s]+/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function classifyPort(port: HandGesturePort): string {
  const text = `${port.device} ${port.description || ""} ${port.hwid || ""}`.toLowerCase();
  if (/arduino|ch34[0-9]|wch|usb-enhanced-serial|usb-enhanced serial|usb-serial|usb serial|cp210|ftdi/.test(text)) return "可能是 Arduino 手";
  if (/dynamixel|usb2dynamixel|orca|u2d2|robotis/.test(text)) return "可能是 ORCA / Dynamixel";
  return "未知设备";
}

function handDeliverySuffix(result: { dry_run?: boolean; delivered?: boolean }): string {
  if (result.dry_run) return " (dry-run)";
  if (result.delivered === false) return " (未下发硬件)";
  return "";
}

function initialPose(): Record<string, number> {
  return Object.fromEntries(ORCA_JOINTS.map((joint) => [joint.id, joint.neutral]));
}

export default function HandControlPage() {
  const [settings, setSettings] = useSettings();
  const [health, setHealth] = useState<HandGestureHealth | null>(null);
  const [ports, setPorts] = useState<HandGesturePort[]>([]);
  const [status, setStatus] = useState("未检测");
  const [busy, setBusy] = useState<string | null>(null);
  const [pattern, setPattern] = useState("000000");
  const [pose, setPose] = useState<Record<string, number>>(initialPose);
  const [recording, setRecording] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sliceFrames, setSliceFrames] = useState<MotionFrame[]>([]);
  const [importedFrames, setImportedFrames] = useState<MotionFrame[]>([]);
  const [sendReplayToHand, setSendReplayToHand] = useState(false);
  const [motionHistory, setMotionHistory] = useState<HandMotionHistoryItem[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const landmarkerRef = useRef<any>(null);
  const startedAtRef = useRef(0);
  const lastRecordAtRef = useRef(0);
  const lastLiveRecognizeAtRef = useRef(0);
  const lastLiveSendAtRef = useRef(0);
  const lastLiveStatusAtRef = useRef(0);
  const liveSendInFlightRef = useRef(false);
  const recordingRef = useRef(false);

  const missingDeps = useMemo(() => {
    const deps = health?.dependencies || {};
    return Object.entries(deps)
      .filter(([, info]) => !info.ok && !info.optional)
      .map(([name]) => name);
  }, [health]);

  async function run<T>(name: string, task: () => Promise<T>, done?: (value: T) => string) {
    setBusy(name);
    try {
      const value = await task();
      setStatus(done ? done(value) : "完成");
      return value;
    } catch (error) {
      setStatus(String(error));
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    await run(
      "refresh",
      async () => {
        const [nextHealth, nextPorts] = await Promise.all([
          checkHandGestureBridge(),
          listHandGesturePorts(),
        ]);
        setHealth(nextHealth);
        setPorts(nextPorts);
        return nextHealth;
      },
      (value) =>
        `bridge ${value.running ? "识别运行中" : "在线"}，手势 ${
          value.last_pattern || "000000"
        }，${value.config?.dry_run ? "dry-run" : "真实串口"}`,
    );
  }

  async function startBridge(restart = true) {
    await run(
      "start-bridge",
      async () => {
        const result = await startLocalHandGestureBridge(
          {
            camera_index: settings.handGestureCameraIndex,
            arduino_ports: parsePorts(settings.handGestureArduinoPorts),
            baud: settings.handGestureBaud,
            dry_run: settings.handGestureDryRun,
            arduino_enabled: settings.handGestureArduinoEnabled,
            send_interval_ms: clampInterval(settings.handGestureSendIntervalMs, 120),
            orca_enabled: settings.handGestureOrcaEnabled,
            orca_port: settings.handGestureOrcaPort,
            orca_direct_joint_enabled: settings.handGestureOrcaDirectJointEnabled,
            orca_wrist_follow_enabled: settings.handGestureOrcaWristFollowEnabled,
          },
          restart,
        );
        if (!result.ok) throw new Error(result.error || "手部 bridge 启动失败");
        if (result.config || result.health) setHealth((result.config || result.health) ?? null);
        return result.endpoint;
      },
      (endpoint) => `bridge 已连接：${endpoint}`,
    );
  }

  async function startRecognition() {
    await run(
      "start-recognition",
      async () => {
        const result = await startLocalHandGestureBridge(
          {
            camera_index: settings.handGestureCameraIndex,
            arduino_ports: parsePorts(settings.handGestureArduinoPorts),
            baud: settings.handGestureBaud,
            dry_run: settings.handGestureDryRun,
            arduino_enabled: settings.handGestureArduinoEnabled,
            send_interval_ms: clampInterval(settings.handGestureSendIntervalMs, 120),
            orca_enabled: settings.handGestureOrcaEnabled,
            orca_port: settings.handGestureOrcaPort,
            orca_direct_joint_enabled: settings.handGestureOrcaDirectJointEnabled,
            orca_wrist_follow_enabled: settings.handGestureOrcaWristFollowEnabled,
          },
          false,
        );
        const nextHealth = (result.config || result.health) ?? (await checkHandGestureBridge());
        setHealth(nextHealth);
        return nextHealth;
      },
      (value) => `识别已启动：摄像头 ${value.config?.camera_index ?? 0}`,
    );
    if (!cameraOn) await startCamera();
  }

  async function stopRecognition() {
    await run(
      "stop-recognition",
      async () => {
        await sendHandGestureAction("open", "000000").catch(() => null);
        const nextHealth = await stopHandGestureBridge();
        setHealth(nextHealth);
        return nextHealth;
      },
      () => "识别已停止，已发送张开/停止姿态",
    );
    stopCamera();
  }

  async function sendPattern(nextPattern = pattern) {
    await run(
      `pattern-${nextPattern}`,
      async () => sendHandGestureAction("", nextPattern),
      (result) => `已发送手势 ${result.pattern}${handDeliverySuffix(result)}`,
    );
  }

  async function sendAction(action: string) {
    await run(
      action,
      async () => sendHandGestureAction(action),
      (result) => `已发送 ${action}：${result.pattern}${handDeliverySuffix(result)}`,
    );
  }

  async function runArduinoDemo() {
    await run(
      "arduino-demo",
      async () => startArduinoHandDemo(),
      () => "Arduino 演示模式已启动：会循环张开、逐指、握拳",
    );
    await refresh().catch(() => null);
  }

  async function stopArduinoDemo() {
    await run(
      "arduino-demo-stop",
      async () => stopArduinoHandDemo(),
      () => "Arduino 演示模式已停止",
    );
    await refresh().catch(() => null);
  }

  async function runArduinoSong() {
    await run(
      "arduino-play",
      async () => startArduinoHandPlay(),
      () => "Arduino 演奏已启动：宫商角徵羽 / 沧海一声笑",
    );
    await refresh().catch(() => null);
  }

  async function stopArduinoSong() {
    await run(
      "arduino-play-stop",
      async () => stopArduinoHandPlay(),
      () => "Arduino 演奏已停止",
    );
    await refresh().catch(() => null);
  }

  async function refreshMotionHistory() {
    await run(
      "history",
      async () => listHandMotionHistory(120),
      (result) => {
        setMotionHistory(result.items || []);
        return `已读取 ${result.items?.length || 0} 条手部动作历史`;
      },
    );
  }

  async function sendPose() {
    await run(
      "orca-pose",
      async () => sendOrcaPose(pose),
      (result) =>
        `ORCA 姿态已${result.queued ? "排队" : result.pending ? "等待连接" : "发送"}：${
          result.joints ?? ORCA_JOINTS.length
        } 关节${handDeliverySuffix(result)}`,
    );
  }

  function resetPose() {
    setPose(initialPose());
  }

  async function startCamera() {
    await run("camera", async () => {
      const bridge = await startLocalHandGestureBridge(
        {
          camera_index: settings.handGestureCameraIndex,
          arduino_ports: parsePorts(settings.handGestureArduinoPorts),
          baud: settings.handGestureBaud,
          dry_run: settings.handGestureDryRun,
          arduino_enabled: settings.handGestureArduinoEnabled,
          send_interval_ms: clampInterval(settings.handGestureSendIntervalMs, 120),
          orca_enabled: settings.handGestureOrcaEnabled,
          orca_port: settings.handGestureOrcaPort,
          orca_direct_joint_enabled: settings.handGestureOrcaDirectJointEnabled,
          orca_wrist_follow_enabled: settings.handGestureOrcaWristFollowEnabled,
        },
        false,
      );
      if (bridge.config || bridge.health) setHealth((bridge.config || bridge.health) ?? null);
      const unavailable = browserMediaUnavailableReason("camera");
      if (unavailable) throw new Error(unavailable);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
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
      setCameraOn(true);
      startedAtRef.current = performance.now();
      lastLiveRecognizeAtRef.current = 0;
      lastLiveSendAtRef.current = 0;
      lastLiveStatusAtRef.current = 0;
      liveSendInFlightRef.current = false;
      const tick = () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const landmarker = landmarkerRef.current;
        if (!video || !canvas || !landmarker) return;
        const now = performance.now();
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const recognitionInterval = clampInterval(
            settings.handGestureRecognitionIntervalMs,
            90,
          );
          const sendInterval = clampInterval(settings.handGestureSendIntervalMs, 120);
          if (now - lastLiveRecognizeAtRef.current < recognitionInterval) {
            rafRef.current = requestAnimationFrame(tick);
            return;
          }
          lastLiveRecognizeAtRef.current = now;
          const result = landmarker.detectForVideo(video, now);
          const hands = ((result.landmarks || []) as Landmark[][]).filter(
            (points) => points.length >= 21,
          );
          const primary = hands[0];
          const nextPattern = primary ? estimatePattern(primary) : "000000";
          const handType =
            result?.handednesses?.[0]?.[0]?.categoryName ||
            result?.handedness?.[0]?.[0]?.categoryName ||
            null;
          drawSkeleton(canvas, hands, nextPattern, video);
          if (primary && !liveSendInFlightRef.current && now - lastLiveSendAtRef.current >= sendInterval) {
            lastLiveSendAtRef.current = now;
            liveSendInFlightRef.current = true;
            sendHandGestureAction("", nextPattern, primary, handType, "camera")
              .then((result) => {
                setHealth((current) =>
                  current
                    ? {
                        ...current,
                        detected: true,
                        landmark_count: result.landmarks ?? 21,
                        last_angles: result.arduino_angles,
                        last_bends: result.finger_bends,
                        last_pattern: result.pattern,
                      }
                    : current,
                );
                if (now - lastLiveStatusAtRef.current > 900) {
                  const angles = result.arduino_angles
                    ?.slice(1)
                    .map((angle) => Math.round(angle))
                    .join(",");
                  setStatus(`browser camera driving hand: ${result.pattern}${angles ? ` angles ${angles}` : ""}`);
                  lastLiveStatusAtRef.current = now;
                }
              })
              .catch((error) => {
                if (now - lastLiveStatusAtRef.current > 1200) {
                  setStatus(String(error));
                  lastLiveStatusAtRef.current = now;
                }
              })
              .finally(() => {
                liveSendInFlightRef.current = false;
              });
          }
          if (recordingRef.current && now - lastRecordAtRef.current > 90) {
            const frame: MotionFrame = {
              t: Math.round(now - startedAtRef.current),
              hands,
              pattern: nextPattern,
              handType,
            };
            setSliceFrames((frames) => [...frames, frame]);
            lastRecordAtRef.current = now;
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return true;
    }, () => "摄像头已开启，可录制手部运动切片");
  }

  function stopCamera() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    landmarkerRef.current?.close?.();
    landmarkerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    liveSendInFlightRef.current = false;
    lastLiveRecognizeAtRef.current = 0;
    lastLiveSendAtRef.current = 0;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    setRecording(false);
    recordingRef.current = false;
  }

  useEffect(() => () => stopCamera(), []);

  function startRecording() {
    setSliceFrames([]);
    startedAtRef.current = performance.now();
    lastRecordAtRef.current = 0;
    recordingRef.current = true;
    setRecording(true);
  }

  function stopRecording() {
    recordingRef.current = false;
    setRecording(false);
  }

  function downloadSlice() {
    const slice: MotionSlice = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: "ai-lover-hand-control",
      frames: sliceFrames,
    };
    const blob = new Blob([JSON.stringify(slice, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `hand-motion-slice-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importSlice(file: File) {
    const text = await file.text();
    const data = JSON.parse(text) as MotionSlice;
    if (!Array.isArray(data.frames)) throw new Error("切片文件格式不正确");
    setImportedFrames(data.frames);
    setStatus(`已导入 ${data.frames.length} 帧手部运动切片`);
  }

  async function replaySlice() {
    const canvas = canvasRef.current;
    if (!canvas || !importedFrames.length) return;
    setBusy("replay");
    setStatus("正在回放手部运动切片...");
    const started = performance.now();
    let index = 0;
    const step = async () => {
      const elapsed = performance.now() - started;
      while (index < importedFrames.length - 1 && importedFrames[index + 1].t <= elapsed) {
        index += 1;
      }
      const frame = importedFrames[index];
      drawSkeleton(canvas, frame.hands, frame.pattern);
      if (sendReplayToHand && frame.hands[0] && index % 2 === 0) {
        sendHandGestureAction("", frame.pattern, frame.hands[0], frame.handType).catch(() => {});
      }
      if (index < importedFrames.length - 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setBusy(null);
        setStatus("切片回放完成");
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">机械手测试台</h1>
            <p className="mt-1 text-sm text-zinc-400">{status}</p>
          </div>
          <div className="flex gap-2">
            <button
              className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm hover:bg-zinc-900 disabled:opacity-50"
              disabled={Boolean(busy)}
              onClick={refresh}
              type="button"
            >
              <RefreshCw className="h-4 w-4" />
              检测
            </button>
            <button
              className="inline-flex h-10 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
              disabled={Boolean(busy)}
              onClick={() => startBridge(true)}
              type="button"
            >
              <Play className="h-4 w-4" />
              启动/重连
            </button>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="text-sm font-medium">连接设置</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm text-zinc-300">
                摄像头编号
                <input
                  className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 outline-none focus:border-cyan-400"
                  min={0}
                  onChange={(event) =>
                    setSettings({ handGestureCameraIndex: Number(event.target.value) || 0 })
                  }
                  type="number"
                  value={settings.handGestureCameraIndex}
                />
              </label>
              <label className="grid gap-1 text-sm text-zinc-300">
                Baud
                <input
                  className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 outline-none focus:border-cyan-400"
                  min={1200}
                  onChange={(event) =>
                    setSettings({ handGestureBaud: Number(event.target.value) || 9600 })
                  }
                  type="number"
                  value={settings.handGestureBaud}
                />
              </label>
              <label className="grid gap-1 text-sm text-zinc-300 sm:col-span-2">
                Arduino 串口
                <input
                  className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 outline-none focus:border-cyan-400"
                  onChange={(event) =>
                    setSettings({ handGestureArduinoPorts: event.target.value })
                  }
                  placeholder="COM5,COM6"
                  value={settings.handGestureArduinoPorts}
                />
              </label>
              <label className="grid gap-1 text-sm text-zinc-300 sm:col-span-2">
                ORCA / Dynamixel 串口
                <input
                  className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 outline-none focus:border-cyan-400"
                  onChange={(event) =>
                    setSettings({ handGestureOrcaPort: event.target.value.trim() })
                  }
                  placeholder="COM4"
                  value={settings.handGestureOrcaPort}
                />
              </label>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {[
                ["handGestureDryRun", "Dry-run 调试"],
                ["handGestureArduinoEnabled", "启用 Arduino 输出"],
                ["handGestureOrcaEnabled", "启用 ORCA 输出"],
                ["handGestureOrcaDirectJointEnabled", "ORCA 17 关节跟随"],
                ["handGestureOrcaWristFollowEnabled", "ORCA 手腕跟随"],
              ].map(([key, label]) => (
                <label
                  className="flex h-10 items-center justify-between rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-300"
                  key={key}
                >
                  {label}
                  <input
                    checked={Boolean(settings[key as keyof typeof settings])}
                    onChange={(event) =>
                      setSettings({ [key]: event.target.checked } as Partial<typeof settings>)
                    }
                    type="checkbox"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="text-sm font-medium">状态与串口</h2>
            <div className="mt-3 grid gap-2 text-sm text-zinc-300">
              <div>运行：{health?.running ? "识别运行中" : "未运行"}</div>
              <div>模式：{health?.config?.dry_run ? "dry-run" : "真实串口"}</div>
              <div>Arduino 当前端口：{health?.config?.active_arduino_ports?.join(", ") || "-"}</div>
              <div>ORCA 端口：{health?.config?.orca_runtime_port || health?.config?.orca_config_port || "-"}</div>
              <div>ORCA 状态：{health?.orca?.status || "-"}</div>
              {missingDeps.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
                  缺少依赖：{missingDeps.join(", ")}
                </div>
              )}
              {ports.length > 0 && (
                <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2">
                  {ports.map((port) => (
                    <div className="py-1" key={`${port.device}-${port.hwid}`}>
                      <span className="font-medium text-zinc-100">{port.device}</span>
                      <span className="ml-2 text-zinc-500">{classifyPort(port)}</span>
                      <div className="text-xs text-zinc-500">{port.description || port.hwid}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={startRecognition}
                type="button"
              >
                <Hand className="h-4 w-4" />
                启动识别
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={stopRecognition}
                type="button"
              >
                <Square className="h-4 w-4" />
                停止识别
              </button>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="text-sm font-medium">Arduino 手势 / ORCA 常用动作</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {COMMON_ACTIONS.map(([action, label]) => (
                <button
                  className="h-10 rounded-md border border-zinc-700 text-sm hover:border-cyan-400 hover:bg-cyan-950/30 disabled:opacity-50"
                  disabled={Boolean(busy)}
                  key={action}
                  onClick={() => sendAction(action)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:border-emerald-400 hover:bg-emerald-950/25 disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={runArduinoDemo}
                type="button"
              >
                <Hand className="h-4 w-4" />
                演示模式
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={stopArduinoDemo}
                type="button"
              >
                <Square className="h-4 w-4" />
                停止演示
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:border-emerald-400 hover:bg-emerald-950/25 disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={runArduinoSong}
                type="button"
              >
                <Music className="h-4 w-4" />
                演奏
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={stopArduinoSong}
                type="button"
              >
                <Pause className="h-4 w-4" />
                停止演奏
              </button>
            </div>
            <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
              <input
                className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 font-mono outline-none focus:border-cyan-400"
                maxLength={6}
                onChange={(event) => setPattern(event.target.value.replace(/[^01]/g, "").slice(0, 6))}
                value={pattern}
              />
              <button
                className="inline-flex h-10 items-center gap-2 rounded-md bg-cyan-400 px-4 text-sm font-medium text-zinc-950 hover:bg-cyan-300 disabled:opacity-50"
                disabled={Boolean(busy) || pattern.length !== 6}
                onClick={() => sendPattern()}
                type="button"
              >
                <Send className="h-4 w-4" />
                发送
              </button>
            </div>
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">ORCA 17 舵机/关节测试</h2>
              <div className="flex gap-2">
                <button
                  className="h-9 rounded-md border border-zinc-700 px-3 text-sm hover:bg-zinc-900"
                  onClick={resetPose}
                  type="button"
                >
                  中位
                </button>
                <button
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-400 px-3 text-sm font-medium text-zinc-950 hover:bg-cyan-300 disabled:opacity-50"
                  disabled={Boolean(busy)}
                  onClick={sendPose}
                  type="button"
                >
                  <Send className="h-4 w-4" />
                  发送姿态
                </button>
              </div>
            </div>
            <div className="mt-3 grid max-h-[420px] gap-3 overflow-y-auto pr-1 md:grid-cols-2">
              {ORCA_JOINTS.map((joint) => (
                <label
                  className="grid gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm"
                  key={joint.id}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span>{joint.label}</span>
                    <span className="font-mono text-cyan-300">{pose[joint.id].toFixed(1)}</span>
                  </div>
                  <input
                    className="accent-cyan-400"
                    max={joint.max}
                    min={joint.min}
                    onChange={(event) =>
                      setPose((state) => ({ ...state, [joint.id]: Number(event.target.value) }))
                    }
                    step={0.5}
                    type="range"
                    value={pose[joint.id]}
                  />
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="relative min-h-[360px] overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
            {!cameraOn && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-500">
                <VideoOff className="h-8 w-8" />
                <div>摄像头未开启；导入切片后也会在这里回放骨架</div>
              </div>
            )}
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className={`h-full min-h-[360px] w-full scale-x-[-1] object-cover ${cameraOn ? "" : "opacity-0"}`}
            />
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full scale-x-[-1] object-cover"
            />
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="text-sm font-medium">手部运动切片</h2>
            <div className="mt-3 grid gap-2">
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={cameraOn ? stopCamera : startCamera}
                type="button"
              >
                {cameraOn ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
                {cameraOn ? "关闭摄像头" : "打开摄像头"}
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50"
                disabled={!cameraOn}
                onClick={recording ? stopRecording : startRecording}
                type="button"
              >
                {recording ? <Pause className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                {recording ? "停止录制" : "录制切片"}
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50"
                disabled={!sliceFrames.length}
                onClick={downloadSlice}
                type="button"
              >
                <Download className="h-4 w-4" />
                下载切片 JSON ({sliceFrames.length})
              </button>
              <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900">
                <Upload className="h-4 w-4" />
                导入切片
                <input
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) importSlice(file).catch((error) => setStatus(String(error)));
                  }}
                  type="file"
                />
              </label>
              <label className="flex h-10 items-center justify-between rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-300">
                回放时同步下发到机械手
                <input
                  checked={sendReplayToHand}
                  onChange={(event) => setSendReplayToHand(event.target.checked)}
                  type="checkbox"
                />
              </label>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-cyan-400 text-sm font-medium text-zinc-950 hover:bg-cyan-300 disabled:opacity-50"
                disabled={!importedFrames.length || Boolean(busy)}
                onClick={replaySlice}
                type="button"
              >
                <Play className="h-4 w-4" />
                回放切片 ({importedFrames.length})
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={refreshMotionHistory}
                type="button"
              >
                <History className="h-4 w-4" />
                读取最近动作
              </button>
              {motionHistory.length > 0 && (
                <div className="max-h-44 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-300">
                  {motionHistory.slice(-18).reverse().map((item, index) => (
                    <div
                      className="flex items-center justify-between gap-2 border-zinc-800 border-b py-1 last:border-b-0"
                      key={`${item.ts}-${index}`}
                    >
                      <span className="truncate">{item.source || "manual"}</span>
                      <span className="font-mono text-cyan-300">{item.pattern}</span>
                      <span className="text-zinc-500">
                        {item.note?.name || `${item.landmark_count || 0}点`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

"use client";

import {
  Download,
  ExternalLink,
  Hand,
  ImagePlus,
  Library,
  Mic,
  Music,
  Pause,
  RefreshCw,
  Settings,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/ui/select-menu";
import { AVAILABLE_MODELS } from "@/lib/availableModels";
import { getAllAvatarOptions, localizedAvatar } from "@/lib/availableAvatars";
import {
  generateDeviceBridgePairingCode,
  getLocalConnectorCommand,
  isPublicPageHost,
  testDeviceBridge,
} from "@/lib/deviceBridge";
import {
  getAvatarThumbnail,
  subscribeAvatarThumbnails,
} from "@/lib/avatarThumbnailCache";
import { subscribeGeneratedLive2DAvatars } from "@/lib/generatedLive2DAvatars";
import { refreshUserCharactersFromServer, subscribeUserCharacters } from "@/lib/userCharacters";
import { LANGUAGES, setLanguage, useT, useLanguage } from "@/lib/i18n";
import {
  checkHeadBridge,
  configureHeadBridge,
  playHeadTestTone,
  sendHeadAction,
  setHeadSpeakerVolume,
  startLocalHeadBridge,
  testHeadMicrophone,
} from "@/lib/headMotion";
import {
  checkHandGestureBridge,
  getHandGestureSnapshotUrl,
  listHandGesturePorts,
  sendHandGestureAction,
  startArduinoHandPlay,
  startHandGestureBridge,
  startLocalHandGestureBridge,
  stopArduinoHandPlay,
  stopHandGestureBridge,
  type HandGestureHealth,
  type HandGesturePort,
} from "@/lib/handGesture";
import {
  BACKGROUND_PRESETS,
  CAMERA_QUALITY_PRESETS,
  resolveBackgroundCss,
  type CameraQuality,
  type SubtitleRenderMode,
  useSettings,
  type VoiceLockMode,
} from "@/lib/settingsStore";

// Background preset id -> i18n key. Keep UI labels translated through i18n.
const BG_LABEL_KEY: Record<string, string> = {
  default: "settings.bg.default",
  dawn: "settings.bg.dawn",
  forest: "settings.bg.forest",
  ocean: "settings.bg.ocean",
  dusk: "settings.bg.dusk",
  night: "settings.bg.night",
  warm: "settings.bg.warm",
};

const LOCAL_CONNECTOR_PACKAGE_URL =
  "/downloads/AI-Lover-Local-Connector-2.0.4.zip";

interface SettingsDrawerProps {
  /** Optional callback when voice volume changes; useful for hooking into
   *  the live AudioPlayer via setVolume(). */
  onVoiceVolumeChange?: (volume: number) => void;
  /** Currently selected model id and setter, mirrored from toolbar. */
  modelId: string;
  onModelChange: (id: string) => void;
  /** Whether running; disables model switching mid-session. */
  modelLocked: boolean;
  /** Optional controlled open state used by the guided tour. */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}

export function SettingsDrawer({
  onVoiceVolumeChange,
  modelId,
  onModelChange,
  modelLocked,
  open: controlledOpen,
  onOpenChange,
}: SettingsDrawerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [settings, setSettings] = useSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const [headBusy, setHeadBusy] = useState<string | null>(null);
  const [headStatus, setHeadStatus] = useState<string>("");
  const [gestureBusy, setGestureBusy] = useState<string | null>(null);
  const [gestureStatus, setGestureStatus] = useState<string>("");
  const [gesturePorts, setGesturePorts] = useState<HandGesturePort[]>([]);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [connectorBusy, setConnectorBusy] = useState(false);
  const [connectorStatus, setConnectorStatus] = useState("");
  const headVolumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Push voice volume into AudioPlayer whenever it changes.
  useEffect(() => {
    onVoiceVolumeChange?.(settings.voiceVolume);
  }, [settings.voiceVolume, onVoiceVolumeChange]);

  useEffect(() => {
    return () => {
      if (headVolumeTimerRef.current) {
        clearTimeout(headVolumeTimerRef.current);
      }
    };
  }, []);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    // Reset the input value so picking the same file twice still fires onChange.
    input.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error(t("settings.upload.notImage"));
      return;
    }
    // Hard ceiling: anything over 20 MB is almost certainly a mistake
    // (RAW / PSD / etc.) and we'd rather fail fast than try to decode it.
    if (file.size > 20 * 1024 * 1024) {
      toast.error(t("settings.upload.tooLarge"));
      return;
    }

    try {
      const dataUrl = await compressImageToDataURL(file, 1920, 0.82);
      // Bypass the silent catch inside saveToStorage so a quota error
      // surfaces as a toast instead of "鐐逛簡娌″弽搴?.
      try {
        window.localStorage.setItem(
          "__xiaoling_quota_probe__",
          JSON.stringify({ b: dataUrl }),
        );
        window.localStorage.removeItem("__xiaoling_quota_probe__");
      } catch (err) {
        console.error("localStorage probe failed:", err);
        toast.error(t("settings.upload.quotaExceeded"), {
          description: t("settings.upload.quotaExceededDesc"),
        });
        return;
      }
      setSettings({ background: `custom:${dataUrl}` });
      toast.success(t("settings.upload.success"));
    } catch (err) {
      console.error("Background upload failed:", err);
      toast.error(t("settings.upload.failed"), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const updateHeadSetting = (patch: {
    robotHeadEndpoint?: string;
    robotHeadIp?: string;
    robotHeadMotionEnabled?: boolean;
    robotHeadEyeTrackingEnabled?: boolean;
    robotHeadEyeTrackingInvertX?: boolean;
    robotHeadEyeTrackingNeckFollow?: boolean;
    robotHeadSpeakerEnabled?: boolean;
    robotHeadVolume?: number;
    computerMicEnabled?: boolean;
    robotHeadMicEnabled?: boolean;
  }) => {
    setSettings(patch);
  };

  const updateHeadVolume = (volume: number) => {
    const next = Math.min(1, Math.max(0, volume));
    updateHeadSetting({ robotHeadVolume: next });
    if (headVolumeTimerRef.current) {
      clearTimeout(headVolumeTimerRef.current);
    }
    headVolumeTimerRef.current = setTimeout(() => {
      setHeadSpeakerVolume(next).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setHeadStatus(message);
      });
    }, 220);
  };

  const runHeadTask = async (name: string, task: () => Promise<string>) => {
    setHeadBusy(name);
    try {
      const message = await task();
      setHeadStatus(message);
      toast.success(message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHeadStatus(message);
      toast.error(message);
    } finally {
      setHeadBusy(null);
    }
  };

  const runGestureTask = async (name: string, task: () => Promise<string>) => {
    setGestureBusy(name);
    try {
      const message = await task();
      setGestureStatus(message);
      toast.success(message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setGestureStatus(message);
      toast.error(message);
    } finally {
      setGestureBusy(null);
    }
  };

  const refreshCameraDevices = async (requestPermission = false) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      toast.error("当前浏览器不支持摄像头设备列表");
      return;
    }
    setCameraBusy(true);
    let permissionStream: MediaStream | null = null;
    try {
      if (requestPermission) {
        permissionStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      setCameraDevices(cameras);
      if (!cameras.length) {
        toast.error("未找到摄像头");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("读取摄像头失败", { description: message });
    } finally {
      for (const track of permissionStream?.getTracks() ?? []) track.stop();
      setCameraBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refreshCameraDevices(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openSecondScreen = () => {
    const child = window.open(
      "/second-screen",
      "ai-lover-second-screen",
      "popup=yes,width=1280,height=720",
    );
    if (!child) {
      toast.error("浏览器拦截了第二屏窗口，请允许弹窗后再试");
      return;
    }
    child.focus();
  };

  const ensureConnectorPairingCode = () => {
    const code =
      settings.localConnectorPairingCode.trim() ||
      generateDeviceBridgePairingCode();
    setSettings({
      localConnectorEnabled: true,
      localConnectorPairingCode: code,
      localConnectorDeviceName:
        settings.localConnectorDeviceName || "AI-Lover Local Connector",
    });
    return code;
  };

  const runConnectorTest = async () => {
    setConnectorBusy(true);
    try {
      ensureConnectorPairingCode();
      const result = await testDeviceBridge();
      const headText = result.head
        ? `头部 ${result.head.ok ? "可用" : `异常(${result.head.status || result.head.error || "offline"})`}`
        : "头部未检测";
      const handText = result.hand
        ? `手部 ${result.hand.ok ? "可用" : `异常(${result.hand.status || result.hand.error || "offline"})`}`
        : "手部未检测";
      const gpuText = result.gpu
        ? `GPU 数字人 ${result.gpu.ok ? "可用" : `异常(${result.gpu.status || result.gpu.error || "offline"})`}`
        : "GPU 数字人未检测";
      const message = result.connected
        ? `Connector 在线，${headText}，${handText}，${gpuText}`
        : result.error || "Connector 未连接";
      setConnectorStatus(message);
      if (result.connected) toast.success(message);
      else toast.error(message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConnectorStatus(message);
      toast.error(message);
    } finally {
      setConnectorBusy(false);
    }
  };

  const publicPageHost = isPublicPageHost();
  const connectorCommand = getLocalConnectorCommand();

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title={t("settings.title")}
        className="h-9 w-9"
        data-tour="settings"
      >
        <Settings className="h-4 w-4" />
      </Button>

      {/* Backdrop */}
      {open && (
        <button
          type="button"
          aria-label={t("settings.title")}
          className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Drawer */}
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-border/40 border-l bg-background shadow-2xl transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="flex shrink-0 items-center justify-between border-border/40 border-b px-4 py-3">
          <h2 className="font-semibold text-base">{t("settings.title")}</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOpen(false)}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {/* Language first, so users who land on an unfamiliar locale
              can switch out without hunting through other sections. */}
          <section className="space-y-2">
            <h3 className="font-medium text-foreground text-sm">
              {t("settings.language")}
            </h3>
            <div className="flex gap-2">
              {LANGUAGES.map((l) => {
                const selected = settings.language === l.value;
                return (
                  <button
                    type="button"
                    key={l.value}
                    onClick={() => setLanguage(l.value)}
                    className={`flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/40 hover:border-border"
                    }`}
                  >
                    {l.label}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Model */}
          <section className="space-y-2" data-tour="model">
            <h3 className="font-medium text-foreground text-sm">
              {t("settings.model")}
            </h3>
            <SelectMenu
              value={modelId}
              onValueChange={onModelChange}
              disabled={modelLocked}
              options={AVAILABLE_MODELS.map((m) => ({
                value: m.id,
                label: m.label,
                group: m.vendor,
              }))}
            />
            {modelLocked && (
              <p className="text-muted-foreground text-xs">
                {t("settings.modelLockedHint")}
              </p>
            )}
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="font-medium text-foreground text-sm">显示模式</h3>
              <p className="mt-1 text-muted-foreground text-xs">
                会话停止后切换生效。
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={modelLocked}
                onClick={() => setSettings({ avatarRendererMode: "live2d" })}
                className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                  settings.avatarRendererMode === "live2d"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/40 hover:border-border"
                }${modelLocked ? " cursor-not-allowed opacity-60" : ""}`}
              >
                Live2D / CPU
              </button>
              <button
                type="button"
                disabled={modelLocked}
                onClick={() => setSettings({ avatarRendererMode: "gpu" })}
                className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                  settings.avatarRendererMode === "gpu"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/40 hover:border-border"
                }${modelLocked ? " cursor-not-allowed opacity-60" : ""}`}
              >
                GPU 数字人
              </button>
            </div>
            {settings.avatarRendererMode === "gpu" && (
              <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-2">
                <p className="text-muted-foreground text-xs">
                  默认 127.0.0.1:8810 会由本机程序自动启动预览 worker；如果有局域网
                  4090/SoulX/MuseTalk 服务，可填它的 http 地址。云端访问时请先启用
                  Local Connector。
                </p>
                <label className="space-y-1">
                  <span className="text-muted-foreground text-xs">GPU worker</span>
                  <input
                    value={settings.gpuAvatarEndpoint}
                    onChange={(event) =>
                      setSettings({ gpuAvatarEndpoint: event.target.value })
                    }
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-muted-foreground text-xs">Avatar ID</span>
                  <input
                    value={settings.gpuAvatarId}
                    onChange={(event) =>
                      setSettings({ gpuAvatarId: event.target.value || "default" })
                    }
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </label>
              </div>
            )}
          </section>

          <section className="space-y-3" data-tour="camera">
            <div>
              <h3 className="font-medium text-foreground text-sm">
                摄像头 / 第二屏
              </h3>
              <p className="mt-1 text-muted-foreground text-xs">
                主页面和第二屏可以使用不同摄像头。第二屏只有打开新网页时才会启用高清摄像头。
              </p>
            </div>

            <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">
                  主页面摄像头
                </span>
                <select
                  value={settings.cameraDeviceId}
                  onChange={(event) =>
                    setSettings({ cameraDeviceId: event.target.value })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">自动选择（浏览器默认）</option>
                  {cameraDevices.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `摄像头 ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(CAMERA_QUALITY_PRESETS) as CameraQuality[]).map(
                  (quality) => {
                    const selected = settings.cameraQuality === quality;
                    const preset = CAMERA_QUALITY_PRESETS[quality];
                    return (
                      <button
                        type="button"
                        key={quality}
                        onClick={() => setSettings({ cameraQuality: quality })}
                        className={`rounded-md border px-2 py-2 text-xs transition-colors ${
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border/40 hover:border-border"
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  },
                )}
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">
                  第二屏摄像头
                </span>
                <select
                  value={settings.stageCameraDeviceId}
                  onChange={(event) =>
                    setSettings({ stageCameraDeviceId: event.target.value })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">自动选择（浏览器默认）</option>
                  {cameraDevices.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `摄像头 ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(CAMERA_QUALITY_PRESETS) as CameraQuality[]).map(
                  (quality) => {
                    const selected = settings.stageCameraQuality === quality;
                    const preset = CAMERA_QUALITY_PRESETS[quality];
                    return (
                      <button
                        type="button"
                        key={quality}
                        onClick={() =>
                          setSettings({ stageCameraQuality: quality })
                        }
                        className={`rounded-md border px-2 py-2 text-xs transition-colors ${
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border/40 hover:border-border"
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  },
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cameraBusy}
                className="gap-2"
                onClick={() => refreshCameraDevices(true)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                刷新摄像头
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={openSecondScreen}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                打开第二屏
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              PC 端建议把第二屏窗口拖到另一块显示器后全屏。不要再开一个主控首页，以免重复占用麦克风和硬件控制。
            </p>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="font-medium text-foreground text-sm">
                连接本地设备向导
              </h3>
              <p className="mt-1 text-muted-foreground text-xs">
                {publicPageHost
                  ? "云端网页不能直接访问客户内网的头和手。请在客户电脑运行 AI-Lover Local Connector，再用同一个配对码连接。"
                  : "本机或内网页面可以直接连接 127.0.0.1；如果你要测试云端访问本地设备，也可以打开 Connector 模式。"}
              </p>
            </div>

            <HeadToggle
              label="启用云端 Local Connector"
              checked={settings.localConnectorEnabled}
              onChange={(checked) =>
                setSettings({
                  localConnectorEnabled: checked,
                  localConnectorPairingCode: checked
                    ? settings.localConnectorPairingCode ||
                      generateDeviceBridgePairingCode()
                    : settings.localConnectorPairingCode,
                })
              }
            />

            <div className="grid grid-cols-[1fr_auto] gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">配对码</span>
                <input
                  value={settings.localConnectorPairingCode}
                  placeholder="例如 A7K9P"
                  onChange={(event) =>
                    setSettings({
                      localConnectorPairingCode: event.target.value
                        .trim()
                        .toUpperCase(),
                    })
                  }
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-6"
                onClick={() =>
                  setSettings({
                    localConnectorEnabled: true,
                    localConnectorPairingCode:
                      generateDeviceBridgePairingCode(),
                  })
                }
              >
                生成
              </Button>
            </div>

            <label className="space-y-1">
              <span className="text-muted-foreground text-xs">本地设备名称</span>
              <input
                value={settings.localConnectorDeviceName}
                placeholder="例如 展厅电脑 / 客户A"
                onChange={(event) =>
                  setSettings({ localConnectorDeviceName: event.target.value })
                }
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>

            <label className="space-y-1">
              <span className="text-muted-foreground text-xs">
                云端桥地址，可留空
              </span>
              <input
                value={settings.localConnectorBridgeUrl}
                placeholder="留空表示当前网站 /device-bridge"
                onChange={(event) =>
                  setSettings({ localConnectorBridgeUrl: event.target.value })
                }
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>

            <div className="rounded-md border border-border/40 bg-muted/20 p-2">
              <div className="mb-2 rounded-md border border-primary/30 bg-primary/10 p-2">
                <p className="text-foreground text-xs">
                  第一次连接云端网页和本地头/手时，请先在客户电脑下载并运行
                  Local Connector。
                </p>
                <a
                  href={LOCAL_CONNECTOR_PACKAGE_URL}
                  download
                  className="mt-2 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-xs transition-opacity hover:opacity-90"
                >
                  <Download className="h-3.5 w-3.5" />
                  下载 Local Connector
                </a>
              </div>
              <p className="text-muted-foreground text-xs">
                Connector 启动命令：
              </p>
              <code className="mt-1 block break-all rounded bg-background/70 px-2 py-1 text-[11px] text-foreground">
                {connectorCommand}
              </code>
              <a
                className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-primary text-xs transition-colors hover:bg-primary/20"
                href="/local-control"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                打开本地离线控制台
              </a>
              <p className="mt-2 text-muted-foreground text-xs">
                Windows/macOS 包会把这个命令包装成一键启动；现在调试时可以先在项目根目录运行。
              </p>
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={connectorBusy}
              className="w-full gap-2"
              onClick={runConnectorTest}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              检测 Local Connector
            </Button>

            {connectorStatus && (
              <p className="rounded-md bg-muted/40 px-2 py-1 text-muted-foreground text-xs">
                {connectorStatus}
              </p>
            )}
          </section>

          {/* Voice volume */}
          <section className="space-y-2">
            <h3 className="font-medium text-foreground text-sm">
              {t("settings.volume")}
            </h3>
            <div className="flex items-center gap-3">
              {settings.voiceVolume <= 0.01 ? (
                <VolumeX className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Volume2 className="h-4 w-4 text-muted-foreground" />
              )}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={settings.voiceVolume}
                onChange={(e) =>
                  setSettings({ voiceVolume: Number(e.target.value) })
                }
                className="flex-1 accent-primary"
              />
              <span className="w-10 text-right text-muted-foreground text-xs tabular-nums">
                {Math.round(settings.voiceVolume * 100)}%
              </span>
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="font-medium text-foreground text-sm">字幕</h3>
              <p className="mt-1 text-muted-foreground text-xs">
                先使用本地转写和回复文本渲染；接入 TEN/声网 word-level 事件后会自动贴近语音时间轴。
              </p>
            </div>
            <HeadToggle
              label="显示字幕"
              checked={settings.subtitlesEnabled}
              onChange={(checked) =>
                setSettings({ subtitlesEnabled: checked })
              }
            />
            <div className="grid grid-cols-3 gap-2">
              {[
                { mode: "word" as SubtitleRenderMode, label: "Word 模式" },
                {
                  mode: "text_sync" as SubtitleRenderMode,
                  label: "Text 同步",
                },
                {
                  mode: "text_once" as SubtitleRenderMode,
                  label: "Text 先出",
                },
              ].map((item) => {
                const selected = settings.subtitleRenderMode === item.mode;
                return (
                  <button
                    type="button"
                    key={item.mode}
                    onClick={() =>
                      setSettings({ subtitleRenderMode: item.mode })
                    }
                    className={`rounded-md border px-2 py-2 text-sm transition-colors ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/40 hover:border-border"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="font-medium text-foreground text-sm">声纹锁定</h3>
              <p className="mt-1 text-muted-foreground text-xs">
                先随音频帧上报模式和用户 ID；后端接入 TEN diarization 或本地声纹 worker 后执行过滤。
              </p>
            </div>
            <div className="space-y-2">
              {[
                {
                  mode: "off" as VoiceLockMode,
                  label: "关闭",
                  desc: "不限制说话人，适合公开演示。",
                },
                {
                  mode: "auto_learning" as VoiceLockMode,
                  label: "无感模式",
                  desc: "自动学习当前用户声音，后端可屏蔽其他人的声音。",
                },
                {
                  mode: "manual" as VoiceLockMode,
                  label: "有感模式",
                  desc: "先录入一段声纹，再只响应已锁定用户。",
                },
              ].map((item) => {
                const selected = settings.voiceLockMode === item.mode;
                return (
                  <button
                    type="button"
                    key={item.mode}
                    onClick={() => setSettings({ voiceLockMode: item.mode })}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border/40 hover:border-border"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm">{item.label}</span>
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          selected ? "bg-primary" : "bg-muted-foreground/40"
                        }`}
                      />
                    </span>
                    <span className="mt-1 block text-muted-foreground text-xs">
                      {item.desc}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-2">
              <HeadToggle
                label="TEN 说话人分离"
                checked={settings.speakerDiarizationEnabled}
                onChange={(checked) =>
                  setSettings({ speakerDiarizationEnabled: checked })
                }
              />
              <HeadToggle
                label="说话人转头/眼睛跟随"
                checked={settings.speakerFocusHeadEnabled}
                onChange={(checked) =>
                  setSettings({ speakerFocusHeadEnabled: checked })
                }
              />
              <HeadToggle
                label="没有方向时按座位模拟"
                checked={settings.speakerFocusFallbackSeatsEnabled}
                onChange={(checked) =>
                  setSettings({ speakerFocusFallbackSeatsEnabled: checked })
                }
              />
              <label className="block space-y-1">
                <span className="flex items-center justify-between text-muted-foreground text-xs">
                  <span>头部最大转向</span>
                  <span>{settings.speakerFocusMaxHeadAngle}°</span>
                </span>
                <input
                  type="range"
                  min={4}
                  max={32}
                  step={1}
                  value={settings.speakerFocusMaxHeadAngle}
                  onChange={(event) =>
                    setSettings({
                      speakerFocusMaxHeadAngle: Number(event.target.value),
                    })
                  }
                  className="w-full accent-primary"
                />
              </label>
              <label className="block space-y-1">
                <span className="flex items-center justify-between text-muted-foreground text-xs">
                  <span>眼睛先看幅度</span>
                  <span>{settings.speakerFocusMaxEyeAngle}°</span>
                </span>
                <input
                  type="range"
                  min={4}
                  max={18}
                  step={1}
                  value={settings.speakerFocusMaxEyeAngle}
                  onChange={(event) =>
                    setSettings({
                      speakerFocusMaxEyeAngle: Number(event.target.value),
                    })
                  }
                  className="w-full accent-primary"
                />
              </label>
              <p className="text-muted-foreground text-xs">
                TEN 分离需要 SPEECHMATICS_API_KEY。没有真实方位角时，系统会把 S1/S2/S3
                固定到几个座位方向；接入麦克风阵列后可直接使用 speaker_angle。
              </p>
            </div>
          </section>

          {/* Robot head */}
          <section className="space-y-3" data-tour="head">
            <div>
              <h3 className="font-medium text-foreground text-sm">
                {t("settings.head.title")}
              </h3>
              <p className="mt-1 text-muted-foreground text-xs">
                {t("settings.head.hint")}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">
                  {t("settings.head.ip")}
                </span>
                <input
                  value={settings.robotHeadIp}
                  onChange={(e) =>
                    updateHeadSetting({ robotHeadIp: e.target.value })
                  }
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">
                  {t("settings.head.endpoint")}
                </span>
                <input
                  value={settings.robotHeadEndpoint}
                  onChange={(e) =>
                    updateHeadSetting({ robotHeadEndpoint: e.target.value })
                  }
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </label>
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(headBusy)}
              className="w-full gap-2"
              onClick={() =>
                runHeadTask("startBridge", async () => {
                  const result = await startLocalHeadBridge(
                    settings.robotHeadIp,
                    true,
                  );
                  updateHeadSetting({ robotHeadEndpoint: result.endpoint });
                  return `头部桥接已${result.started ? "启动" : "连接"}：${result.endpoint} / ${result.head_ip}`;
                })
              }
            >
              <RefreshCw className="h-3.5 w-3.5" />
              启动/重连头部桥接
            </Button>

            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(headBusy)}
                className="gap-1"
                onClick={() =>
                  runHeadTask("detect", async () => {
                    await configureHeadBridge(settings.robotHeadIp);
                    const health = await checkHeadBridge();
                    if (!health.ok) throw new Error(health.error || "检测失败");
                    return t("settings.head.detectOk");
                  })
                }
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("settings.head.detect")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(headBusy)}
                className="gap-1"
                onClick={() =>
                  runHeadTask("reset", async () => {
                    await sendHeadAction("init", { source: "settings" });
                    return t("settings.head.resetOk");
                  })
                }
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("settings.head.reset")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(headBusy)}
                className="gap-1"
                onClick={() =>
                  runHeadTask("speaker", async () => {
                    await playHeadTestTone();
                    return t("settings.head.speakerOk");
                  })
                }
              >
                <Volume2 className="h-3.5 w-3.5" />
                {t("settings.head.testSpeaker")}
              </Button>
            </div>

            <div className="space-y-1 rounded-md border border-border/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-foreground">
                  {t("settings.head.volume")}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {Math.round(settings.robotHeadVolume * 100)}%
                </span>
              </div>
              <div className="flex items-center gap-3">
                {settings.robotHeadVolume <= 0.01 ? (
                  <VolumeX className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Volume2 className="h-4 w-4 text-muted-foreground" />
                )}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.robotHeadVolume}
                  onChange={(e) => updateHeadVolume(Number(e.target.value))}
                  className="flex-1 accent-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <HeadToggle
                label={t("settings.head.motion")}
                checked={settings.robotHeadMotionEnabled}
                onChange={(checked) =>
                  updateHeadSetting({ robotHeadMotionEnabled: checked })
                }
              />
              <HeadToggle
                label="眼球追踪外部摄像头中的人脸"
                checked={settings.robotHeadEyeTrackingEnabled}
                onChange={(checked) =>
                  updateHeadSetting({ robotHeadEyeTrackingEnabled: checked })
                }
              />
              <HeadToggle
                label="眼球追踪反向"
                checked={settings.robotHeadEyeTrackingInvertX}
                onChange={(checked) =>
                  updateHeadSetting({ robotHeadEyeTrackingInvertX: checked })
                }
              />
              <HeadToggle
                label="脖子跟随大幅度方向"
                checked={settings.robotHeadEyeTrackingNeckFollow}
                onChange={(checked) =>
                  updateHeadSetting({ robotHeadEyeTrackingNeckFollow: checked })
                }
              />
              <HeadToggle
                label={t("settings.head.speaker")}
                checked={settings.robotHeadSpeakerEnabled}
                onChange={(checked) =>
                  updateHeadSetting({ robotHeadSpeakerEnabled: checked })
                }
              />
              <HeadToggle
                label={t("settings.head.computerMic")}
                checked={settings.computerMicEnabled}
                onChange={(checked) =>
                  updateHeadSetting({ computerMicEnabled: checked })
                }
              />
              <HeadToggle
                label={t("settings.head.mic")}
                checked={settings.robotHeadMicEnabled}
                onChange={(checked) =>
                  updateHeadSetting({ robotHeadMicEnabled: checked })
                }
              />
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(headBusy)}
              className="w-full gap-2"
              onClick={() =>
                runHeadTask("mic", async () => {
                  const result = await testHeadMicrophone(2000, true);
                  if (!result.chunk.bytes) throw new Error("没有采集到音频");
                  return `${t("settings.head.micOk")} ${Math.round(
                    result.chunk.bytes / 1024,
                  )}KB / ${t("settings.head.micLevel")} ${
                    result.levelPercent
                  }%`;
                })
              }
            >
              <Mic className="h-3.5 w-3.5" />
              {t("settings.head.testMic")}
            </Button>

            {headStatus && (
              <p className="rounded-md bg-muted/40 px-2 py-1 text-muted-foreground text-xs">
                {headStatus}
              </p>
            )}
          </section>

          {/* Gesture / robot arm */}
          <section className="space-y-3" data-tour="hand">
            <div>
              <h3 className="font-medium text-foreground text-sm">
                手势识别 / 机械手臂
              </h3>
              <p className="mt-1 text-muted-foreground text-xs">
                用摄像头识别手势，把六位手指状态下发给 Arduino；OrcaHand 可在本机依赖安装完成后开启。
              </p>
            </div>

            <label className="space-y-1">
              <span className="text-muted-foreground text-xs">Bridge endpoint</span>
              <input
                value={settings.handGestureEndpoint}
                onChange={(event) =>
                  setSettings({ handGestureEndpoint: event.target.value })
                }
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(gestureBusy)}
              className="w-full gap-2"
              onClick={() =>
                runGestureTask("startBridge", async () => {
                  const result = await startLocalHandGestureBridge(
                    {
                      camera_index: settings.handGestureCameraIndex,
                      arduino_ports: parsePortList(settings.handGestureArduinoPorts),
                      baud: settings.handGestureBaud,
                      dry_run: settings.handGestureDryRun,
                      arduino_enabled: settings.handGestureArduinoEnabled,
                      send_interval_ms: settings.handGestureSendIntervalMs,
                      orca_enabled: settings.handGestureOrcaEnabled,
                      orca_port: settings.handGestureOrcaPort,
                      orca_direct_joint_enabled: settings.handGestureOrcaDirectJointEnabled,
                      orca_wrist_follow_enabled: settings.handGestureOrcaWristFollowEnabled,
                    },
                    true,
                  );
                  setSettings({ handGestureEndpoint: result.endpoint });
                  const health = result.config || result.health;
                  if (!result.ok || health?.ok === false) {
                    throw new Error(result.error || health?.error || "Gesture bridge unavailable");
                  }
                  return `机械手 bridge 已${result.started ? "启动" : "连接"}：${result.endpoint}`;
                })
              }
            >
              <RefreshCw className="h-3.5 w-3.5" />
              启动/重连机械手 bridge
            </Button>

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">摄像头编号</span>
                <input
                  type="number"
                  min={0}
                  value={settings.handGestureCameraIndex}
                  onChange={(event) =>
                    setSettings({
                      handGestureCameraIndex: Number(event.target.value) || 0,
                    })
                  }
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">Baud</span>
                <input
                  type="number"
                  min={1200}
                  value={settings.handGestureBaud}
                  onChange={(event) =>
                    setSettings({
                      handGestureBaud: Number(event.target.value) || 9600,
                    })
                  }
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">识别间隔 ms</span>
                <input
                  type="number"
                  min={50}
                  max={1000}
                  value={settings.handGestureRecognitionIntervalMs}
                  onChange={(event) =>
                    setSettings({
                      handGestureRecognitionIntervalMs:
                        Number(event.target.value) || 90,
                    })
                  }
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">发送间隔 ms</span>
                <input
                  type="number"
                  min={50}
                  max={1000}
                  value={settings.handGestureSendIntervalMs}
                  onChange={(event) =>
                    setSettings({
                      handGestureSendIntervalMs: Number(event.target.value) || 120,
                    })
                  }
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </label>
            </div>

            <label className="space-y-1">
              <span className="text-muted-foreground text-xs">
                Arduino 串口，多个用逗号分隔
              </span>
              <input
                value={settings.handGestureArduinoPorts}
                placeholder="COM5,COM6"
                onChange={(event) =>
                  setSettings({ handGestureArduinoPorts: event.target.value })
                }
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>

            <label className="space-y-1">
              <span className="text-muted-foreground text-xs">
                ORCA / Dynamixel port (optional)
              </span>
              <input
                value={settings.handGestureOrcaPort}
                placeholder="COM6"
                onChange={(event) =>
                  setSettings({ handGestureOrcaPort: event.target.value.trim() })
                }
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>

            {gesturePorts.length > 0 && (
              <div className="rounded-md border border-border/40 bg-muted/20 px-2 py-1.5 text-muted-foreground text-xs">
                可用串口：
                {gesturePorts
                  .map((port) => `${port.device}${port.description ? ` (${port.description})` : ""}`)
                  .join("；")}
              </div>
            )}

            <div className="grid grid-cols-1 gap-2">
              <HeadToggle
                label="启用手势识别"
                checked={settings.handGestureEnabled}
                onChange={(checked) =>
                  setSettings({ handGestureEnabled: checked })
                }
              />
              <HeadToggle
                label="启用比心粒子特效"
                checked={settings.handGestureParticleEffectsEnabled}
                onChange={(checked) =>
                  setSettings({ handGestureParticleEffectsEnabled: checked })
                }
              />
              <HeadToggle
                label="Dry-run 调试，不打开机械手串口"
                checked={settings.handGestureDryRun}
                onChange={(checked) =>
                  setSettings({ handGestureDryRun: checked })
                }
              />
              <HeadToggle
                label="启用 Arduino 六位手指串口输出"
                checked={settings.handGestureArduinoEnabled}
                onChange={(checked) =>
                  setSettings({ handGestureArduinoEnabled: checked })
                }
              />
              <HeadToggle
                label="启用 OrcaHand / Dynamixel 映射"
                checked={settings.handGestureOrcaEnabled}
                onChange={(checked) =>
                  setSettings({ handGestureOrcaEnabled: checked })
                }
              />
              <HeadToggle
                label="ORCA 17关节连续跟随"
                checked={settings.handGestureOrcaDirectJointEnabled}
                onChange={(checked) =>
                  setSettings({ handGestureOrcaDirectJointEnabled: checked })
                }
              />
              <HeadToggle
                label="ORCA 手腕跟随真人手腕"
                checked={settings.handGestureOrcaWristFollowEnabled}
                onChange={(checked) =>
                  setSettings({ handGestureOrcaWristFollowEnabled: checked })
                }
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(gestureBusy)}
                className="gap-1"
                onClick={() =>
                  runGestureTask("detect", async () => {
                    const [health, ports] = await Promise.all([
                      checkHandGestureBridge(),
                      listHandGesturePorts(),
                    ]);
                    setGesturePorts(ports);
                    return summarizeGestureHealth(health);
                  })
                }
              >
                <RefreshCw className="h-3.5 w-3.5" />
                检测
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(gestureBusy)}
                className="gap-1"
                onClick={() =>
                  runGestureTask("start", async () => {
                    const health = await startHandGestureBridge({
                      camera_index: settings.handGestureCameraIndex,
                      arduino_ports: parsePortList(settings.handGestureArduinoPorts),
                      baud: settings.handGestureBaud,
                      dry_run: settings.handGestureDryRun,
                      arduino_enabled: settings.handGestureArduinoEnabled,
                      send_interval_ms: settings.handGestureSendIntervalMs,
                      orca_enabled: settings.handGestureOrcaEnabled,
                      orca_port: settings.handGestureOrcaPort,
                      orca_direct_joint_enabled: settings.handGestureOrcaDirectJointEnabled,
                      orca_wrist_follow_enabled: settings.handGestureOrcaWristFollowEnabled,
                    });
                    setSettings({ handGestureEnabled: true });
                    return summarizeGestureHealth(health);
                  })
                }
              >
                <Hand className="h-3.5 w-3.5" />
                启动
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(gestureBusy)}
                className="gap-1"
                onClick={() =>
                  runGestureTask("stop", async () => {
                    const health = await stopHandGestureBridge();
                    setSettings({ handGestureEnabled: false });
                    return summarizeGestureHealth(health);
                  })
                }
              >
                <X className="h-3.5 w-3.5" />
                停止
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                ["open", "张开"],
                ["fist", "握拳"],
                ["point", "食指"],
              ].map(([action, label]) => (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={Boolean(gestureBusy)}
                  onClick={() =>
                    runGestureTask(action, async () => {
                      const result = await sendHandGestureAction(action);
                      return `已发送 ${label}：${result.pattern}${
                        handDeliverySuffix(result)
                      }`;
                    })
                  }
                >
                  {label}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(gestureBusy)}
                className="gap-1"
                onClick={() =>
                  runGestureTask("arduino-play", async () => {
                    await startArduinoHandPlay();
                    return "演奏模式已启动：手指对应宫商角徵羽，并播放《沧海一声笑》";
                  })
                }
              >
                <Music className="h-3.5 w-3.5" />
                演奏模式
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(gestureBusy)}
                className="gap-1"
                onClick={() =>
                  runGestureTask("arduino-play-stop", async () => {
                    await stopArduinoHandPlay();
                    return "演奏模式已停止";
                  })
                }
              >
                <Pause className="h-3.5 w-3.5" />
                停止演奏
              </Button>
            </div>

            <a
              className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              href="/hand-control"
              target="_blank"
              rel="noreferrer"
            >
              <span className="inline-flex items-center gap-2 text-foreground">
                <ExternalLink className="h-4 w-4" />
                打开机械手测试台
              </span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </a>

            <a
              className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              href={getHandGestureSnapshotUrl()}
              target="_blank"
              rel="noreferrer"
            >
              <span className="inline-flex items-center gap-2 text-foreground">
                <ExternalLink className="h-4 w-4" />
                打开手势摄像头快照
              </span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </a>

            {gestureStatus && (
              <p className="rounded-md bg-muted/40 px-2 py-1 text-muted-foreground text-xs">
                {gestureStatus}
              </p>
            )}
          </section>

          {/* Background */}
          <section className="space-y-2" data-tour="bg">
            <h3 className="font-medium text-foreground text-sm">
              {t("settings.background")}
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {BACKGROUND_PRESETS.map((p) => {
                const selected = settings.background === p.id;
                const label = BG_LABEL_KEY[p.id]
                  ? t(BG_LABEL_KEY[p.id])
                  : p.label;
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => setSettings({ background: p.id })}
                    className={`relative h-16 overflow-hidden rounded-md border transition-all ${
                      selected
                        ? "border-primary ring-2 ring-primary/40"
                        : "border-border/40 hover:border-border"
                    }`}
                    style={{ background: resolveBackgroundCss(p.id) }}
                    title={label}
                  >
                    <span className="absolute inset-x-0 bottom-0 bg-black/40 px-1 py-0.5 text-center text-white text-xs">
                      {label}
                    </span>
                  </button>
                );
              })}
              {/* Custom upload showing current uploaded image as preview */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`relative h-16 overflow-hidden rounded-md border-2 border-dashed transition-all ${
                  settings.background.startsWith("custom:")
                    ? "border-primary ring-2 ring-primary/40"
                    : "border-border/40 hover:border-border"
                }`}
                style={
                  settings.background.startsWith("custom:")
                    ? { background: resolveBackgroundCss(settings.background) }
                    : undefined
                }
                title={t("settings.backgroundCustom")}
              >
                <Upload className="absolute inset-0 m-auto h-4 w-4 text-muted-foreground" />
                <span className="absolute inset-x-0 bottom-0 bg-black/40 px-1 py-0.5 text-center text-white text-xs">
                  {t("settings.backgroundCustom")}
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={handleUpload}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              {t("settings.backgroundUploadHint")}
            </p>
          </section>

          {/* Avatar placeholder for M3.2 */}
          <section className="space-y-2" data-tour="char">
            <h3 className="font-medium text-foreground text-sm">
              {t("settings.character")}
            </h3>
            <AvatarCardGrid
              value={settings.selectedAvatar}
              onValueChange={(v) => setSettings({ selectedAvatar: v })}
              disabled={modelLocked}
            />
            {modelLocked ? (
              <p className="text-muted-foreground text-xs">
                {t("settings.characterLockedHint")}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t("settings.characterHint")}
              </p>
            )}
            <p className="text-muted-foreground/80 text-xs">
              {t("settings.characterThumbnailHint")}
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-medium text-foreground text-sm">{"Live2D \u5de5\u5177"}</h3>
            <a
              className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              href="/characters"
              target="_blank"
              rel="noreferrer"
            >
              <span className="inline-flex items-center gap-2 text-foreground">
                <Library className="h-4 w-4" />
                {"Character Manager"}
              </span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </a>
            <a
              className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              href="/live2d-generate"
              target="_blank"
              rel="noreferrer"
            >
              <span className="inline-flex items-center gap-2 text-foreground">
                <ImagePlus className="h-4 w-4" />
                {"\u751f\u6210 Live2D \u5f62\u8c61"}
              </span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </a>
            <a
              className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              href="/photo-avatar-test"
              target="_blank"
              rel="noreferrer"
            >
              <span className="inline-flex items-center gap-2 text-foreground">
                <ImagePlus className="h-4 w-4" />
                {"\u5355\u5f20\u7167\u7247\u8bf4\u8bdd\u6d4b\u8bd5"}
              </span>
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </a>
          </section>

          {/* Desktop app download (V0.1 preview) */}
          <DesktopDownloadSection />
        </div>

        <div className="shrink-0 border-border/40 border-t px-4 py-3 text-muted-foreground text-xs">
          {t("settings.footer")}
        </div>
      </aside>
    </>
  );
}

/**
 * Downsize and re-encode an image so a 4K phone photo doesn't blow past
 * localStorage's ~5 MB quota. Caps the longest edge at `maxEdge` and emits
 * JPEG (or PNG for transparency-bearing PNGs). Returns a data URL ready
 * to drop into a `background-image: url(...)` CSS value.
 *
 * Why JPEG over PNG: a 1920x1080 photo as PNG is ~3-4 MB even when
 * downsized; same image as JPEG q=0.82 is ~250-400 KB. localStorage
 * stores strings, so dataURL bytes count double after base64; every KB
 * matters.
 */
async function compressImageToDataURL(
  file: File,
  maxEdge: number,
  quality: number,
): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(async () => {
    // Fallback for browsers without createImageBitmap on File:
    // route through an <img> + objectURL.
    return await new Promise<ImageBitmap | HTMLImageElement>((res, rej) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        res(img);
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        rej(e);
      };
      img.src = url;
    });
  });
  const srcW = (bitmap as any).width;
  const srcH = (bitmap as any).height;
  const ratio = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.round(srcW * ratio);
  const h = Math.round(srcH * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.drawImage(bitmap as any, 0, 0, w, h);
  // PNGs with alpha 鈫?keep PNG; everything else 鈫?JPEG.
  const outType =
    file.type === "image/png" ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(outType, quality);
  if ((bitmap as any).close) (bitmap as any).close();
  return dataUrl;
}

function parsePortList(value: string): string[] {
  return value
    .replace(/[;\uff1b\uff0c\s]+/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function describeGesturePort(port: HandGesturePort): string {
  const text = `${port.device} ${port.description || ""} ${port.hwid || ""}`.toLowerCase();
  if (/arduino|ch34[0-9]|wch|usb-enhanced-serial|usb-enhanced serial|usb-serial|usb serial|cp210|ftdi/.test(text)) {
    return `${port.device}=可能是 Arduino 手`;
  }
  if (/dynamixel|usb2dynamixel|orca|u2d2|robotis/.test(text)) {
    return `${port.device}=可能是 ORCA / Dynamixel`;
  }
  return `${port.device}=未知设备`;
}

function handDeliverySuffix(result: { dry_run?: boolean; delivered?: boolean }): string {
  if (result.dry_run) return " (dry-run)";
  if (result.delivered === false) return " (未下发硬件)";
  return "";
}

function summarizeGestureHealth(health: HandGestureHealth): string {
  const missing = Object.entries(health.dependencies || {})
    .filter(([, dep]) => !dep.ok && !dep.optional)
    .map(([name]) => name);
  const mode = health.running ? "识别运行中" : "服务在线，识别未启动";
  const pattern = health.last_pattern ? `，手势 ${health.last_pattern}` : "";
  const detected = health.detected
    ? `，已识别手 ${health.landmark_count ?? 0} 点`
    : "，未识别到手";
  const camera = health.config?.camera_index ?? 0;
  const fps = health.fps ? `，${health.fps} FPS` : "";
  const stage = health.stage ? `，${health.stage}` : "";
  const dryRun = health.config?.dry_run ? "，dry-run" : "";
  const orca = health.orca?.requested_enabled || health.config?.orca_enabled
    ? `, ORCA ${health.orca?.mode || health.orca?.status || "idle"}${health.orca?.last_joint_count ? `/${health.orca.last_joint_count} joints` : ""}`
    : "";
  const portText = health.serial_ports?.length
    ? `；串口提示：${health.serial_ports.map(describeGesturePort).join("，")}`
    : "";
  const missingText = missing.length
    ? `；缺少依赖：${missing.join(", ")}`
    : "";
  return `机械手 bridge ${mode}，摄像头 ${camera}${pattern}${detected}${fps}${stage}${dryRun}${orca}${portText}${missingText}`;
}

/**
 * Desktop app download card (V0.1 preview, macOS Apple Silicon only for now).
 * Detects platform via userAgent and shows the right CTA. Hidden inside the
 * Tauri shell itself (no point downloading the desktop app from the desktop
 * app).
 */
function DesktopDownloadSection() {
  const [platform, setPlatform] = useState<"mac" | "win" | "other">("other");
  const [isTauri, setIsTauri] = useState(false);
  const t = useT();

  useEffect(() => {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (/Mac/i.test(ua)) setPlatform("mac");
    else if (/Windows/i.test(ua)) setPlatform("win");
    // Detect we're already inside the Tauri shell
    const w = window as unknown as {
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    setIsTauri(Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__));
  }, []);

  if (isTauri) return null; // already in the desktop app

  const macUrl = "/downloads/Xiaoling-mac.dmg";

  return (
    <section className="space-y-2">
      <h3 className="font-medium text-foreground text-sm">
        {t("settings.desktop.title")}
      </h3>
      <div className="rounded-md border border-border/40 bg-muted/30 p-3 text-sm">
        <p className="text-foreground">{t("settings.desktop.intro")}</p>
        <ul className="mt-1.5 ml-4 list-disc text-muted-foreground text-xs">
          <li>{t("settings.desktop.feature1")}</li>
          <li>{t("settings.desktop.feature2")}</li>
        </ul>
        {platform === "mac" ? (
          <>
            <a
              href={macUrl}
              download
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-opacity hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              {t("settings.desktop.downloadMac")}
            </a>
            <p className="mt-2 text-muted-foreground text-xs">
              {t("settings.desktop.macHint")}
            </p>
          </>
        ) : platform === "win" ? (
          <p className="mt-3 text-muted-foreground text-xs">
            {t("settings.desktop.windowsPending")}
          </p>
        ) : (
          <p className="mt-3 text-muted-foreground text-xs">
            {t("settings.desktop.otherPending")}
          </p>
        )}
      </div>
    </section>
  );
}

function HeadToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border border-border/40 px-3 py-2 text-sm">
      <span className="text-foreground">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-primary"
      />
    </label>
  );
}

/**
 * Avatar picker replaces the dropdown with a thumbnail+intro card list.
 * Each card shows the rendered Live2D preview snapshotted from AvatarLive2D
 * (or a colored placeholder if the user has not opened that avatar yet).
 */
interface AvatarCardGridProps {
  value: string;
  onValueChange: (id: string) => void;
  disabled?: boolean;
}

function AvatarCardGrid({
  value,
  onValueChange,
  disabled = false,
}: AvatarCardGridProps) {
  const lang = useLanguage();
  // Re-render whenever a new thumbnail lands in the cache.
  const [mounted, setMounted] = useState(false);
  const [, forceRerender] = useState(0);
  useEffect(() => {
    setMounted(true);
    const unsubscribeThumbs = subscribeAvatarThumbnails(() => forceRerender((n) => n + 1));
    const unsubscribeGenerated = subscribeGeneratedLive2DAvatars(() => forceRerender((n) => n + 1));
    const unsubscribeUserCharacters = subscribeUserCharacters(() => forceRerender((n) => n + 1));
    refreshUserCharactersFromServer().catch(() => {});
    return () => {
      unsubscribeThumbs();
      unsubscribeGenerated();
      unsubscribeUserCharacters();
    };
  }, []);

  // Hide IP-risk avatars unless the user is currently using one; same
  // filter the old SelectMenu used.
  const visible = getAllAvatarOptions().filter(
    (a) => !a.hidden || a.id === value,
  );

  return (
    <div className="space-y-1.5">
      {visible.map((a) => {
        const selected = a.id === value;
        const thumb = mounted ? getAvatarThumbnail(a.id) : null;
        const loc = localizedAvatar(a, lang);
        const initial = loc.displayName?.charAt(0) ?? "?";
        return (
          <button
            key={a.id}
            type="button"
            disabled={disabled}
            onClick={() => onValueChange(a.id)}
            className={
              "flex w-full items-start gap-3 rounded-md border p-2 text-left transition-colors " +
              (selected
                ? "border-primary bg-primary/10"
                : "border-border/40 hover:border-border hover:bg-muted/40") +
              (disabled ? " cursor-not-allowed opacity-60" : "")
            }
          >
            {/* Thumbnail (or initial fallback). 14 = 56px square. */}
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-gradient-to-br from-slate-800 to-slate-900">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumb}
                  alt={loc.label}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center font-semibold text-white/80 text-xl">
                  {initial}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-foreground text-sm">
                {loc.label}
              </div>
              <div className="mt-0.5 line-clamp-3 text-muted-foreground text-xs leading-snug">
                {loc.intro}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

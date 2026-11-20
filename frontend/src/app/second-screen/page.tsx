"use client";

import { RefreshCw, Video, VideoOff } from "lucide-react";
import { useEffect, useState } from "react";
import { UserCamera } from "@/components/Agent/UserCamera";
import {
  CAMERA_QUALITY_PRESETS,
  type CameraQuality,
  resolveBackgroundCss,
  useSettings,
} from "@/lib/settingsStore";

export default function SecondScreenPage() {
  const [settings, setSettings] = useSettings();
  const [enabled, setEnabled] = useState(true);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refreshCameraDevices = async (requestPermission = false) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMessage("当前浏览器不支持摄像头设备列表");
      return;
    }
    setBusy(true);
    let stream: MediaStream | null = null;
    try {
      if (requestPermission) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      setCameraDevices(cameras);
      setMessage(cameras.length ? `已找到 ${cameras.length} 个摄像头` : "未找到摄像头");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop();
      setBusy(false);
    }
  };

  useEffect(() => {
    void refreshCameraDevices(false);
  }, []);

  return (
    <main
      className="h-screen w-screen overflow-hidden"
      style={{ background: resolveBackgroundCss(settings.background) }}
    >
      <div className="relative h-full w-full bg-black/35">
        <UserCamera
          enabled={enabled}
          transparent
          readOnly
          ignoreGlobalCameraEnabled
          cameraDeviceId={settings.stageCameraDeviceId}
          cameraQuality={settings.stageCameraQuality}
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/70 to-transparent p-3 sm:p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="font-semibold text-lg text-white sm:text-2xl">
                第二屏高清摄像头
              </h1>
              <p className="mt-1 max-w-lg text-white/65 text-xs sm:text-sm">
                适合拖到第二块显示器全屏展示。此页面只显示摄像头、骨架和粒子特效，不会重复控制机械手。
              </p>
            </div>
            <button
              type="button"
              className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3 text-sm text-white backdrop-blur-md transition hover:bg-white/20"
              onClick={() => setEnabled((value) => !value)}
            >
              {enabled ? (
                <VideoOff className="h-4 w-4" />
              ) : (
                <Video className="h-4 w-4" />
              )}
              {enabled ? "关闭" : "开启"}
            </button>
          </div>
        </div>

        <section className="absolute inset-x-3 bottom-3 z-20 rounded-xl border border-white/15 bg-black/55 p-3 text-white shadow-2xl backdrop-blur-xl sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-auto sm:w-[360px]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium text-sm">第二屏摄像头设置</h2>
            <button
              type="button"
              disabled={busy}
              onClick={() => refreshCameraDevices(true)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 text-xs transition hover:bg-white/20 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
              刷新
            </button>
          </div>

          <label className="mt-3 block space-y-1">
            <span className="text-white/55 text-xs">摄像头</span>
            <select
              value={settings.stageCameraDeviceId}
              onChange={(event) =>
                setSettings({ stageCameraDeviceId: event.target.value })
              }
              className="h-10 w-full rounded-md border border-white/15 bg-black/55 px-2 text-sm text-white outline-none focus:ring-1 focus:ring-white/40"
            >
              <option value="">自动选择（浏览器默认）</option>
              {cameraDevices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `摄像头 ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {(Object.keys(CAMERA_QUALITY_PRESETS) as CameraQuality[]).map(
              (quality) => {
                const selected = settings.stageCameraQuality === quality;
                return (
                  <button
                    type="button"
                    key={quality}
                    onClick={() => setSettings({ stageCameraQuality: quality })}
                    className={`rounded-md border px-2 py-2 text-xs transition ${
                      selected
                        ? "border-sky-300 bg-sky-400/80 text-slate-950"
                        : "border-white/15 bg-white/10 text-white hover:bg-white/20"
                    }`}
                  >
                    {CAMERA_QUALITY_PRESETS[quality].label}
                  </button>
                );
              },
            )}
          </div>

          {message && <p className="mt-3 text-white/60 text-xs">{message}</p>}
        </section>
      </div>
    </main>
  );
}

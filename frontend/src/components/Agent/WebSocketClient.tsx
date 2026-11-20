"use client";

import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Play,
  Send,
  Square,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useIsPortrait } from "@/hooks/useIsPortrait";
import { useT, useLanguage } from "@/lib/i18n";
import { DEFAULT_MODEL_ID, getSelectedModel, setSelectedModel } from "@/lib/availableModels";
import { getAvatarById, localizedAvatar } from "@/lib/availableAvatars";
import { playReadyChime } from "@/lib/chime";
import { setHeadSpeakerVolume } from "@/lib/headMotion";
import { buildTickPayload, readGreetOverride } from "@/lib/proactiveTick";
import { resolveBackgroundCss, useSettings } from "@/lib/settingsStore";
import { refreshUserCharactersFromServer, subscribeUserCharacters } from "@/lib/userCharacters";
import { AudioControls } from "@/components/Agent/AudioControls";
import { AudioVisualizer } from "@/components/Agent/AudioVisualizer";
import { AvatarGpuDigitalHuman } from "@/components/Agent/AvatarGpuDigitalHuman";
import { AvatarLive2D } from "@/components/Agent/AvatarLive2D";
import { ChatHistory } from "@/components/Agent/ChatHistory";
import { LiveStreamChat } from "@/components/Agent/LiveStreamChat";
import { ConnectionStatus } from "@/components/Agent/ConnectionStatus";
import { SettingsDrawer } from "@/components/Agent/SettingsDrawer";
import { SubtitleOverlay } from "@/components/Agent/SubtitleOverlay";
import { TranscriptionDisplay } from "@/components/Agent/TranscriptionDisplay";
import { UserCamera } from "@/components/Agent/UserCamera";
import { OnboardingConsent } from "@/components/Agent/OnboardingConsent";
import { GuidedTour } from "@/components/Agent/GuidedTour";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAgentLifecycle } from "@/hooks/useAgentLifecycle";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { useWebSocket } from "@/hooks/useWebSocket";
import { getOrGeneratePort, getWebSocketUrl } from "@/lib/portManager";
import { isPublicPageHost } from "@/lib/deviceBridge";
import {
  executeCommandsFromText,
  isStandaloneVolumeAdjustmentRequest,
} from "@/lib/agentCommandBus";
import { useAgentStore } from "@/store/agentStore";

function isAutoManagedGpuEndpoint(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return (
      (host === "127.0.0.1" || host === "localhost") &&
      port === "8810" &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return value.trim().startsWith("/api/local-services/gpu-avatar");
  }
}

export function WebSocketClient() {
  const t = useT();
  const [port, setPort] = useState<number | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setPort(getOrGeneratePort());
  }, []);

  // Model selector — persists to localStorage, takes effect on next Start.
  // Hydration-safe: the first render (SSR + initial client render) MUST
  // produce identical markup. localStorage only exists in the browser,
  // so start with the static default and swap in the persisted value
  // after mount via the useEffect below.
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL_ID);
  useEffect(() => {
    const saved = getSelectedModel();
    if (saved !== modelId) setModelId(saved);
    // Run once on mount — we intentionally do not depend on modelId
    // to avoid re-reading localStorage after every user-driven change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleModelChange = (id: string) => {
    setModelId(id);
    setSelectedModel(id);
  };

  const {
    state: agentState,
    startAgent,
    stopAgent,
    reset,
    isStarting,
    isRunning,
  } = useAgentLifecycle();

  const {
    wsManager,
    connect: connectWebSocket,
    disconnect: disconnectWebSocket,
  } = useWebSocket({
    url: port ? getWebSocketUrl(port) : "ws://localhost:8765",
    autoConnect: false,
    maxReconnectAttempts: -1,
    reconnectInterval: 3000,
  });

  const { isRecording, startRecording, stopRecording, getMediaStream } =
    useAudioRecorder(wsManager);
  // Pull setVolume so the SettingsDrawer can drive master TTS volume.
  const { analyser: ttsAnalyser, setVolume: setPlaybackVolume } =
    useAudioPlayer(wsManager);
  const handleVoiceVolumeChange = useCallback(
    (v: number) => setPlaybackVolume(v),
    [setPlaybackVolume],
  );
  const { wsConnected, pipelineReady, transcribing, addMessage } = useAgentStore();

  // Ring a soft chime exactly once per Start, the moment the worker
  // pipeline confirms liveness. Without this, users start talking before
  // the WS+ASR is wired up and the first half of their sentence is lost.
  const prevReadyRef = useRef(false);
  useEffect(() => {
    if (pipelineReady && !prevReadyRef.current) {
      playReadyChime();
    }
    prevReadyRef.current = pipelineReady;
  }, [pipelineReady]);

  // Persistent UI settings (background, volume, avatar, camera). Background
  // gets applied via inline style on the outermost container; cameraEnabled
  // is consumed by UserCamera and toggled via the toolbar button.
  const [settings, setSettings] = useSettings();
  useEffect(() => {
    setPlaybackVolume(settings.voiceVolume);
  }, [settings.voiceVolume, setPlaybackVolume]);
  const headVolumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceAvatarRegistryRender] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribeUserCharacters(() => forceAvatarRegistryRender((value) => value + 1));
    refreshUserCharactersFromServer().catch(() => {});
    return unsubscribe;
  }, []);
  const toggleCamera = useCallback(
    () => setSettings({ cameraEnabled: !settings.cameraEnabled }),
    [settings.cameraEnabled, setSettings],
  );
  const openSecondScreen = useCallback(() => {
    const child = window.open(
      "/second-screen",
      "ai-lover-second-screen",
      "popup=yes,width=1280,height=720",
    );
    child?.focus();
  }, []);
  const updateHeadVolume = useCallback(
    (value: number) => {
      const next = Math.min(1, Math.max(0, value));
      setSettings({ robotHeadVolume: next });
      if (headVolumeTimerRef.current) {
        clearTimeout(headVolumeTimerRef.current);
      }
      headVolumeTimerRef.current = setTimeout(() => {
        setHeadSpeakerVolume(next).catch((err) => {
          console.warn("Failed to update head speaker volume:", err);
        });
      }, 220);
    },
    [setSettings],
  );

  useEffect(() => {
    return () => {
      if (headVolumeTimerRef.current) {
        clearTimeout(headVolumeTimerRef.current);
      }
    };
  }, []);

  // Resolve current avatar once per render so the modelUrl,
  // displayName, and persona id stay in sync everywhere they’re used.
  const avatar = getAvatarById(settings.selectedAvatar);
  const uiLang = useLanguage();
  const avatarDisplayName = localizedAvatar(avatar, uiLang).displayName;
  const isGpuAvatar = settings.avatarRendererMode === "gpu";
  const [publicPageHost, setPublicPageHost] = useState(false);
  useEffect(() => {
    setPublicPageHost(isPublicPageHost());
  }, []);
  const effectiveGpuAvatarEndpoint =
    isGpuAvatar &&
    (isAutoManagedGpuEndpoint(settings.gpuAvatarEndpoint) ||
      (publicPageHost &&
        settings.localConnectorEnabled &&
        settings.localConnectorPairingCode.trim()))
      ? "/api/local-services/gpu-avatar"
      : settings.gpuAvatarEndpoint;
  const effectiveGpuBackendEndpoint =
    effectiveGpuAvatarEndpoint === "/api/local-services/gpu-avatar" &&
    !isAutoManagedGpuEndpoint(settings.gpuAvatarEndpoint)
      ? settings.gpuAvatarEndpoint
      : "";

  const isPortrait = useIsPortrait();
  const [landscapeMainPane, setLandscapeMainPane] = useState<
    "chat" | "avatar" | "camera"
  >("chat");
  const [portraitMainPane, setPortraitMainPane] = useState<
    "avatar" | "camera"
  >("avatar");

  const renderAvatarView = () =>
    isGpuAvatar ? (
      <AvatarGpuDigitalHuman
        key={`${effectiveGpuAvatarEndpoint}:${settings.gpuAvatarId}`}
        analyser={ttsAnalyser}
        endpoint={effectiveGpuAvatarEndpoint}
        backendEndpoint={effectiveGpuBackendEndpoint}
        avatarId={settings.gpuAvatarId}
        transparent
      />
    ) : (
      <AvatarLive2D
        key={avatar.modelUrl}
        analyser={ttsAnalyser}
        modelUrl={avatar.modelUrl}
        avatarId={avatar.id}
        scaleBoost={avatar.scaleBoost}
        anchorRatio={avatar.anchorRatio}
        horizontalOffsetRatio={avatar.horizontalOffsetRatio}
        transparent
      />
    );

  const renderCameraView = () => (
    <UserCamera
      enabled={settings.cameraEnabled && settings.consentAccepted}
      transparent
    />
  );

  const renderCompactChatView = () => (
    <div className="flex h-full min-h-0 flex-col rounded-lg bg-black/20 p-3">
      <div className="mb-2 shrink-0 text-sm font-medium text-foreground">
        {t("chat.conversation")}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatHistory />
      </div>
    </div>
  );

  // Pre-warm the heavy Live2D + PIXI bundles during browser idle time so
  // the first avatar load completes faster — by the time the user clicks
  // a model, the JS is already parsed and only the textures need to fetch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ric =
      (window as any).requestIdleCallback ??
      ((cb: () => void) => setTimeout(cb, 1500));
    const id = ric(() => {
      import("pixi.js").catch(() => {});
      import("pixi-live2d-display/cubism4").catch(() => {});
    });
    return () => {
      const cic = (window as any).cancelIdleCallback;
      if (cic) cic(id);
      else clearTimeout(id as any);
    };
  }, []);

  // Auto-start the mic exactly once per page load. Previously the dep
  // array listed [startRecording], but that callback’s identity flips
  // every time isRecording toggles — which made the mic snap back on
  // a tick after the user clicked Mic-off to mute. Guard with a ref so
  // we honour manual mute.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    // Don't grab the mic until the user has accepted the consent
    // overlay — otherwise the browser permission prompt fires before
    // they've seen what we do with audio.
    if (!settings.consentAccepted) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    startRecording().catch((err) =>
      console.error("Failed to auto-start recording:", err),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.consentAccepted]);

  // Fire a proactive tick the moment the WebSocket connects so 小灵 opens
  // first instead of waiting for the user to speak. The tick reason comes
  // from the URL (?greet=morning|afternoon|evening|remind) when set, else
  // defaults to user_just_arrived.
  //
  // Keyed on `channelName` (one new value per Start click) so that
  // mid-session reconnects, React StrictMode double-effect-runs in dev,
  // and any other wsConnected flip-flops do NOT re-trigger the greeting.
  // Each Start = exactly one greeting, period.
  const lastFiredChannelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wsConnected || !wsManager) return;
    const channel = agentState.channelName;
    if (!channel) return;
    if (lastFiredChannelRef.current === channel) return;
    lastFiredChannelRef.current = channel;
    const reason = readGreetOverride() ?? "user_just_arrived";
    try {
      wsManager.send(buildTickPayload(reason));
    } catch (err) {
      console.error("Failed to send proactive tick:", err);
    }
  }, [wsConnected, wsManager, agentState.channelName]);

  const handleStartAgent = async () => {
    if (!port) {
      setInitError("Port not available");
      return;
    }
    setInitError(null);
    try {
      await startAgent({ port, avatarId: avatar.id, voiceId: avatar.voiceId });
      setTimeout(() => connectWebSocket(), 2000);
    } catch (error) {
      setInitError(
        error instanceof Error ? error.message : "Failed to start agent",
      );
    }
  };

  // Text-input handling. Sends {"text": "..."} over the same WebSocket the
  // mic uses; server-side websocket_server patch turns it into an asr_result
  // event so the rest of the pipeline is unchanged.
  const [textInput, setTextInput] = useState("");
  const sendTextMessage = () => {
    const trimmed = textInput.trim();
    if (!trimmed) return;
    // 用户在 Start 之前就敲了字按发送——直接提示而不是静默无视,
    // 避免 "按了没反应" 的疑惑(早期反馈集中在这里)。
    if (!wsConnected || !wsManager) {
      toast.error(t("chat.sendBeforeStart"), {
        description: t("chat.sendBeforeStartDesc"),
      });
      return;
    }
    try {
      if (isStandaloneVolumeAdjustmentRequest(trimmed)) {
        addMessage({ role: "user", content: trimmed });
        setTextInput("");
        void executeCommandsFromText(trimmed, "user");
        return;
      }
      wsManager.send({ text: trimmed });
      setTextInput("");
    } catch (err) {
      console.error("Failed to send text message:", err);
      toast.error(t("chat.sendFailed"));
    }
  };

  const handleStopAgent = async () => {
    try {
      disconnectWebSocket();
      await stopAgent();
      setInitError(null);
      reset();
    } catch {
      setInitError(null);
      reset();
    }
  };

  return (
    <div
      className="h-screen w-screen overflow-hidden"
      style={{ background: resolveBackgroundCss(settings.background) }}
    >
      <OnboardingConsent />
      <GuidedTour
        openSettings={() => setSettingsOpen(true)}
        closeSettings={() => setSettingsOpen(false)}
      />
      {/* 整页只盖一层轻透黑做文字对比度,不分预设/自定义,让背景都
          能"穿透"到角色和卡片后面。 */}
      <div className="flex h-full flex-col bg-black/20 backdrop-blur-sm">
        {/* Top toolbar: title + connection status + start/stop + mic + settings */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border/40 px-4 py-3">
          <h1 className="font-semibold text-foreground text-lg tracking-tight">
            完美恋人
          </h1>
          <ConnectionStatus />
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={openSecondScreen}
              title="打开第二屏高清摄像头"
              className="h-9 w-9"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            <SettingsDrawer
              modelId={modelId}
              onModelChange={handleModelChange}
              modelLocked={isRunning || isStarting}
              onVoiceVolumeChange={handleVoiceVolumeChange}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
            />
            {!isRunning && !isStarting && (
              <Button
                onClick={handleStartAgent}
                disabled={!port}
                size="sm"
                className="gap-2"
                data-tour="start"
              >
                <Play className="h-4 w-4" />
                {t("toolbar.start")}
              </Button>
            )}
            {isStarting && (
              <Button disabled size="sm" className="gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("toolbar.starting")}
              </Button>
            )}
            {isRunning && (
              <Button
                onClick={handleStopAgent}
                variant="destructive"
                size="sm"
                className="gap-2"
              >
                <Square className="h-4 w-4" />
                {t("toolbar.stop")}
              </Button>
            )}
            <Button
              size="sm"
              variant={settings.cameraEnabled ? "default" : "outline"}
              onClick={toggleCamera}
              className="gap-2"
              title={
                settings.cameraEnabled
                  ? t("toolbar.cameraOff")
                  : t("toolbar.cameraOn")
              }
            >
              {settings.cameraEnabled ? (
                <Video className="h-4 w-4" />
              ) : (
                <VideoOff className="h-4 w-4" />
              )}
            </Button>
            <div data-tour="mic" className="flex">
              <AudioControls
                isRecording={isRecording}
                onStartRecording={startRecording}
                onStopRecording={stopRecording}
              />
            </div>
          </div>
        </div>

        {/* Error alert (only when present) */}
        {(initError || agentState.error) && (
          <div className="shrink-0 px-4 pt-3">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t("status.connectionError")}</AlertTitle>
              <AlertDescription>
                {initError || agentState.error}
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Main area: portrait (vertical stack with collapsible chat) vs
            landscape (current 2-column). Both share the toolbar + alert
            above. */}
        {isPortrait ? (
          /* Portrait: full-bleed avatar background with livestream-style
              transparent chat overlay. No card backdrop — each message is
              its own small translucent pill so the avatar stays visible.
              Swipe up (or tap chevron) to expand for full chat history. */
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {/* Avatar — full-bleed background layer */}
            <div
              className="absolute inset-0 cursor-pointer"
              onClick={() =>
                setPortraitMainPane((pane) =>
                  pane === "avatar" ? "camera" : "avatar",
                )
              }
              title="点击交换数字人和摄像头画面"
            >
              {portraitMainPane === "avatar"
                ? renderAvatarView()
                : renderCameraView()}
            </div>
            <SubtitleOverlay className="bottom-16" />

            {/* User camera PiP — top-right */}
            <div
              className="pointer-events-auto absolute right-3 top-3 z-10 h-20 w-20 cursor-pointer overflow-hidden rounded-lg ring-2 ring-black/40"
              onClick={() =>
                setPortraitMainPane((pane) =>
                  pane === "avatar" ? "camera" : "avatar",
                )
              }
              title="点击交换大小画面"
            >
              {portraitMainPane === "avatar"
                ? renderCameraView()
                : renderAvatarView()}
            </div>

            {/* Mic visualizer — thin floating band, top-left, leaves room
                for the camera PiP on the right. */}
            <div
              className="absolute left-3 right-28 top-3 z-10 overflow-hidden rounded-xl border border-border/30 bg-background/40 ring-1 ring-border/40 backdrop-blur-sm"
              style={{ height: 32 }}
            >
              <AudioVisualizer
                stream={getMediaStream()}
                isActive={isRecording}
                barCount={28}
                barWidth={3}
                barGap={2}
                height={32}
              />
            </div>

            {/* Status pill (waking up / listening / idle) below the mic vis. */}
            {isRunning && wsConnected && (
              <div className="pointer-events-none absolute left-3 top-12 z-10">
                <span
                  className={
                    pipelineReady
                      ? "rounded-full bg-black/45 px-2.5 py-0.5 text-xs text-emerald-300 backdrop-blur-sm"
                      : "rounded-full bg-black/45 px-2.5 py-0.5 text-xs text-amber-300 backdrop-blur-sm"
                  }
                >
                  {pipelineReady
                    ? isRecording
                      ? t("status.listening")
                      : t("status.muted")
                    : t("status.waking")}
                </span>
              </div>
            )}

            {/* Chat column — fixed to the bottom-left ~1/3 of the screen
                (livestream layout). Scroll inside the column to see older
                messages; we do NOT expand upward and cover the avatar. */}
            <div
              className="pointer-events-auto absolute left-0 z-20 flex w-[62%] flex-col"
              style={{ top: "65%", bottom: "56px" }}
            >
              <div className="pointer-events-auto min-h-0 flex-1">
                <LiveStreamChat expanded={true} assistantLabel={avatarDisplayName} />
              </div>

              {/* Live partial-ASR pill — only visible while user is speaking. */}
              {transcribing && (
                <div className="pointer-events-none mx-3 mb-1 self-start rounded-full bg-amber-500/70 px-3 py-1 text-xs text-white shadow backdrop-blur-sm">
                  {transcribing}
                </div>
              )}
            </div>

            {/* Input bar — full width at the very bottom. Sits OUTSIDE
                the chat column so it isn't affected by the expand/collapse
                height transition, and matches the livestream layout where
                the composer spans the full width. */}
            <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex items-center gap-2 bg-black/45 px-3 py-2 backdrop-blur-md">
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendTextMessage();
                  }
                }}
                placeholder={
                  wsConnected
                    ? t("chat.placeholderConnectedPortrait")
                    : t("chat.placeholderDisconnectedPortrait")
                }
                className="flex h-9 flex-1 rounded-full border-0 bg-white/10 px-4 py-1 text-sm text-white shadow-sm transition-colors placeholder:text-white/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
              />
              <Button
                size="sm"
                onClick={sendTextMessage}
                disabled={!textInput.trim()}
                className="rounded-full bg-white/15 text-white hover:bg-white/25"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : (
          /* Landscape: avatar+cam stacked left, chat on right.
             所有背景(预设/自定义)都用同一套半透 + 毛玻璃卡片样式 —— 让
             选中的背景从卡片下面透出来,视觉更连贯。`bg-black/30` 配
             `backdrop-blur-md` 在任何背景上文字都可读。 */
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[minmax(260px,1fr)_2fr]">
            <div className="flex min-h-0 flex-col gap-3">
              <Card
                className="flex flex-1 flex-col overflow-hidden border-white/10 bg-black/30 shadow-sm backdrop-blur-md"
                onDoubleClick={() =>
                  setLandscapeMainPane((pane) =>
                    pane === "avatar" ? "chat" : "avatar",
                  )
                }
                title="双击放大数字人画面"
              >
                <CardContent className="relative flex-1 p-2">
                  {landscapeMainPane === "avatar" ? (
                    renderCompactChatView()
                  ) : (
                    <>
                      {renderAvatarView()}
                      <SubtitleOverlay />
                    </>
                  )}
                </CardContent>
              </Card>
              <div
                className="relative overflow-hidden rounded-xl border border-white/10 bg-black/20 ring-1 ring-border/40 backdrop-blur-md"
                style={{ height: 40 }}
              >
                <AudioVisualizer
                  stream={getMediaStream()}
                  isActive={isRecording}
                  barCount={32}
                  barWidth={3}
                  barGap={2}
                  height={40}
                />
              </div>
              <div className="flex shrink-0 items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm ring-1 ring-border/40 backdrop-blur-md">
                {settings.robotHeadVolume <= 0.01 ? (
                  <VolumeX className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="shrink-0 text-muted-foreground text-xs">
                  {t("settings.head.volume")}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.robotHeadVolume}
                  onChange={(e) => updateHeadVolume(Number(e.target.value))}
                  className="min-w-0 flex-1 accent-primary"
                />
                <span className="w-10 text-right text-muted-foreground text-xs tabular-nums">
                  {Math.round(settings.robotHeadVolume * 100)}%
                </span>
              </div>
              <Card
                className="flex flex-1 flex-col overflow-hidden border-white/10 bg-black/30 shadow-sm backdrop-blur-md"
                onDoubleClick={() =>
                  setLandscapeMainPane((pane) =>
                    pane === "camera" ? "chat" : "camera",
                  )
                }
                title="双击放大摄像头画面"
              >
                <CardContent className="flex-1 p-2">
                  {landscapeMainPane === "camera"
                    ? renderCompactChatView()
                    : renderCameraView()}
                </CardContent>
              </Card>
            </div>

            <Card
              className="flex min-h-0 flex-col overflow-hidden border-white/10 bg-black/30 shadow-sm backdrop-blur-md"
              onDoubleClick={() => setLandscapeMainPane("chat")}
              title={
                landscapeMainPane === "chat" ? undefined : "双击返回对话画面"
              }
            >
              {landscapeMainPane === "chat" ? (
                <>
                  <CardHeader className="shrink-0 pb-2">
                    <CardTitle className="text-base">
                      {t("chat.conversation")}
                    </CardTitle>
                    {isRunning && wsConnected && pipelineReady && (
                      <div className="text-xs text-emerald-500">
                        {isRecording
                          ? t("status.listening")
                          : t("status.clickMicToSpeak")}
                      </div>
                    )}
                    {isRunning && wsConnected && !pipelineReady && (
                      <div className="flex items-center gap-2 text-xs text-amber-500">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>{t("status.waking")}</span>
                      </div>
                    )}
                    {isRunning && !wsConnected && (
                      <div className="flex items-center gap-2 text-muted-foreground text-xs">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>{t("status.connecting")}</span>
                      </div>
                    )}
                  </CardHeader>
                  <CardContent className="flex min-h-0 flex-1 flex-col gap-2 pb-3 pt-0">
                    <div className="min-h-0 flex-1 overflow-hidden">
                      <ChatHistory />
                    </div>
                    <TranscriptionDisplay />
                    <div className="flex shrink-0 items-center gap-2 border-t border-border/30 pt-2">
                      <input
                        type="text"
                        value={textInput}
                        onChange={(e) => setTextInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            sendTextMessage();
                          }
                        }}
                        placeholder={
                          wsConnected
                            ? t("chat.placeholderConnectedLandscape")
                            : t("chat.placeholderDisconnectedLandscape")
                        }
                        className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      <Button
                        size="sm"
                        onClick={sendTextMessage}
                        disabled={!textInput.trim()}
                        className="gap-1"
                      >
                        <Send className="h-4 w-4" />
                        {t("chat.send")}
                      </Button>
                    </div>
                  </CardContent>
                </>
              ) : (
                <CardContent className="relative min-h-0 flex-1 p-2">
                  {landscapeMainPane === "avatar"
                    ? renderAvatarView()
                    : renderCameraView()}
                  {landscapeMainPane === "avatar" && <SubtitleOverlay />}
                  <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/50 px-3 py-1 text-xs text-white/80 backdrop-blur-sm">
                    双击返回对话
                  </div>
                </CardContent>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

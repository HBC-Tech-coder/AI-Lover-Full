"use client";

import { TrulienceAvatar } from "@trulience/react-sdk";
import { TRULIENCE_DEMO_AVATAR_ID, TRULIENCE_DEMO_TOKEN, TRULIENCE_SDK_URL } from "@/components/Agent/AvatarTrulience";
import {
  ArrowLeft,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Send,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Mode = "react" | "iframe";
type TrulienceObjectLike = {
  sendMessage?: (message: string) => void;
  disconnectGateway?: () => void;
};
type TrulienceForm = {
  avatarId: string;
  username: string;
  sdkUrl: string;
  autoConnect: boolean;
  prefetchAvatar: boolean;
  micOff: boolean;
  speakerOff: boolean;
  hideChatHistory: boolean;
  hideChatInput: boolean;
};

const STORAGE_KEY = "xiaoling-trulience-test";
const DEFAULT_FORM: TrulienceForm = {
  avatarId: TRULIENCE_DEMO_AVATAR_ID,
  username: "Guest",
  sdkUrl: TRULIENCE_SDK_URL,
  autoConnect: true,
  prefetchAvatar: false,
  micOff: true,
  speakerOff: false,
  hideChatHistory: false,
  hideChatInput: false,
};
const EVENTS = [
  "auth-success",
  "auth-fail",
  "websocket-connect",
  "websocket-close",
  "websocket-error",
  "mic-update",
  "speech-recognition-start",
  "speech-recognition-end",
  "speech-recognition-final-transcript",
  "trl-chat",
  "load-progress",
  "avatar-status-update",
];

export default function TrulienceTestPage() {
  const avatarRef = useRef<InstanceType<typeof TrulienceAvatar> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeReadyRef = useRef(false);
  const iframeRetryRef = useRef(0);
  const previewFallbackRef = useRef(false);
  const [mode, setMode] = useState<Mode>("iframe");
  const [form, setForm] = useState<TrulienceForm>(DEFAULT_FORM);
  const [token, setToken] = useState(TRULIENCE_DEMO_TOKEN);
  const [activeToken, setActiveToken] = useState(TRULIENCE_DEMO_TOKEN);
  const [apiKey, setApiKey] = useState("");

  const [mountedKey, setMountedKey] = useState("iframe:built-in-demo");
  const [message, setMessage] = useState("你好，请介绍一下你自己。");
  const [logs, setLogs] = useState<string[]>(["Built-in demo avatar loading"]);
  const [status, setStatus] = useState("Loading built-in demo avatar");
  const [busy, setBusy] = useState(false);
  const [quotaBlocked, setQuotaBlocked] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      delete parsed.token;
      setForm({ ...DEFAULT_FORM, ...parsed, avatarId: parsed.avatarId?.trim() || DEFAULT_FORM.avatarId });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {}
  }, [form]);

  const addLog = useCallback((line: string, data?: unknown) => {
    const suffix = data === undefined ? "" : ` ${safeStringify(data)}`;
    setLogs((items) => [
      `${new Date().toLocaleTimeString()} ${line}${suffix}`,
      ...items,
    ].slice(0, 60));
  }, []);
  const startPreviewFallback = useCallback((source: Mode) => {
    if (previewFallbackRef.current) return;
    previewFallbackRef.current = true;
    setQuotaBlocked(true);
    addLog(`${source}:quota-exceeded`);
    if (source === "iframe") {
      setStatus("iFrame 已保持当前模式；Trulience 实时对话额度已用完，所以 LET'S CHAT / Start 暂时不能发声。配置可用 API Key 后重新 Load。");
      try {
        iframeRef.current?.contentWindow?.postMessage({ command: "end-call" }, "*");
      } catch {}
      return;
    }
    setStatus("Trulience 免费月度对话额度已用完，正在切换到人物预览模式...");
    try {
      getTrulienceObject(avatarRef.current)?.disconnectGateway?.();
      iframeRef.current?.contentWindow?.postMessage({ command: "end-call" }, "*");
    } catch {}
    setMountedKey("");
    setForm((state) => ({ ...state, autoConnect: false, prefetchAvatar: true }));
    setMode("react");
    window.setTimeout(() => {
      setMountedKey(`react:quota-preview:${Date.now()}`);
      setStatus("人物预览模式已启用；恢复联网对话需要新的 API Key 或可用额度。");
    }, 1400);
  }, [addLog]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (mode !== "iframe" || !event.origin.includes("trulience.com")) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const name = event.data?.name || event.data?.eventName || event.data?.event || event.data?.type || "message";
      addLog(`iframe:${name}`, event.data);
      if (name === "auth-success") {
        iframeReadyRef.current = true;
        setStatus("Avatar authentication succeeded");
      }
      if (name === "websocket-connect") {
        iframeReadyRef.current = true;
        setStatus("人物已连接");
      }
      const detail = safeStringify(event.data);
      if (isMonthlyQuotaExceeded(event.data)) {
        startPreviewFallback("iframe");
      } else if (detail.includes("Authentication Failed") || detail.includes("Invalid Token")) {
        setStatus(`iFrame 认证失败：${getTrulienceError(event.data)}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [addLog, mode, startPreviewFallback]);

  useEffect(() => {
    if (mode !== "iframe" || !mountedKey) return;
    iframeReadyRef.current = false;
    const timer = window.setTimeout(() => {
      if (iframeReadyRef.current || iframeRetryRef.current >= 1) return;
      iframeRetryRef.current += 1;
      setStatus("First load incomplete; retrying automatically...");
      setMountedKey(`iframe:auto-retry:${Date.now()}`);
      addLog("iframe:auto-retry");
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [addLog, mode, mountedKey]);
  const eventCallbacks = useMemo(
    () => Object.fromEntries(EVENTS.map((name) => [name, (data: unknown) => {
      addLog(`react:${name}`, data);
      if (name === "auth-success") {
        setStatus(previewFallbackRef.current
          ? "人物认证成功，正在加载预览..."
          : "React 人物认证成功，正在连接...");
      }
      if (name === "websocket-connect") setStatus("人物已连接");
      if (name === "websocket-error") setStatus("React 人物连接错误");
      if (name === "load-progress" && previewFallbackRef.current) {
        const progress = Number((data as { progress?: number })?.progress ?? 0);
        setStatus(progress >= 1
          ? "人物预览已就绪；当前 Trulience 对话额度已用完。"
          : `正在加载人物预览... ${Math.round(progress * 100)}%`);
      }
      if (name === "auth-fail") {
        if (isMonthlyQuotaExceeded(data)) {
          startPreviewFallback("react");
        } else {
          setStatus(`React 认证失败：${getTrulienceError(data)}`);
        }
      }
    }])),
    [addLog, startPreviewFallback],
  );

  const iframeUrl = useMemo(() => buildIframeUrl(form, activeToken), [activeToken, form]);
  const canLoad = Boolean(form.avatarId.trim());

  async function requestFreshToken(): Promise<string> {
    const response = await fetch("/api/trulience/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        avatarId: form.avatarId.trim(),
        apiKey: apiKey.trim() || undefined,

      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !data?.token) {
      throw new Error(data?.error || `Token request failed: ${response.status}`);
    }
    return data.token as string;
  }

  async function loadAvatar() {
    if (!canLoad) return;
    setBusy(true);
    iframeRetryRef.current = 0;
    previewFallbackRef.current = false;
    setQuotaBlocked(false);
    setStatus("正在关闭之前的人物会话...");
    await releaseCurrentSession();
    try {
      let sessionToken = token.trim() || TRULIENCE_DEMO_TOKEN;
      if (apiKey.trim()) {
        setStatus("正在生成新的单次 Token...");
        sessionToken = await requestFreshToken();
        setToken(sessionToken);
        addLog("token:generated");
      }
      setToken(sessionToken);
      setActiveToken(sessionToken);
      setStatus(sessionToken ? "Token 已准备，正在加载 Avatar" : "未提供凭证，正在尝试匿名连接公开 Avatar");
      setMountedKey(`${mode}:${Date.now()}`);
      addLog(`${mode}:load`, { avatarId: form.avatarId, token: sessionToken ? "provided" : "anonymous" });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setStatus(text);
      addLog("token:error", text);
    } finally {
      setBusy(false);
    }
  }

  async function releaseCurrentSession() {
    try {
      getTrulienceObject(avatarRef.current)?.disconnectGateway?.();
      iframeRef.current?.contentWindow?.postMessage({ command: "end-call" }, "*");
    } catch {}
    setMountedKey("");
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  }

  async function switchMode(nextMode: Mode) {
    if (nextMode === mode || busy) return;
    setBusy(true);
    setStatus("正在关闭之前的人物会话...");
    await releaseCurrentSession();
    iframeRetryRef.current = 0;
    previewFallbackRef.current = false;
    setQuotaBlocked(false);
    setActiveToken(token.trim() || TRULIENCE_DEMO_TOKEN);
    setMode(nextMode);
    setStatus(`${nextMode === "react" ? "React SDK" : "iFrame"} 已就绪，请点击 Load。`);
    addLog(`mode:${mode}->${nextMode}`);
    setBusy(false);
  }

  async function stopAvatar() {
    await releaseCurrentSession();
    setQuotaBlocked(false);
    setStatus("Stopped");
    addLog(`${mode}:unload`);
  }

  function sendText() {
    const value = message.trim();
    if (!value) return;
    if (quotaBlocked) {
      setStatus("当前 Trulience 实时对话额度已用完；人物可预览，但不会说话。请配置可用 API Key 后重新 Load。");
      return;
    }
    if (mode === "react") {
      getTrulienceObject(avatarRef.current)?.sendMessage?.(value);
      addLog("react:sendMessage", value);
    } else {
      iframeRef.current?.contentWindow?.postMessage({ command: "trl-chat", message: value }, "*");
      addLog("iframe:trl-chat", value);
    }
  }

  function iframeCommand(command: string, payload?: Record<string, unknown>) {
    if (quotaBlocked && command === "start-call") {
      setStatus("当前 Trulience 实时对话额度已用完；Start 暂时不能发声。请配置可用 API Key 后重新 Load。");
      return;
    }
    iframeRef.current?.contentWindow?.postMessage({ command, ...payload }, "*");
    addLog(`iframe:${command}`, payload);
  }

  return (
    <main className="min-h-screen bg-[#0d1117] text-zinc-100">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl gap-5 px-4 py-5 lg:grid-cols-[400px_minmax(0,1fr)]">
        <section className="flex flex-col gap-4">
          <header className="flex items-start justify-between gap-3 border-zinc-800 border-b pb-4">
            <div><h1 className="font-semibold text-2xl">Trulience</h1><p className="mt-1 text-sm text-zinc-400">{mode === "react" ? "React SDK" : "iFrame"}</p></div>
            <Link className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 hover:bg-zinc-900" href="/" title="返回主页"><ArrowLeft className="h-4 w-4" /></Link>
          </header>

          <div className="grid grid-cols-2 overflow-hidden rounded-md border border-zinc-700">
            {(["react", "iframe"] as Mode[]).map((item) => <button className={`h-11 text-sm ${mode === item ? "bg-emerald-400 text-zinc-950" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"}`} disabled={busy} key={item} onClick={() => void switchMode(item)} type="button">{item === "react" ? "React SDK" : "iFrame"}</button>)}
          </div>

          <div className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <Field label="Avatar ID"><TextInput onChange={(value) => setForm((state) => ({ ...state, avatarId: value }))} placeholder="Trulience avatar id" value={form.avatarId} /></Field>
            <Field label="Session Token"><TextInput onChange={setToken} placeholder="单次使用；可手动粘贴" type="password" value={token} /></Field>
            <Field label="API Key"><TextInput onChange={setApiKey} placeholder="tru_live_...；也可配置 TRULIENCE_API_KEY" type="password" value={apiKey} /></Field>

            <Field label="Username"><TextInput onChange={(value) => setForm((state) => ({ ...state, username: value }))} value={form.username} /></Field>
            {mode === "react" && <Field label="SDK URL"><TextInput onChange={(value) => setForm((state) => ({ ...state, sdkUrl: value }))} value={form.sdkUrl} /></Field>}
            <div className="grid grid-cols-2 gap-2">
              {mode === "react" ? <><Toggle checked={form.autoConnect} label="Auto connect" onChange={(checked) => setForm((state) => ({ ...state, autoConnect: checked }))} /><Toggle checked={form.prefetchAvatar} label="Prefetch" onChange={(checked) => setForm((state) => ({ ...state, prefetchAvatar: checked }))} /></> : <><Toggle checked={form.micOff} label="Mic off" onChange={(checked) => setForm((state) => ({ ...state, micOff: checked }))} /><Toggle checked={form.speakerOff} label="Speaker off" onChange={(checked) => setForm((state) => ({ ...state, speakerOff: checked }))} /><Toggle checked={form.hideChatHistory} label="Hide history" onChange={(checked) => setForm((state) => ({ ...state, hideChatHistory: checked }))} /><Toggle checked={form.hideChatInput} label="Hide input" onChange={(checked) => setForm((state) => ({ ...state, hideChatInput: checked }))} /></>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 font-medium text-zinc-950 hover:bg-emerald-300 disabled:opacity-50" disabled={!canLoad || busy} onClick={loadAvatar} type="button">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}Load</button>
              <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900" onClick={() => void stopAvatar()} type="button"><PhoneOff className="h-4 w-4" />Stop</button>
            </div>
          </div>

          <div className="space-y-1 text-xs text-zinc-500"><p>当前默认使用原项目内置的长期演示 JWT，不是 API Key。</p><p>联网说话需要可用 Trulience API Key/额度；没有额度时人物只会预览，不会开口。</p></div>

          <div className={`rounded-md border px-3 py-2 text-sm ${status.includes("失败") || status.includes("无效") || status.includes("额度") || status.includes("quota") || status.includes("error") || status.includes("failed") ? "border-red-900/70 bg-red-950/40 text-red-200" : "border-zinc-800 bg-zinc-950/70 text-zinc-300"}`}>{status}</div>

          <div className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <Field label="Message"><textarea className="min-h-24 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-400" onChange={(event) => setMessage(event.target.value)} value={message} /></Field>
            <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50" disabled={quotaBlocked || !mountedKey} onClick={sendText} type="button"><Send className="h-4 w-4" />Send</button>
            {mode === "iframe" && <div className="grid grid-cols-2 gap-2"><IconButton disabled={quotaBlocked || !mountedKey} icon={Phone} label="Start" onClick={() => iframeCommand("start-call", activeToken ? { token: activeToken } : undefined)} /><IconButton icon={PhoneOff} label="End" onClick={() => iframeCommand("end-call")} /><IconButton icon={Mic} label="Mic on" onClick={() => iframeCommand("trl-mic-status", { status: true })} /><IconButton icon={MicOff} label="Mic off" onClick={() => iframeCommand("trl-mic-status", { status: false })} /><IconButton icon={Volume2} label="Speaker on" onClick={() => iframeCommand("trl-set-speaker-status", { status: true })} /><IconButton icon={VolumeX} label="Speaker off" onClick={() => iframeCommand("trl-set-speaker-status", { status: false })} /></div>}
          </div>
        </section>

        <section className="grid min-h-[620px] gap-3 lg:grid-rows-[minmax(420px,1fr)_180px]">
          <div className="rounded-md border border-zinc-800 bg-black p-2">
            {mountedKey ? mode === "react" ? <TrulienceAvatar ref={avatarRef} autoConnect={form.autoConnect} avatarId={form.avatarId} backgroundColor="#000" eventCallbacks={eventCallbacks} height="100%" key={mountedKey} prefetchAvatar={form.prefetchAvatar} token={activeToken || undefined} url={form.sdkUrl} username={form.username || "Guest"} width="100%" /> : <iframe allow="camera; microphone; fullscreen; accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen className="h-full min-h-[420px] w-full rounded bg-black" key={mountedKey} ref={iframeRef} src={iframeUrl} title="Trulience iframe test" /> : <div className="flex h-full min-h-[420px] items-center justify-center text-zinc-500">Waiting for avatar</div>}
          </div>
          <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950"><div className="border-zinc-800 border-b px-3 py-2 text-sm text-zinc-400">Events</div><pre className="h-[140px] overflow-auto px-3 py-2 text-xs text-emerald-200">{logs.join("\n")}</pre></div>
        </section>
      </div>
    </main>
  );
}

function isMonthlyQuotaExceeded(value: unknown): boolean {
  const detail = safeStringify(value);
  return detail.includes("Free Monthly Limit Exceeded") || detail.includes('"failReason":11');
}
function getTrulienceError(value: unknown): string {
  if (!value || typeof value !== "object") return String(value || "Unknown error");
  const record = value as Record<string, unknown>;
  const nested = (record.data || record.eventParams) as Record<string, unknown> | undefined;
  return String(
    nested?.message || nested?.errorTitle || record.message || record.errorTitle || "Unknown error",
  );
}
function buildIframeUrl(form: TrulienceForm, token: string): string {
  const base = `https://www.trulience.com/avatar/${encodeURIComponent(form.avatarId.trim())}`;
  const params = new URLSearchParams();
  if (token.trim()) params.set("token", token.trim());
  params.set("connect", String(form.autoConnect));
  params.set("micOff", String(form.micOff));
  params.set("speakerOff", String(form.speakerOff));
  params.set("hideChatHistory", String(form.hideChatHistory));
  params.set("hideChatInput", String(form.hideChatInput));
  params.set("registerTrlEvents", EVENTS.join(","));
  return `${base}?${params.toString()}`;
}
function getTrulienceObject(avatar: InstanceType<typeof TrulienceAvatar> | null): TrulienceObjectLike | null { return (avatar?.getTrulienceObject?.() as TrulienceObjectLike | null) || null; }
function safeStringify(value: unknown): string { try { return JSON.stringify(value); } catch { return String(value); } }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1.5 text-sm text-zinc-300"><span className="text-zinc-500 text-xs uppercase">{label}</span>{children}</label>; }
function TextInput({ onChange, placeholder, type = "text", value }: { onChange: (value: string) => void; placeholder?: string; type?: string; value: string; }) { return <input className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm outline-none focus:border-emerald-400" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={type} value={value} />; }
function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void; }) { return <label className="flex h-10 items-center justify-between gap-3 rounded-md border border-zinc-800 px-3 text-sm"><span>{label}</span><input checked={checked} className="h-4 w-4 accent-emerald-400" onChange={(event) => onChange(event.target.checked)} type="checkbox" /></label>; }
function IconButton({ disabled = false, icon: Icon, label, onClick }: { disabled?: boolean; icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; }) { return <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm hover:bg-zinc-900 disabled:opacity-50 disabled:hover:bg-transparent" disabled={disabled} onClick={onClick} type="button"><Icon className="h-4 w-4" />{label}</button>; }

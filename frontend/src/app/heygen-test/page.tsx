"use client";

import { ArrowLeft, ExternalLink, KeyRound, Loader2, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Orientation = "horizontal" | "vertical";
type EmbedType = "DEFAULT" | "WIDGET";

type HeyGenForm = {
  avatarId: string;
  contextId: string;
  voiceId: string;
  defaultLanguage: string;
  maxSessionDuration: number;
  orientation: Orientation;
  type: EmbedType;
  isSandbox: boolean;
};

const STORAGE_KEY = "xiaoling-heygen-liveavatar-test";

const DEFAULT_FORM: HeyGenForm = {
  avatarId: "",
  contextId: "",
  voiceId: "",
  defaultLanguage: "zh",
  maxSessionDuration: 600,
  orientation: "horizontal",
  type: "DEFAULT",
  isSandbox: true,
};

export default function HeyGenTestPage() {
  const [form, setForm] = useState<HeyGenForm>(DEFAULT_FORM);
  const [apiKey, setApiKey] = useState("");
  const [directUrl, setDirectUrl] = useState("");
  const [embedUrl, setEmbedUrl] = useState("");
  const [embedScript, setEmbedScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setForm({ ...DEFAULT_FORM, ...JSON.parse(stored) });
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {}
  }, [form]);

  const aspectClass = form.orientation === "vertical" ? "aspect-[9/16]" : "aspect-video";

  const canCreate = Boolean(form.avatarId.trim() && form.contextId.trim());

  async function createEmbed() {
    setBusy(true);
    setStatus("Creating embed...");
    setEmbedScript("");
    try {
      const response = await fetch("/api/heygen/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, apiKey: apiKey.trim() || undefined }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok || !data?.url) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      setEmbedUrl(data.url);
      setEmbedScript(data.script || "");
      setStatus(data.embedId ? `Embed ready: ${data.embedId}` : "Embed ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function loadDirectUrl() {
    const value = directUrl.trim();
    if (!value) return;
    setEmbedUrl(value);
    setEmbedScript("");
    setStatus("Direct URL loaded");
  }

  return (
    <main className="min-h-screen bg-[#0d1117] text-zinc-100">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl gap-5 px-4 py-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <section className="flex flex-col gap-4">
          <header className="flex items-start justify-between gap-3 border-zinc-800 border-b pb-4">
            <div>
              <h1 className="font-semibold text-2xl tracking-normal">HeyGen LiveAvatar</h1>
              <p className="mt-1 text-sm text-zinc-400">{status}</p>
            </div>
            <Link
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900"
              href="/"
              title="返回主页"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </header>

          <div className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <Field label="API Key">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-zinc-500" />
                <input
                  className="h-10 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm outline-none focus:border-cyan-400"
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="env HEYGEN_LIVEAVATAR_API_KEY 可代替"
                  type="password"
                  value={apiKey}
                />
              </div>
            </Field>
            <Field label="Avatar ID">
              <TextInput
                onChange={(value) => setForm((state) => ({ ...state, avatarId: value }))}
                placeholder="LiveAvatar avatar_id"
                value={form.avatarId}
              />
            </Field>
            <Field label="Context ID">
              <TextInput
                onChange={(value) => setForm((state) => ({ ...state, contextId: value }))}
                placeholder="LiveAvatar context_id"
                value={form.contextId}
              />
            </Field>
            <Field label="Voice ID">
              <TextInput
                onChange={(value) => setForm((state) => ({ ...state, voiceId: value }))}
                placeholder="可选"
                value={form.voiceId}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Language">
                <TextInput
                  onChange={(value) =>
                    setForm((state) => ({ ...state, defaultLanguage: value.slice(0, 5) }))
                  }
                  placeholder="zh / en / multi"
                  value={form.defaultLanguage}
                />
              </Field>
              <Field label="Duration">
                <input
                  className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm outline-none focus:border-cyan-400"
                  max={3600}
                  min={60}
                  onChange={(event) =>
                    setForm((state) => ({
                      ...state,
                      maxSessionDuration: Number(event.target.value),
                    }))
                  }
                  type="number"
                  value={form.maxSessionDuration}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Segmented
                label="Orientation"
                onChange={(value) =>
                  setForm((state) => ({ ...state, orientation: value as Orientation }))
                }
                options={["horizontal", "vertical"]}
                value={form.orientation}
              />
              <Segmented
                label="Type"
                onChange={(value) =>
                  setForm((state) => ({ ...state, type: value as EmbedType }))
                }
                options={["DEFAULT", "WIDGET"]}
                value={form.type}
              />
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 px-3 py-2 text-sm">
              <span>Sandbox</span>
              <input
                checked={form.isSandbox}
                className="h-4 w-4 accent-cyan-400"
                onChange={(event) =>
                  setForm((state) => ({ ...state, isSandbox: event.target.checked }))
                }
                type="checkbox"
              />
            </label>
            <button
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-cyan-400 px-4 font-medium text-zinc-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy || !canCreate}
              onClick={createEmbed}
              type="button"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Create embed
            </button>
          </div>

          <div className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <Field label="Direct embed URL">
              <TextInput
                onChange={setDirectUrl}
                placeholder="https://app.liveavatar.com/..."
                value={directUrl}
              />
            </Field>
            <button
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900"
              onClick={loadDirectUrl}
              type="button"
            >
              <RefreshCw className="h-4 w-4" />
              Load URL
            </button>
          </div>

          {embedScript && (
            <pre className="max-h-32 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
              {embedScript}
            </pre>
          )}
        </section>

        <section className="flex min-h-[520px] flex-col gap-3">
          <div className="flex items-center justify-between gap-3 border-zinc-800 border-b pb-3">
            <div className="text-sm text-zinc-400">{embedUrl || "No embed loaded"}</div>
            {embedUrl && (
              <a
                className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm hover:bg-zinc-900"
                href={embedUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-4 w-4" />
                Open
              </a>
            )}
          </div>
          <div className="flex flex-1 items-start justify-center rounded-md border border-zinc-800 bg-black p-2">
            {embedUrl ? (
              <iframe
                allow="camera; microphone; fullscreen; autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                className={`max-h-[calc(100vh-130px)] w-full rounded bg-black ${aspectClass}`}
                onLoad={() => setStatus("Embed loaded")}
                src={embedUrl}
                title="HeyGen LiveAvatar test"
              />
            ) : (
              <div className="flex h-full min-h-[420px] items-center text-zinc-500">
                Waiting for embed
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm text-zinc-300">
      <span className="text-zinc-500 text-xs uppercase">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  onChange,
  placeholder,
  value,
}: {
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <input
      className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm outline-none focus:border-cyan-400"
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      value={value}
    />
  );
}

function Segmented({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="text-zinc-500 text-xs uppercase">{label}</div>
      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-zinc-700">
        {options.map((option) => (
          <button
            className={`h-10 px-2 text-xs ${
              value === option
                ? "bg-cyan-400 text-zinc-950"
                : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
            }`}
            key={option}
            onClick={() => onChange(option)}
            type="button"
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

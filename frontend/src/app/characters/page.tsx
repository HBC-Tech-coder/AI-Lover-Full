"use client";

import {
  ArrowLeft,
  CheckCircle2,
  FolderUp,
  Globe2,
  ImagePlus,
  Loader2,
  Lock,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CharacterGender, CharacterVisibility, ManagedCharacter } from "@/lib/characterTypes";
import { setSettings } from "@/lib/settingsStore";
import { refreshUserCharactersFromServer, writeUserCharacters } from "@/lib/userCharacters";

const GENDER_OPTIONS: Array<{ value: CharacterGender; label: string }> = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "neutral", label: "Neutral" },
  { value: "other", label: "Custom" },
];

const VISIBILITY_OPTIONS: Array<{ value: CharacterVisibility; label: string; hint: string }> = [
  { value: "private", label: "Private", hint: "Only available in this local project." },
  { value: "public", label: "Shared", hint: "Marked for a common/team character pool." },
];

const directoryInputProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

export default function CharactersPage() {
  const modelInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const [characters, setCharacters] = useState<ManagedCharacter[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [modelFiles, setModelFiles] = useState<File[]>([]);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [thumbnailPreview, setThumbnailPreview] = useState("");
  const [form, setForm] = useState({
    label: "",
    displayName: "",
    gender: "female" as CharacterGender,
    visibility: "private" as CharacterVisibility,
    affiliation: "",
    ownership: "",
    personality: "",
    intro: "",
    voiceId: "",
    scaleBoost: "1.3",
    anchorRatio: "0",
  });

  const selected = useMemo(() => characters.find((item) => item.id === selectedId) || characters[0] || null, [characters, selectedId]);
  const model3Files = useMemo(() => modelFiles.filter((file) => relativePathForFile(file).toLowerCase().endsWith(".model3.json")), [modelFiles]);
  const totalBytes = useMemo(() => modelFiles.reduce((sum, file) => sum + file.size, 0), [modelFiles]);

  useEffect(() => {
    void loadCharacters();
  }, []);

  useEffect(() => {
    return () => {
      if (thumbnailPreview) URL.revokeObjectURL(thumbnailPreview);
    };
  }, [thumbnailPreview]);

  async function loadCharacters() {
    setLoading(true);
    setError("");
    try {
      const next = await refreshUserCharactersFromServer();
      setCharacters(next || []);
      if (!selectedId && next?.[0]) setSelectedId(next[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function pickModelFiles(files: FileList | null) {
    const next = Array.from(files || []);
    setModelFiles(next);
    const firstModel = next.find((file) => relativePathForFile(file).toLowerCase().endsWith(".model3.json"));
    if (firstModel && !form.label) {
      const base = firstModel.name.replace(/\.model3\.json$/i, "").replace(/[\-_]+/g, " ").trim();
      update("label", base || "Live2D Character");
      update("displayName", base || "Live2D Character");
    }
  }

  function pickThumbnail(file: File | undefined) {
    if (!file) return;
    if (thumbnailPreview) URL.revokeObjectURL(thumbnailPreview);
    setThumbnail(file);
    setThumbnailPreview(URL.createObjectURL(file));
  }

  async function submit() {
    setSaving(true);
    setError("");
    try {
      if (!modelFiles.length) throw new Error("Choose a completed Live2D model folder first.");
      if (!model3Files.length) throw new Error("The selected folder does not contain a .model3.json file.");
      const body = new FormData();
      Object.entries(form).forEach(([key, value]) => body.append(key, value));
      if (thumbnail) body.append("thumbnail", thumbnail, thumbnail.name);
      modelFiles.forEach((file) => {
        body.append("modelFiles", file, file.name);
        body.append("modelPaths", relativePathForFile(file));
      });
      body.append("modelPath", relativePathForFile(model3Files[0]));
      const response = await fetch("/api/characters", { method: "POST", body });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "Failed to save character.");
      const next = [data.character as ManagedCharacter, ...characters.filter((item) => item.id !== data.character.id)];
      setCharacters(next);
      writeUserCharacters(next);
      setSelectedId(data.character.id);
      setSettings({ selectedAvatar: data.character.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(character: ManagedCharacter) {
    if (!window.confirm(`Delete character ${character.label}?`)) return;
    setError("");
    const response = await fetch(`/api/characters/${encodeURIComponent(character.id)}`, { method: "DELETE" });
    const data = await response.json();
    if (!data.ok) {
      setError(data.error || "Failed to delete character.");
      return;
    }
    const next = (data.characters || []) as ManagedCharacter[];
    setCharacters(next);
    writeUserCharacters(next);
    if (selectedId === character.id) setSelectedId(next[0]?.id || "");
  }

  function useCharacter(character: ManagedCharacter) {
    writeUserCharacters(characters);
    setSettings({ selectedAvatar: character.id });
    setSelectedId(character.id);
  }

  return (
    <main className="min-h-screen bg-[#0f1419] text-zinc-100">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl gap-5 px-4 py-5 lg:grid-cols-[420px_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col gap-4">
          <header className="flex items-start justify-between gap-3 border-zinc-800 border-b pb-4">
            <div>
              <h1 className="font-semibold text-2xl tracking-normal">Character Manager</h1>
              <p className="mt-1 text-sm text-zinc-400">Upload finished Live2D models, set avatar metadata, and make them selectable on the main agent page.</p>
            </div>
            <Link className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" href="/" title="Back to main page">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </header>

          <section className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <input ref={modelInputRef} className="hidden" type="file" multiple onChange={(event) => pickModelFiles(event.target.files)} {...directoryInputProps} />
            <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 font-medium text-zinc-950 hover:bg-emerald-300" onClick={() => modelInputRef.current?.click()} type="button">
              <FolderUp className="h-4 w-4" /> Choose Live2D Model Folder
            </button>
            <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-400">
              <div>Files: {modelFiles.length} / Size: {formatBytes(totalBytes)}</div>
              <div>model3.json: {model3Files[0] ? relativePathForFile(model3Files[0]) : "not found"}</div>
            </div>

            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
              <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
                {thumbnailPreview ? <img alt="Avatar preview" className="h-24 w-full object-cover" src={thumbnailPreview} /> : <div className="flex h-24 items-center justify-center text-zinc-500"><ImagePlus className="h-6 w-6" /></div>}
              </div>
              <div className="grid gap-2">
                <input ref={thumbnailInputRef} accept="image/*" className="hidden" type="file" onChange={(event) => pickThumbnail(event.target.files?.[0])} />
                <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900" onClick={() => thumbnailInputRef.current?.click()} type="button">
                  <Upload className="h-4 w-4" /> Set Avatar Image
                </button>
                <p className="text-zinc-500 text-xs">Optional. Without an image, the character card will use a text placeholder until the Live2D thumbnail cache updates.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Role name"><input className={inputClass} value={form.label} onChange={(event) => update("label", event.target.value)} /></Field>
              <Field label="Talk name"><input className={inputClass} value={form.displayName} onChange={(event) => update("displayName", event.target.value)} /></Field>
            </div>

            <div className="grid grid-cols-4 gap-2">
              {GENDER_OPTIONS.map((option) => <Choice key={option.value} active={form.gender === option.value} label={option.label} onClick={() => update("gender", option.value)} />)}
            </div>

            <div className="grid grid-cols-2 gap-2">
              {VISIBILITY_OPTIONS.map((option) => <button key={option.value} className={`rounded-md border p-2 text-left ${form.visibility === option.value ? "border-emerald-400 bg-emerald-400/10" : "border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900"}`} onClick={() => update("visibility", option.value)} type="button">
                <div className="inline-flex items-center gap-2 text-sm font-medium">{option.value === "private" ? <Lock className="h-4 w-4" /> : <Globe2 className="h-4 w-4" />}{option.label}</div>
                <div className="mt-1 text-xs text-zinc-500">{option.hint}</div>
              </button>)}
            </div>

            <Field label="Affiliation"><input className={inputClass} placeholder="HBC internal / IP world / customer project" value={form.affiliation} onChange={(event) => update("affiliation", event.target.value)} /></Field>
            <Field label="Ownership"><input className={inputClass} placeholder="Fully private / team shared / licensed commercial" value={form.ownership} onChange={(event) => update("ownership", event.target.value)} /></Field>
            <Field label="Personality"><textarea className={`${textareaClass} min-h-28`} placeholder="Personality, speech style, taboos, and relationship with the user." value={form.personality} onChange={(event) => update("personality", event.target.value)} /></Field>
            <Field label="Card intro"><textarea className={`${textareaClass} min-h-20`} placeholder="Short intro shown in the settings drawer." value={form.intro} onChange={(event) => update("intro", event.target.value)} /></Field>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Voice ID"><input className={inputClass} placeholder="optional" value={form.voiceId} onChange={(event) => update("voiceId", event.target.value)} /></Field>
              <Field label="Scale"><input className={inputClass} value={form.scaleBoost} onChange={(event) => update("scaleBoost", event.target.value)} /></Field>
              <Field label="Anchor"><input className={inputClass} value={form.anchorRatio} onChange={(event) => update("anchorRatio", event.target.value)} /></Field>
            </div>

            {error ? <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-red-200 text-sm">{error}</div> : null}
            <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 font-medium text-zinc-950 hover:bg-white disabled:opacity-50" disabled={saving || !modelFiles.length || !model3Files.length} onClick={() => void submit()} type="button">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Save and Use Character
            </button>
          </section>
        </section>

        <section className="grid min-h-[680px] gap-3 lg:grid-rows-[auto_minmax(0,1fr)]">
          <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <div>
              <h2 className="font-medium">Character Library</h2>
              <p className="text-sm text-zinc-500">Private and shared roles are stored in this local project and loaded by the main settings panel.</p>
            </div>
            <button className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm hover:bg-zinc-900" onClick={() => void loadCharacters()} type="button">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
            </button>
          </div>

          <div className="grid min-h-0 gap-3 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-3 md:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid content-start gap-2">
              {characters.length ? characters.map((character) => (
                <button key={character.id} className={`rounded-md border p-3 text-left transition-colors ${selected?.id === character.id ? "border-emerald-400 bg-emerald-400/10" : "border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900"}`} onClick={() => setSelectedId(character.id)} type="button">
                  <div className="flex items-start gap-3">
                    <AvatarThumb character={character} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{character.label}</span>
                        <Badge>{character.visibility === "public" ? "shared" : "private"}</Badge>
                        <Badge>{character.gender}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{character.intro || character.personality || "No intro yet."}</p>
                      <p className="mt-2 truncate text-xs text-zinc-500">{character.modelUrl}</p>
                    </div>
                  </div>
                </button>
              )) : <div className="rounded-md border border-dashed border-zinc-800 p-8 text-center text-zinc-500">No custom characters yet. Upload a finished Live2D folder to begin.</div>}
            </div>

            <aside className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
              {selected ? (
                <div className="grid gap-3">
                  <div className="flex items-center gap-3">
                    <AvatarThumb character={selected} large />
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{selected.label}</h3>
                      <p className="text-sm text-zinc-400">{selected.displayName}</p>
                    </div>
                  </div>
                  <dl className="grid gap-2 text-sm">
                    <Info label="Visibility" value={selected.visibility} />
                    <Info label="Gender" value={selected.gender} />
                    <Info label="Affiliation" value={selected.affiliation || "-"} />
                    <Info label="Ownership" value={selected.ownership || "-"} />
                    <Info label="Created" value={formatDate(selected.createdAt)} />
                    <Info label="Model" value={selected.modelUrl} />
                  </dl>
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2 text-sm text-zinc-300">
                    <div className="mb-1 text-xs uppercase text-zinc-500">Personality prompt</div>
                    <p className="whitespace-pre-wrap break-words">{selected.personality || selected.identity}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 font-medium text-zinc-950 hover:bg-emerald-300" onClick={() => useCharacter(selected)} type="button">
                      <CheckCircle2 className="h-4 w-4" /> Use
                    </button>
                    <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-red-500/50 px-3 text-red-200 hover:bg-red-500/10" onClick={() => void remove(selected)} type="button">
                      <Trash2 className="h-4 w-4" /> Delete
                    </button>
                  </div>
                </div>
              ) : <div className="text-sm text-zinc-500">Select a character to see details.</div>}
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

const inputClass = "h-10 w-full rounded-md border border-zinc-700 bg-zinc-900/80 px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-emerald-400";
const textareaClass = "w-full rounded-md border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-emerald-400";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-xs uppercase tracking-normal text-zinc-500">
      {label}
      {children}
    </label>
  );
}

function Choice({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button className={`h-9 rounded-md border px-2 text-sm ${active ? "border-emerald-400 bg-emerald-400/10 text-emerald-100" : "border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-900"}`} onClick={onClick} type="button">{label}</button>;
}

function AvatarThumb({ character, large = false }: { character: ManagedCharacter; large?: boolean }) {
  const sizeClass = large ? "h-16 w-16" : "h-12 w-12";
  if (character.thumbnailUrl) return <img alt={character.label} className={`${sizeClass} flex-none rounded-md object-cover`} src={character.thumbnailUrl} />;
  return <div className={`${sizeClass} flex flex-none items-center justify-center rounded-md bg-zinc-800 font-semibold text-zinc-300`}>{character.label.slice(0, 1).toUpperCase()}</div>;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 border-zinc-800 border-b pb-2 last:border-b-0">
      <dt className="text-xs uppercase text-zinc-500">{label}</dt>
      <dd className="break-words text-zinc-200">{value}</dd>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] uppercase text-zinc-400">{children}</span>;
}

function relativePathForFile(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** order).toFixed(order ? 1 : 0)} ${units[order]}`;
}

function formatDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}
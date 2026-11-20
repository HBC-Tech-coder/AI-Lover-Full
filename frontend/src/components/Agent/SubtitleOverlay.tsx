"use client";

import { useEffect, useMemo, useState } from "react";
import { useSettings } from "@/lib/settingsStore";
import { useAgentStore } from "@/store/agentStore";

interface SubtitleOverlayProps {
  className?: string;
}

export function SubtitleOverlay({ className = "" }: SubtitleOverlayProps) {
  const [settings] = useSettings();
  const messages = useAgentStore((state) => state.messages);
  const transcribing = useAgentStore((state) => state.transcribing);
  const [visibleChars, setVisibleChars] = useState(0);

  const latestFinal = useMemo(
    () => [...messages].reverse().find((message) => message.role !== "tool"),
    [messages],
  );

  const source = useMemo(() => {
    if (settings.subtitleRenderMode !== "text_once" && transcribing.trim()) {
      return {
        key: `partial:${transcribing}`,
        role: "user" as const,
        text: transcribing.trim(),
        partial: true,
      };
    }
    if (!latestFinal?.content.trim()) return null;
    return {
      key: `${latestFinal.id}:${latestFinal.content}`,
      role: latestFinal.role,
      text: latestFinal.content.trim(),
      partial: false,
    };
  }, [latestFinal, settings.subtitleRenderMode, transcribing]);

  useEffect(() => {
    if (!source || settings.subtitleRenderMode !== "word" || source.partial) {
      setVisibleChars(source?.text.length ?? 0);
      return;
    }

    setVisibleChars(0);
    const timer = window.setInterval(() => {
      setVisibleChars((current) => {
        if (current >= source.text.length) {
          window.clearInterval(timer);
          return current;
        }
        return Math.min(source.text.length, current + 1);
      });
    }, 45);
    return () => window.clearInterval(timer);
  }, [source, settings.subtitleRenderMode]);

  if (!settings.subtitlesEnabled || !source) return null;

  const label = source.role === "user" ? "你" : "AI";
  const text =
    settings.subtitleRenderMode === "word"
      ? source.text.slice(0, visibleChars)
      : source.text;

  if (!text) return null;

  return (
    <div
      className={`pointer-events-none absolute inset-x-3 bottom-4 z-30 flex justify-center ${className}`}
    >
      <div className="max-w-[92%] rounded-md bg-black/65 px-4 py-2 text-center text-sm leading-relaxed text-white shadow-lg ring-1 ring-white/15 backdrop-blur-md md:text-base">
        <span className="mr-2 text-xs text-white/55">{label}</span>
        <span>{text}</span>
      </div>
    </div>
  );
}

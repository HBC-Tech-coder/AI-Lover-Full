"use client";

/**
 * LiveStreamChat — portrait-mode chat overlay in 抖音/直播 style.
 *
 * Renders messages as floating semi-transparent pills stacked at the bottom
 * of the viewport so the avatar stays fully visible behind them. No outer
 * card / border / backdrop — only per-row scrims. The top edge of the list
 * fades into the background via a CSS mask so older messages disappear
 * gracefully into the avatar rather than hitting a hard cut.
 *
 * Two modes:
 *   - collapsed: only the most recent ~5 messages, list does NOT scroll
 *     internally (avoids competing with the parent's drag-to-expand
 *     gesture). Older messages fade out via the top mask.
 *   - expanded: full scrollable history.
 */

import { Bot, User, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAgentStore } from "@/store/agentStore";
import { useT } from "@/lib/i18n";
import type { ChatMessage } from "@/types";

interface LiveStreamChatProps {
  expanded: boolean;
  /** Display name for the assistant role — follows the active
   *  avatar. Defaults to '小灵' for the project default. */
  assistantLabel?: string;
}

function roleLabel(
  role: ChatMessage["role"],
  assistantLabel: string,
): string {
  if (role === "user") return "我";
  if (role === "tool") return "工具";
  return assistantLabel;
}

// Username-strip colours, picked to read on both dark and bright avatar
// frames. Kept high-saturation so the role is recognisable at a glance.
const ROLE_NAME_COLOR: Record<ChatMessage["role"], string> = {
  user: "text-amber-300",
  assistant: "text-cyan-300",
  tool: "text-slate-400",
};

function MessageRow({
  message,
  assistantLabel,
}: {
  message: ChatMessage;
  assistantLabel: string;
}) {
  const t = useT();
  if (message.role === "tool") {
    const nameKey = `tool.name.${message.toolName ?? ""}`;
    const translatedName = t(nameKey);
    const label =
      translatedName !== nameKey
        ? translatedName
        : (message.toolName ?? t("tool.genericName"));
    const statusDot =
      message.toolStatus === "ok"
        ? "bg-emerald-400"
        : message.toolStatus === "error"
          ? "bg-rose-400"
          : "bg-amber-300 animate-pulse";
    return (
      <div className="flex items-center gap-1.5 self-start rounded-full bg-black/45 px-2.5 py-1 text-[11px] text-slate-300 shadow-sm backdrop-blur-sm">
        <Wrench className="h-3 w-3 shrink-0 opacity-70" />
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot}`} />
        <span className="truncate">{label}</span>
      </div>
    );
  }

  const Icon = message.role === "user" ? User : Bot;
  return (
    <div className="flex max-w-full items-start gap-2 self-start rounded-2xl bg-black/45 px-3 py-1.5 shadow-sm backdrop-blur-sm">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10">
        <Icon className="h-3 w-3 text-white" />
      </div>
      <div className="min-w-0 flex-1 text-[13px] leading-snug text-white">
        <span
          className={`mr-1.5 font-semibold ${ROLE_NAME_COLOR[message.role]}`}
        >
          {roleLabel(message.role, assistantLabel)}
        </span>
        <span className="break-words">{message.content}</span>
      </div>
    </div>
  );
}

export function LiveStreamChat({
  expanded,
  assistantLabel = "小灵",
}: LiveStreamChatProps) {
  const { messages } = useAgentStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-stick to bottom as new messages arrive. Only meaningful when
  // expanded; the collapsed view uses a static-height window so there's
  // no scrollable region to pin.
  useEffect(() => {
    if (!expanded) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [expanded, messages]);

  // Top-edge fade so older messages dissolve into the avatar background.
  const fadeMask =
    "linear-gradient(to bottom, transparent 0%, black 14%, black 100%)";

  // Collapsed view: render only the tail of the conversation, no scroll.
  // This keeps the gesture parent in full control of pull-to-expand and
  // avoids the awkward "drag scrolls chat instead of expanding panel".
  if (!expanded) {
    const tail = messages.slice(-6);
    if (tail.length === 0) return null;
    return (
      <div
        className="pointer-events-none flex h-full w-full flex-col justify-end gap-1.5 overflow-hidden px-3 pb-2"
        style={{ WebkitMaskImage: fadeMask, maskImage: fadeMask }}
      >
        {tail.map((m) => (
          <MessageRow key={m.id} message={m} assistantLabel={assistantLabel} />
        ))}
      </div>
    );
  }

  // Expanded: full scrollable history. pointer-events re-enabled so the
  // user can flick-scroll through it.
  return (
    <div
      ref={scrollRef}
      className="no-scrollbar flex h-full w-full flex-col gap-1.5 overflow-y-auto px-3 pb-2 pt-2"
      style={{ WebkitMaskImage: fadeMask, maskImage: fadeMask }}
    >
      {messages.length === 0 ? (
        <div className="m-auto text-center text-white/60 text-sm">
          开始说话或打字,聊天会显示在这里
        </div>
      ) : (
        messages.map((m) => <MessageRow key={m.id} message={m} assistantLabel={assistantLabel} />)
      )}
    </div>
  );
}

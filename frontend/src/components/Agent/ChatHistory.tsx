"use client";

import { Bot, CheckCircle2, Loader2, User, Wrench, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useT } from "@/lib/i18n";
import { useAgentStore } from "@/store/agentStore";
import type { ChatMessage } from "@/types";

// Map raw MCP tool names to short Chinese labels for the chip.
function ToolChip({ message }: { message: ChatMessage }) {
  const t = useT();
  const status = message.toolStatus ?? "calling";
  const Icon =
    status === "calling"
      ? Loader2
      : status === "ok"
        ? CheckCircle2
        : XCircle;
  const colorCls =
    status === "calling"
      ? "text-muted-foreground"
      : status === "ok"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-rose-600 dark:text-rose-400";
  const nameKey = `tool.name.${message.toolName ?? ""}`;
  const translatedName = t(nameKey);
  const label =
    translatedName !== nameKey
      ? translatedName
      : (message.toolName ?? t("tool.genericName"));

  // The args (and result preview after completion) are kept in the
  // expandable details so the bubble itself stays compact.
  const detail =
    status === "calling"
      ? message.content
      : message.toolPreview
        ? `${message.content}\n→ ${message.toolPreview}`
        : message.content;

  return (
    <div className="flex w-full justify-center px-2">
      <details className="group w-full max-w-[92%] rounded-md border border-border/40 bg-muted/30 px-3 py-1.5 text-muted-foreground text-xs shadow-sm">
        <summary className="flex cursor-pointer items-center gap-2 list-none [&::-webkit-details-marker]:hidden">
          <Wrench className="h-3.5 w-3.5 shrink-0" />
          <Icon
            className={`h-3.5 w-3.5 shrink-0 ${colorCls} ${
              status === "calling" ? "animate-spin" : ""
            }`}
          />
          <span className="font-medium text-foreground/80">{label}</span>
          <span className="truncate">
            {status === "calling"
              ? t("tool.calling")
              : status === "ok"
                ? t("tool.returned")
                : t("tool.failed")}
          </span>
          <span className="ml-auto text-[10px] tabular-nums">
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/50 p-2 font-mono text-[11px] leading-snug">
          {detail}
        </pre>
      </details>
    </div>
  );
}

export function ChatHistory() {
  const { messages } = useAgentStore();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const t = useT();

  // Auto-scroll to bottom whenever messages update — including streaming
  // token updates (the store re-creates the array on each push). shadcn's
  // ScrollArea wraps content in a Radix viewport; that viewport is the
  // actual scrollable element, so set scrollTop on it rather than on our
  // inner div.
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center rounded-xl bg-muted/20 shadow-sm">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-muted p-4 shadow-sm">
            <Bot className="h-8 w-8 text-muted-foreground" />
          </div>
          <p className="text-muted-foreground text-sm">
            {t("chat.emptyHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea
      ref={scrollAreaRef}
      className="h-full w-full rounded-xl border border-border/30 ring-1 ring-border/40"
    >
      <div className="space-y-4 p-4">
        {messages.map((message) => {
          if (message.role === "tool") {
            return <ToolChip key={message.id} message={message} />;
          }
          return (
            <div
              key={message.id}
              className={`flex gap-3 ${
                message.role === "user" ? "flex-row-reverse" : "flex-row"
              }`}
            >
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback
                  className={
                    message.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground"
                  }
                >
                  {message.role === "user" ? (
                    <User className="h-4 w-4" />
                  ) : (
                    <Bot className="h-4 w-4" />
                  )}
                </AvatarFallback>
              </Avatar>
              <div
                className={`flex flex-col gap-1 ${
                  message.role === "user" ? "items-end" : "items-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-4 py-2.5 ${
                    message.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/60 text-foreground"
                  }`}
                >
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {message.content}
                  </p>
                </div>
                <p className="px-2 text-muted-foreground text-xs">
                  {new Date(message.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

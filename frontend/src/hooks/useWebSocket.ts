/**
 * useWebSocket Hook
 * Manages WebSocket connection and integrates with Zustand store
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { WebSocketManager } from "@/manager/websocket";
import {
  executeAgentCommand,
  inferAgentCommandsFromText,
  normalizeAgentCommands,
  stripAgentCommandMarkup,
  type AgentCommand,
  type AgentCommandRole,
} from "@/lib/agentCommandBus";
import { scheduleBrowserTtsFallback } from "@/lib/browserTtsFallback";
import { isProactiveTick } from "@/lib/proactiveTick";
import { useAgentStore } from "@/store/agentStore";
import { isTauri, callLocalTool } from "@/lib/tauriBridge";
import { getUserId } from "@/lib/userIdentity";
import { focusRobotHeadOnSpeaker } from "@/lib/speakerFocus";

// Fire-and-forget log to the admin DB. Never blocks chat — any failure
// is swallowed. Generates one session id per WebSocket connection.
function makeSessionLogger() {
  let sessionId: string | null = null;
  const post = (body: Record<string, unknown>) => {
    // Use `keepalive` so a session_start posted right before a navigation
    // (rare here, but cheap insurance) still gets flushed.
    fetch("/api/log/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  };
  return {
    start(): string {
      try {
        sessionId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        post({ type: "session_start", session_id: sessionId, user_id: getUserId() });
      } catch {
        sessionId = null;
      }
      return sessionId ?? "";
    },
    message(role: "user" | "assistant", content: string) {
      if (!sessionId || !content) return;
      post({ type: "message", session_id: sessionId, role, content });
    },
    end() {
      sessionId = null;
    },
  };
}

function getSpeakerLabel(payload: any): string | null {
  const metadata = payload?.metadata ?? {};
  const value =
    payload?.speaker_label ??
    payload?.speaker_name ??
    payload?.speaker_id ??
    payload?.speaker ??
    metadata?.speaker_label ??
    metadata?.speaker_name ??
    metadata?.speaker_id ??
    metadata?.speaker;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const label = String(value).trim();
  return label || null;
}

function withSpeakerPrefix(text: string, payload: any): string {
  const label = getSpeakerLabel(payload);
  if (!label) return text;
  const normalized = /^s\d+$/i.test(label) ? label.toUpperCase() : label;
  const prefix = `[${normalized}]`;
  return text.startsWith(prefix) ? text : `${prefix} ${text}`;
}

interface UseWebSocketOptions {
  url: string;
  autoConnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectInterval?: number;
}

export function useWebSocket(options: UseWebSocketOptions | string) {
  // Support both object and string parameter for backwards compatibility
  const {
    url,
    autoConnect = false,
    maxReconnectAttempts,
    reconnectInterval,
  } = typeof options === "string"
    ? { url: options, autoConnect: false }
    : options;

  const wsManagerRef = useRef<WebSocketManager | null>(null);
  // Expose the manager through state so consumers re-render
  const [wsManagerState, setWsManagerState] = useState<WebSocketManager | null>(
    null
  );
  // Select stable action references from Zustand store to avoid unnecessary re-renders
  // Zustand action function identities are stable; using selectors prevents effect churn
  const setWsConnected = useAgentStore((s) => s.setWsConnected);
  const setPipelineReady = useAgentStore((s) => s.setPipelineReady);
  const setError = useAgentStore((s) => s.setError);
  const addMessage = useAgentStore((s) => s.addMessage);
  const setTranscribing = useAgentStore((s) => s.setTranscribing);
  const clearTranscribing = useAgentStore((s) => s.clearTranscribing);
  const addToolCall = useAgentStore((s) => s.addToolCall);
  const finishToolCall = useAgentStore((s) => s.finishToolCall);

  // Initialize WebSocket manager
  useEffect(() => {
    // Create WebSocket manager (but don't connect yet)
    const wsManager = new WebSocketManager({
      url,
      maxReconnectAttempts,
      reconnectInterval,
    });
    wsManagerRef.current = wsManager;
    setWsManagerState(wsManager);

    // Per-connection logger for /api/log/event (admin DB).
    const logger = makeSessionLogger();
    const runClientCommands = (commands: AgentCommand[]) => {
      for (const command of commands) {
        const toolName = `client.${command.target}.${command.action}`;
        const showToolChip = command.source !== "rule";
        if (showToolChip) {
          addToolCall(toolName, command.args);
        }
        executeAgentCommand(command).then((result) => {
          if (showToolChip) {
            finishToolCall(
              toolName,
              result.ok ? "ok" : "error",
              result.ok ? result.preview : result.error || result.preview,
            );
          }
        });
      }
    };
    const runTextCommands = (text: string, role: AgentCommandRole) => {
      runClientCommands(inferAgentCommandsFromText(text, role));
    };

    // Handle connection open
    wsManager.onOpen(() => {
      console.log("WebSocket connected");
      setWsConnected(true);
      // pipelineReady is set true by the first inbound message handler
      // below; explicitly reset here in case the previous session left
      // it on (e.g. quick disconnect/reconnect).
      setPipelineReady(false);
      setError(null);
      logger.start();
    });

    // Handle connection close
    wsManager.onClose(() => {
      console.log("WebSocket closed");
      setWsConnected(false);
      setPipelineReady(false);
      logger.end();
    });

    // Handle connection error
    wsManager.onError((error) => {
      console.error("WebSocket error:", error);
      setError("WebSocket connection error");
    });

    // First message from the server (of any type) proves the worker
    // graph is actually wired up. Flip pipelineReady so the mic stops
    // dropping frames and the UI plays the “ready” chime.
    wsManager.onMessage(() => {
      setPipelineReady(true);
    });

    // Handle audio messages
    wsManager.onAudio((message) => {
      console.log("Received audio:", message.audio.length, "bytes");
      // Audio will be played by useAudioPlayer hook
    });

    // Handle data messages
    wsManager.onData((message) => {
      console.log("Received data:", message.name, message.data);

      // Handle ASR results
      if (message.name === "asr_result") {
        const text = message.data?.text || message.data?.transcript || "";
        const isFinal = message.data?.is_final || message.data?.final || false;

        // Hide proactive ticks from the chat UI — they're internal cues, not
        // things the user actually said. The LLM still sees them via the
        // pipeline; we just don't render the user-side bubble.
        if (isProactiveTick(text)) {
          return;
        }

        if (isFinal) {
          // Final transcription - add as user message
          if (text) {
            focusRobotHeadOnSpeaker(message.data, "asr_result_final");
            const visibleText = withSpeakerPrefix(text, message.data);
            addMessage({
              role: "user",
              content: visibleText,
            });
            logger.message("user", visibleText);
            runTextCommands(text, "user");
          }
          clearTranscribing();
        } else {
          // Partial transcription - show as transcribing
          if (text) {
            focusRobotHeadOnSpeaker(message.data, "asr_result_partial");
          }
          setTranscribing(withSpeakerPrefix(text, message.data));
        }
      }

      // Handle transcript messages (text_data with data_type: 'transcribe')
      if (
        message.name === "text_data" &&
        message.data?.data_type === "transcribe"
      ) {
        const transcript = message.data;
        const text = transcript.text || "";
        const isFinal = transcript.is_final || false;
        const role = transcript.role === "user" ? "user" : "assistant";

        // Same filter as above — proactive tick text shouldn't appear in chat.
        if (isProactiveTick(text)) {
          return;
        }

        if (isFinal) {
          // Final transcription - add to chat history
          if (text) {
            if (role === "user") {
              focusRobotHeadOnSpeaker(transcript, "text_data_final");
            }
            const visibleText =
              role === "assistant"
                ? stripAgentCommandMarkup(text)
                : withSpeakerPrefix(text, transcript);
            if (visibleText) {
              addMessage({
                role,
                content: visibleText,
              });
              logger.message(role, visibleText);
              if (role === "assistant") {
                scheduleBrowserTtsFallback(visibleText);
              }
            }
            runTextCommands(text, role);
          }
          // Clear transcribing state for final messages
          clearTranscribing();
        } else {
          // Partial transcription - show in transcription display
          if (text) {
            if (role === "user") {
              focusRobotHeadOnSpeaker(transcript, "text_data_partial");
            }
            setTranscribing(
              role === "assistant" ? text : withSpeakerPrefix(text, transcript),
            );
          }
        }
      }

      // Handle MCP tool-call events emitted by main_python's llm_exec.
      // Two data_type variants share the text_data channel:
      //   "mcp_call"   — tool just got invoked; show "正在调 …" chip
      //   "mcp_result" — tool returned; patch the chip with ok / error
      if (
        message.name === "text_data" &&
        message.data?.data_type === "mcp_call"
      ) {
        const toolName = message.data?.tool_name || "";
        if (toolName) {
          addToolCall(toolName, message.data?.arguments);
        }
      }
      if (
        message.name === "text_data" &&
        message.data?.data_type === "mcp_result"
      ) {
        const toolName = message.data?.tool_name || "";
        if (toolName) {
          const ok = message.data?.ok === false ? "error" : "ok";
          const preview = String(message.data?.preview || "");
          finishToolCall(toolName, ok, preview);
        }
      }

      // Formal command bus emitted by the TEN tool extension. This keeps
      // physical controls out of the spoken text/TTS stream.
      if (
        (message.name === "text_data" &&
          message.data?.data_type === "client_control") ||
        message.name === "client_control" ||
        message.name === "agent_command" ||
        message.name === "xiaoling_command"
      ) {
        const commandPayload =
          message.data?.command ??
          message.data?.commands ??
          message.data?.payload ??
          message.data;
        runClientCommands(normalizeAgentCommands(commandPayload, "server_cmd"));
        return;
      }

      // Handle other LLM text responses (non-transcribe)
      if (message.name === "llm_response" || message.name === "chat_message") {
        const text = message.data?.text || message.data?.content || "";
        if (text) {
          const visibleText = stripAgentCommandMarkup(text);
          if (visibleText) {
            addMessage({
              role: "assistant",
              content: visibleText,
            });
            logger.message("assistant", visibleText);
            scheduleBrowserTtsFallback(visibleText);
          }
          runTextCommands(text, "assistant");
        }
      }
    });

    // Handle command messages
    wsManager.onCmd(async (message) => {
      console.log("Received command:", message.name, message.data);

      if (
        message.name === "client_control" ||
        message.name === "agent_command" ||
        message.name === "xiaoling_command"
      ) {
        runClientCommands(normalizeAgentCommands(message.data, "server_cmd"));
        return;
      }

      // Tool-call relay: when running inside the xiaoling-desktop Tauri
      // shell, the backend may request a tool be executed *locally* on the
      // user's machine (terminal, file access, etc.). We forward the call
      // to the local MCP sidecar via Tauri IPC and reply through the same
      // socket. In a normal browser session this branch is a no-op.
      if (message.name === "client_tool_call" && isTauri()) {
        const payload = message.data as
          | { id?: string; tool?: string; args?: Record<string, unknown> }
          | undefined;
        const id = payload?.id ?? "unknown";
        const tool = payload?.tool;
        const args = payload?.args ?? {};
        if (!tool) {
          wsManager.send({
            type: "cmd",
            name: "client_tool_call_result",
            data: { id, ok: false, error: "missing tool name" },
          });
          return;
        }
        try {
          const result = await callLocalTool(tool, args);
          wsManager.send({
            type: "cmd",
            name: "client_tool_call_result",
            data: { id, ...result },
          });
        } catch (err) {
          wsManager.send({
            type: "cmd",
            name: "client_tool_call_result",
            data: { id, ok: false, error: String(err) },
          });
        }
      }
    });

    // Handle error messages
    wsManager.onErrorMessage((message) => {
      console.error("Server error:", message.error);
      setError(message.error);
    });

    // Auto-connect if enabled
    if (autoConnect) {
      wsManager.connect();
    }

    // Cleanup on unmount
    return () => {
      wsManager.disconnect();
    };
  }, [
    url,
    autoConnect,
    maxReconnectAttempts,
    reconnectInterval,
    setWsConnected,
    setPipelineReady,
    setError,
    addMessage,
    setTranscribing,
    clearTranscribing,
    addToolCall,
    finishToolCall,
  ]);

  // Manual connect function
  const connect = useCallback(() => {
    wsManagerRef.current?.connect();
  }, []);

  // Manual disconnect function
  const disconnect = useCallback(() => {
    wsManagerRef.current?.disconnect();
  }, []);

  return {
    wsManager: wsManagerState,
    connect,
    disconnect,
  };
}

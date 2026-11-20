/**
 * Zustand Store for Agent State Management
 */

import { create } from "zustand";
import type { AgentStatus, ChatMessage, RecordingState } from "@/types";

interface AgentStore {
  // Connection state
  status: AgentStatus;
  wsConnected: boolean;
  /** True once the worker pipeline has confirmed liveness by sending
   *  at least one message back. Used to gate mic frame forwarding so
   *  we don’t drop the first half of the user’s sentence into a
   *  half-initialised ASR. Reset on WS close / Stop. */
  pipelineReady: boolean;
  error: string | null;

  // Recording state
  recording: RecordingState;

  // Messages
  messages: ChatMessage[];
  transcribing: string; // Current partial transcription

  // Actions
  setStatus: (status: AgentStatus) => void;
  setWsConnected: (connected: boolean) => void;
  setPipelineReady: (ready: boolean) => void;
  setError: (error: string | null) => void;
  setRecording: (state: RecordingState) => void;
  addMessage: (message: Omit<ChatMessage, "id" | "timestamp">) => void;
  /** Append a "tool" message (MCP call started). Returns its id so the
   *  caller can later patch in the result. */
  addToolCall: (toolName: string, args: unknown) => string;
  /** Patch a previously-added "tool" message with the result. If no
   *  matching call was found, this is a no-op. */
  finishToolCall: (
    toolName: string,
    status: "ok" | "error",
    preview: string,
  ) => void;
  setTranscribing: (text: string) => void;
  clearTranscribing: () => void;
  clearMessages: () => void;
  reset: () => void;
}

const initialState = {
  status: "idle" as AgentStatus,
  wsConnected: false,
  pipelineReady: false,
  error: null,
  recording: "idle" as RecordingState,
  messages: [],
  transcribing: "",
};

export const useAgentStore = create<AgentStore>((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setWsConnected: (connected) => set({ wsConnected: connected }),

  setPipelineReady: (ready) => set({ pipelineReady: ready }),

  setError: (error) => set({ error }),

  setRecording: (recording) => set({ recording }),

  addMessage: (message) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          ...message,
          id: `${Date.now()}-${Math.random()}`,
          timestamp: Date.now(),
        },
      ],
    })),

  addToolCall: (toolName, args) => {
    const id = `${Date.now()}-${Math.random()}`;
    let argsPreview = "";
    try {
      argsPreview = JSON.stringify(args ?? {});
    } catch {
      argsPreview = String(args ?? "");
    }
    if (argsPreview.length > 120) {
      argsPreview = `${argsPreview.slice(0, 120)}…`;
    }
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id,
          role: "tool",
          // content is the human-readable line shown in the UI.
          content: `${toolName}(${argsPreview})`,
          timestamp: Date.now(),
          toolName,
          toolStatus: "calling",
        },
      ],
    }));
    return id;
  },

  finishToolCall: (toolName, status, preview) =>
    set((state) => {
      // Find the most recent "calling" entry for this tool and patch it.
      const idx = [...state.messages]
        .reverse()
        .findIndex(
          (m) =>
            m.role === "tool" &&
            m.toolName === toolName &&
            m.toolStatus === "calling",
        );
      if (idx === -1) return state;
      const realIdx = state.messages.length - 1 - idx;
      const next = state.messages.slice();
      const target = next[realIdx];
      next[realIdx] = {
        ...target,
        toolStatus: status,
        toolPreview: preview,
      };
      return { messages: next };
    }),

  setTranscribing: (text) => set({ transcribing: text }),

  clearTranscribing: () => set({ transcribing: "" }),

  clearMessages: () => set({ messages: [] }),

  reset: () => set(initialState),
}));

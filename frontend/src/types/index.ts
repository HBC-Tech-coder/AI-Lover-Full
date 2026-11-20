/**
 * Type definitions for WebSocket Voice Assistant
 */

export type MessageType = "audio" | "data" | "error" | "cmd";

export interface WebSocketMessage {
  type: MessageType;
  [key: string]: any;
}

export interface AudioMessage extends WebSocketMessage {
  type: "audio";
  audio: string; // base64
  metadata?: {
    sample_rate?: number;
    channels?: number;
    bytes_per_sample?: number;
    samples_per_channel?: number;
    source?: string;
    user_id?: string;
    voice_lock_mode?: string;
    speaker_id?: string;
  };
}

export interface DataMessage extends WebSocketMessage {
  type: "data";
  name: string;
  data: any;
}

export interface ErrorMessage extends WebSocketMessage {
  type: "error";
  error: string;
}

export interface CmdMessage extends WebSocketMessage {
  type: "cmd";
  name: string;
  data: any;
}

export interface ChatMessage {
  id: string;
  /** "tool" entries are MCP tool-call records, rendered as a small chip
   *  rather than a chat bubble. */
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  /** Only set for role="tool". The MCP tool name (e.g. "bocha_search"). */
  toolName?: string;
  /** Only set for role="tool". "calling" while in flight, "ok"/"error"
   *  once the result event arrives. */
  toolStatus?: "calling" | "ok" | "error";
  /** Only set for role="tool". Short preview of the tool's return value. */
  toolPreview?: string;
}

export type AgentStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type RecordingState = "idle" | "recording" | "processing";

export interface AgentState {
  status: AgentStatus;
  wsConnected: boolean;
  recording: RecordingState;
  messages: ChatMessage[];
  transcribing: string;
  error: string | null;
}

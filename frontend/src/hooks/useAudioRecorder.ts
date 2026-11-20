/**
 * useAudioRecorder Hook
 * Manages microphone recording and sends audio to WebSocket
 */

import { useCallback, useRef, useState } from "react";
import {
  AudioRecorder,
  DEFAULT_AUDIO_CONFIG,
  browserMediaUnavailableReason,
} from "@/lib/audioUtils";
import { captureHeadMicrophoneChunk, isHeadSpeakerBusy } from "@/lib/headMotion";
import { useSettings } from "@/lib/settingsStore";
import { getUserId } from "@/lib/userIdentity";
import type { WebSocketManager } from "@/manager/websocket";
import { useAgentStore } from "@/store/agentStore";

export function useAudioRecorder(wsManager: WebSocketManager | null) {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const remoteStopRef = useRef<(() => void) | null>(null);
  // Track the latest wsManager even if start() was called earlier
  const wsRef = useRef<WebSocketManager | null>(null);
  wsRef.current = wsManager;
  const [settings] = useSettings();
  const { setRecording } = useAgentStore();
  // Read pipelineReady through a ref so the long-lived audio callback
  // sees the latest value without re-creating the recorder.
  const pipelineReady = useAgentStore((s) => s.pipelineReady);
  const readyRef = useRef(pipelineReady);
  readyRef.current = pipelineReady;

  const startRecording = useCallback(async () => {
    if (isRecording) {
      console.warn("Already recording");
      return;
    }

    try {
      const userId = getUserId();
      const voiceLockMode = settings.voiceLockMode;
      const diarizationEnabled = settings.speakerDiarizationEnabled;
      if (settings.robotHeadMicEnabled) {
        let stopped = false;
        remoteStopRef.current = () => {
          stopped = true;
        };
        setIsRecording(true);
        setRecording("recording");
        setError(null);
        console.log("Head microphone capture started");

        void (async () => {
          while (!stopped) {
            const ws = wsRef.current;
            if (!ws?.isConnected() || !readyRef.current) {
              await wait(250);
              continue;
            }
            if (settings.robotHeadSpeakerEnabled && isHeadSpeakerBusy()) {
              await wait(180);
              continue;
            }
            try {
              const chunk = await captureHeadMicrophoneChunk(1000);
              if (!stopped && ws.isConnected() && readyRef.current) {
                setError(null);
                ws.sendAudio(chunk.audio, {
                  sample_rate: chunk.sample_rate,
                  channels: chunk.channels,
                  bytes_per_sample: chunk.bytes_per_sample,
                  source: "robot_head_mic",
                  user_id: userId,
                  voice_lock_mode: voiceLockMode,
                  diarization_enabled: diarizationEnabled,
                });
              }
            } catch (err) {
              console.error("Head microphone capture failed:", err);
              setError(
                err instanceof Error ? err.message : "Head microphone capture failed",
              );
              await wait(1000);
            }
          }
        })();
        return;
      }

      if (!settings.computerMicEnabled) {
        setError("电脑麦克风已关闭，未启用头部麦克风");
        setRecording("idle");
        return;
      }

      const unavailable = browserMediaUnavailableReason("microphone");
      if (unavailable) {
        setError(unavailable);
        setRecording("idle");
        return;
      }

      const recorder = new AudioRecorder(DEFAULT_AUDIO_CONFIG);
      recorderRef.current = recorder;

      await recorder.start((audioBase64) => {
        const ws = wsRef.current;
        // Drop frames until the worker pipeline is confirmed live, so
        // the first half of the user’s sentence doesn’t get fed
        // into a still-initialising ASR.
        if (ws?.isConnected() && readyRef.current) {
          ws.sendAudio(audioBase64, {
            sample_rate: DEFAULT_AUDIO_CONFIG.sampleRate,
            channels: DEFAULT_AUDIO_CONFIG.channels,
            bytes_per_sample: DEFAULT_AUDIO_CONFIG.bitsPerSample / 8,
            source: "computer_mic",
            user_id: userId,
            voice_lock_mode: voiceLockMode,
            diarization_enabled: diarizationEnabled,
          });
        }
      });

      setIsRecording(true);
      setRecording("recording");
      setError(null);
      console.log("Recording started");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
      setRecording("idle");
      console.error("Failed to start recording:", err);
    }
  }, [
    isRecording,
    setRecording,
    settings.computerMicEnabled,
    settings.robotHeadMicEnabled,
    settings.robotHeadSpeakerEnabled,
    settings.speakerDiarizationEnabled,
    settings.voiceLockMode,
  ]);

  const stopRecording = useCallback(() => {
    if (!isRecording) {
      return;
    }

    if (remoteStopRef.current) {
      remoteStopRef.current();
      remoteStopRef.current = null;
      setIsRecording(false);
      setRecording("idle");
      console.log("Head microphone capture stopped");
      return;
    }

    if (!recorderRef.current) {
      return;
    }

    recorderRef.current.stop();
    recorderRef.current = null;
    setIsRecording(false);
    setRecording("idle");
    console.log("Recording stopped");
  }, [isRecording, setRecording]);

  const getMediaStream = useCallback((): MediaStream | null => {
    return recorderRef.current?.getStream() || null;
  }, []);

  return {
    isRecording,
    error,
    startRecording,
    stopRecording,
    getMediaStream,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

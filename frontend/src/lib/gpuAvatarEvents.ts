export const GPU_AVATAR_TTS_AUDIO_EVENT = "xiaoling:tts-audio";

export interface GpuAvatarTtsAudioPayload {
  audio: string;
  metadata?: {
    sample_rate?: number;
    channels?: number;
    bytes_per_sample?: number;
  };
}

export function emitGpuAvatarTtsAudio(payload: GpuAvatarTtsAudioPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<GpuAvatarTtsAudioPayload>(GPU_AVATAR_TTS_AUDIO_EVENT, {
      detail: payload,
    }),
  );
}

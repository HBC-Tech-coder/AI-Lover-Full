/**
 * useAudioPlayer Hook
 * Manages audio playback from WebSocket server
 */

import { AudioPlayer, DEFAULT_AUDIO_CONFIG } from "@/lib/audioUtils";
import { markServerAudioArrived } from "@/lib/browserTtsFallback";
import { emitGpuAvatarTtsAudio } from "@/lib/gpuAvatarEvents";
import { playHeadSpeakerAudio, triggerHeadMotion } from "@/lib/headMotion";
import { getSettings } from "@/lib/settingsStore";
import type { WebSocketManager } from "@/manager/websocket";
import { useCallback, useEffect, useRef, useState } from "react";

const HEAD_AUDIO_FLUSH_DELAY_MS = 220;
const HEAD_AUDIO_MAX_CHUNKS_PER_FLUSH = 8;

export function useAudioPlayer(wsManager: WebSocketManager | null) {
	const [isPlaying, setIsPlaying] = useState(false);
	const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
	const playerRef = useRef<AudioPlayer | null>(null);
	const headAudioBufferRef = useRef<string[]>([]);
	const headSampleRateRef = useRef(16000);
	const headChannelsRef = useRef(1);
	const headBytesPerSampleRef = useRef(2);
	const headFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const headStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flushHeadAudioBuffer = useCallback(async () => {
		if (headFlushTimerRef.current) {
			clearTimeout(headFlushTimerRef.current);
			headFlushTimerRef.current = null;
		}

		const chunks = headAudioBufferRef.current;
		if (!chunks.length) return;

		let total = 0;
		for (const chunk of chunks) total += (chunk.length * 3) >> 2;
		const raw = new Uint8Array(total);
		let offset = 0;

		for (const chunk of chunks) {
			const binary = atob(chunk);
			for (let i = 0; i < binary.length; i += 1) {
				raw[offset] = binary.charCodeAt(i);
				offset += 1;
			}
		}

		chunks.length = 0;

		let combined = "";
		for (let i = 0; i < offset; i += 1) {
			combined += String.fromCharCode(raw[i]);
		}

		const combinedBase64 = btoa(combined);
		const playbackOk = await playHeadSpeakerAudio(combinedBase64, {
			sampleRate: headSampleRateRef.current,
			channels: headChannelsRef.current,
			bytesPerSample: headBytesPerSampleRef.current,
			driveMouth: true,
		});
		if (!playbackOk) {
			void triggerHeadMotion("speak", {
				source: "tts_audio_fallback",
				audio: combinedBase64,
				sample_rate: headSampleRateRef.current,
				channels: headChannelsRef.current,
				bytes_per_sample: headBytesPerSampleRef.current,
			});
			try {
				await playerRef.current?.playBase64Audio(
					combinedBase64,
					headSampleRateRef.current,
				);
			} catch (error) {
				console.error("Failed to play fallback audio:", error);
			}
		}

		const durationMs =
			(offset * 1000) /
				(headSampleRateRef.current *
					headChannelsRef.current *
					headBytesPerSampleRef.current) +
			300;
		if (headStopTimerRef.current) {
			clearTimeout(headStopTimerRef.current);
			headStopTimerRef.current = null;
		}
		headStopTimerRef.current = setTimeout(() => {
			void triggerHeadMotion("stopspeak", { source: "tts_audio" });
			setIsPlaying(false);
			headStopTimerRef.current = null;
		}, durationMs);
	}, []);

	useEffect(() => {
		// Initialize audio player
		const player = new AudioPlayer(DEFAULT_AUDIO_CONFIG);
		playerRef.current = player;

		player.initialize().then(() => {
			setAnalyser(player.getAnalyser());
		});

		// Listen for audio messages from WebSocket
		const unsubscribe = wsManager?.onAudio(async (message) => {
			markServerAudioArrived();
			setIsPlaying(true);
			emitGpuAvatarTtsAudio({
				audio: message.audio,
				metadata: message.metadata,
			});

			const settings = getSettings();
			const sampleRate = message.metadata?.sample_rate ?? 16000;
			const channels = message.metadata?.channels ?? 1;
			const bytesPerSample = message.metadata?.bytes_per_sample ?? 2;

			if (settings.robotHeadSpeakerEnabled) {
				headSampleRateRef.current = sampleRate;
				headChannelsRef.current = channels;
				headBytesPerSampleRef.current = bytesPerSample;
				headAudioBufferRef.current.push(message.audio);

				if (headFlushTimerRef.current) clearTimeout(headFlushTimerRef.current);
				if (headAudioBufferRef.current.length >= HEAD_AUDIO_MAX_CHUNKS_PER_FLUSH) {
					flushHeadAudioBuffer();
				} else {
					headFlushTimerRef.current = setTimeout(
						flushHeadAudioBuffer,
						HEAD_AUDIO_FLUSH_DELAY_MS,
					);
				}
				return;
			}

			void triggerHeadMotion("speak", {
				source: "tts_audio",
				audio: message.audio,
				sample_rate: sampleRate,
				channels,
				bytes_per_sample: bytesPerSample,
			});
			try {
				// Use the ACTUAL sample rate from the server metadata (e.g., OpenAI
				// TTS returns 24000Hz PCM), not a hardcoded 16000, so playback speed
				// matches the recording rate.
				await player.playBase64Audio(message.audio, sampleRate);
			} catch (error) {
				console.error("Failed to play audio:", error);
			} finally {
				setIsPlaying(false);
				void triggerHeadMotion("stopspeak", { source: "tts_audio" });
			}
		});

		// Cleanup
		return () => {
			unsubscribe?.();
			player.destroy();
			if (headFlushTimerRef.current) clearTimeout(headFlushTimerRef.current);
			if (headStopTimerRef.current) clearTimeout(headStopTimerRef.current);
		};
	}, [wsManager, flushHeadAudioBuffer]);

	const setVolume = useCallback((volume: number) => {
		playerRef.current?.setVolume(volume);
	}, []);

	return {
		isPlaying,
		setVolume,
		/** AnalyserNode tapping the TTS output for lip-sync/visualizers. */
		analyser,
	};
}

"use client";

import { getSettings } from "@/lib/settingsStore";

let lastServerAudioAt = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function chooseLang(text: string): string {
	return /[\u3400-\u9fff]/.test(text) ? "zh-CN" : "en-US";
}

export function markServerAudioArrived() {
	lastServerAudioAt = Date.now();
	if (pendingTimer) {
		clearTimeout(pendingTimer);
		pendingTimer = null;
	}
}

export function scheduleBrowserTtsFallback(text: string, delayMs = 1300) {
	if (typeof window === "undefined") return;
	if (!("speechSynthesis" in window)) return;

	const content = text.trim();
	if (!content) return;

	const scheduledAt = Date.now();
	const audioMarkAtSchedule = lastServerAudioAt;
	if (pendingTimer) clearTimeout(pendingTimer);

	pendingTimer = setTimeout(() => {
		pendingTimer = null;
		if (lastServerAudioAt > audioMarkAtSchedule && lastServerAudioAt >= scheduledAt) {
			return;
		}

		try {
			window.speechSynthesis.cancel();
			const utterance = new SpeechSynthesisUtterance(content);
			const settings = getSettings();
			utterance.lang = chooseLang(content);
			utterance.volume = Math.min(1, Math.max(0, settings.voiceVolume ?? 1));
			utterance.rate = 1;
			utterance.pitch = 1;
			window.speechSynthesis.speak(utterance);
		} catch (error) {
			console.error("Browser TTS fallback failed:", error);
		}
	}, delayMs);
}

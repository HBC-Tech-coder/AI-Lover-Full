import { getSettings, setSettings } from "@/lib/settingsStore";
import { hardwareFetch, isDeviceBridgeEnabled } from "@/lib/deviceBridge";

type HeadMotionAction =
	| "init"
	| "speak"
	| "stopspeak"
	| "smile"
	| "sad"
	| "kiss"
	| "makeface"
	| "blink"
	| "blink_left"
	| "blink_right"
	| "eyes_rotate"
	| "turn_neck"
	| "servo";

type HeadMotionPayload = Record<string, unknown>;

const ENABLED = process.env.NEXT_PUBLIC_HEAD_MOTION_ENABLED === "true";
const LOCAL_HEAD_API = "/api/local-services/head";

const lastActionAt = new Map<string, number>();
let headSpeakerBusyUntil = 0;

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function headApiBase(): string {
	if (isDeviceBridgeEnabled()) return LOCAL_HEAD_API;
	const endpoint = trimTrailingSlash(getSettings().robotHeadEndpoint || "");
	return endpoint || LOCAL_HEAD_API;
}

function headApiUrl(path: string): string {
	return `${headApiBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

function isPrivateOrLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host.startsWith("192.168.") ||
		host.startsWith("10.") ||
		/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
	);
}

function canUseSameOriginLocalServices(): boolean {
	if (isDeviceBridgeEnabled()) return true;
	if (typeof window === "undefined") return true;
	return isPrivateOrLocalHost(window.location.hostname);
}

export interface HeadBridgeHealth {
	ok: boolean;
	transport?: string;
	dry_run?: boolean;
	port?: string;
	baud?: number;
	adb_serial?: string;
	audio?: {
		playback?: boolean;
		capture?: boolean;
		playback_queue?: number;
		playback_volume?: number;
		playback_volume_percent?: number;
	};
	actions?: string[];
	error?: string;
}

export interface LocalHeadBridgeStartResult {
	ok: boolean;
	head_ip: string;
	endpoint: string;
	started?: boolean;
	error?: string;
	health?: HeadBridgeHealth & { error?: string };
	config?: HeadBridgeHealth & { error?: string };
}

export interface HeadMicChunk {
	ok: boolean;
	audio: string;
	sample_rate: number;
	channels: number;
	bytes_per_sample: number;
	bytes: number;
}

export interface HeadMicTestResult {
	chunk: HeadMicChunk;
	rms: number;
	peak: number;
	levelPercent: number;
}

function shouldThrottle(action: HeadMotionAction): boolean {
	if (action === "speak" || action === "stopspeak") return false;
	const now = Date.now();
	const previous = lastActionAt.get(action) ?? 0;
	if (now - previous < 900) return true;
	lastActionAt.set(action, now);
	return false;
}

export async function triggerHeadMotion(
	action: HeadMotionAction,
	payload: HeadMotionPayload = {},
): Promise<void> {
	const settings = getSettings();
	if (
		!ENABLED ||
		!settings.robotHeadMotionEnabled ||
		typeof window === "undefined" ||
		shouldThrottle(action)
	) {
		return;
	}

	const controller = new AbortController();
	const timeoutMs = action === "speak" && "audio" in payload ? 2500 : 1200;
	const timer = window.setTimeout(() => controller.abort(), timeoutMs);
	try {
		await postHeadAction(action, payload, controller.signal);
	} catch {
		// Hardware motion must never break the conversation flow.
	} finally {
		window.clearTimeout(timer);
	}
}

export async function sendHeadAction(
	action: HeadMotionAction,
	payload: HeadMotionPayload = {},
): Promise<void> {
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), 1500);
	try {
		const response = await postHeadAction(action, payload, controller.signal);
		if (!response.ok) {
			const data = await response.json().catch(() => null);
			throw new Error(data?.error || "Head action failed");
		}
	} finally {
		window.clearTimeout(timer);
	}
}

function postHeadAction(
	action: HeadMotionAction,
	payload: HeadMotionPayload,
	signal?: AbortSignal,
): Promise<Response> {
	return hardwareFetch(headApiUrl("/action"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, ...payload }),
		signal,
	});
}

export function triggerHeadMotionFromText(
	text: string,
	role: "user" | "assistant",
): void {
	if (role === "user") {
		const volumeDelta = inferHeadVolumeDelta(text);
		if (volumeDelta !== 0) {
			const settings = getSettings();
			const nextVolume = clamp(settings.robotHeadVolume + volumeDelta, 0, 1);
			setSettings({ robotHeadVolume: nextVolume });
			void setHeadSpeakerVolume(nextVolume).catch(() => {});
		}
	}
	const action = inferHeadMotionAction(text, role);
	if (action) {
		void triggerHeadMotion(action, { source: `text_${role}` });
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function isHeadSpeakerBusy(): boolean {
	return typeof window !== "undefined" && Date.now() < headSpeakerBusyUntil;
}

function estimateRawPcmDurationMs(
	audio: string,
	sampleRate: number,
	channels: number,
	bytesPerSample: number,
): number {
	try {
		const bytes = atob(audio).length;
		const frameBytes = Math.max(1, channels) * Math.max(1, bytesPerSample);
		return (bytes * 1000) / Math.max(1, sampleRate) / frameBytes;
	} catch {
		return 1200;
	}
}

function markHeadSpeakerBusy(
	audio: string,
	sampleRate: number,
	channels: number,
	bytesPerSample: number,
) {
	const durationMs = estimateRawPcmDurationMs(
		audio,
		sampleRate,
		channels,
		bytesPerSample,
	);
	headSpeakerBusyUntil = Math.max(
		headSpeakerBusyUntil,
		Date.now() + Math.min(15000, Math.max(900, durationMs + 900)),
	);
}

export function inferHeadVolumeDelta(text: string): number {
	const value = text.trim().toLowerCase();
	if (!value) return 0;
	if (/(小声|小一点声|小点声|声音小一点|音量小|轻一点|轻声|quiet|quieter|lower\s+volume|turn\s+down)/i.test(value)) {
		return -0.18;
	}
	if (/(大声|大一点声|大点声|声音大一点|音量大|响一点|loud|louder|higher\s+volume|turn\s+up)/i.test(value)) {
		return 0.18;
	}
	return 0;
}

export function inferHeadMotionAction(
	text: string,
	role: "user" | "assistant",
): HeadMotionAction | null {
	const value = text.trim().toLowerCase();
	if (!value) return null;

	if (/(不要|别|停止|不用).{0,8}(笑|动|眨|亲|转头|摇头|鬼脸)/.test(value)) {
		return null;
	}

	if (/(做.*鬼脸|鬼脸|make\s*a\s*face)/i.test(value)) return "makeface";
	if (/(眨左眼|左眼.*眨|blink\s*left)/i.test(value)) return "blink_left";
	if (/(眨右眼|右眼.*眨|blink\s*right)/i.test(value)) return "blink_right";
	if (/(眨眼|眨一下|blink)/i.test(value)) return "blink";
	if (/(转头|扭头|摇头|左右看|看.*左右|turn\s*neck)/i.test(value)) {
		return "turn_neck";
	}
	if (/(眼睛.*转|转.*眼睛|eyes?\s*rotate)/i.test(value)) return "eyes_rotate";
	if (/(亲一下|亲亲|亲一个|么么|kiss)/i.test(value)) return "kiss";
	if (/(伤心|难过|委屈|sad|不开心|想哭)/i.test(value)) return "sad";

	if (role === "user") {
		if (/(笑一个|笑一下|微笑|开心一点|smile)/i.test(value)) return "smile";
		return null;
	}

	if (/(哈哈|开心|高兴|好玩|笑|smile|happy)/i.test(value)) return "smile";
	return null;
}

export async function checkHeadBridge(): Promise<HeadBridgeHealth> {
	const response = await hardwareFetch(headApiUrl("/health"));
	const data = (await response.json()) as {
		ok?: boolean;
		health?: HeadBridgeHealth;
		error?: string;
	};
	if (!response.ok || data.ok === false) {
		throw new Error(data.error || data.health?.error || "Head bridge unavailable");
	}
	return (data.health ?? data) as HeadBridgeHealth;
}

export async function configureHeadBridge(
	headIp: string,
	options: { playbackVolume?: number } = {},
): Promise<HeadBridgeHealth> {
	const response = await hardwareFetch(headApiUrl("/config"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			head_ip: headIp.trim(),
			...(options.playbackVolume === undefined
				? {}
				: { playback_volume: Math.round(clamp(options.playbackVolume, 0, 1) * 31) }),
		}),
	});
	const data = (await response.json()) as HeadBridgeHealth;
	if (!response.ok || !data.ok) {
		throw new Error(data.error || "Head bridge config failed");
	}
	return data;
}

export async function setHeadSpeakerVolume(volume: number): Promise<HeadBridgeHealth> {
	const response = await hardwareFetch(headApiUrl("/config"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			playback_volume: Math.round(clamp(volume, 0, 1) * 31),
		}),
	});
	const data = (await response.json()) as HeadBridgeHealth;
	if (!response.ok || !data.ok) {
		throw new Error(data.error || "Head speaker volume update failed");
	}
	return data;
}

export async function startLocalHeadBridge(
	headIp: string,
	restart = false,
): Promise<LocalHeadBridgeStartResult> {
	if (!canUseSameOriginLocalServices()) {
		try {
			const config = await configureHeadBridge(headIp);
			const health = await checkHeadBridge().catch(() => config);
			return {
				ok: true,
				head_ip: headIp.trim(),
				endpoint: headApiBase(),
				started: false,
				config,
				health,
			};
		} catch (error) {
			throw new Error(
				`Local head bridge is not reachable from this browser. Start the AI-Lover local connector on this computer, keep the endpoint as ${headApiBase()}, then try again. ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	const response = await hardwareFetch("/api/local-services/head/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ head_ip: headIp.trim(), restart }),
	});
	const text = await response.text();
	let data: LocalHeadBridgeStartResult;
	try {
		data = JSON.parse(text) as LocalHeadBridgeStartResult;
	} catch {
		throw new Error(text.slice(0, 200) || "Head bridge start failed");
	}
	if (!response.ok || !data.ok) {
		throw new Error(
			data.error ||
				data.config?.error ||
				data.health?.error ||
				"Head bridge start failed",
		);
	}
	return data;
}

export async function playHeadSpeakerAudio(
	audio: string,
	options: {
		sampleRate?: number;
		channels?: number;
		bytesPerSample?: number;
		driveMouth?: boolean;
	} = {},
): Promise<boolean> {
	const settings = getSettings();
	if (!settings.robotHeadSpeakerEnabled || typeof window === "undefined") {
		return false;
	}
	const sampleRate = options.sampleRate ?? 16000;
	const channels = options.channels ?? 1;
	const bytesPerSample = options.bytesPerSample ?? 2;
	markHeadSpeakerBusy(audio, sampleRate, channels, bytesPerSample);
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), 2500);
	try {
		const response = await hardwareFetch(headApiUrl("/audio/play"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				audio,
				sample_rate: sampleRate,
				channels,
				bytes_per_sample: bytesPerSample,
				playback_volume: Math.round(clamp(settings.robotHeadVolume, 0, 1) * 31),
				drive_mouth: options.driveMouth !== false,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			console.warn("[head-speaker] bridge error", error);
			return false;
		}
		return true;
	} catch {
		// Head speaker playback should not interrupt the on-screen conversation.
		return false;
	} finally {
		window.clearTimeout(timer);
	}
}

export async function stopHeadSpeakerAudio(): Promise<void> {
	headSpeakerBusyUntil = 0;
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), 1500);
	try {
		await hardwareFetch(headApiUrl("/audio/stop"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			signal: controller.signal,
		});
	} catch {
		// Best-effort cleanup only.
	} finally {
		window.clearTimeout(timer);
	}
}

export async function captureHeadMicrophoneChunk(
	durationMs = 1000,
): Promise<HeadMicChunk> {
	const response = await hardwareFetch(headApiUrl("/audio/capture"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ duration_ms: durationMs }),
	});
	const data = (await response.json()) as HeadMicChunk & { error?: string };
	if (!response.ok || !data.ok) {
		throw new Error(data.error || "Head microphone capture failed");
	}
	return data;
}

export async function testHeadMicrophone(
	durationMs = 2000,
	playLocally = true,
): Promise<HeadMicTestResult> {
	const chunk = await captureHeadMicrophoneChunk(durationMs);
	const result = analyzeHeadMicChunk(chunk);
	if (playLocally && typeof window !== "undefined") {
		void playPcm16ChunkLocally(chunk).catch(() => {});
	}
	return result;
}

export function analyzeHeadMicChunk(chunk: HeadMicChunk): HeadMicTestResult {
	const samples = decodePcm16Base64(chunk.audio);
	if (!samples.length) {
		return { chunk, rms: 0, peak: 0, levelPercent: 0 };
	}

	let sumSquares = 0;
	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		const normalized = samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff);
		const abs = Math.abs(normalized);
		sumSquares += normalized * normalized;
		if (abs > peak) peak = abs;
	}
	const rms = Math.sqrt(sumSquares / samples.length);
	return {
		chunk,
		rms,
		peak,
		levelPercent: Math.min(100, Math.round(Math.max(rms * 300, peak * 100))),
	};
}

export async function playHeadTestTone(): Promise<void> {
	const sampleRate = 16000;
	const seconds = 0.85;
	const sampleCount = Math.floor(sampleRate * seconds);
	const pcm = new Int16Array(sampleCount);
	for (let i = 0; i < sampleCount; i++) {
		const fade = Math.min(i / 640, (sampleCount - i) / 640, 1);
		const frequency = i < sampleCount / 2 ? 660 : 880;
		pcm[i] = Math.round(
			Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 22000 * fade,
		);
	}
	const bytes = new Uint8Array(pcm.buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	const response = await hardwareFetch(headApiUrl("/audio/play"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			audio: btoa(binary),
			sample_rate: sampleRate,
			channels: 1,
			bytes_per_sample: 2,
			wait: true,
		}),
	});
	const data = await response.json().catch(() => null);
	if (!response.ok || !data?.ok) {
		throw new Error(data?.error || "Head speaker test failed");
	}
}

export function decodePcm16Base64(base64: string): Int16Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	const aligned = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
	return new Int16Array(aligned);
}

async function playPcm16ChunkLocally(chunk: HeadMicChunk): Promise<void> {
	const AudioContextClass =
		window.AudioContext ||
		(window as unknown as { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;
	if (!AudioContextClass) return;

	const samples = decodePcm16Base64(chunk.audio);
	if (!samples.length) return;

	const context = new AudioContextClass({ sampleRate: chunk.sample_rate });
	const buffer = context.createBuffer(1, samples.length, chunk.sample_rate);
	const channel = buffer.getChannelData(0);
	for (let i = 0; i < samples.length; i++) {
		channel[i] = samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff);
	}

	const source = context.createBufferSource();
	source.buffer = buffer;
	source.connect(context.destination);
	await context.resume().catch(() => {});
	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			resolve();
		};
		const timer = window.setTimeout(
			finish,
			Math.ceil((samples.length / chunk.sample_rate) * 1000) + 700,
		);
		source.onended = finish;
		try {
			source.start();
		} catch {
			finish();
		}
	});
	void context.close().catch(() => {});
}

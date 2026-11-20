"use client";

import { getSettings } from "@/lib/settingsStore";

type DeviceBridgeStatusListener = (status: DeviceBridgeStatus) => void;

export interface DeviceBridgeStatus {
	connected: boolean;
	deviceName?: string;
	connectedAt?: string | null;
	error?: string;
}

export interface DeviceBridgeTestResult {
	ok: boolean;
	connected: boolean;
	head?: { ok: boolean; status: number; data?: unknown; error?: string };
	hand?: { ok: boolean; status: number; data?: unknown; error?: string };
	gpu?: { ok: boolean; status: number; data?: unknown; error?: string };
	error?: string;
}

interface PendingRequest {
	resolve: (response: Response) => void;
	reject: (error: Error) => void;
	timer: number;
}

interface PendingPong {
	resolve: (status: DeviceBridgeStatus) => void;
	reject: (error: Error) => void;
	timer: number;
}

const REQUEST_TIMEOUT_MS = 180000;
const CONNECT_TIMEOUT_MS = 9000;

let socket: WebSocket | null = null;
let connectPromise: Promise<WebSocket> | null = null;
let socketKey = "";
let status: DeviceBridgeStatus = { connected: false };
const listeners = new Set<DeviceBridgeStatusListener>();
const pendingRequests = new Map<string, PendingRequest>();
const pendingPongs = new Map<string, PendingPong>();

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

export function isPublicPageHost(): boolean {
	if (typeof window === "undefined") return false;
	return !isPrivateOrLocalHost(window.location.hostname);
}

export function isDeviceBridgeEnabled(): boolean {
	if (typeof window === "undefined") return false;
	const settings = getSettings();
	return Boolean(
		settings.localConnectorEnabled &&
			settings.localConnectorPairingCode.trim(),
	);
}

export function generateDeviceBridgePairingCode(): string {
	const bytes = new Uint8Array(5);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => (byte % 36).toString(36))
		.join("")
		.toUpperCase();
}

function normalizeWebSocketUrl(value: string): string {
	if (typeof window === "undefined") return value;
	const trimmed = value.trim();
	if (trimmed) return trimmed;
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/device-bridge`;
}

export function getDeviceBridgeWebSocketUrl(): string {
	const settings = getSettings();
	const base = normalizeWebSocketUrl(settings.localConnectorBridgeUrl || "");
	const url = new URL(base, window.location.href);
	url.searchParams.set("role", "browser");
	url.searchParams.set("pairingCode", settings.localConnectorPairingCode.trim());
	return url.toString();
}

export function getLocalConnectorCommand(): string {
	const settings = getSettings();
	const code = settings.localConnectorPairingCode.trim() || "<配对码>";
	const name = settings.localConnectorDeviceName.trim() || "AI-Lover Local Connector";
	if (typeof window === "undefined") {
		return `node tools/local-connector/ai-lover-local-connector.js --bridge "wss://ai.vituralmodel.com/device-bridge" --code "${code}" --name "${name}"`;
	}
	const bridgeUrl = normalizeWebSocketUrl(settings.localConnectorBridgeUrl || "");
	const url = new URL(bridgeUrl, window.location.href);
	url.searchParams.delete("role");
	url.searchParams.delete("pairingCode");
	url.searchParams.delete("code");
	return `node tools/local-connector/ai-lover-local-connector.js --bridge "${url.toString()}" --code "${code}" --name "${name}"`;
}

export function subscribeDeviceBridgeStatus(
	listener: DeviceBridgeStatusListener,
): () => void {
	listeners.add(listener);
	listener(status);
	return () => listeners.delete(listener);
}

function emitStatus(next: DeviceBridgeStatus) {
	status = next;
	for (const listener of listeners) {
		listener(status);
	}
}

function closeSocketForKeyChange() {
	if (socket) {
		socket.close();
		socket = null;
	}
	connectPromise = null;
	socketKey = "";
}

function rejectAllPending(error: Error) {
	for (const pending of pendingRequests.values()) {
		clearTimeout(pending.timer);
		pending.reject(error);
	}
	pendingRequests.clear();
	for (const pending of pendingPongs.values()) {
		clearTimeout(pending.timer);
		pending.reject(error);
	}
	pendingPongs.clear();
}

function createRequestId(): string {
	if (crypto.randomUUID) return crypto.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value || "");
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function bodyToBase64(body: BodyInit | null | undefined): Promise<string> {
	if (body == null) return "";
	if (typeof body === "string") {
		return bytesToBase64(new TextEncoder().encode(body));
	}
	if (body instanceof URLSearchParams) {
		return bytesToBase64(new TextEncoder().encode(body.toString()));
	}
	if (body instanceof Blob) {
		return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
	}
	if (body instanceof ArrayBuffer) {
		return bytesToBase64(new Uint8Array(body));
	}
	if (ArrayBuffer.isView(body)) {
		return bytesToBase64(
			new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
		);
	}
	throw new Error("Device bridge only supports string/blob/binary request bodies");
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
	if (!headers) return {};
	const result: Record<string, string> = {};
	const source = new Headers(headers);
	source.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}

function toBridgePath(input: RequestInfo | URL): string {
	const value =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	if (value.startsWith("/api/local-services/")) return value;
	const url = new URL(value, window.location.href);
	if (url.origin === window.location.origin) {
		return `${url.pathname}${url.search}`;
	}
	throw new Error("Device bridge only accepts same-origin local service paths");
}

export function shouldUseDeviceBridgeForUrl(input: RequestInfo | URL): boolean {
	if (!isDeviceBridgeEnabled()) return false;
	try {
		return toBridgePath(input).startsWith("/api/local-services/");
	} catch {
		return false;
	}
}

function ensureDeviceBridgeSocket(): Promise<WebSocket> {
	if (!isDeviceBridgeEnabled()) {
		return Promise.reject(new Error("Local connector is not enabled"));
	}
	const nextKey = getDeviceBridgeWebSocketUrl();
	if (socketKey && socketKey !== nextKey) {
		closeSocketForKeyChange();
	}
	if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
	if (connectPromise) return connectPromise;

	socketKey = nextKey;
	connectPromise = new Promise((resolve, reject) => {
		const ws = new WebSocket(nextKey);
		let settled = false;
		const timer = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			ws.close();
			reject(new Error("Local connector WebSocket timed out"));
		}, CONNECT_TIMEOUT_MS);

		ws.onopen = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			socket = ws;
			emitStatus({ connected: false });
			resolve(ws);
		};
		ws.onerror = () => {
			if (!settled) {
				settled = true;
				window.clearTimeout(timer);
				reject(new Error("Local connector WebSocket failed"));
			}
		};
		ws.onclose = () => {
			if (socket === ws) socket = null;
			connectPromise = null;
			emitStatus({ connected: false, error: "Local connector disconnected" });
			rejectAllPending(new Error("Local connector disconnected"));
		};
		ws.onmessage = (event) => {
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (message.type === "device.status") {
				emitStatus({
					connected: Boolean(message.connected),
					deviceName:
						typeof message.deviceName === "string" ? message.deviceName : "",
					connectedAt:
						typeof message.connectedAt === "string"
							? message.connectedAt
							: null,
				});
				return;
			}
			if (message.type === "bridge.pong") {
				const pending = pendingPongs.get(String(message.id || ""));
				if (!pending) return;
				clearTimeout(pending.timer);
				pendingPongs.delete(String(message.id || ""));
				pending.resolve({
					connected: Boolean(message.connected),
					deviceName:
						typeof message.deviceName === "string" ? message.deviceName : "",
					connectedAt:
						typeof message.connectedAt === "string"
							? message.connectedAt
							: null,
				});
				return;
			}
			if (message.type !== "bridge.response") return;
			const id = String(message.id || "");
			const pending = pendingRequests.get(id);
			if (!pending) return;
			clearTimeout(pending.timer);
			pendingRequests.delete(id);
			const headers = new Headers(
				(message.headers || {}) as Record<string, string>,
			);
			const body = base64ToBytes(String(message.bodyBase64 || ""));
			const responseBody = body.buffer.slice(
				body.byteOffset,
				body.byteOffset + body.byteLength,
			) as ArrayBuffer;
			pending.resolve(
				new Response(responseBody, {
					status: Number(message.status) || 502,
					headers,
				}),
			);
		};
	});
	return connectPromise;
}

export async function deviceBridgeFetch(
	input: RequestInfo | URL,
	init: RequestInit = {},
): Promise<Response> {
	const ws = await ensureDeviceBridgeSocket();
	const path = toBridgePath(input);
	const id = createRequestId();
	const method = String(init.method || "GET").toUpperCase();
	const bodyBase64 = await bodyToBase64(init.body);
	const headers = headersToObject(init.headers);

	return new Promise<Response>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			pendingRequests.delete(id);
			reject(new Error("Local connector request timed out"));
		}, REQUEST_TIMEOUT_MS);
		pendingRequests.set(id, { resolve, reject, timer });
		ws.send(
			JSON.stringify({
				type: "bridge.request",
				id,
				method,
				path,
				headers,
				bodyBase64,
			}),
		);
	});
}

export function hardwareFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	if (shouldUseDeviceBridgeForUrl(input)) {
		return deviceBridgeFetch(input, init);
	}
	return fetch(input, init);
}

export async function pingDeviceBridge(): Promise<DeviceBridgeStatus> {
	const ws = await ensureDeviceBridgeSocket();
	const id = createRequestId();
	return new Promise<DeviceBridgeStatus>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			pendingPongs.delete(id);
			reject(new Error("Local connector ping timed out"));
		}, 5000);
		pendingPongs.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ type: "bridge.ping", id }));
	});
}

async function readBridgeJson(response: Response) {
	const text = await response.text();
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return text;
	}
}

export async function testDeviceBridge(): Promise<DeviceBridgeTestResult> {
	try {
		const bridge = await pingDeviceBridge();
		const [headResult, handResult, gpuResult] = await Promise.all([
			deviceBridgeFetch("/api/local-services/head/health")
				.then(async (response) => ({
					ok: response.ok,
					status: response.status,
					data: await readBridgeJson(response),
				}))
				.catch((error: unknown) => ({
					ok: false,
					status: 0,
					error: error instanceof Error ? error.message : String(error),
				})),
			deviceBridgeFetch("/api/local-services/hand/health")
				.then(async (response) => ({
					ok: response.ok,
					status: response.status,
					data: await readBridgeJson(response),
				}))
				.catch((error: unknown) => ({
					ok: false,
					status: 0,
					error: error instanceof Error ? error.message : String(error),
				})),
			deviceBridgeFetch("/api/local-services/gpu-avatar/health")
				.then(async (response) => ({
					ok: response.ok,
					status: response.status,
					data: await readBridgeJson(response),
				}))
				.catch((error: unknown) => ({
					ok: false,
					status: 0,
					error: error instanceof Error ? error.message : String(error),
				})),
		]);
		return {
			ok: bridge.connected,
			connected: bridge.connected,
			head: headResult,
			hand: handResult,
			gpu: gpuResult,
		};
	} catch (error) {
		return {
			ok: false,
			connected: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

import { getSettings } from "@/lib/settingsStore";
import { hardwareFetch, isDeviceBridgeEnabled } from "@/lib/deviceBridge";

const LOCAL_HAND_API = "/api/local-services/hand";

type HandApiRoute =
	| "health"
	| "ports"
	| "snapshot"
	| "config"
	| "recognitionStart"
	| "recognitionStop"
	| "action"
	| "history"
	| "demoStart"
	| "demoStop"
	| "playStart"
	| "playStop"
	| "orcaPose";

const LOCAL_HAND_PATHS: Record<HandApiRoute, string> = {
	health: "/health",
	ports: "/ports",
	snapshot: "/snapshot",
	config: "/config",
	recognitionStart: "/recognition/start",
	recognitionStop: "/recognition/stop",
	action: "/action",
	history: "/history",
	demoStart: "/demo/start",
	demoStop: "/demo/stop",
	playStart: "/play/start",
	playStop: "/play/stop",
	orcaPose: "/orca/pose",
};

const DIRECT_HAND_PATHS: Record<HandApiRoute, string> = {
	health: "/health",
	ports: "/ports",
	snapshot: "/snapshot",
	config: "/config",
	recognitionStart: "/start",
	recognitionStop: "/stop",
	action: "/action",
	history: "/history",
	demoStart: "/arduino/demo/start",
	demoStop: "/arduino/demo/stop",
	playStart: "/arduino/play/start",
	playStop: "/arduino/play/stop",
	orcaPose: "/orca/pose",
};

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function handApiBase(): string {
	if (isDeviceBridgeEnabled()) return LOCAL_HAND_API;
	const endpoint = trimTrailingSlash(getSettings().handGestureEndpoint || "");
	return endpoint || LOCAL_HAND_API;
}

function isLocalServicesProxy(base = handApiBase()): boolean {
	return base.startsWith("/api/local-services/");
}

function handApiUrl(route: HandApiRoute, query = ""): string {
	const base = handApiBase();
	const path = (isLocalServicesProxy(base) ? LOCAL_HAND_PATHS : DIRECT_HAND_PATHS)[
		route
	];
	return `${base}${path}${query}`;
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

export interface HandGestureDependency {
	ok: boolean;
	version?: string;
	error?: string;
	optional?: boolean;
}

export interface HandGestureHealth {
	ok: boolean;
	worker?: string;
	running?: boolean;
	error?: string;
	config?: {
		camera_index?: number;
		baud?: number;
		arduino_ports?: string[];
		active_arduino_ports?: string[];
		dry_run?: boolean;
		arduino_enabled?: boolean;
		arduino_continuous_enabled?: boolean;
		arduino_angle_protocol_enabled?: boolean;
		arduino_open_angles?: number[];
		arduino_closed_angles?: number[];
		arduino_min_angles?: number[];
		arduino_max_angles?: number[];
		orca_enabled?: boolean;
		orca_config_port?: string;
		orca_runtime_port?: string;
		orca_direct_joint_enabled?: boolean;
		orca_wrist_follow_enabled?: boolean;
		orca_pose_smoothing?: number;
		send_interval_ms?: number;
		finger_smoothing?: number;
		finger_send_threshold?: number;
		finger_open_threshold?: number;
		finger_closed_threshold?: number;
		finger_max_step?: number;
		continuous_heartbeat_ms?: number;
		model_path?: string;
		urdf_path?: string;
	};
	last_pattern?: string;
	last_bends?: number[];
	last_angles?: number[];
	detected?: boolean;
	hand_type?: string | null;
	landmark_count?: number;
	frames?: number;
	fps?: number;
	stage?: string;
	snapshot_at?: number;
	history_count?: number;
	history_path?: string;
	demo?: { running?: boolean };
	play?: { running?: boolean };
	dependencies?: Record<string, HandGestureDependency>;
	serial_ports?: HandGesturePort[];
	actions?: string[];
	pattern_order?: string[];
	orca?: {
		enabled?: boolean;
		requested_enabled?: boolean;
		running?: boolean;
		status?: string;
		error?: string;
		mode?: string;
		last_joint_count?: number;
		last_wrist_angle?: number | null;
	};
}

export interface HandGesturePort {
	device: string;
	description?: string;
	hwid?: string;
}

export interface HandGestureStartOptions {
	camera_index?: number;
	arduino_ports?: string[];
	baud?: number;
	dry_run?: boolean;
	arduino_enabled?: boolean;
	arduino_continuous_enabled?: boolean;
	arduino_angle_protocol_enabled?: boolean;
	arduino_open_angles?: number[];
	arduino_closed_angles?: number[];
	arduino_min_angles?: number[];
	arduino_max_angles?: number[];
	orca_enabled?: boolean;
	orca_port?: string;
	orca_direct_joint_enabled?: boolean;
	orca_wrist_follow_enabled?: boolean;
	orca_pose_smoothing?: number;
	send_interval_ms?: number;
	finger_smoothing?: number;
	finger_send_threshold?: number;
	finger_open_threshold?: number;
	finger_closed_threshold?: number;
	finger_max_step?: number;
	continuous_heartbeat_ms?: number;
	package_root?: string;
	model_path?: string;
	urdf_path?: string;
	history_path?: string;
}

export interface HandMotionHistoryItem {
	ts: number;
	source?: string;
	pattern: string;
	hand_type?: string | null;
	detected?: boolean;
	landmark_count?: number;
	landmarks?: Array<{ x: number; y: number; z?: number }>;
	finger_bends?: number[];
	arduino_angles?: number[];
	note?: {
		index?: number;
		value?: number;
		name?: string;
		duration?: number;
	};
}

export interface LocalHandGestureBridgeStartResult {
	ok: boolean;
	endpoint: string;
	started?: boolean;
	error?: string;
	health?: HandGestureHealth;
	config?: HandGestureHealth;
}

async function readJson<T>(response: Response): Promise<T> {
	const text = await response.text();
	let data: { ok?: boolean; error?: string } = {};
	try {
		data = (text ? JSON.parse(text) : {}) as {
			ok?: boolean;
			error?: string;
		};
	} catch {
		throw new Error(text.slice(0, 180) || "Gesture bridge returned non-JSON");
	}
	if (!response.ok || data?.ok === false) {
		throw new Error(data?.error || `Gesture bridge HTTP ${response.status}`);
	}
	return data as T;
}

export async function startLocalHandGestureBridge(
	options: HandGestureStartOptions = {},
	restart = false,
): Promise<LocalHandGestureBridgeStartResult> {
	if (!canUseSameOriginLocalServices()) {
		try {
			const response = await hardwareFetch(handApiUrl("config"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(options),
			});
			const health = await readJson<HandGestureHealth>(response);
			return {
				ok: true,
				endpoint: handApiBase(),
				started: false,
				config: health,
				health,
			};
		} catch (error) {
			throw new Error(
				`Local hand bridge is not reachable from this browser. Start the AI-Lover local connector on this computer, keep the endpoint as ${handApiBase()}, then try again. ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	const response = await hardwareFetch("/api/local-services/hand/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...options, restart }),
	});
	return readJson<LocalHandGestureBridgeStartResult>(response);
}

export async function checkHandGestureBridge(): Promise<HandGestureHealth> {
	try {
		const response = await hardwareFetch(handApiUrl("health"));
		const data = await readJson<{
			ok: boolean;
			health?: HandGestureHealth;
			error?: string;
		}>(response);
		return (data.health ?? data) as HandGestureHealth;
	} catch {
		await startLocalHandGestureBridge();
		const response = await hardwareFetch(handApiUrl("health"));
		const data = await readJson<{
			ok: boolean;
			health?: HandGestureHealth;
			error?: string;
		}>(response);
		return (data.health ?? data) as HandGestureHealth;
	}
}

export async function listHandGesturePorts(): Promise<HandGesturePort[]> {
	let response: Response;
	try {
		response = await hardwareFetch(handApiUrl("ports"));
	} catch {
		await startLocalHandGestureBridge();
		response = await hardwareFetch(handApiUrl("ports"));
	}
	const data = await readJson<{ ok: boolean; ports: HandGesturePort[] }>(response);
	return data.ports || [];
}

export function getHandGestureSnapshotUrl(): string {
	return handApiUrl("snapshot");
}

export async function startHandGestureBridge(
	options: HandGestureStartOptions,
): Promise<HandGestureHealth> {
	const response = await hardwareFetch(handApiUrl("recognitionStart"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
	return readJson<HandGestureHealth>(response);
}

export async function stopHandGestureBridge(): Promise<HandGestureHealth> {
	const response = await hardwareFetch(handApiUrl("recognitionStop"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	return readJson<HandGestureHealth>(response);
}

export async function sendHandGestureAction(
	action: string,
	pattern?: string,
	landmarks?: Array<{ x: number; y: number; z?: number }>,
	handType?: string | null,
	source?: string,
): Promise<{
	ok: boolean;
	action?: string;
	pattern: string;
	finger_bends?: number[];
	arduino_angles?: number[];
	dry_run?: boolean;
	delivered?: boolean;
	landmarks?: number;
	serial?: {
		ok?: boolean;
		dry_run?: boolean;
		delivered?: boolean;
		continuous?: boolean;
		pattern?: string;
		payload?: string;
		bends?: number[];
		angles?: number[];
		error?: string;
	};
	orca?: {
		ok?: boolean;
		dry_run?: boolean;
		delivered?: boolean;
		pattern?: string;
		status?: string;
		mode?: string;
		landmarks?: number;
		error?: string;
	};
}> {
	const response = await hardwareFetch(handApiUrl("action"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			action,
			pattern,
			landmarks,
			hand_type: handType,
			source,
		}),
	});
	return readJson(response);
}

export async function startArduinoHandDemo(): Promise<{
	ok: boolean;
	running?: boolean;
	mode?: string;
	sequence?: string[];
}> {
	const response = await hardwareFetch(handApiUrl("demoStart"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	return readJson(response);
}

export async function stopArduinoHandDemo(): Promise<{
	ok: boolean;
	running?: boolean;
	mode?: string;
}> {
	const response = await hardwareFetch(handApiUrl("demoStop"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	return readJson(response);
}

export async function startArduinoHandPlay(): Promise<{
	ok: boolean;
	running?: boolean;
	mode?: string;
	notes?: number[];
}> {
	const response = await hardwareFetch(handApiUrl("playStart"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	return readJson(response);
}

export async function stopArduinoHandPlay(): Promise<{
	ok: boolean;
	running?: boolean;
	mode?: string;
}> {
	const response = await hardwareFetch(handApiUrl("playStop"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	return readJson(response);
}

export async function listHandMotionHistory(
	limit = 120,
): Promise<{ ok: boolean; path?: string; items: HandMotionHistoryItem[] }> {
	const response = await hardwareFetch(
		handApiUrl("history", `?limit=${encodeURIComponent(limit)}`),
	);
	return readJson(response);
}

export async function sendOrcaPose(
	pose: Record<string, number>,
): Promise<{
	ok: boolean;
	dry_run?: boolean;
	delivered?: boolean;
	pending?: boolean;
	queued?: boolean;
	mode?: string;
	joints?: number;
	status?: string;
	error?: string;
}> {
	const response = await hardwareFetch(handApiUrl("orcaPose"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pose }),
	});
	return readJson(response);
}

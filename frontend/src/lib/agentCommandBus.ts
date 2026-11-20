import { sendHandGestureAction } from "@/lib/handGesture";
import {
	sendHeadAction,
	setHeadSpeakerVolume,
	triggerHeadMotion,
} from "@/lib/headMotion";
import { getSettings, setSettings } from "@/lib/settingsStore";
import { useAgentStore } from "@/store/agentStore";

export type AgentCommandRole = "user" | "assistant" | "system";
export type AgentCommandSource = "rule" | "assistant_tool" | "server_cmd";
export type AgentCommandTarget = "head" | "hand" | "settings";

export interface AgentCommand {
	target: AgentCommandTarget;
	action: string;
	args?: Record<string, unknown>;
	source?: AgentCommandSource;
	requestId?: string;
	confidence?: number;
}

export interface AgentCommandResult {
	ok: boolean;
	command: AgentCommand;
	preview: string;
	error?: string;
}

type RawCommand = Partial<AgentCommand> & {
	command?: string;
	name?: string;
	tool?: string;
	parameters?: Record<string, unknown>;
};

const COMMAND_COMMENT_RE =
	/<!--\s*(?:xiaoling-command|agent-command|client-control)\s*([\s\S]*?)\s*-->/gi;
const COMMAND_FENCE_RE =
	/```(?:xiaoling-command|agent-command|client-control)\s*([\s\S]*?)```/gi;
const VOLUME_ACK_TEXT = "\u597d\u7684";
const VOLUME_CONFIRM_TEXT =
	"\u6211\u73b0\u5728\u7684\u58f0\u97f3\u5927\u5c0f\u53ef\u4ee5\u5417\uff1f";

let volumeAdjustmentChain: Promise<void> = Promise.resolve();
let lastVolumeAdjustmentAt = 0;
let lastVolumeAdjustmentDirection = 0;

export function stripAgentCommandMarkup(text: string): string {
	return text
		.replace(COMMAND_COMMENT_RE, "")
		.replace(COMMAND_FENCE_RE, "")
		.trim();
}

export function isStandaloneVolumeAdjustmentRequest(text: string): boolean {
	const value = text.trim().toLowerCase();
	if (!value || inferVolumeDelta(value) === 0) return false;
	return (
		/^(please\s+)?(speak\s+)?(a\s+little\s+)?(louder|quieter|lower\s+volume|turn\s+(up|down))( please)?[.!?。！？，,]*$/i.test(
			value,
		) ||
		/^(请|麻烦)?(你)?(说话|声音|音量)?(再|稍微|有点)?(小声|大声|小一点|大一点|小点|大点|小一点声|大一点声|小点声|大点声|轻一点|响一点|低一点|高一点|调小|调大|变小|变大)(一点|点|些)?(吧|吗|呢)?[。！？，,]*$/.test(
			value,
		)
	);
}

export function inferAgentCommandsFromText(
	text: string,
	role: AgentCommandRole,
): AgentCommand[] {
	const commands = [
		...extractStructuredCommands(
			text,
			role === "system" ? "server_cmd" : "assistant_tool",
		),
		...inferRuleCommands(text, role),
	];
	return dedupeCommands(commands);
}

export function normalizeAgentCommands(
	payload: unknown,
	source: AgentCommandSource = "server_cmd",
): AgentCommand[] {
	if (!payload) return [];
	if (Array.isArray(payload)) {
		return dedupeCommands(
			payload.flatMap((item) => normalizeAgentCommands(item, source)),
		);
	}
	if (typeof payload === "string") {
		const parsed = tryParseJson(payload);
		return parsed ? normalizeAgentCommands(parsed, source) : [];
	}
	if (typeof payload !== "object") return [];

	const record = payload as Record<string, unknown>;
	if (Array.isArray(record.commands)) {
		return dedupeCommands(
			record.commands.flatMap((item) => normalizeAgentCommands(item, source)),
		);
	}

	const command = coerceCommand(record as RawCommand, source);
	return command ? [command] : [];
}

export async function executeAgentCommand(
	command: AgentCommand,
): Promise<AgentCommandResult> {
	try {
		const normalized = normalizeAction(command);
		if (!normalized) {
			return {
				ok: false,
				command,
				preview: "ignored",
				error: "unsupported command",
			};
		}
		switch (normalized.target) {
			case "head":
				return await executeHeadCommand(normalized);
			case "hand":
				return await executeHandCommand(normalized);
			case "settings":
				return await executeSettingsCommand(normalized);
			default:
				return {
					ok: false,
					command: normalized,
					preview: "ignored",
					error: "unsupported target",
				};
		}
	} catch (error) {
		return {
			ok: false,
			command,
			preview: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeCommandsFromText(
	text: string,
	role: AgentCommandRole,
): Promise<AgentCommandResult[]> {
	const commands = inferAgentCommandsFromText(text, role);
	const results: AgentCommandResult[] = [];
	for (const command of commands) {
		results.push(await executeAgentCommand(command));
	}
	return results;
}

function extractStructuredCommands(
	text: string,
	source: AgentCommandSource,
): AgentCommand[] {
	const commands: AgentCommand[] = [];
	for (const match of text.matchAll(COMMAND_COMMENT_RE)) {
		commands.push(...normalizeAgentCommands(match[1], source));
	}
	for (const match of text.matchAll(COMMAND_FENCE_RE)) {
		commands.push(...normalizeAgentCommands(match[1], source));
	}
	return commands;
}

function inferRuleCommands(text: string, role: AgentCommandRole): AgentCommand[] {
	const value = text.trim().toLowerCase();
	if (!value) return [];

	const commands: AgentCommand[] = [];
	const push = (
		target: AgentCommandTarget,
		action: string,
		args?: Record<string, unknown>,
		confidence = 0.86,
	) => {
		commands.push({ target, action, args, source: "rule", confidence });
	};

	const isUser = role === "user";
	const isAssistant = role === "assistant";

	if (isUser) {
		const volumeDelta = inferVolumeDelta(value);
		if (volumeDelta !== 0) {
			push("head", "set_volume", { delta: volumeDelta }, 0.9);
		}

		const replyLanguage = inferReplyLanguage(value);
		if (replyLanguage) {
			push("settings", "set_reply_language", { language: replyLanguage }, 0.82);
		}

		if (isEnableRequest(value) && hasHeadSpeakerTerm(value)) {
			push("settings", "set_head_speaker", { enabled: true });
		}
		if (isDisableRequest(value) && hasHeadSpeakerTerm(value)) {
			push("settings", "set_head_speaker", { enabled: false });
		}
		if (isEnableRequest(value) && hasCameraTerm(value)) {
			push("settings", "set_camera", { enabled: true });
		}
		if (isDisableRequest(value) && hasCameraTerm(value)) {
			push("settings", "set_camera", { enabled: false });
		}
		if (isUseRequest(value) && hasHeadMicTerm(value)) {
			push("settings", "set_head_mic", { enabled: true });
		}
		if (isUseRequest(value) && hasComputerMicTerm(value)) {
			push("settings", "set_computer_mic", { enabled: true });
		}
	}

	if (isUser || isAssistant) {
		const headAction = inferHeadAction(value, role);
		if (headAction) push("head", headAction, undefined, 0.88);
		const handCommand = inferHandCommand(value);
		if (handCommand) push("hand", handCommand.action, handCommand.args, 0.86);
	}

	return commands;
}

function inferVolumeDelta(value: string): number {
	if (
		hasAny(value, [
			"\u5c0f\u58f0",
			"\u5c0f\u4e00\u70b9\u58f0",
			"\u5c0f\u70b9\u58f0",
			"\u58f0\u97f3\u5c0f\u4e00\u70b9",
			"\u97f3\u91cf\u5c0f",
			"\u8f7b\u4e00\u70b9",
			"\u8f7b\u58f0",
		]) ||
		/(quiet|quieter|lower\s+volume|turn\s+down)/i.test(value)
	) {
		return -0.18;
	}
	if (
		hasAny(value, [
			"\u5927\u58f0",
			"\u5927\u4e00\u70b9\u58f0",
			"\u5927\u70b9\u58f0",
			"\u58f0\u97f3\u5927\u4e00\u70b9",
			"\u97f3\u91cf\u5927",
			"\u54cd\u4e00\u70b9",
		]) ||
		/(loud|louder|higher\s+volume|turn\s+up)/i.test(value)
	) {
		return 0.18;
	}
	return 0;
}

function inferReplyLanguage(value: string): string | null {
	const wantsSwitch =
		hasAny(value, [
			"\u8bf4",
			"\u8bb2",
			"\u7528",
			"\u6362\u6210",
			"\u5207\u6362",
			"\u8ddf\u6211\u8bf4",
		]) || /\bspeak\b|\bsay\b|\buse\b|\bswitch\b/i.test(value);
	if (!wantsSwitch) return null;
	if (
		hasAny(value, ["\u82f1\u8bed", "\u82f1\u6587", "\u5916\u8bed"]) ||
		/english/i.test(value)
	) {
		return "en";
	}
	if (hasAny(value, ["\u65e5\u8bed", "\u65e5\u6587"]) || /japanese/i.test(value)) return "ja";
	if (hasAny(value, ["\u97e9\u8bed", "\u97e9\u6587"]) || /korean/i.test(value)) return "ko";
	if (hasAny(value, ["\u6cd5\u8bed", "\u6cd5\u6587"]) || /french/i.test(value)) return "fr";
	if (hasAny(value, ["\u5fb7\u8bed", "\u5fb7\u6587"]) || /german/i.test(value)) return "de";
	if (hasAny(value, ["\u897f\u73ed\u7259\u8bed"]) || /spanish/i.test(value)) return "es";
	if (
		hasAny(value, ["\u4e2d\u6587", "\u666e\u901a\u8bdd", "\u6c49\u8bed"]) ||
		/chinese/i.test(value)
	) {
		return "zh";
	}
	return null;
}

function inferHeadAction(
	value: string,
	role: AgentCommandRole,
): string | null {
	if (
		hasAny(value, ["\u9b3c\u8138", "\u505a\u4e2a\u9b3c\u8138"]) ||
		/make\s*a\s*face/i.test(value)
	) {
		return "makeface";
	}
	if (
		hasAny(value, ["\u4eb2\u4e00\u4e0b", "\u4eb2\u4eb2", "\u4eb2\u543b", "\u98de\u543b"]) ||
		/kiss/i.test(value)
	) {
		return "kiss";
	}
	if (hasAny(value, ["\u7728\u5de6\u773c"]) || /blink\s*left/i.test(value)) return "blink_left";
	if (hasAny(value, ["\u7728\u53f3\u773c"]) || /blink\s*right/i.test(value)) return "blink_right";
	if (hasAny(value, ["\u7728\u773c", "\u7728\u4e00\u4e0b"]) || /blink/i.test(value)) return "blink";
	if (
		hasAny(value, [
			"\u590d\u4f4d",
			"\u6062\u590d\u9ed8\u8ba4",
			"\u56de\u6b63",
			"\u521d\u59cb\u5316",
		]) ||
		/reset|init/i.test(value)
	) {
		return "init";
	}
	if (
		hasAny(value, ["\u8f6c\u5934", "\u8116\u5b50\u52a8\u4e00\u4e0b"]) ||
		/turn\s*neck/i.test(value)
	) {
		return "turn_neck";
	}
	if (
		hasAny(value, ["\u8f6c\u773c", "\u773c\u775b\u8f6c\u4e00\u4e0b"]) ||
		/eyes?\s*rotate/i.test(value)
	) {
		return "eyes_rotate";
	}
	if (hasAny(value, ["\u4f24\u5fc3", "\u96be\u8fc7"]) || /sad/i.test(value)) return "sad";
	if (
		hasAny(value, [
			"\u7b11\u4e00\u4e0b",
			"\u7b11\u4e00\u7b11",
			"\u5fae\u7b11",
			"\u5f00\u5fc3\u4e00\u70b9",
		]) ||
		/smile/i.test(value)
	) {
		return "smile";
	}
	if (
		role === "assistant" &&
		(hasAny(value, ["\u54c8\u54c8", "\u5f00\u5fc3", "\u9ad8\u5174", "\u597d\u73a9", "\u7b11"]) ||
			/smile|happy/i.test(value))
	) {
		return "smile";
	}
	return null;
}

function inferHandCommand(
	value: string,
): { action: string; args?: Record<string, unknown> } | null {
	if (
		hasAny(value, [
			"\u5f20\u5f00\u624b",
			"\u6253\u5f00\u624b",
			"\u4e94\u6307\u5f20\u5f00",
			"\u677e\u5f00\u624b",
		]) ||
		/open\s*hand/i.test(value)
	) {
		return { action: "open" };
	}
	if (hasAny(value, ["\u63e1\u62f3", "\u6505\u62f3", "\u62f3\u5934"]) || /fist/i.test(value)) return { action: "fist" };
	if (
		hasAny(value, [
			"\u653e\u677e\u624b",
			"\u624b\u653e\u677e",
			"\u505c\u6b62\u624b",
			"\u624b\u505c",
		]) ||
		/relax\s*hand|stop\s*hand/i.test(value)
	) {
		return { action: "relax" };
	}
	if (hasAny(value, ["\u4f38\u98df\u6307", "\u6307\u4e00\u4e0b"]) || /point/i.test(value)) return { action: "point" };
	if (hasAny(value, ["\u6bd4\u8036", "\u526a\u5200\u624b"]) || /two|peace/i.test(value)) return { action: "two" };
	if (hasAny(value, ["\u4e09\u6839\u624b\u6307"]) || /three/i.test(value)) return { action: "three" };
	if (hasAny(value, ["\u56db\u6839\u624b\u6307"]) || /four/i.test(value)) return { action: "four" };
	if (hasAny(value, ["\u5927\u62c7\u6307"]) || /thumb/i.test(value)) return { action: "thumb" };
	if (hasAny(value, ["\u634f\u4e00\u4e0b"]) || /pinch/i.test(value)) return { action: "pinch" };
	const pattern = value.match(/\b[01]{6}\b/);
	if (
		pattern &&
		(hasAny(value, ["\u624b", "\u673a\u68b0\u624b"]) || /hand|pattern/i.test(value))
	) {
		return { action: "pattern", args: { pattern: pattern[0] } };
	}
	return null;
}

function tryParseJson(value: string): unknown | null {
	try {
		return JSON.parse(value.trim());
	} catch {
		return null;
	}
}

function coerceCommand(
	raw: RawCommand,
	source: AgentCommandSource,
): AgentCommand | null {
	let target = raw.target;
	let action = raw.action || raw.command || raw.name || raw.tool || "";
	const args = raw.args || raw.parameters || {};

	if (!target && action.includes(".")) {
		const [head, ...rest] = action.split(".");
		target = head as AgentCommandTarget;
		action = rest.join(".");
	}
	if (!target || !action) return null;
	if (!["head", "hand", "settings"].includes(String(target))) return null;
	return {
		target: target as AgentCommandTarget,
		action: String(action),
		args: isRecord(args) ? args : {},
		source,
		requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
		confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
	};
}

function normalizeAction(command: AgentCommand): AgentCommand | null {
	const target = command.target;
	let action = command.action.trim().toLowerCase().replace(/[\s-]+/g, "_");
	const rawAction = action;
	let args = command.args ?? {};

	const aliases: Record<AgentCommandTarget, Record<string, string>> = {
		head: {
			face: "makeface",
			grin: "makeface",
			volume: "set_volume",
			louder: "set_volume",
			quieter: "set_volume",
			stop_speak: "stopspeak",
		},
		hand: {
			close: "fist",
			full_close: "full_fist",
			relaxed: "relax",
			gesture: "pattern",
		},
		settings: {
			language: "set_language",
			reply_language: "set_reply_language",
			voice_volume: "set_voice_volume",
			head_volume: "set_head_volume",
			head_speaker: "set_head_speaker",
			head_motion: "set_head_motion",
			head_mic: "set_head_mic",
			computer_mic: "set_computer_mic",
			camera: "set_camera",
			renderer: "set_renderer",
		},
	};
	action = aliases[target]?.[action] ?? action;
	if (target === "head" && action === "set_volume") {
		if (rawAction === "louder") args = { ...args, direction: "up" };
		if (rawAction === "quieter") args = { ...args, direction: "down" };
	}
	return { ...command, target, action, args };
}

async function executeHeadCommand(
	command: AgentCommand,
): Promise<AgentCommandResult> {
	if (command.action === "set_volume") {
		const current = getSettings().robotHeadVolume;
		const explicit = readNumber(command.args, "volume", "value", "level");
		const delta = readNumber(command.args, "delta", "change");
		const direction = readVolumeDirection(command.args, delta);
		if (explicit === null && direction !== 0) {
			return await executeInteractiveVolumeAdjustment(command, direction);
		}
		const next = clamp(
			explicit !== null ? normalizeVolume(explicit) : current + (delta ?? 0),
			0,
			1,
		);
		setSettings({ robotHeadVolume: next });
		await setHeadSpeakerVolume(next);
		return ok(command, `head volume ${Math.round(next * 100)}%`);
	}
	await sendHeadAction(command.action as Parameters<typeof sendHeadAction>[0], {
		...(command.args ?? {}),
		source: command.source ?? "command_bus",
	});
	return ok(command, `head.${command.action}`);
}

async function executeInteractiveVolumeAdjustment(
	command: AgentCommand,
	direction: number,
): Promise<AgentCommandResult> {
	const now = Date.now();
	if (
		lastVolumeAdjustmentDirection === Math.sign(direction) &&
		now - lastVolumeAdjustmentAt < 1200
	) {
		return ok(command, "volume adjustment already handled");
	}
	lastVolumeAdjustmentAt = now;
	lastVolumeAdjustmentDirection = Math.sign(direction);

	volumeAdjustmentChain = volumeAdjustmentChain
		.catch(() => {})
		.then(() => runInteractiveVolumeAdjustment(direction));
	await volumeAdjustmentChain;
	const next = getSettings().robotHeadVolume;
	return ok(command, `head volume ${Math.round(next * 100)}%`);
}

async function runInteractiveVolumeAdjustment(direction: number): Promise<void> {
	const settings = getSettings();
	const current = clamp(
		settings.robotHeadSpeakerEnabled
			? settings.robotHeadVolume
			: settings.voiceVolume,
		0,
		1,
	);
	addLocalAssistantMessage(VOLUME_ACK_TEXT);
	await speakLocalAssistantPhrase(VOLUME_ACK_TEXT, current);

	const next = computeSteppedVolume(current, direction);
	setSettings({
		voiceVolume: next,
		robotHeadVolume: next,
	});
	try {
		await setHeadSpeakerVolume(next);
	} catch (error) {
		console.warn("Failed to update head speaker volume:", error);
	}

	addLocalAssistantMessage(VOLUME_CONFIRM_TEXT);
	await speakLocalAssistantPhrase(VOLUME_CONFIRM_TEXT, next);
}

function computeSteppedVolume(current: number, direction: number): number {
	const value = clamp(current, 0, 1);
	if (direction < 0) {
		return clamp(value < 0.2 ? value * 0.5 : value - 0.2, 0, 1);
	}
	if (direction > 0) {
		return clamp(value > 0.8 ? 1 : value + 0.2, 0, 1);
	}
	return value;
}

function addLocalAssistantMessage(content: string): void {
	useAgentStore.getState().addMessage({ role: "assistant", content });
}

async function speakLocalAssistantPhrase(
	text: string,
	volume: number,
): Promise<void> {
	if (typeof window === "undefined" || !("speechSynthesis" in window)) {
		return;
	}
	const speech = window.speechSynthesis;
	speech.cancel();
	await triggerHeadMotion("speak", { source: "local_volume_adjustment" });
	await new Promise<void>((resolve) => {
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = "zh-CN";
		utterance.volume = clamp(volume, 0, 1);
		utterance.rate = 1;
		utterance.pitch = 1;
		let settled = false;
		const timer = window.setTimeout(() => finish(), 2600);
		const finish = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			resolve();
		};
		utterance.onend = finish;
		utterance.onerror = finish;
		try {
			speech.speak(utterance);
		} catch {
			finish();
		}
	});
	await triggerHeadMotion("stopspeak", { source: "local_volume_adjustment" });
}

async function executeHandCommand(
	command: AgentCommand,
): Promise<AgentCommandResult> {
	const pattern =
		typeof command.args?.pattern === "string" ? command.args.pattern : undefined;
	const action = command.action === "pattern" ? "" : command.action;
	const result = await sendHandGestureAction(action, pattern);
	return ok(command, `hand ${result.pattern}`);
}

async function executeSettingsCommand(
	command: AgentCommand,
): Promise<AgentCommandResult> {
	switch (command.action) {
		case "set_language": {
			const language = readString(command.args, "language", "value");
			if (!["zh", "en", "ja"].includes(language)) {
				throw new Error("language must be zh, en, or ja");
			}
			setSettings({ language: language as "zh" | "en" | "ja" });
			return ok(command, `ui language ${language}`);
		}
		case "set_reply_language": {
			const language = readString(command.args, "language", "value");
			setSettings({ preferredReplyLanguage: language || "auto" });
			return ok(command, `reply language ${language || "auto"}`);
		}
		case "set_voice_volume": {
			const next = readVolume(command.args, getSettings().voiceVolume);
			setSettings({ voiceVolume: next });
			return ok(command, `voice volume ${Math.round(next * 100)}%`);
		}
		case "set_head_volume": {
			const next = readVolume(command.args, getSettings().robotHeadVolume);
			setSettings({ robotHeadVolume: next });
			await setHeadSpeakerVolume(next);
			return ok(command, `head volume ${Math.round(next * 100)}%`);
		}
		case "set_head_speaker": {
			setSettings({
				robotHeadSpeakerEnabled: readBoolean(command.args, "enabled", "value"),
			});
			return ok(command, "head speaker updated");
		}
		case "set_head_motion": {
			setSettings({
				robotHeadMotionEnabled: readBoolean(command.args, "enabled", "value"),
			});
			return ok(command, "head motion updated");
		}
		case "set_head_mic": {
			setSettings({
				robotHeadMicEnabled: readBoolean(command.args, "enabled", "value"),
			});
			return ok(command, "head mic updated");
		}
		case "set_computer_mic": {
			setSettings({
				computerMicEnabled: readBoolean(command.args, "enabled", "value"),
			});
			return ok(command, "computer mic updated");
		}
		case "set_camera": {
			setSettings({
				cameraEnabled: readBoolean(command.args, "enabled", "value"),
			});
			return ok(command, "camera updated");
		}
		case "set_renderer": {
			const mode = readString(command.args, "mode", "value", "renderer");
			if (mode !== "live2d" && mode !== "gpu") {
				throw new Error("renderer must be live2d or gpu");
			}
			setSettings({ avatarRendererMode: mode });
			return ok(command, `renderer ${mode}`);
		}
		default:
			throw new Error(`unsupported settings action: ${command.action}`);
	}
}

function readVolume(
	args: Record<string, unknown> | undefined,
	current: number,
): number {
	const explicit = readNumber(args, "volume", "value", "level");
	const delta = readNumber(args, "delta", "change");
	return clamp(
		explicit !== null ? normalizeVolume(explicit) : current + (delta ?? 0),
		0,
		1,
	);
}

function readVolumeDirection(
	args: Record<string, unknown> | undefined,
	delta: number | null,
): number {
	const direction = readString(args, "direction", "intent", "mode");
	if (["up", "louder", "increase", "\u589e\u5927", "\u5927"].includes(direction)) {
		return 1;
	}
	if (
		["down", "quieter", "decrease", "lower", "\u51cf\u5c0f", "\u5c0f"].includes(
			direction,
		)
	) {
		return -1;
	}
	return delta === null ? 0 : Math.sign(delta);
}

function normalizeVolume(value: number): number {
	return value > 1 ? value / 100 : value;
}

function readNumber(
	args: Record<string, unknown> | undefined,
	...keys: string[]
): number | null {
	if (!args) return null;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (
			typeof value === "string" &&
			value.trim() &&
			Number.isFinite(Number(value))
		) {
			return Number(value);
		}
	}
	return null;
}

function readString(
	args: Record<string, unknown> | undefined,
	...keys: string[]
): string {
	if (!args) return "";
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string") return value.trim().toLowerCase();
	}
	return "";
}

function readBoolean(
	args: Record<string, unknown> | undefined,
	...keys: string[]
): boolean {
	if (!args) return true;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "boolean") return value;
		if (typeof value === "number") return value !== 0;
		if (typeof value === "string") {
			return ![
				"0",
				"false",
				"off",
				"no",
				"\u5173\u95ed",
				"\u5173",
				"\u5173\u6389",
			].includes(value.trim().toLowerCase());
		}
	}
	return true;
}

function isEnableRequest(value: string): boolean {
	return hasAny(value, ["\u6253\u5f00", "\u5f00\u542f", "\u5f00"]) || /enable|turn\s+on/i.test(value);
}

function isDisableRequest(value: string): boolean {
	return hasAny(value, ["\u5173\u95ed", "\u5173\u6389", "\u5173"]) || /disable|turn\s+off/i.test(value);
}

function isUseRequest(value: string): boolean {
	return hasAny(value, ["\u7528", "\u5207\u6362\u5230", "\u6539\u7528"]) || /use|switch\s+to/i.test(value);
}

function hasHeadSpeakerTerm(value: string): boolean {
	return hasAny(value, [
		"\u5934\u90e8\u5587\u53ed",
		"\u5934\u7684\u5587\u53ed",
		"\u673a\u82af\u5587\u53ed",
		"\u5934\u90e8\u53d1\u58f0",
		"\u5934\u53d1\u58f0",
	]);
}

function hasCameraTerm(value: string): boolean {
	return hasAny(value, ["\u6444\u50cf\u5934", "\u76f8\u673a", "camera"]);
}

function hasHeadMicTerm(value: string): boolean {
	return hasAny(value, [
		"\u5934\u90e8\u9ea6\u514b\u98ce",
		"\u5934\u7684\u9ea6\u514b\u98ce",
		"\u673a\u82af\u9ea6\u514b\u98ce",
		"\u5934\u90e8mic",
		"head mic",
	]);
}

function hasComputerMicTerm(value: string): boolean {
	return hasAny(value, [
		"\u7535\u8111\u9ea6\u514b\u98ce",
		"\u7535\u8111mic",
		"\u672c\u673a\u9ea6\u514b\u98ce",
		"computer mic",
	]);
}

function hasAny(value: string, needles: string[]): boolean {
	return needles.some((needle) => value.includes(needle.toLowerCase()));
}

function dedupeCommands(commands: AgentCommand[]): AgentCommand[] {
	const seen = new Set<string>();
	const out: AgentCommand[] = [];
	for (const command of commands) {
		const key = `${command.target}.${command.action}.${JSON.stringify(command.args ?? {})}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(command);
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function ok(command: AgentCommand, preview: string): AgentCommandResult {
	return { ok: true, command, preview };
}

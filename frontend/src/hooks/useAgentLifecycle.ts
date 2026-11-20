/**
 * Agent Lifecycle Hook - Manages agent start/stop via API server
 */

import { ping } from "@/lib/api";
import { getSelectedModel } from "@/lib/availableModels";
import { buildPromptForUser } from "@/lib/persona";
import { getSettings } from "@/lib/settingsStore";
import { getUserId } from "@/lib/userIdentity";
import { useCallback, useEffect, useRef, useState } from "react";

interface StartAgentParams {
	port: number;
	graphName?: string;
	timeout?: number;
	/** Active avatar id; controls which persona prompt is sent. */
	avatarId?: string;
	/** Optional Minimax voice id to override the server default. Used so
	 *  male / non-default characters speak in a matching voice instead of
	 *  the baked-in female-tianmei. Falls back to server property.json
	 *  when unset. */
	voiceId?: string;
}

interface AgentState {
	status: "idle" | "starting" | "running" | "error" | "stopped";
	error: string | null;
	channelName: string | null;
	requestId: string | null;
}

interface StartAgentResponse {
	code?: number | string;
	msg?: string;
	error?: string;
	success?: boolean;
	data?: unknown;
}

async function readAgentResponse(
	response: Response,
): Promise<StartAgentResponse> {
	const text = await response.text();
	const trimmed = text.trim();

	if (!trimmed) {
		return {
			code: response.ok ? 0 : response.status,
			msg: response.statusText || "Empty response from agent server",
		};
	}

	try {
		return JSON.parse(trimmed) as StartAgentResponse;
	} catch {
		return {
			code: response.status,
			msg:
				trimmed.slice(0, 240) ||
				response.statusText ||
				"Agent server returned a non-JSON response",
		};
	}
}

function buildClientTimeContext(): string {
	const now = new Date();
	const resolved =
		typeof Intl !== "undefined"
			? Intl.DateTimeFormat().resolvedOptions()
			: undefined;
	const timezone = resolved?.timeZone || "unknown";
	const locale =
		typeof navigator !== "undefined" ? navigator.language : resolved?.locale;
	const offsetMinutes = -now.getTimezoneOffset();
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	const absOffset = Math.abs(offsetMinutes);
	const offsetText = `${offsetSign}${String(Math.floor(absOffset / 60)).padStart(2, "0")}:${String(absOffset % 60).padStart(2, "0")}`;
	let localTime = now.toISOString();

	try {
		localTime = now.toLocaleString("zh-CN", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
			timeZone: timezone !== "unknown" ? timezone : undefined,
		});
	} catch {
		localTime = now.toISOString();
	}

	return [
		"[CLIENT_TIME_CONTEXT]",
		`browser_local_time=${localTime}`,
		`browser_timezone=${timezone}`,
		`browser_utc_offset=${offsetText}`,
		`browser_locale=${locale || "unknown"}`,
		"Use this for natural greetings when it differs from Beijing time. Do not call time/lunar tools just to start a conversation.",
	].join("\n");
}

function buildRuntimePrompt(uid: string, avatarId?: string): string {
	const settings = getSettings();
	const base = buildPromptForUser(uid, avatarId);
	const language = (settings.preferredReplyLanguage || "auto").trim();
	let prompt = `${base}\n\n${buildClientTimeContext()}`;
	if (language && language !== "auto") {
		prompt += `\n\n[CLIENT_PREFERENCE]\nThe user currently prefers replies in language code "${language}". Follow this preference unless the user asks otherwise in the current turn.`;
	}
	if (settings.speakerDiarizationEnabled) {
		prompt +=
			"\n\n[SPEAKER_DIARIZATION]\nUser speech may be prefixed with labels such as [S1] or [S2]. Treat each label as a different speaker, keep their preferences separate when relevant, and answer the current speaker directly. Do not read the speaker label aloud.";
	}
	return prompt;
}

/**
 * Hook to manage agent lifecycle (start/stop)
 */
export function useAgentLifecycle() {
	const [state, setState] = useState<AgentState>({
		status: "idle",
		error: null,
		channelName: null,
		requestId: null,
	});

	// Ping interval ref to keep agent alive
	const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);

	/**
	 * Start pinging the agent to keep it alive
	 * Uses recursive setTimeout to prevent ping stacking
	 */
	const startPing = useCallback((channelName: string) => {
		// Clear any existing timeout
		if (pingIntervalRef.current) {
			clearTimeout(pingIntervalRef.current);
		}

		// Recursive setTimeout pattern - waits for completion before next ping
		const schedulePing = async () => {
			await ping(channelName);
			// Schedule next ping only after current one completes
			pingIntervalRef.current = setTimeout(schedulePing, 3000);
		};

		// Start the first ping
		schedulePing();
	}, []);

	/**
	 * Stop pinging the agent
	 */
	const stopPing = useCallback(() => {
		if (pingIntervalRef.current) {
			clearTimeout(pingIntervalRef.current);
			pingIntervalRef.current = null;
		}
	}, []);

	// Clean up ping interval on unmount
	useEffect(() => {
		return () => {
			stopPing();
		};
	}, [stopPing]);

	/**
	 * Generate a unique channel name
	 */
	const generateChannelName = useCallback(() => {
		return `websocket-${Date.now()}-${Math.random().toString(36).substring(7)}`;
	}, []);

	/**
	 * Generate a unique request ID
	 */
	const generateRequestId = useCallback(() => {
		return `${Date.now()}-${Math.random().toString(36).substring(2)}`;
	}, []);

	/**
	 * Start the agent with property overrides
	 */
	const startAgent = useCallback(
		async ({
			port,
			graphName,
			timeout = -1,
			avatarId,
			voiceId,
		}: StartAgentParams) => {
			setState((prev) => ({ ...prev, status: "starting", error: null }));

			const channelName = generateChannelName();
			const requestId = generateRequestId();
			const settings = getSettings();
			const selectedGraphName =
				graphName ??
				(settings.speakerDiarizationEnabled
					? "voice_assistant_diarization"
					: "voice_assistant");

			try {
				const response = await fetch("/api/agents/start", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						request_id: requestId,
						channel_name: channelName,
						user_uid: 176573,
						graph_name: selectedGraphName,
						properties: {
							websocket_server: {
								port: port,
							},
							// Inject the anonymous per-browser UUID into the LLM's system
							// prompt so memory tools can scope recall/remember per user
							// without requiring login. Kept out of channel_name to preserve
							// uniqueness across tabs/sessions of the same user.
							// Also override `model` so the user's dropdown pick takes
							// effect; base_url + api_key stay with the server's property
							// so the gateway key is never exposed in frontend JS.
							llm: {
								prompt: buildRuntimePrompt(getUserId(), avatarId),
								model: getSelectedModel(),
								max_tokens: 160,
							},
							// Per-avatar TTS voice override. Only the voice_id is
							// sent — Minimax merges this with the rest of voice_setting
							// server-side, so other knobs (speed/pitch) stay at their
							// property.json defaults. Omit the whole block when the
							// avatar doesn't override (server keeps female-tianmei).
							...(voiceId
								? {
										tts: {
											params: {
												voice_setting: { voice_id: voiceId },
											},
										},
									}
								: {}),
						},
						timeout: timeout,
					}),
				});

				const data = await readAgentResponse(response);

				// Handle both string and number codes (server returns "0" as string for success)
				const code =
					typeof data.code === "string"
						? Number.parseInt(data.code, 10)
						: typeof data.code === "number"
							? data.code
							: response.ok && data.success !== false
								? 0
								: response.status;
				if (!response.ok || code !== 0 || data.success === false) {
					throw new Error(
						data.msg ||
							data.error ||
							`Failed to start agent (${response.status})`,
					);
				}

				setState({
					status: "running",
					error: null,
					channelName,
					requestId,
				});

				// Start pinging to keep agent alive
				startPing(channelName);

				return { channelName, requestId, port };
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				setState({
					status: "error",
					error: errorMessage,
					channelName: null,
					requestId: null,
				});
				throw error;
			}
		},
		[generateChannelName, generateRequestId, startPing],
	);

	/**
	 * Stop the agent
	 */
	const stopAgent = useCallback(async () => {
		if (!state.channelName) {
			console.warn("No active agent to stop");
			return;
		}

		try {
			// Stop pinging
			stopPing();

			const response = await fetch("/api/agents/stop", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					channel_name: state.channelName,
				}),
			});

			if (!response.ok) {
				const data = await readAgentResponse(response);
				throw new Error(data.msg || data.error || "Failed to stop agent");
			}

			setState({
				status: "stopped",
				error: null,
				channelName: null,
				requestId: null,
			});
		} catch (error) {
			console.error("Error stopping agent:", error);
			// Don't update state to error - stopping is best effort
		}
	}, [state.channelName, stopPing]);

	/**
	 * Reset the state
	 */
	const reset = useCallback(() => {
		stopPing();
		setState({
			status: "idle",
			error: null,
			channelName: null,
			requestId: null,
		});
	}, [stopPing]);

	return {
		state,
		startAgent,
		stopAgent,
		reset,
		isStarting: state.status === "starting",
		isRunning: state.status === "running",
		hasError: state.status === "error",
	};
}

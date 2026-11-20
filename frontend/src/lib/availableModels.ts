/**
 * LLM models available through the server-side OpenAI-compatible gateway.
 *
 * The API key and base URL stay on the TEN server. The frontend only sends the
 * selected model id in the /start property override.
 */

export type ModelVendor = "DeepSeek" | "Anthropic" | "OpenAI" | "Google";

export interface ModelOption {
	id: string;
	label: string;
	vendor: ModelVendor;
	hint?: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
	{
		id: "deepseek-chat",
		label: "DeepSeek Chat",
		vendor: "DeepSeek",
		hint: "Default, low cost, reliable for daily chat",
	},
	{
		id: "deepseek-reasoner",
		label: "DeepSeek Reasoner",
		vendor: "DeepSeek",
		hint: "Stronger reasoning, slower responses",
	},
	{
		id: "gpt-4o-mini",
		label: "GPT-4o mini",
		vendor: "OpenAI",
		hint: "Fallback if the OpenAI-compatible gateway has quota",
	},
	{
		id: "gpt-4o-2024-11-20",
		label: "GPT-4o",
		vendor: "OpenAI",
		hint: "Higher quality, higher cost",
	},
	{
		id: "gpt-4.1",
		label: "GPT-4.1",
		vendor: "OpenAI",
		hint: "Higher quality, higher cost",
	},
	{
		id: "claude-sonnet-4-6",
		label: "Claude Sonnet 4.6",
		vendor: "Anthropic",
		hint: "Strong reasoning if the gateway account supports it",
	},
	{
		id: "claude-haiku-4-5-20251001",
		label: "Claude Haiku 4.5",
		vendor: "Anthropic",
		hint: "Fast Claude option if available",
	},
	{
		id: "gemini-2.5-flash",
		label: "Gemini 2.5 Flash",
		vendor: "Google",
		hint: "Fast Gemini option if available",
	},
	{
		id: "gemini-2.5-pro",
		label: "Gemini 2.5 Pro",
		vendor: "Google",
		hint: "Long-context Gemini option if available",
	},
];

export const DEFAULT_MODEL_ID = "deepseek-chat";

const STORAGE_KEY = "xiaoling_model";
const DEFAULT_MIGRATION_KEY = "xiaoling_model_default_migrated_v3";

function isAvailableModel(id: string): boolean {
	return AVAILABLE_MODELS.some((model) => model.id === id);
}

export function getSelectedModel(): string {
	if (typeof window === "undefined") return DEFAULT_MODEL_ID;

	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		const migrated = window.localStorage.getItem(DEFAULT_MIGRATION_KEY) === "1";

		if (!migrated && stored && !stored.startsWith("deepseek-")) {
			window.localStorage.setItem(STORAGE_KEY, DEFAULT_MODEL_ID);
			window.localStorage.setItem(DEFAULT_MIGRATION_KEY, "1");
			return DEFAULT_MODEL_ID;
		}

		if (stored && isAvailableModel(stored)) return stored;
	} catch {
		// localStorage can be disabled in private or embedded browser contexts.
	}

	return DEFAULT_MODEL_ID;
}

export function setSelectedModel(id: string): void {
	if (typeof window === "undefined") return;
	if (!isAvailableModel(id)) return;

	try {
		window.localStorage.setItem(STORAGE_KEY, id);
		window.localStorage.setItem(DEFAULT_MIGRATION_KEY, "1");
	} catch {
		// ignore
	}
}

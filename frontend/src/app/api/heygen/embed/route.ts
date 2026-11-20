import { NextRequest, NextResponse } from "next/server";

type LiveAvatarEmbedRequest = {
  apiKey?: string;
  avatarId?: string;
  contextId?: string;
  voiceId?: string;
  type?: "DEFAULT" | "WIDGET";
  maxSessionDuration?: number;
  defaultLanguage?: string;
  isSandbox?: boolean;
  orientation?: "horizontal" | "vertical";
};

type LiveAvatarEmbedResponse = {
  code?: number;
  data?: {
    embed_id?: string;
    url?: string;
    script?: string;
    orientation?: string;
  };
  message?: string;
};

const API_URL = "https://api.liveavatar.com/v2/embeddings";

export async function POST(request: NextRequest) {
  let body: LiveAvatarEmbedRequest;
  try {
    body = (await request.json()) as LiveAvatarEmbedRequest;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const apiKey =
    body.apiKey?.trim() ||
    process.env.HEYGEN_LIVEAVATAR_API_KEY ||
    process.env.LIVEAVATAR_API_KEY ||
    process.env.HEYGEN_API_KEY ||
    "";
  const avatarId = body.avatarId?.trim();
  const contextId = body.contextId?.trim();

  if (!apiKey) {
    return jsonError("Missing LiveAvatar API key", 400);
  }
  if (!avatarId || !contextId) {
    return jsonError("avatarId and contextId are required", 400);
  }

  const payload = compact({
    avatar_id: avatarId,
    context_id: contextId,
    voice_id: body.voiceId?.trim(),
    type: body.type || "DEFAULT",
    max_session_duration: clampDuration(body.maxSessionDuration),
    default_language: body.defaultLanguage?.trim() || undefined,
    is_sandbox: Boolean(body.isSandbox),
    orientation: body.orientation || "horizontal",
  });

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => null)) as
      | LiveAvatarEmbedResponse
      | null;

    if (!response.ok || !data?.data?.url) {
      return NextResponse.json(
        {
          ok: false,
          error: data?.message || `LiveAvatar API returned ${response.status}`,
          status: response.status,
          data,
        },
        { status: response.ok ? 502 : response.status },
      );
    }

    return NextResponse.json({
      ok: true,
      embedId: data.data.embed_id,
      url: data.data.url,
      script: data.data.script,
      orientation: data.data.orientation,
      message: data.message,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502);
  }
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== ""),
  ) as Partial<T>;
}

function clampDuration(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(60, Math.min(3600, Math.round(parsed)));
}

function jsonError(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

import { NextRequest, NextResponse } from "next/server";

type TokenRequest = {
  avatarId?: string;
  apiKey?: string;
};

const TOKEN_URL = "https://www.trulience.com/auth/generate-token";

export async function POST(request: NextRequest) {
  let body: TokenRequest;
  try {
    body = (await request.json()) as TokenRequest;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const avatarId = body.avatarId?.trim();
  const apiKey =
    body.apiKey?.trim() || process.env.TRULIENCE_API_KEY?.trim() || "";

  if (!avatarId) return jsonError("Avatar ID is required", 400);
  if (!apiKey) return jsonError("Provide a Trulience API key", 400);

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        avatar_id: avatarId,
        expire_at: 300,
      }),
      cache: "no-store",
    });
    const data = await response.json().catch(() => null);
    const token = findToken(data);

    if (!response.ok || !token) {
      return NextResponse.json(
        {
          ok: false,
          error:
            data?.error?.message ||
            data?.message ||
            `Trulience token API returned ${response.status}`,
        },
        { status: response.ok ? 502 : response.status },
      );
    }

    return NextResponse.json({ ok: true, token });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502);
  }
}

function findToken(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const value = data as Record<string, unknown>;
  const nested =
    value.data && typeof value.data === "object"
      ? (value.data as Record<string, unknown>)
      : null;
  const token =
    value.jwt ||
    value.token ||
    value.access_token ||
    value.accessToken ||
    nested?.jwt ||
    nested?.token ||
    nested?.access_token ||
    nested?.accessToken;
  return typeof token === "string" ? token : "";
}

function jsonError(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

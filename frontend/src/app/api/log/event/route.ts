/**
 * POST /api/log/event
 *
 * Called by the frontend WebSocket hook to record activity. No auth
 * here — anyone hitting the site can write, but they can only write
 * with their own self-claimed user_id and session_id, which is
 * acceptable for an MVP analytics use case. Reading is gated by the
 * admin endpoints.
 *
 * Body shapes:
 *   { type: "session_start", session_id, user_id }
 *   { type: "message", session_id, role: "user"|"assistant", content }
 *
 * Writes are wrapped in a single transaction. Errors return 200 with
 * { ok: false } so the client never retries forever — logging must
 * never break the chat experience.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionStartBody {
  type: "session_start";
  session_id: string;
  user_id: string;
}

interface MessageBody {
  type: "message";
  session_id: string;
  role: "user" | "assistant";
  content: string;
}

type Body = SessionStartBody | MessageBody;

const MAX_CONTENT_LEN = 8 * 1024; // 8 KiB per message — generous, blocks abuse

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  if (!body || typeof body.type !== "string") {
    return NextResponse.json({ ok: false, error: "missing type" }, { status: 400 });
  }

  try {
    const db = getDb();
    const now = Date.now();

    if (body.type === "session_start") {
      const { session_id, user_id } = body;
      if (!session_id || !user_id) {
        return NextResponse.json({ ok: false, error: "missing ids" }, { status: 400 });
      }
      const ua = request.headers.get("user-agent") || null;
      const ip = getClientIp(request);
      db.prepare(
        `INSERT INTO sessions (id, user_id, started_at, last_seen, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`
      ).run(session_id, user_id, now, now, ua, ip);
      return NextResponse.json({ ok: true });
    }

    if (body.type === "message") {
      const { session_id, role, content } = body;
      if (!session_id || (role !== "user" && role !== "assistant") || typeof content !== "string") {
        return NextResponse.json({ ok: false, error: "bad message" }, { status: 400 });
      }
      const safe = content.slice(0, MAX_CONTENT_LEN);
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO messages (session_id, ts, role, content) VALUES (?, ?, ?, ?)`).run(
          session_id,
          now,
          role,
          safe,
        );
        db.prepare(`UPDATE sessions SET last_seen = ? WHERE id = ?`).run(now, session_id);
      });
      tx();
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "unknown type" }, { status: 400 });
  } catch (err) {
    console.error("log/event error", err);
    return NextResponse.json({ ok: false, error: "internal" }, { status: 200 });
  }
}

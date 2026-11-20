/**
 * GET /api/admin/sessions/[id] — full transcript for one session.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkAdminAuth } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = checkAdminAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const { id } = await ctx.params;
  const db = getDb();
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
  if (!session) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const messages = db
    .prepare(`SELECT id, ts, role, content FROM messages WHERE session_id = ? ORDER BY ts ASC, id ASC`)
    .all(id);
  return NextResponse.json({ session, messages });
}

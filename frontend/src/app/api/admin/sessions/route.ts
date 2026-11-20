/**
 * GET /api/admin/sessions?user_id=<uid>
 * List a single device's sessions, newest first.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkAdminAuth } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = checkAdminAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         s.id,
         s.started_at,
         s.last_seen,
         s.user_agent,
         s.ip,
         COUNT(m.id) AS message_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.user_id = ?
       GROUP BY s.id
       ORDER BY s.started_at DESC`
    )
    .all(userId);

  return NextResponse.json({ sessions: rows });
}

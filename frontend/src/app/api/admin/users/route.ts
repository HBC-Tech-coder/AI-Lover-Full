/**
 * GET /api/admin/users — list every distinct device/user with session
 * and message counts. Sorted by most recent activity.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkAdminAuth } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = checkAdminAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         s.user_id                                AS user_id,
         MIN(s.started_at)                        AS first_seen,
         MAX(s.last_seen)                         AS last_seen,
         COUNT(DISTINCT s.id)                     AS session_count,
         (SELECT COUNT(*) FROM messages m
          WHERE m.session_id IN (SELECT id FROM sessions WHERE user_id = s.user_id))
                                                  AS message_count
       FROM sessions s
       GROUP BY s.user_id
       ORDER BY last_seen DESC`
    )
    .all();

  return NextResponse.json({ users: rows });
}

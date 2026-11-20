/**
 * GET /api/admin/stats — top-level dashboard counters.
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
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const totalUsers = (db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions`).get() as { n: number }).n;
  const totalSessions = (db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  const totalMessages = (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
  const usersLast24h = (db
    .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_seen >= ?`)
    .get(now - day) as { n: number }).n;
  const usersLast7d = (db
    .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_seen >= ?`)
    .get(now - 7 * day) as { n: number }).n;
  const sessionsLast24h = (db
    .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?`)
    .get(now - day) as { n: number }).n;

  return NextResponse.json({
    totalUsers,
    totalSessions,
    totalMessages,
    usersLast24h,
    usersLast7d,
    sessionsLast24h,
  });
}

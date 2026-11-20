/**
 * GET /api/data/stats — public (no auth) aggregated visitor analytics.
 *
 * Returns only aggregate numbers/charts — no raw transcripts, no IPs.
 * Safe to expose on the unauthenticated /data leadership dashboard.
 */

import { NextResponse } from "next/server";
import { computeStats } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stats = computeStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("/api/data/stats error", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

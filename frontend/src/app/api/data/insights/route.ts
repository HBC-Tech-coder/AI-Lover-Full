/**
 * GET /api/data/insights — public (no auth) LLM topic analysis.
 *
 * Returns aggregated semantic insights (summary, topic clusters, keyword
 * weights, drop-off topics). No raw transcripts beyond short representative
 * example phrases the LLM surfaces. Result is cached on disk; pass ?force=1
 * to bypass the cache (used by the dashboard's manual refresh button).
 */

import { NextResponse } from "next/server";
import { getInsights } from "@/lib/llmAnalysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// LLM call can take a while on a cold cache.
export const maxDuration = 90;

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    const insights = await getInsights(force);
    return NextResponse.json(insights);
  } catch (err) {
    console.error("/api/data/insights error", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { readGenerationJob } from "@/lib/live2dGenerationStore";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const job = await readGenerationJob(id);
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "not found" }, { status: 404 });
  }
}
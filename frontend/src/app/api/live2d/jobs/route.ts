import { NextResponse } from "next/server";
import { getGenerationProvider, listGenerationJobs } from "@/lib/live2dGenerationStore";

export const runtime = "nodejs";

export async function GET() {
  const jobs = await listGenerationJobs();
  return NextResponse.json({ ok: true, jobs, generator: getGenerationProvider() });
}
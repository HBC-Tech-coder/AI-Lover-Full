import { NextRequest, NextResponse } from "next/server";
import { deleteCharacter } from "@/lib/characterStore";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const characters = await deleteCharacter(id);
    return NextResponse.json({ ok: true, characters });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "internal" }, { status: 400 });
  }
}
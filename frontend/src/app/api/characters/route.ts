import { NextRequest, NextResponse } from "next/server";
import { createCharacterFromForm, listCharacters } from "@/lib/characterStore";

export const runtime = "nodejs";

export async function GET() {
  try {
    const characters = await listCharacters();
    return NextResponse.json({ ok: true, characters });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "internal" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const character = await createCharacterFromForm(form);
    return NextResponse.json({ ok: true, character });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "internal" }, { status: 400 });
  }
}
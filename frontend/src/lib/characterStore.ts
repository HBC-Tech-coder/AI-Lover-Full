import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CharacterGender, CharacterVisibility, ManagedCharacter } from "@/lib/characterTypes";

const CHARACTER_DATA_DIR = path.join(process.cwd(), "data", "characters");
const CHARACTER_DATA_PATH = path.join(CHARACTER_DATA_DIR, "characters.json");
const PUBLIC_ROOT = path.join(process.cwd(), "public", "user-live2d");
const MAX_MODEL_FILE_BYTES = 80 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

export async function listCharacters() {
  return readCharacters();
}

export async function deleteCharacter(id: string) {
  const safeId = sanitizeId(id);
  const characters = await readCharacters();
  const next = characters.filter((character) => character.id !== safeId);
  await writeCharacters(next);
  await fs.rm(path.join(PUBLIC_ROOT, safeId), { recursive: true, force: true });
  return next;
}

export async function createCharacterFromForm(form: FormData) {
  const files = form.getAll("modelFiles").filter((entry): entry is File => entry instanceof File);
  const relativePaths = form.getAll("modelPaths").map((entry) => String(entry || ""));
  if (!files.length) throw new Error("Please choose a Live2D model folder or a model3.json file.");

  const id = createCharacterId(String(form.get("displayName") || form.get("label") || "character"));
  const characterDir = path.join(PUBLIC_ROOT, id);
  await fs.mkdir(characterDir, { recursive: true });

  let modelRelativePath = "";
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file.size > MAX_MODEL_FILE_BYTES) throw new Error(`${file.name} is too large. Each model file must be under 80MB.`);
    const relative = sanitizeRelativePath(relativePaths[index] || file.name);
    if (!relative) continue;
    const targetPath = path.resolve(characterDir, relative);
    if (!isInside(characterDir, targetPath)) throw new Error("Unsafe model file path.");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, Buffer.from(await file.arrayBuffer()));
    if (!modelRelativePath && relative.toLowerCase().endsWith(".model3.json")) modelRelativePath = relative.replace(/\\/g, "/");
  }

  const requestedModelPath = sanitizeRelativePath(String(form.get("modelPath") || ""));
  if (requestedModelPath) modelRelativePath = requestedModelPath.replace(/\\/g, "/");
  if (!modelRelativePath || !modelRelativePath.toLowerCase().endsWith(".model3.json")) {
    throw new Error("No .model3.json file was found. Please upload a complete Live2D model folder.");
  }

  const modelFullPath = path.resolve(characterDir, modelRelativePath);
  if (!isInside(characterDir, modelFullPath)) throw new Error("Unsafe model3.json path.");
  await validateModelJson(modelFullPath);

  const thumbnail = form.get("thumbnail");
  let thumbnailUrl = "";
  if (thumbnail instanceof File && thumbnail.size > 0) {
    if (!thumbnail.type.startsWith("image/")) throw new Error("Avatar image must be an image file.");
    if (thumbnail.size > MAX_THUMBNAIL_BYTES) throw new Error("Avatar image must be under 8MB.");
    const ext = extensionForMime(thumbnail.type);
    const thumbnailName = `thumbnail${ext}`;
    await fs.writeFile(path.join(characterDir, thumbnailName), Buffer.from(await thumbnail.arrayBuffer()));
    thumbnailUrl = `/user-live2d/${id}/${thumbnailName}`;
  }

  const displayName = sanitizeDisplayName(String(form.get("displayName") || "My Character"));
  const label = sanitizeDisplayName(String(form.get("label") || displayName));
  const gender = normalizeGender(String(form.get("gender") || "neutral"));
  const visibility = normalizeVisibility(String(form.get("visibility") || "private"));
  const affiliation = cleanText(String(form.get("affiliation") || ""), 64);
  const ownership = cleanText(String(form.get("ownership") || ""), 64);
  const personality = cleanText(String(form.get("personality") || ""), 1200);
  const intro = cleanText(String(form.get("intro") || personality || `${displayName} is a custom Live2D character.`), 220);
  const voiceId = cleanText(String(form.get("voiceId") || ""), 80) || undefined;
  const scaleBoost = parseOptionalNumber(form.get("scaleBoost"));
  const anchorRatio = parseOptionalNumber(form.get("anchorRatio"));
  const now = new Date().toISOString();

  const character: ManagedCharacter = {
    id,
    label,
    displayName,
    gender,
    visibility,
    affiliation,
    ownership,
    personality,
    intro,
    identity: buildIdentity({ displayName, gender, affiliation, ownership, personality }),
    modelUrl: `/user-live2d/${id}/${modelRelativePath}`,
    thumbnailUrl: thumbnailUrl || undefined,
    voiceId,
    scaleBoost,
    anchorRatio,
    sourceType: "manual-live2d",
    createdAt: now,
    updatedAt: now,
  };

  const characters = await readCharacters();
  const next = [character, ...characters.filter((item) => item.id !== character.id)];
  await writeCharacters(next);
  return character;
}

async function readCharacters(): Promise<ManagedCharacter[]> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(CHARACTER_DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCharacter) : [];
  } catch {
    return [];
  }
}

async function writeCharacters(characters: ManagedCharacter[]) {
  await ensureDirs();
  await fs.writeFile(CHARACTER_DATA_PATH, JSON.stringify(characters, null, 2), "utf8");
}

async function ensureDirs() {
  await fs.mkdir(CHARACTER_DATA_DIR, { recursive: true });
  await fs.mkdir(PUBLIC_ROOT, { recursive: true });
}

async function validateModelJson(modelPath: string) {
  const raw = await fs.readFile(modelPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid model3.json file.");
  const fileReferences = (parsed as { FileReferences?: unknown }).FileReferences;
  if (!fileReferences || typeof fileReferences !== "object") throw new Error("model3.json is missing FileReferences.");
}

function buildIdentity({ displayName, gender, affiliation, ownership, personality }: { displayName: string; gender: CharacterGender; affiliation: string; ownership: string; personality: string }) {
  const genderText: Record<CharacterGender, string> = { female: "female", male: "male", neutral: "neutral", other: "custom" };
  const lines = [
    `You are ${displayName}, a user-configured Live2D conversation character. Stay in character and do not describe yourself as an AI assistant.`,
    `Gender setting: ${genderText[gender]}.`,
  ];
  if (affiliation) lines.push(`Affiliation: ${affiliation}.`);
  if (ownership) lines.push(`Ownership and usage scope: ${ownership}.`);
  if (personality) lines.push(`Personality and speaking style: ${personality}`);
  lines.push("Keep replies natural, concise, warm, and consistent with this character setting.");
  return lines.join("\n");
}

function isCharacter(value: unknown): value is ManagedCharacter {
  const item = value as Partial<ManagedCharacter>;
  return Boolean(item?.id && item?.label && item?.displayName && item?.modelUrl?.endsWith(".model3.json") && item?.sourceType === "manual-live2d");
}

function createCharacterId(seed: string) {
  const slug = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "character";
  return `char_${slug}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}

export function sanitizeId(id: string) {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) throw new Error("invalid character id");
  return clean;
}

function sanitizeDisplayName(value: string) {
  return cleanText(value, 32) || "My Character";
}

function cleanText(value: string, maxLength: number) {
  return value.replace(/[<>]/g, "").trim().slice(0, maxLength);
}

function normalizeGender(value: string): CharacterGender {
  if (value === "female" || value === "male" || value === "other") return value;
  return "neutral";
}

function normalizeVisibility(value: string): CharacterVisibility {
  return value === "public" ? "public" : "private";
}

function parseOptionalNumber(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeRelativePath(value: string) {
  const clean = value.replace(/\\/g, "/");
  const parts = clean.split("/").map((part) => part.trim()).filter(Boolean);
  const safeParts = parts
    .filter((part) => part !== "." && part !== "..")
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_"));
  return safeParts.join("/");
}

function extensionForMime(mime: string) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
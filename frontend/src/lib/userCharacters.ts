"use client";

import type { AvatarOption } from "@/lib/availableAvatars";
import type { ManagedCharacter } from "@/lib/characterTypes";

export const USER_CHARACTERS_STORAGE_KEY = "xiaoling_user_characters_v1";
export const USER_CHARACTERS_CHANGED_EVENT = "xiaoling-user-characters-changed";

export function readUserCharacters(): ManagedCharacter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USER_CHARACTERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isManagedCharacter) : [];
  } catch {
    return [];
  }
}

export function readUserCharacterAvatars(): AvatarOption[] {
  return readUserCharacters().map(characterToAvatarOption);
}

export async function refreshUserCharactersFromServer() {
  const response = await fetch("/api/characters", { cache: "no-store" });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "failed to load characters");
  writeUserCharacters(data.characters || []);
  return data.characters as ManagedCharacter[];
}

export function writeUserCharacters(characters: ManagedCharacter[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USER_CHARACTERS_STORAGE_KEY, JSON.stringify(characters.filter(isManagedCharacter)));
    window.dispatchEvent(new CustomEvent(USER_CHARACTERS_CHANGED_EVENT));
  } catch {
    // Ignore cache failures; the API remains the source of truth.
  }
}

export function subscribeUserCharacters(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(USER_CHARACTERS_CHANGED_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(USER_CHARACTERS_CHANGED_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function characterToAvatarOption(character: ManagedCharacter): AvatarOption {
  return {
    id: character.id,
    label: character.label,
    displayName: character.displayName,
    modelUrl: character.modelUrl,
    identity: character.identity,
    intro: character.intro,
    voiceId: character.voiceId,
    scaleBoost: character.scaleBoost,
    anchorRatio: character.anchorRatio,
    generated: true,
  };
}

function isManagedCharacter(value: unknown): value is ManagedCharacter {
  const item = value as Partial<ManagedCharacter>;
  return Boolean(item?.id && item?.label && item?.displayName && item?.modelUrl?.endsWith(".model3.json") && item?.sourceType === "manual-live2d");
}
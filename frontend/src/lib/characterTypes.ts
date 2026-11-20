export type CharacterGender = "female" | "male" | "neutral" | "other";
export type CharacterVisibility = "private" | "public";

export interface ManagedCharacter {
  id: string;
  label: string;
  displayName: string;
  gender: CharacterGender;
  visibility: CharacterVisibility;
  affiliation: string;
  ownership: string;
  personality: string;
  intro: string;
  identity: string;
  modelUrl: string;
  thumbnailUrl?: string;
  voiceId?: string;
  scaleBoost?: number;
  anchorRatio?: number;
  sourceType: "manual-live2d";
  createdAt: string;
  updatedAt: string;
}
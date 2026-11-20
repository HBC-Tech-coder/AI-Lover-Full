export const GENERATED_LIVE2D_AVATARS_STORAGE_KEY = "xiaoling_generated_live2d_avatars_v1";
export const GENERATED_LIVE2D_AVATARS_CHANGED_EVENT = "xiaoling-generated-live2d-avatars-changed";

export interface GeneratedLive2DAvatar {
  id: string;
  label: string;
  displayName: string;
  modelUrl: string;
  intro: string;
  identity: string;
  createdAt: string;
  sourceImageUrl?: string;
  previewImageUrl?: string;
  assetManifestUrl?: string;
  templatePreview?: boolean;
  scaleBoost?: number;
  anchorRatio?: number;
  voiceId?: string;
  generated?: boolean;
}

export function readGeneratedLive2DAvatars(): GeneratedLive2DAvatar[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(GENERATED_LIVE2D_AVATARS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isGeneratedAvatar);
  } catch {
    return [];
  }
}

export function registerGeneratedLive2DAvatar(avatar: GeneratedLive2DAvatar) {
  if (typeof window === "undefined") return;
  const current = readGeneratedLive2DAvatars();
  const next = [avatar, ...current.filter((item) => item.id !== avatar.id)].slice(0, 24);
  try {
    window.localStorage.setItem(GENERATED_LIVE2D_AVATARS_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(GENERATED_LIVE2D_AVATARS_CHANGED_EVENT));
  } catch {
    // localStorage may be full or disabled. The avatar can still be tested on the generation page.
  }
}

export function subscribeGeneratedLive2DAvatars(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(GENERATED_LIVE2D_AVATARS_CHANGED_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(GENERATED_LIVE2D_AVATARS_CHANGED_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function makeGeneratedAvatarIdentity(displayName: string) {
  return `你叫${displayName}，是用户上传照片生成的 Live2D 数字人。你不是工具说明页，而是一个自然、亲切、会认真听用户说话的对话伙伴。回答保持简短、口语化、有温度。`;
}

function isGeneratedAvatar(value: unknown): value is GeneratedLive2DAvatar {
  const item = value as Partial<GeneratedLive2DAvatar>;
  if (item?.templatePreview || item?.label?.includes("(worker preview)") || item?.intro?.includes("built-in Cubism model is mounted only") || item?.intro?.includes("Local flow-test model")) {
    return false;
  }
  return Boolean(
    item &&
      typeof item.id === "string" &&
      item.id.startsWith("generated-") &&
      typeof item.label === "string" &&
      typeof item.displayName === "string" &&
      typeof item.modelUrl === "string" &&
      item.modelUrl.endsWith(".model3.json"),
  );
}
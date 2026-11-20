export type Live2DComposition = "headshot" | "upper_body" | "full_body" | "needs_regeneration";
export type BackgroundComplexity = "simple" | "medium" | "complex";

export type NormalizedBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Live2DPreprocessResult = {
  version: "1.0";
  image: {
    width: number;
    height: number;
    aspect: number;
  };
  face?: {
    box: NormalizedBox;
    confidence: number;
    method: string;
  };
  body: {
    box: NormalizedBox;
    composition: Live2DComposition;
    estimated: boolean;
    missing: string[];
  };
  background: {
    complexity: BackgroundComplexity;
    score: number;
  };
  quality: {
    score: number;
    issues: string[];
    recommendations: string[];
  };
  rigging: {
    target: "live2d-cubism4";
    requiredLayers: string[];
    generationPrompt: string;
    negativePrompt: string;
  };
};

type SourceFaceBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  method: string;
  confidence: number;
};

type FaceDetectorBox = {
  boundingBox: DOMRectReadOnly;
};

type BrowserFaceDetector = new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => {
  detect: (source: CanvasImageSource) => Promise<FaceDetectorBox[]>;
};

export async function preprocessLive2DPhoto(file: File): Promise<Live2DPreprocessResult> {
  const image = await loadImageFromFile(file);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error("Image dimensions are unavailable");

  const face = (await detectFaceWithBrowser(image).catch(() => null)) ?? estimateFaceBySkinCluster(image);
  const body = estimateBodyBox(face, width, height);
  const background = estimateBackgroundComplexity(image, body.box);
  const quality = scoreInput({ face, body, background, width, height });

  return {
    version: "1.0",
    image: { width, height, aspect: round(width / height, 4) },
    face: face
      ? {
          box: toNormalizedBox(face, width, height),
          confidence: face.confidence,
          method: face.method,
        }
      : undefined,
    body,
    background,
    quality,
    rigging: {
      target: "live2d-cubism4",
      requiredLayers: [
        "transparent full-body character",
        "head and hair separated",
        "eyes separated left/right",
        "mouth interior and lips separated",
        "neck and torso separated",
        "arms separated when visible",
        "clean background plate",
      ],
      generationPrompt: buildGenerationPrompt(body, background, Boolean(face)),
      negativePrompt: "extra limbs, cropped head, hidden face, closed eyes, heavy motion blur, hard shadows, complex background, text, watermark",
    },
  };
}

function estimateBodyBox(face: SourceFaceBox | null, width: number, height: number) {
  if (!face) {
    return {
      box: { x: 8, y: 6, width: 84, height: 90 },
      composition: "needs_regeneration" as Live2DComposition,
      estimated: true,
      missing: ["face", "body_landmarks"],
    };
  }

  const faceBox = toNormalizedBox(face, width, height);
  const cx = faceBox.x + faceBox.width / 2;
  const top = clamp(faceBox.y - faceBox.height * 0.28, 0, 100);
  const fullBodyHeight = faceBox.height * 5.2;
  const bodyWidth = Math.max(faceBox.width * 3.8, faceBox.height * 1.65);
  const bottom = top + fullBodyHeight;
  const missing: string[] = ["pose_landmarks_estimated"];

  let composition: Live2DComposition = "full_body";
  if (faceBox.height > 34) {
    composition = "headshot";
    missing.push("torso", "arms", "lower_body");
  } else if (bottom > 116) {
    composition = "upper_body";
    missing.push("lower_body");
  }
  if (faceBox.y > 34) {
    missing.push("upper_head_margin");
  }

  const box = {
    x: clamp(cx - bodyWidth / 2, 0, 100),
    y: top,
    width: clamp(bodyWidth, 18, 100),
    height: clamp(Math.min(bottom, 100) - top, 20, 100),
  };

  return {
    box: normalizeBox(box),
    composition,
    estimated: true,
    missing,
  };
}

function estimateBackgroundComplexity(image: HTMLImageElement, bodyBox: NormalizedBox): { complexity: BackgroundComplexity; score: number } {
  const width = 160;
  const height = Math.max(1, Math.round(width / ((image.naturalWidth || image.width) / (image.naturalHeight || image.height))));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { complexity: "medium" as BackgroundComplexity, score: 0.5 };
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let samples = 0;
  let edgeSum = 0;
  let colorVar = 0;
  let lastLuma = 0;
  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      const px = (x / width) * 100;
      const py = (y / height) * 100;
      if (pointInBox(px, py, bodyBox)) continue;
      const i = (y * width + x) * 4;
      const luma = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
      if (samples > 0) edgeSum += Math.abs(luma - lastLuma);
      colorVar += Math.abs(pixels[i] - pixels[i + 1]) + Math.abs(pixels[i + 1] - pixels[i + 2]);
      lastLuma = luma;
      samples += 1;
    }
  }
  if (!samples) return { complexity: "medium" as BackgroundComplexity, score: 0.5 };
  const score = clamp((edgeSum / samples) / 42 + (colorVar / samples) / 260, 0, 1);
  const complexity: BackgroundComplexity = score > 0.62 ? "complex" : score > 0.34 ? "medium" : "simple";
  return {
    complexity,
    score: round(score, 3),
  };
}

function scoreInput({ face, body, background, width, height }: { face: SourceFaceBox | null; body: ReturnType<typeof estimateBodyBox>; background: { complexity: BackgroundComplexity; score: number }; width: number; height: number }) {
  const issues: string[] = [];
  const recommendations: string[] = [];
  let score = 100;

  if (!face) {
    score -= 38;
    issues.push("No stable face box was detected.");
    recommendations.push("Generate or upload a front-facing portrait before rigging.");
  }
  if (body.composition === "headshot") {
    score -= 26;
    issues.push("The photo is a headshot; torso and limbs need AI completion.");
    recommendations.push("Use image generation to expand to a clean half-body or full-body character sheet.");
  } else if (body.composition === "upper_body") {
    score -= 14;
    issues.push("Lower body is incomplete for full-body rigging.");
    recommendations.push("Use AI outpainting if a full-body Live2D model is required.");
  }
  if (background.complexity === "complex") {
    score -= 12;
    issues.push("Background is complex and should be segmented before layer generation.");
    recommendations.push("Run person segmentation and create a clean transparent character layer.");
  }
  if (width < 768 || height < 768) {
    score -= 10;
    issues.push("Source resolution is low.");
    recommendations.push("Upscale the character plate before PSD/Cubism preparation.");
  }

  if (!issues.length) recommendations.push("Input is suitable for cloud segmentation and Live2D layer generation.");
  return {
    score: clamp(Math.round(score), 0, 100),
    issues,
    recommendations,
  };
}

async function detectFaceWithBrowser(image: HTMLImageElement): Promise<SourceFaceBox | null> {
  const FaceDetectorCtor = (window as Window & { FaceDetector?: BrowserFaceDetector }).FaceDetector;
  if (!FaceDetectorCtor) return null;
  const detector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 5 });
  const faces = await detector.detect(image);
  if (!faces.length) return null;
  const best = faces.map((face) => face.boundingBox).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return { x: best.x, y: best.y, width: best.width, height: best.height, method: "FaceDetector", confidence: 0.88 };
}

function estimateFaceBySkinCluster(image: HTMLImageElement): SourceFaceBox | null {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const maxEdge = 480;
  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  const scanMaxY = Math.round(height * 0.78);
  for (let y = 0; y < scanMaxY; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (isSkinPixel(pixels[index], pixels[index + 1], pixels[index + 2])) mask[y * width + x] = 1;
    }
  }

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let best: { x: number; y: number; width: number; height: number; score: number } | null = null;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [current - 1, current + 1, current - width, current + width];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        const nextX = next % width;
        if ((next === current - 1 && nextX > x) || (next === current + 1 && nextX < x)) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (area < 90 || boxWidth < width * 0.035 || boxHeight < height * 0.045) continue;
    const widthPct = boxWidth / width;
    const heightPct = boxHeight / height;
    const centerY = (minY + maxY) / 2 / height;
    const aspect = boxWidth / boxHeight;
    if (centerY > 0.72 || widthPct > 0.45 || heightPct > 0.54 || aspect < 0.32 || aspect > 1.25) continue;
    const fill = area / (boxWidth * boxHeight);
    const score = area * Math.max(0.15, 1 - Math.abs(aspect - 0.72) * 0.9) * (1 + (1 - centerY) * 1.8) * clamp(fill * 2.2, 0.35, 1.25);
    if (!best || score > best.score) best = { x: minX, y: minY, width: boxWidth, height: boxHeight, score };
  }
  if (!best) return null;
  return { x: best.x / scale, y: best.y / scale, width: best.width / scale, height: best.height / scale, method: "CanvasSkinCluster", confidence: 0.58 };
}

function isSkinPixel(red: number, green: number, blue: number) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const y = 0.299 * red + 0.587 * green + 0.114 * blue;
  const cb = 128 - 0.168736 * red - 0.331264 * green + 0.5 * blue;
  const cr = 128 + 0.5 * red - 0.418688 * green - 0.081312 * blue;
  const rgbSkin = red > 58 && green > 35 && blue > 22 && max - min > 12 && red > green * 1.03 && red > blue * 1.12;
  const ycbcrSkin = y > 45 && cb > 76 && cb < 138 && cr > 132 && cr < 184;
  return rgbSkin && ycbcrSkin;
}

function buildGenerationPrompt(body: { composition: Live2DComposition; missing: string[] }, background: { complexity: BackgroundComplexity }, hasFace: boolean) {
  const base = "Create a clean Live2D-ready character sheet from the uploaded person. Separate the person from the background, normalize to a front-facing anime/semi-real Live2D style, preserve identity cues, and output layered assets for Cubism rigging.";
  const bodyHint = body.composition === "headshot" ? "Outpaint torso, arms, and lower body in a neutral standing pose." : body.composition === "upper_body" ? "Complete lower body only if full-body rigging is requested." : "Keep the visible full-body proportions.";
  const faceHint = hasFace ? "Use the detected face as identity reference." : "First generate a stable front-facing face before layer separation.";
  const bgHint = background.complexity === "complex" ? "Use strong person segmentation and remove background clutter." : "Keep a clean transparent character layer.";
  return `${base} ${faceHint} ${bodyHint} ${bgHint} Required missing items: ${body.missing.join(", ") || "none"}.`;
}

function toNormalizedBox(box: { x: number; y: number; width: number; height: number }, width: number, height: number): NormalizedBox {
  return normalizeBox({
    x: (box.x / width) * 100,
    y: (box.y / height) * 100,
    width: (box.width / width) * 100,
    height: (box.height / height) * 100,
  });
}

function normalizeBox(box: NormalizedBox): NormalizedBox {
  return {
    x: round(clamp(box.x, 0, 100), 3),
    y: round(clamp(box.y, 0, 100), 3),
    width: round(clamp(box.width, 0, 100), 3),
    height: round(clamp(box.height, 0, 100), 3),
  };
}

function pointInBox(x: number, y: number, box: NormalizedBox) {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function loadImageFromFile(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image failed to load"));
    };
    image.src = url;
  });
}
"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { makeFaceThumbnail, saveAvatarThumbnail } from "@/lib/avatarThumbnailCache";

// Paths served from our own public/ directory — no US CDN dependency.
const DEFAULT_MODEL_URL = "/live2d/kei_vowels_pro/kei_vowels_pro.model3.json";
const LIVE2D_PARAM_IDS = {
  mouthOpen: "ParamMouthOpenY",
  mouthForm: "ParamMouthForm",
  eyeLOpen: "ParamEyeLOpen",
  eyeROpen: "ParamEyeROpen",
  breath: "ParamBreath",
  angleX: "ParamAngleX",
  angleY: "ParamAngleY",
  angleZ: "ParamAngleZ",
  bodyAngleX: "ParamBodyAngleX",
};

interface AvatarLive2DProps {
  /**
   * AnalyserNode tapping the TTS audio graph. When provided, the avatar's
   * mouth parameter is driven by the RMS level of this analyser.
   */
  analyser: AnalyserNode | null;
  /** Override the model3.json path. Defaults to Kei. Changing this
   *  triggers a full Live2D reload via the effect's dependency on it. */
  modelUrl?: string;
  /** Per-avatar framing override — different Live2D rigs ship with
   *  wildly different canvases (full body / half body / chibi), so a
   *  single fit ratio looks off across characters.
   *
   *  scaleBoost: multiplier on the "fit-to-height" baseline. 1.0 = whole
   *    model fits canvas height. >1 zooms in (something gets cropped);
   *    <1 leaves vertical letterbox.
   *
   *  anchorRatio: where in the canvas the overflow is cut. 0 = anchor
   *    model TOP to canvas top (crops legs, shows head/upper body).
   *    0.5 = center. 1 = anchor BOTTOM to canvas bottom (crops head).
   *    For full-body rigs, use 0 to keep the face on screen. */
  scaleBoost?: number;
  anchorRatio?: number;
  /** Shift the fitted model horizontally by this fraction of the viewport. */
  horizontalOffsetRatio?: number;
  /** When true, the wrapper div uses a transparent background instead of
   *  the slate gradient — lets a custom page background show through
   *  around the rendered model. */
  transparent?: boolean;
  /** Stable avatar id, used as the cache key when we snapshot the
   *  rendered canvas for the SettingsDrawer thumbnails. Omitting it
   *  disables the snapshot. */
  avatarId?: string;
}

function clampLive2D(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getBlinkValue(timeMs: number) {
  const phase = timeMs % 4300;
  if (phase > 165) return 0;
  return Math.sin((phase / 165) * Math.PI);
}

function setLive2DParam(coreModel: { setParameterValueById: (id: string, value: number) => void }, id: string, value: number) {
  try {
    coreModel.setParameterValueById(id, value);
  } catch {
    // Some third-party models do not implement every standard Cubism parameter.
  }
}
/**
 * Lightweight Live2D avatar.
 *
 *  - PIXI v6.5.10 is forced into WEBGL_LEGACY mode BEFORE any Renderer is
 *    created, to sidestep the checkMaxIfStatementsInShader bug on some
 *    Chrome/ANGLE drivers (see earlier debugging session).
 *  - The model is loaded from /public/ on this same origin, not an external
 *    CDN — this keeps the avatar working on Chinese networks.
 *  - Mouth parameter is driven by RMS of the TTS AnalyserNode supplied by
 *    useAudioPlayer. Reusing the same AudioContext as playback avoids the
 *    cross-context MediaStream sample-rate mismatch that kept the mouth
 *    frozen in an earlier attempt.
 */
export function AvatarLive2D({
  analyser,
  modelUrl = DEFAULT_MODEL_URL,
  scaleBoost: scaleBoostProp = 1.3,
  anchorRatio: anchorRatioProp = 0.0,
  horizontalOffsetRatio: horizontalOffsetRatioProp = 0.0,
  transparent = false,
  avatarId,
}: AvatarLive2DProps) {
  // Allow live tuning via URL params — `?fit=1.4,0.1` overrides whatever
  // the avatar registry sets. Lets us iterate on framing without a
  // redeploy: open the page, tweak until the head/shoulders look right,
  // bake the numbers into availableAvatars.ts. Only read once on mount.
  const [scaleBoost, anchorRatio, horizontalOffsetRatio] = useMemo(() => {
    if (typeof window === "undefined")
      return [scaleBoostProp, anchorRatioProp, horizontalOffsetRatioProp] as const;
    const raw = new URLSearchParams(window.location.search).get("fit");
    if (!raw)
      return [scaleBoostProp, anchorRatioProp, horizontalOffsetRatioProp] as const;
    const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()));
    const s = Number.isFinite(parts[0]) ? parts[0] : scaleBoostProp;
    const a = Number.isFinite(parts[1]) ? parts[1] : anchorRatioProp;
    const x = Number.isFinite(parts[2]) ? parts[2] : horizontalOffsetRatioProp;
    return [s, a, x] as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const mouthValueRef = useRef(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  // ---------------------------------------------------------------
  // Initialize PIXI + load Live2D model (runs once per canvas mount).
  // ---------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!canvasRef.current) return;

    let cancelled = false;

    const init = async () => {
      try {
        // Wait for the Cubism Core script (loaded via <script> in layout.tsx).
        await new Promise<void>((resolve, reject) => {
          if ((window as any).Live2DCubismCore) return resolve();
          let elapsed = 0;
          const h = setInterval(() => {
            if ((window as any).Live2DCubismCore) {
              clearInterval(h);
              resolve();
              return;
            }
            elapsed += 100;
            if (elapsed >= 10000) {
              clearInterval(h);
              reject(new Error("Cubism Core failed to load"));
            }
          }, 100);
        });

        if (cancelled) return;

        // Import PIXI dynamically (it touches `window`).
        const PIXI = await import("pixi.js");
        // Critical fix: avoid the checkMaxIfStatementsInShader(0) bug in
        // PIXI v6 batchRenderer by forcing the legacy WebGL path.
        (PIXI as any).settings.PREFER_ENV = (PIXI as any).ENV.WEBGL_LEGACY;
        // Expose PIXI globally for pixi-live2d-display.
        (window as any).PIXI = PIXI;

        const { Live2DModel } = await import(
          "pixi-live2d-display/cubism4"
        );

        if (cancelled) return;

        const app = new (PIXI as any).Application({
          view: canvasRef.current,
          autoStart: true,
          backgroundAlpha: 0,
          antialias: false,
          powerPreference: "low-power",
          resizeTo: canvasRef.current?.parentElement ?? undefined,
        });
        appRef.current = app;

        const model = await Live2DModel.from(modelUrl);
        if (cancelled) {
          model.destroy?.();
          return;
        }
        // Disable auto mouse/touch tracking — otherwise Live2D attaches
        // pointer listeners to document, makes the avatar stare at the cursor
        // (creepy), AND hijacks clicks that should hit Start / Mic buttons.
        try {
          (model as any).autoInteract = false;
          model.interactive = false;
          model.interactiveChildren = false;
        } catch {}
        modelRef.current = model;
        app.stage.addChild(model);

        // ⚠️ pixi-live2d-display 的 model.width/height 返回的是 Cubism
        // 模型的"画布"尺寸(含大量透明 padding),不是角色实际渲染区域。
        // 直接拿它 fit 会让角色相对画布缩得极小。
        // 正解:渲染一帧后用 getLocalBounds() 取角色实际边界,以此
        // 作为 fit 基准。bounds.x/y 反映角色在画布里的偏移,positioning
        // 时要补回去,角色才会真正居中而不是带着 padding 居中。
        model.scale.set(1);
        model.position.set(0, 0);
        app.render();
        const nb = model.getLocalBounds();

        // Fit the model to the canvas. Two-step:
        //   1. scale = min(parent_w / bounds_w, parent_h / bounds_h) × scaleBoost
        //      —— scaleBoost=1.0 让角色完美装入两个方向,>1 主动裁出局部。
        //   2. position: anchorRatio (0=顶/0.5=中/1=底) 决定多余空间留哪边。
        //      bounds 的 x/y 偏移叠在 model.x/y 上,补偿透明 padding。
        // 这次 scaleBoost / anchorRatio 的"基准刻度"完全变了:之前的
        // 数值是为了补偿"按画布 fit"的过小问题。现在按角色 fit 后,
        // 大多数角色 scaleBoost=1.0 / anchorRatio=0.5 就是正常居中。
        const fit = () => {
          const parent = canvasRef.current?.parentElement;
          if (!parent || !model || !nb.width || !nb.height) return;
          const fitH = parent.clientHeight / nb.height;
          const fitW = parent.clientWidth / nb.width;
          const scale = Math.min(fitH, fitW) * scaleBoost;
          model.scale.set(scale);
          const visibleW = nb.width * scale;
          const visibleH = nb.height * scale;
          // 让角色可见区域(而不是画布原点)落在期望位置:
          model.x =
            (parent.clientWidth - visibleW) / 2 -
            nb.x * scale +
            parent.clientWidth * horizontalOffsetRatio;
          model.y =
            -nb.y * scale + anchorRatio * (parent.clientHeight - visibleH);
          // Always log so we can iterate without ?fit-debug.
          console.log("[AvatarLive2D] fit", {
            modelUrl,
            scaleBoost,
            anchorRatio,
            horizontalOffsetRatio,
            parent: { w: parent.clientWidth, h: parent.clientHeight },
            naturalBounds: {
              x: nb.x,
              y: nb.y,
              w: nb.width,
              h: nb.height,
            },
            applied: { scale, x: model.x, y: model.y },
          });
        };
        fit();

        // Snapshot the rendered canvas into the thumbnail cache once
        // the first real frame is on screen. Wait a few frames so the
        // model is actually visible (alloc + first draw can lag the
        // promise resolution by 1-2 frames in PIXI v6).
        if (avatarId && canvasRef.current) {
          let tries = 0;
          const snap = () => {
            if (cancelled || !canvasRef.current) return;
            tries += 1;
            try {
              // Fast pre-check: is anything on the canvas yet?
              // A freshly-cleared canvas serializes to a tiny dataURL.
              const probe = canvasRef.current.toDataURL("image/png");
              if (probe.length > 5000) {
                // Now do the real face-crop using the alpha bbox.
                const cropped = makeFaceThumbnail(canvasRef.current, 256);
                if (cropped) {
                  saveAvatarThumbnail(avatarId, cropped);
                  return;
                }
              }
            } catch {
              return;
            }
            if (tries < 60) requestAnimationFrame(snap);
          };
          requestAnimationFrame(snap);
        }

        // 用 ResizeObserver 直接观察父容器,涵盖所有尺寸变化:
        //   - 窗口 resize
        //   - portrait <-> landscape 布局切换的中间帧
        //   - 设置抽屉开/合、字体缩放、Card 自适应
        // 旧代码只挂 window.resize → 中间帧父容器可能极小,fit() 算出
        // 一个巨大的 scale,模型只露出头顶头发那一小块。
        // rAF 节流避免 ResizeObserver 触发回调时 layout 还没稳定就读
        // clientHeight,产生抖动。
        const parent = canvasRef.current?.parentElement;
        let pendingRaf = 0;
        const scheduleFit = () => {
          if (pendingRaf) return;
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = 0;
            fit();
          });
        };
        let resizeObserver: ResizeObserver | null = null;
        if (parent && typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(scheduleFit);
          resizeObserver.observe(parent);
        } else {
          // Fallback for ancient browsers without ResizeObserver
          window.addEventListener("resize", scheduleFit);
        }
        // Stash for cleanup
        (appRef as any).__cleanupFit = () => {
          if (pendingRaf) cancelAnimationFrame(pendingRaf);
          resizeObserver?.disconnect();
          window.removeEventListener("resize", scheduleFit);
        };

        // Drive standard Cubism parameters each frame. This keeps audio lip-sync,
        // idle breathing, blink, and subtle head/body motion independent.
        const tick = () => {
          const m = modelRef.current;
          const coreModel = m?.internalModel?.coreModel;
          if (coreModel?.setParameterValueById) {
            const time = performance.now();
            const mouth = mouthValueRef.current;
            const blink = getBlinkValue(time);
            const breath = (Math.sin(time / 1850) + 1) * 0.5;
            const mouthForm = clampLive2D(Math.sin(time / 95) * mouth * 0.42, -0.45, 0.45);
            const talkNod = mouth * Math.sin(time / 210);

            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.mouthOpen, mouth);
            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.mouthForm, mouthForm);
            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.eyeLOpen, 1 - blink * 0.92);
            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.eyeROpen, 1 - blink * 0.92);
            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.breath, breath);
            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.angleX, Math.sin(time / 2600) * 3 + talkNod * 1.1);
            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.angleY, Math.sin(time / 3400) * 2);
            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.angleZ, Math.sin(time / 4800) * 1.2 + talkNod * 0.35);
            setLive2DParam(coreModel, LIVE2D_PARAM_IDS.bodyAngleX, Math.sin(time / 3900) * 1.6);
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();

        setLoading(false);
      } catch (e) {
        console.error("[AvatarLive2D] init failed:", e);
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    };

    init();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try {
        (appRef as any).__cleanupFit?.();
      } catch {}
      try {
        modelRef.current?.destroy?.();
      } catch {}
      try {
        appRef.current?.destroy?.(false, { children: true });
      } catch {}
      appRef.current = null;
      modelRef.current = null;
    };
  }, [modelUrl, scaleBoost, anchorRatio]);

  // ---------------------------------------------------------------
  // Drive the mouth from the TTS AnalyserNode supplied by useAudioPlayer.
  // Same AudioContext as playback → no cross-context sample-rate issues.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!analyser) return;

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let active = true;
    let smoothed = 0;
    let frames = 0;

    const loop = () => {
      if (!active) return;
      analyser.getByteTimeDomainData(buffer);
      // Compute RMS in [0, 1].
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = (buffer[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buffer.length);
      // Scale + clamp.
      const target = Math.min(1, rms * 4);
      // Low-pass smoothing for natural motion.
      smoothed = smoothed * 0.5 + target * 0.5;
      mouthValueRef.current = smoothed;
      // One-time debug log so we can verify audio is reaching the analyser.
      if (frames === 30 || (frames % 120 === 0 && smoothed > 0.05)) {
        console.log(
          `[AvatarLive2D] RMS=${rms.toFixed(3)} mouth=${smoothed.toFixed(3)}`,
        );
      }
      frames++;
      requestAnimationFrame(loop);
    };
    loop();

    return () => {
      active = false;
      mouthValueRef.current = 0;
    };
  }, [analyser]);

  return (
    <div
      className={
        "relative h-full w-full overflow-hidden rounded-xl " +
        (transparent
          ? "bg-transparent"
          : "bg-gradient-to-b from-slate-900 to-slate-800")
      }
    >
      {/* pointer-events: none so clicks fall through to UI below. */}
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ pointerEvents: "none" }}
      />
      {loading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/80">
          <Loader2 className="h-6 w-6 animate-spin" />
          <div className="text-sm">{t("avatar.loading")}</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-900/80 p-4 text-center text-sm text-white">
          {error}
        </div>
      )}
    </div>
  );
}

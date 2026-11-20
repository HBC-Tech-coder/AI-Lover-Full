"use client";

/**
 * First-run guided tour for AI-Lover 2.0.
 *
 * The tour appears after consent and explains the cloud agent plus local
 * connector workflow: start the agent, open settings, connect the robot head,
 * connect the hand bridge, choose cameras, then pick the avatar/scene.
 * Completion persists in settings.tourCompleted, so it only runs once per
 * browser unless the user resets local settings.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage, type Language } from "@/lib/i18n";
import { useSettings } from "@/lib/settingsStore";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

type TourStepKey =
  | "welcome"
  | "start"
  | "mic"
  | "settings"
  | "head"
  | "hand"
  | "camera"
  | "character"
  | "model"
  | "background"
  | "done";

interface Step {
  key: TourStepKey;
  /** CSS selector of the element to spotlight; omitted = centered card. */
  selector?: string;
  /** Whether the settings drawer must be open for this step. */
  drawer?: boolean;
}

interface TourText {
  title: string;
  body: string;
}

const STEPS: Step[] = [
  { key: "welcome" },
  { key: "start", selector: '[data-tour="start"]' },
  { key: "mic", selector: '[data-tour="mic"]' },
  { key: "settings", selector: '[data-tour="settings"]' },
  { key: "head", selector: '[data-tour="head"]', drawer: true },
  { key: "hand", selector: '[data-tour="hand"]', drawer: true },
  { key: "camera", selector: '[data-tour="camera"]', drawer: true },
  { key: "character", selector: '[data-tour="char"]', drawer: true },
  { key: "model", selector: '[data-tour="model"]', drawer: true },
  { key: "background", selector: '[data-tour="bg"]', drawer: true },
  { key: "done" },
];

const TOUR_COPY: Record<
  Language,
  {
    steps: Record<TourStepKey, TourText>;
    actions: { skip: string; back: string; next: string; done: string };
  }
> = {
  zh: {
    steps: {
      welcome: {
        title: "欢迎使用 AI-Lover 2.0",
        body: "2.0 支持云端智能体、本地硅胶头机芯、ORCA/Arduino 机械手、摄像头手势识别、粒子特效和第二屏展示。",
      },
      start: {
        title: "1. 先点开始",
        body: "点击开始后会连接云端 agent。可以先用文字测试；需要语音时再打开麦克风。",
      },
      mic: {
        title: "2. 麦克风和摄像头",
        body: "电脑麦克风可直接对话；连接头部桥接后，也可以切换为头部麦克风。摄像头用于手势骨架、机械手控制和特效。",
      },
      settings: {
        title: "3. 打开设置",
        body: "头部 IP、桥接地址、机械手、摄像头、第二屏、角色、模型和背景都在这里配置。",
      },
      head: {
        title: "4. 连接硅胶头机芯",
        body: "先运行本地连接器，填写头部 IP；桥接地址通常保持 http://127.0.0.1:8787。可在这里重连、检测、测试喇叭和测试头部麦克风。",
      },
      hand: {
        title: "5. 连接机械手臂",
        body: "机械手 bridge 通常是 http://127.0.0.1:8791。先检测串口，再选择 Arduino 手或 ORCA 手；关闭 Dry-run 后才会真正下发到硬件。",
      },
      camera: {
        title: "6. 摄像头、特效和第二屏",
        body: "选择清晰摄像头后可识别手势。比心会出爱心，多手比心会触发铜钱特效；需要大屏互动时打开第二屏页面。",
      },
      character: {
        title: "7. 选择角色",
        body: "这里可以切换内置角色，也可以使用角色管理上传私有或共享的 Live2D 角色。",
      },
      model: {
        title: "8. 选择形象模式",
        body: "可在 Live2D、照片数字人、本地 GPU 预览等模式之间切换。客户演示建议先用稳定的 Live2D 模式。",
      },
      background: {
        title: "9. 设置背景",
        body: "选择一个适合场景的背景。对外演示时，背景会影响整体沉浸感和画面观感。",
      },
      done: {
        title: "准备好了",
        body: "现在可以开始对话。硬件断开时，回到设置里点启动/重连即可，不需要重新打开整个系统。",
      },
    },
    actions: { skip: "跳过", back: "上一步", next: "下一步", done: "完成" },
  },
  en: {
    steps: {
      welcome: {
        title: "Welcome to AI-Lover 2.0",
        body: "2.0 supports the cloud agent, local robot head, ORCA/Arduino hand, camera gesture tracking, particle effects, and a second-screen stage.",
      },
      start: {
        title: "1. Start the agent",
        body: "Click Start to connect to the cloud agent. You can test with text first, then enable the microphone when voice is needed.",
      },
      mic: {
        title: "2. Microphone and camera",
        body: "Use the computer mic by default, or switch to the robot-head mic after the local head bridge is connected. The camera drives hand tracking and effects.",
      },
      settings: {
        title: "3. Open settings",
        body: "Head IP, bridge endpoints, hand control, cameras, second screen, characters, models, and backgrounds are configured here.",
      },
      head: {
        title: "4. Connect the robot head",
        body: "Run the local connector, enter the head IP, and usually keep the bridge endpoint as http://127.0.0.1:8787. You can reconnect, detect, and test speaker or mic here.",
      },
      hand: {
        title: "5. Connect the robot hand",
        body: "The hand bridge is usually http://127.0.0.1:8791. Detect ports first, choose Arduino or ORCA, and turn off Dry-run before sending real hardware commands.",
      },
      camera: {
        title: "6. Camera, effects, stage",
        body: "Choose a clear camera for gesture tracking. Heart gestures trigger hearts, multi-hand hearts trigger coins, and the second screen opens a stage view.",
      },
      character: {
        title: "7. Choose a character",
        body: "Switch built-in roles here, or upload private/shared Live2D characters in Character Manager.",
      },
      model: {
        title: "8. Choose avatar mode",
        body: "Switch between Live2D, photo avatar, and local GPU preview modes. For demos, Live2D is the safest default.",
      },
      background: {
        title: "9. Set the background",
        body: "Pick a scene background that matches your demo. It changes the overall presentation feel.",
      },
      done: {
        title: "You are ready",
        body: "Start chatting now. If hardware disconnects, return to Settings and use Start/Reconnect instead of restarting everything.",
      },
    },
    actions: { skip: "Skip", back: "Back", next: "Next", done: "Done" },
  },
  ja: {
    steps: {
      welcome: {
        title: "AI-Lover 2.0 へようこそ",
        body: "2.0 はクラウド AI、本地のロボットヘッド、ORCA/Arduino ハンド、カメラ手勢認識、粒子エフェクト、第二スクリーンに対応します。",
      },
      start: {
        title: "1. 開始します",
        body: "開始を押すとクラウド agent に接続します。まず文字入力でテストし、必要な時にマイクをオンにします。",
      },
      mic: {
        title: "2. マイクとカメラ",
        body: "通常は PC マイクを使います。ヘッド bridge 接続後はヘッドマイクにも切り替えできます。カメラは手勢認識とエフェクトに使います。",
      },
      settings: {
        title: "3. 設定を開きます",
        body: "ヘッド IP、bridge、ハンド、カメラ、第二スクリーン、キャラクター、モデル、背景をここで設定します。",
      },
      head: {
        title: "4. ロボットヘッド接続",
        body: "本地 connector を起動し、ヘッド IP を入力します。bridge は通常 http://127.0.0.1:8787 のままです。スピーカーとマイクもここでテストします。",
      },
      hand: {
        title: "5. ロボットハンド接続",
        body: "ハンド bridge は通常 http://127.0.0.1:8791 です。先にポートを検出し、Arduino または ORCA を選び、実機では Dry-run をオフにします。",
      },
      camera: {
        title: "6. カメラと第二スクリーン",
        body: "明るく鮮明なカメラを選んでください。ハート手勢でハート、多人数手勢でコイン効果が出ます。大画面には第二スクリーンを使います。",
      },
      character: {
        title: "7. キャラクター選択",
        body: "内蔵キャラクターを切り替えたり、Character Manager で Live2D モデルをアップロードできます。",
      },
      model: {
        title: "8. 表示モード選択",
        body: "Live2D、写真アバター、本地 GPU プレビューを切り替えできます。デモでは Live2D が安定しています。",
      },
      background: {
        title: "9. 背景設定",
        body: "デモに合う背景を選ぶと、全体の雰囲気が良くなります。",
      },
      done: {
        title: "準備完了",
        body: "会話を始められます。ハードウェアが切れた時は設定で再接続してください。",
      },
    },
    actions: { skip: "スキップ", back: "戻る", next: "次へ", done: "完了" },
  },
};

const PAD = 6;

interface GuidedTourProps {
  openSettings: () => void;
  closeSettings: () => void;
}

export function GuidedTour({ openSettings, closeSettings }: GuidedTourProps) {
  const lang = useLanguage();
  const copy = TOUR_COPY[lang] ?? TOUR_COPY.zh;
  const [settings, setSettings] = useSettings();
  const [mounted, setMounted] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const scrolledForIndex = useRef<number>(-1);

  useEffect(() => setMounted(true), []);

  const active = mounted && settings.consentAccepted && !settings.tourCompleted;
  const step = STEPS[index];
  const stepCopy = copy.steps[step.key];

  useEffect(() => {
    if (!active) return;
    if (step.drawer) openSettings();
    else closeSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, active]);

  useEffect(() => {
    if (!active) return;
    scrolledForIndex.current = -1;
    let raf = 0;
    const tick = () => {
      if (step.selector) {
        const el = document.querySelector(step.selector) as HTMLElement | null;
        if (el) {
          if (step.drawer && scrolledForIndex.current !== index) {
            scrolledForIndex.current = index;
            el.scrollIntoView({ block: "center", behavior: "smooth" });
          }
          const r = el.getBoundingClientRect();
          setRect((prev) =>
            prev &&
            prev.top === r.top &&
            prev.left === r.left &&
            prev.width === r.width &&
            prev.height === r.height
              ? prev
              : { top: r.top, left: r.left, width: r.width, height: r.height },
          );
        } else {
          setRect(null);
        }
      } else {
        setRect(null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, active]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!rect) {
      setCardPos({ left: (vw - cw) / 2, top: (vh - ch) / 2 });
      return;
    }
    let top = rect.top + rect.height + 14;
    if (top + ch > vh - 8) top = rect.top - ch - 14;
    if (top < 8) top = 8;
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(8, Math.min(left, vw - cw - 8));
    setCardPos({ top, left });
  }, [rect, index, active]);

  if (!active) return null;

  const finish = () => {
    closeSettings();
    setSettings({ tourCompleted: true });
  };
  const isLast = index === STEPS.length - 1;
  const next = () => (isLast ? finish() : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  return (
    <div className="fixed inset-0 z-[90]">
      <button
        type="button"
        aria-label={copy.actions.skip}
        onClick={() => {}}
        className={
          "absolute inset-0 cursor-default " + (rect ? "" : "bg-black/70")
        }
      />

      {rect && (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-white/80 transition-all duration-200"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.7)",
          }}
        />
      )}

      <div
        ref={cardRef}
        className="absolute w-[320px] max-w-[calc(100vw-16px)] rounded-2xl border border-border/40 bg-card/95 p-4 shadow-2xl backdrop-blur"
        style={{ top: cardPos?.top ?? -9999, left: cardPos?.left ?? -9999 }}
      >
        <div className="font-semibold text-base text-foreground">
          {stepCopy.title}
        </div>
        <p className="mt-1 text-muted-foreground text-sm leading-relaxed">
          {stepCopy.body}
        </p>

        <div className="mt-3 flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={
                "h-1.5 rounded-full transition-all " +
                (i === index ? "w-4 bg-primary" : "w-1.5 bg-border")
              }
            />
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={finish}
            className="text-muted-foreground text-xs hover:text-foreground"
          >
            {copy.actions.skip}
          </button>
          <div className="flex gap-2">
            {index > 0 && (
              <Button variant="outline" size="sm" onClick={back}>
                {copy.actions.back}
              </Button>
            )}
            <Button size="sm" onClick={next}>
              {isLast ? copy.actions.done : copy.actions.next}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

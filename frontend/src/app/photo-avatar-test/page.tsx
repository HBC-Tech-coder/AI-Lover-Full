"use client";

import {
  ArrowLeft,
  FileAudio,
  ImagePlus,
  Play,
  RefreshCw,
  ScanFace,
  SlidersHorizontal,
  Square,
  Upload,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FrameState = {
  mouth: number;
  tilt: number;
  bob: number;
  blink: number;
  breathe: number;
};

type FaceGuide = {
  x: number;
  y: number;
  width: number;
  height: number;
  method: string;
};

type SourceFaceBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  method: string;
};

const DEFAULT_TEXT = "你好，我是本地照片数字人。现在这段语音和嘴型动画全部在浏览器里运行，不需要 Trulience，也不需要 GPU。";

export default function PhotoAvatarTestPage() {
  const [imageUrl, setImageUrl] = useState("");
  const [imageName, setImageName] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [audioName, setAudioName] = useState("");
  const [text, setText] = useState(DEFAULT_TEXT);
  const [status, setStatus] = useState("等待上传照片");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [rate, setRate] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [volume, setVolume] = useState(1);
  const [mouthX, setMouthX] = useState(50);
  const [mouthY, setMouthY] = useState(62);
  const [mouthSize, setMouthSize] = useState(18);
  const [sensitivity, setSensitivity] = useState(1.15);
  const [faceGuide, setFaceGuide] = useState<FaceGuide | null>(null);
  const [detectingFace, setDetectingFace] = useState(false);
  const [headMotion, setHeadMotion] = useState(true);
  const [showGuides, setShowGuides] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [frame, setFrame] = useState<FrameState>({ mouth: 0, tilt: 0, bob: 0, blink: 0, breathe: 0 });

  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const imageUrlRef = useRef("");
  const audioUrlRef = useRef("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechActiveRef = useRef(false);
  const boundaryPulseRef = useRef(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceReadyRef = useRef(false);
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const lastFrameRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const loadVoices = () => setVoices(window.speechSynthesis.getVoices());
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, []);

  useEffect(() => {
    imageUrlRef.current = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      void audioContextRef.current?.close();
    };
  }, []);

  const voiceOptions = useMemo(() => {
    return voices
      .filter((voice) => voice.lang.toLowerCase().startsWith("zh") || voice.lang.toLowerCase().startsWith("en"))
      .concat(voices.filter((voice) => !voice.lang.toLowerCase().startsWith("zh") && !voice.lang.toLowerCase().startsWith("en")))
      .slice(0, 80);
  }, [voices]);

  const stopAll = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    audioRef.current?.pause();
    speechActiveRef.current = false;
    boundaryPulseRef.current = 0;
    utteranceRef.current = null;
    setSpeaking(false);
    setFrame((state) => ({ ...state, mouth: 0, breathe: 0 }));
    setStatus(imageUrl ? "已停止" : "等待上传照片");
  }, [imageUrl]);

  useEffect(() => {
    let raf = 0;
    const tick = (time: number) => {
      raf = window.requestAnimationFrame(tick);
      if (time - lastFrameRef.current < 33) return;
      lastFrameRef.current = time;

      let mouth = 0;
      const audio = audioRef.current;
      const analyser = analyserRef.current;
      if (audio && analyser && !audio.paused && !audio.ended) {
        let data = analyserDataRef.current;
        if (!data || data.length !== analyser.fftSize) {
          data = new Uint8Array(analyser.fftSize);
          analyserDataRef.current = data;
        }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        mouth = clamp(rms * 8 * sensitivity, 0, 1);
      } else if (speechActiveRef.current) {
        boundaryPulseRef.current = Math.max(boundaryPulseRef.current * 0.92, 0.28);
        const fast = (Math.sin(time / 52) + 1) * 0.5;
        const slow = (Math.sin(time / 118) + 1) * 0.5;
        mouth = clamp((0.18 + fast * 0.58 + slow * 0.2) * boundaryPulseRef.current * volume * sensitivity, 0, 1);
      }

      const idle = Math.sin(time / 1800) * 0.45;
      const tilt = headMotion ? idle + mouth * Math.sin(time / 420) * 1.25 : 0;
      const bob = headMotion ? Math.sin(time / 950) * 2 + mouth * 5 : 0;
      const blinkPhase = time % 4200;
      const blink = blinkPhase < 170 ? Math.sin((blinkPhase / 170) * Math.PI) : 0;
      const breathe = headMotion ? (Math.sin(time / 2300) + 1) * 0.5 : 0;
      setFrame({ mouth, tilt, bob, blink, breathe });
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [headMotion, sensitivity, volume]);

  function uploadImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("请选择图片文件");
      return;
    }
    stopAll();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setImageName(file.name);
    setFaceGuide(null);
    setStatus("照片已加载，正在自动定位嘴巴...");
    void autoLocateMouth(url);
  }

  async function autoLocateMouth(url = imageUrl) {
    if (!url || detectingFace) return;
    setDetectingFace(true);
    setStatus("正在本地识别人脸和嘴巴位置...");
    try {
      const result = await locateMouthFromImage(url);
      if (!result) {
        setFaceGuide(null);
        setShowGuides(true);
        setStatus("没有稳定识别到人脸；请打开校准线后手动调整 X/Y/Size。");
        return;
      }
      setMouthX(result.mouthX);
      setMouthY(result.mouthY);
      setMouthSize(result.mouthSize);
      setFaceGuide(result.faceGuide);
      setShowGuides(true);
      setStatus(`已自动定位嘴巴（${result.faceGuide.method}），可继续微调。`);
    } catch (error) {
      setFaceGuide(null);
      setShowGuides(true);
      setStatus(error instanceof Error ? error.message : "自动定位失败，请手动调整。");
    } finally {
      setDetectingFace(false);
    }
  }

  function uploadAudio(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setStatus("请选择音频文件");
      return;
    }
    stopAll();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file);
    setAudioUrl(url);
    setAudioName(file.name);
    setStatus("音频已加载，可以用真实音频能量驱动口型");
  }

  async function prepareAudioAnalyser() {
    const audio = audioRef.current;
    if (!audio) return;
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      setStatus("当前浏览器不支持 Web Audio");
      return;
    }
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor();
    }
    const context = audioContextRef.current;
    if (context.state === "suspended") await context.resume();
    if (!audioSourceReadyRef.current) {
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.62;
      source.connect(analyser);
      analyser.connect(context.destination);
      analyserRef.current = analyser;
      audioSourceReadyRef.current = true;
    }
  }

  async function playAudioFile() {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    stopSpeechOnly();
    await prepareAudioAnalyser();
    audio.currentTime = 0;
    await audio.play();
    setSpeaking(true);
    setStatus("正在播放音频文件");
  }

  function stopSpeechOnly() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    speechActiveRef.current = false;
    utteranceRef.current = null;
  }

  function speakText() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setStatus("当前浏览器不支持本地语音合成");
      return;
    }
    const value = text.trim();
    if (!value) return;
    audioRef.current?.pause();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(value);
    const selectedVoice = voices.find((voice) => voice.voiceURI === voiceURI) ?? voices.find((voice) => voice.lang.toLowerCase().startsWith("zh"));
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.lang = selectedVoice?.lang || "zh-CN";
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;
    utterance.onstart = () => {
      speechActiveRef.current = true;
      boundaryPulseRef.current = 0.8;
      setSpeaking(true);
      setStatus("正在用浏览器本地语音合成");
    };
    utterance.onboundary = (event) => {
      const chunk = value.slice(event.charIndex, event.charIndex + Math.max(event.charLength || 2, 2));
      boundaryPulseRef.current = Math.max(boundaryPulseRef.current, estimateSpeechPulse(chunk));
    };
    utterance.onend = () => {
      speechActiveRef.current = false;
      boundaryPulseRef.current = 0;
      setSpeaking(false);
      setStatus("语音播放完成");
    };
    utterance.onerror = () => {
      speechActiveRef.current = false;
      boundaryPulseRef.current = 0;
      setSpeaking(false);
      setStatus("浏览器语音合成被中断");
    };
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  function resetMouth() {
    setMouthX(50);
    setMouthY(62);
    setMouthSize(18);
    setSensitivity(1.15);
    setFaceGuide(null);
    setStatus("口型位置已重置");
  }

  const mouthHeight = Math.max(0.8, mouthSize * (0.08 + frame.mouth * 0.32));
  const mouthWidth = mouthSize * (0.72 + frame.mouth * 0.18);
  const faceCenterX = faceGuide ? faceGuide.x + faceGuide.width * 0.5 : 50;
  const faceCenterY = faceGuide ? faceGuide.y + faceGuide.height * 0.5 : 36;
  const shoulderY = faceGuide ? clamp(faceGuide.y + faceGuide.height * 1.92, 0, 100) : 72;
  const bodyBottomY = 100;
  const subjectLeft = faceGuide ? clamp(faceCenterX - faceGuide.width * 1.95, 0, 100) : 0;
  const subjectRight = faceGuide ? clamp(faceCenterX + faceGuide.width * 1.95, 0, 100) : 100;
  const subjectNeckLeft = faceGuide ? clamp(faceCenterX - faceGuide.width * 0.62, 0, 100) : 28;
  const subjectNeckRight = faceGuide ? clamp(faceCenterX + faceGuide.width * 0.62, 0, 100) : 72;
  const subjectTopY = faceGuide ? clamp(faceGuide.y - faceGuide.height * 0.18, 0, 100) : 0;
  const subjectClipPath = faceGuide
    ? `polygon(${subjectNeckLeft}% ${subjectTopY}%, ${subjectNeckRight}% ${subjectTopY}%, ${subjectRight}% ${shoulderY}%, ${clamp(subjectRight - faceGuide.width * 0.25, 0, 100)}% ${bodyBottomY}%, ${clamp(subjectLeft + faceGuide.width * 0.25, 0, 100)}% ${bodyBottomY}%, ${subjectLeft}% ${shoulderY}%)`
    : "inset(0)";
  const faceClipPath = faceGuide
    ? `ellipse(${Math.max(7, faceGuide.width * 0.62)}% ${Math.max(7, faceGuide.height * 0.72)}% at ${faceCenterX}% ${faceCenterY}%)`
    : "inset(0)";
  const mouthPatchClipPath = `ellipse(${Math.max(2.3, mouthWidth * 0.85)}% ${Math.max(1.2, mouthSize * 0.28)}% at ${mouthX}% ${mouthY + mouthSize * 0.08}%)`;
  const subjectOrigin = `${faceCenterX}% ${clamp(faceGuide ? faceGuide.y + faceGuide.height * 2.15 : 78, 45, 108)}%`;
  const faceOrigin = `${faceCenterX}% ${faceCenterY}%`;
  const subjectTransform = `translateY(${frame.bob * 0.12}px) scale(${1 + frame.breathe * 0.014})`;
  const faceTransform = `translateY(${frame.bob * 0.25}px) rotate(${frame.tilt * 0.22}deg) scale(${1 + frame.mouth * 0.003})`;
  const jawDropPx = Math.max(1.4, mouthSize * 0.36) * frame.mouth;
  const jawTransform = `${faceTransform} translateY(${jawDropPx}px)`;
  const mouthShadowOpacity = clamp(0.18 + frame.mouth * 0.62, 0.18, 0.82);
  const leftEye = faceGuide
    ? { x: faceGuide.x + faceGuide.width * 0.35, y: faceGuide.y + faceGuide.height * 0.38, w: faceGuide.width * 0.16, h: faceGuide.height * 0.035 }
    : { x: 38, y: 37, w: 18, h: 3.6 };
  const rightEye = faceGuide
    ? { x: faceGuide.x + faceGuide.width * 0.65, y: faceGuide.y + faceGuide.height * 0.38, w: faceGuide.width * 0.16, h: faceGuide.height * 0.035 }
    : { x: 62, y: 37, w: 18, h: 3.6 };

  return (
    <main className="min-h-screen bg-[#101419] text-zinc-100">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl gap-5 px-4 py-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col gap-4">
          <header className="flex items-start justify-between gap-3 border-zinc-800 border-b pb-4">
            <div>
              <h1 className="font-semibold text-2xl tracking-normal">本地照片数字人</h1>
              <p className="mt-1 text-sm text-zinc-400">{status}</p>
            </div>
            <Link className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" href="/" title="返回主页">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </header>

          <section className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <input ref={imageInputRef} accept="image/*" className="hidden" onChange={(event) => uploadImage(event.target.files?.[0])} type="file" />
            <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 font-medium text-zinc-950 hover:bg-emerald-300" onClick={() => imageInputRef.current?.click()} type="button">
              <Upload className="h-4 w-4" />
              上传照片
            </button>
            <div className="min-h-5 truncate text-zinc-500 text-xs">{imageName || "未选择照片"}</div>
          </section>

          <section className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <label className="grid gap-1.5 text-sm text-zinc-300">
              <span className="text-zinc-500 text-xs uppercase">Text</span>
              <textarea className="min-h-28 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-400" onChange={(event) => setText(event.target.value)} value={text} />
            </label>
            <label className="grid gap-1.5 text-sm text-zinc-300">
              <span className="text-zinc-500 text-xs uppercase">Voice</span>
              <select className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm outline-none focus:border-emerald-400" onChange={(event) => setVoiceURI(event.target.value)} value={voiceURI}>
                <option value="">浏览器默认语音</option>
                {voiceOptions.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <Range label="Rate" max={1.5} min={0.65} onChange={setRate} step={0.05} value={rate} />
              <Range label="Pitch" max={1.6} min={0.5} onChange={setPitch} step={0.05} value={pitch} />
              <Range label="Volume" max={1} min={0} onChange={setVolume} step={0.05} value={volume} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 font-medium text-zinc-950 hover:bg-white disabled:opacity-50" disabled={!text.trim()} onClick={speakText} type="button">
                <Play className="h-4 w-4" />
                朗读
              </button>
              <button className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900" onClick={stopAll} type="button">
                <Square className="h-4 w-4" />
                停止
              </button>
            </div>
          </section>

          <section className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <div className="flex items-center gap-2 text-zinc-300 text-sm"><FileAudio className="h-4 w-4" />音频文件测试</div>
            <input ref={audioInputRef} accept="audio/*" className="hidden" onChange={(event) => uploadAudio(event.target.files?.[0])} type="file" />
            <div className="grid grid-cols-2 gap-2">
              <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900" onClick={() => audioInputRef.current?.click()} type="button">
                <Upload className="h-4 w-4" />
                选择音频
              </button>
              <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm hover:bg-zinc-900 disabled:opacity-50" disabled={!audioUrl} onClick={() => void playAudioFile()} type="button">
                <Volume2 className="h-4 w-4" />
                播放驱动
              </button>
            </div>
            <div className="truncate text-zinc-500 text-xs">{audioName || "可选：上传 wav/mp3 观察真实音频口型"}</div>
            <audio className="w-full" controls onEnded={() => setSpeaking(false)} ref={audioRef} src={audioUrl || undefined} />
          </section>

          <section className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
            <div className="flex items-center justify-between gap-3 text-zinc-300 text-sm">
              <span className="inline-flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" />口型校准</span>
              <div className="flex items-center gap-2">
                <button className="inline-flex h-8 items-center gap-1 rounded-md border border-zinc-700 px-2 text-xs hover:bg-zinc-900 disabled:opacity-50" disabled={!imageUrl || detectingFace} onClick={() => void autoLocateMouth()} type="button"><ScanFace className="h-3.5 w-3.5" />{detectingFace ? "定位中" : "自动定位"}</button>
                <button className="inline-flex h-8 items-center gap-1 rounded-md border border-zinc-700 px-2 text-xs hover:bg-zinc-900" onClick={resetMouth} type="button"><RefreshCw className="h-3.5 w-3.5" />重置</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Range label="X" max={75} min={25} onChange={setMouthX} step={1} value={mouthX} />
              <Range label="Y" max={80} min={45} onChange={setMouthY} step={1} value={mouthY} />
              <Range label="Size" max={30} min={8} onChange={setMouthSize} step={1} value={mouthSize} />
              <Range label="Sense" max={2.4} min={0.4} onChange={setSensitivity} step={0.05} value={sensitivity} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Toggle checked={headMotion} label="头部微动" onChange={setHeadMotion} />
              <Toggle checked={showGuides} label="校准线" onChange={setShowGuides} />
            </div>
          </section>
        </section>

        <section className="grid min-h-[680px] gap-3 lg:grid-rows-[minmax(520px,1fr)_120px]">
          <div className="relative overflow-hidden rounded-md border border-zinc-800 bg-[#080b0f]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_35%_25%,rgba(49,151,149,0.22),transparent_36%),linear-gradient(135deg,#111827,#121b22_46%,#1b2730)]" />
            <div className="relative flex h-full min-h-[520px] items-center justify-center p-4 sm:p-8">
              <div className="relative aspect-[4/5] h-full max-h-[740px] w-full max-w-[580px] overflow-hidden rounded-md border border-zinc-700/70 bg-zinc-950 shadow-2xl">
                {imageUrl ? (
                  <div className="relative h-full w-full overflow-hidden bg-zinc-950">
                    <img alt="Photo background" className="absolute inset-0 h-full w-full scale-[1.06] object-cover opacity-75 blur-[7px] saturate-[0.85]" src={imageUrl} />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/12 via-transparent to-black/28" />
                    <img
                      alt="Detected subject"
                      className="absolute inset-0 h-full w-full object-cover will-change-transform"
                      src={imageUrl}
                      style={{ clipPath: subjectClipPath, transform: subjectTransform, transformOrigin: subjectOrigin }}
                    />
                    <img
                      alt=""
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 h-full w-full object-cover will-change-transform"
                      src={imageUrl}
                      style={{ clipPath: faceClipPath, transform: faceTransform, transformOrigin: faceOrigin }}
                    />
                    <img
                      alt=""
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 h-full w-full object-cover will-change-transform"
                      src={imageUrl}
                      style={{ clipPath: mouthPatchClipPath, transform: jawTransform, transformOrigin: faceOrigin }}
                    />
                    <div
                      className="pointer-events-none absolute rounded-full bg-zinc-950 shadow-[inset_0_1px_3px_rgba(255,255,255,0.16),0_1px_4px_rgba(0,0,0,0.45)]"
                      style={{ height: `${mouthHeight}%`, left: `${mouthX}%`, opacity: mouthShadowOpacity, top: `${mouthY + frame.mouth * 0.55}%`, transform: `translate(-50%, -50%) rotate(${frame.tilt * 0.1}deg)`, width: `${mouthWidth}%` }}
                    />
                    <div
                      className="pointer-events-none absolute rounded-full bg-rose-100/35 blur-[1px]"
                      style={{ height: `${Math.max(0.45, mouthHeight * 0.22)}%`, left: `${mouthX}%`, opacity: 0.24 + frame.mouth * 0.18, top: `${mouthY + mouthHeight * 0.45}%`, transform: "translate(-50%, -50%)", width: `${mouthWidth * 0.82}%` }}
                    />
                    <div className="pointer-events-none absolute rounded-full bg-zinc-950/74 transition-opacity" style={{ height: `${leftEye.h}%`, left: `${leftEye.x}%`, opacity: frame.blink * 0.8, top: `${leftEye.y}%`, transform: "translate(-50%, -50%)", width: `${leftEye.w}%` }} />
                    <div className="pointer-events-none absolute rounded-full bg-zinc-950/74 transition-opacity" style={{ height: `${rightEye.h}%`, left: `${rightEye.x}%`, opacity: frame.blink * 0.8, top: `${rightEye.y}%`, transform: "translate(-50%, -50%)", width: `${rightEye.w}%` }} />
                    {showGuides && faceGuide && <div className="pointer-events-none absolute border border-cyan-300/80" style={{ height: `${faceGuide.height}%`, left: `${faceGuide.x}%`, top: `${faceGuide.y}%`, width: `${faceGuide.width}%` }} />}
                    {showGuides && faceGuide && <div className="pointer-events-none absolute border border-amber-300/70" style={{ clipPath: subjectClipPath, inset: 0 }} />}
                    {showGuides && <div className="pointer-events-none absolute rounded-full border border-emerald-300" style={{ height: `${mouthSize}%`, left: `${mouthX}%`, top: `${mouthY}%`, transform: "translate(-50%, -50%)", width: `${mouthSize}%` }} />}
                  </div>
                ) : (
                  <button className="flex h-full w-full flex-col items-center justify-center gap-3 text-zinc-500 hover:text-zinc-300" onClick={() => imageInputRef.current?.click()} type="button">
                    <ImagePlus className="h-12 w-12" />
                    <span className="text-sm">上传一张正脸照片</span>
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 rounded-md border border-zinc-800 bg-zinc-950/70 p-3 text-sm">
            <Metric label="Mouth" value={`${Math.round(frame.mouth * 100)}%`} />
            <Metric label="Mode" value={audioRef.current && !audioRef.current.paused ? "Audio" : speaking ? "TTS" : "Idle"} />
            <Metric label="Layer" value={faceGuide ? "2.5D" : "Full"} />
          </div>
        </section>
      </div>
    </main>
  );
}

function Range({ label, max, min, onChange, step, value }: { label: string; max: number; min: number; onChange: (value: number) => void; step: number; value: number }) {
  return (
    <label className="grid gap-1 text-xs text-zinc-400">
      <span className="flex items-center justify-between gap-2"><span>{label}</span><span className="tabular-nums text-zinc-500">{formatNumber(value)}</span></span>
      <input className="w-full accent-emerald-400" max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={step} type="range" value={value} />
    </label>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex h-10 items-center justify-between gap-3 rounded-md border border-zinc-800 px-3 text-sm text-zinc-300">
      <span>{label}</span>
      <input checked={checked} className="h-4 w-4 accent-emerald-400" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2">
      <div className="text-zinc-500 text-xs uppercase">{label}</div>
      <div className="mt-1 truncate font-medium text-zinc-100">{value}</div>
    </div>
  );
}

function estimateSpeechPulse(chunk: string) {
  const vowelCount = (chunk.match(/[aeiouAEIOUāáǎàōóǒòēéěèīíǐìūúǔùüǖǘǚǜ]/g) || []).length;
  const asciiCount = (chunk.match(/[a-zA-Z]/g) || []).length;
  const chineseCount = (chunk.match(/[\u4e00-\u9fff]/g) || []).length;
  return clamp(0.55 + vowelCount * 0.16 + asciiCount * 0.04 + chineseCount * 0.08, 0.55, 1.25);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}


type FaceDetectorBox = {
  boundingBox: DOMRectReadOnly;
};

type BrowserFaceDetector = new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => {
  detect: (source: CanvasImageSource) => Promise<FaceDetectorBox[]>;
};

async function locateMouthFromImage(url: string): Promise<{ mouthX: number; mouthY: number; mouthSize: number; faceGuide: FaceGuide } | null> {
  const image = await loadImage(url);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) throw new Error("图片尺寸读取失败");

  const face = (await detectFaceWithBrowser(image).catch(() => null)) ?? estimateFaceBySkinCluster(image);
  if (!face) return null;

  const mouthPoint = sourcePointToCoverPercent(face.x + face.width * 0.5, face.y + face.height * 0.68, naturalWidth, naturalHeight);
  const faceTopLeft = sourcePointToCoverPercent(face.x, face.y, naturalWidth, naturalHeight);
  const faceBottomRight = sourcePointToCoverPercent(face.x + face.width, face.y + face.height, naturalWidth, naturalHeight);
  const faceWidth = clamp(faceBottomRight.x - faceTopLeft.x, 4, 80);
  const faceHeight = clamp(faceBottomRight.y - faceTopLeft.y, 5, 80);

  return {
    mouthX: clamp(mouthPoint.x, 5, 95),
    mouthY: clamp(mouthPoint.y, 5, 95),
    mouthSize: clamp(faceWidth * 0.28, 3.8, 13.5),
    faceGuide: {
      x: clamp(faceTopLeft.x, 0, 100),
      y: clamp(faceTopLeft.y, 0, 100),
      width: faceWidth,
      height: faceHeight,
      method: face.method,
    },
  };
}

async function detectFaceWithBrowser(image: HTMLImageElement): Promise<SourceFaceBox | null> {
  const FaceDetectorCtor = (window as Window & { FaceDetector?: BrowserFaceDetector }).FaceDetector;
  if (!FaceDetectorCtor) return null;
  const detector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 5 });
  const faces = await detector.detect(image);
  if (!faces.length) return null;
  const best = faces.map((face) => face.boundingBox).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return { x: best.x, y: best.y, width: best.width, height: best.height, method: "FaceDetector" };
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
  const scanMaxY = Math.round(height * 0.74);
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
    if (centerY > 0.68 || widthPct > 0.42 || heightPct > 0.5 || aspect < 0.32 || aspect > 1.25) continue;
    const fill = area / (boxWidth * boxHeight);
    const aspectScore = Math.max(0.15, 1 - Math.abs(aspect - 0.72) * 0.9);
    const upperScore = 1 + (1 - centerY) * 1.8;
    const fillScore = clamp(fill * 2.2, 0.35, 1.25);
    const sizeScore = Math.min(widthPct / 0.18, 1.2);
    const score = area * aspectScore * upperScore * fillScore * sizeScore;
    if (!best || score > best.score) best = { x: minX, y: minY, width: boxWidth, height: boxHeight, score };
  }
  if (!best) return null;
  return { x: best.x / scale, y: best.y / scale, width: best.width / scale, height: best.height / scale, method: "Canvas heuristic" };
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

function sourcePointToCoverPercent(x: number, y: number, naturalWidth: number, naturalHeight: number) {
  const containerWidth = 400;
  const containerHeight = 500;
  const scale = Math.max(containerWidth / naturalWidth, containerHeight / naturalHeight);
  const renderedWidth = naturalWidth * scale;
  const renderedHeight = naturalHeight * scale;
  const offsetX = (containerWidth - renderedWidth) / 2;
  const offsetY = (containerHeight - renderedHeight) / 2;
  return {
    x: ((x * scale + offsetX) / containerWidth) * 100,
    y: ((y * scale + offsetY) / containerHeight) * 100,
  };
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = url;
  });
}
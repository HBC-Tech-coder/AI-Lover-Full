/**
 * Lightweight i18n for the xiaoling UI.
 *
 * 三件事:
 *   1. `translations` —— 字典,每条 key 在 zh/en/ja 各给一份。漏译会
 *      fall back 到 zh (中文是产品母语)。
 *   2. `useT()` —— 组件里拿翻译函数: `const t = useT(); t("toolbar.start")`
 *   3. `setLanguage()` —— 切换语言,持久化到 settingsStore。
 *
 * 复用 settingsStore 作为唯一的状态/存储,避免两套 cache 写同一个
 * localStorage key 时互相覆盖。
 */

"use client";

import { getSettings, setSettings, useSettings } from "./settingsStore";

export type Language = "zh" | "en" | "ja";

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
];

type Dict = Record<string, string>;
type Translations = Record<Language, Dict>;

const translations: Translations = {
  zh: {
    "toolbar.start": "开始",
    "toolbar.starting": "启动中…",
    "toolbar.stop": "停止",
    "toolbar.cameraOn": "开启摄像头",
    "toolbar.cameraOff": "关闭摄像头",
    "toolbar.micOn": "点击开启麦克风",
    "toolbar.micOff": "点击静音",

    "status.connected": "已连接",
    "status.disconnected": "未连接",
    "status.listening": "在听…",
    "status.muted": "已静音",
    "status.waking": "正在唤醒…",
    "status.connecting": "连接中…",
    "status.clickMicToSpeak": "点麦克风开始说话",
    "status.connectionError": "连接错误",

    "chat.conversation": "对话",
    "chat.emptyHint": "开始说话或打字,聊天会显示在这里",
    "chat.placeholderConnectedPortrait": "说点什么…",
    "chat.placeholderConnectedLandscape": "输入消息,按回车发送…",
    "chat.placeholderDisconnectedPortrait": "可先打字,Start 后再发",
    "chat.placeholderDisconnectedLandscape": "可先打字,Start 后再发送",
    "chat.send": "发送",
    "chat.sendBeforeStart": "先点 Start 再发送",
    "chat.sendBeforeStartDesc": "需要等唤醒完成后才能收消息",
    "chat.sendFailed": "发送失败,请稍后重试",

    "avatar.loading": "加载形象中…",
    "camera.off": "摄像头已关",
    "camera.unavailable": "摄像头不可用",

    "tool.calling": "调用中…",
    "tool.returned": "已返回",
    "tool.failed": "失败",
    "tool.genericName": "工具",
    "consent.title": "欢迎使用完美恋人",
    "consent.subtitle": "开始前,请了解我们如何使用你的数据。",
    "consent.voiceTitle": "语音",
    "consent.voice": "你说话时,语音会实时发送到服务器做识别,这样她才能听懂你。",
    "consent.videoTitle": "摄像头",
    "consent.video": "摄像头仅用于在你这一侧显示自己的画面预览,不会上传服务器,也不会被处理。可随时在工具栏关闭。",
    "consent.dataTitle": "数据存储与使用",
    "consent.data": "对话内容会被记录用于改进服务;你主动透露的信息可能被记住,以便下次对话自然提起。界面设置(背景、音量、角色、语言)只保存在你的浏览器本地。",
    "consent.featuresTitle": "你可以",
    "consent.features": "在「设置」里随时切换不同角色(各有独立人设与形象)、切换 AI 模型、更换背景与界面语言。",
    "consent.accept": "我已阅读并同意,开始使用",
    "consent.footnote": "继续使用即表示你同意以上内容。",
    "consent.loadingNote": "首次加载需要 1-2 分钟(角色模型较大),请耐心等待。",
    "tool.name.fetch_url": "抓网页",
    "tool.name.bocha_search": "联网搜索",
    "tool.name.get_hotnews": "查热榜",
    "tool.name.get_poetry": "古诗词",
    "tool.name.get_jieqi_info": "节气",
    "tool.name.map_geocode": "地址定位",
    "tool.name.map_search_poi": "搜地点",
    "tool.name.map_route_driving": "路线规划",
    "tool.name.map_traffic": "实时路况",
    "tool.name.get_current_time": "查时间",
    "tool.name.get_lunar_date": "农历",
    "tool.name.get_weather": "查天气",
    "tool.name.recall": "翻记忆",
    "tool.name.remember": "记一下",

    "settings.title": "设置",
    "settings.language": "界面语言",
    "settings.model": "模型",
    "settings.modelLockedHint": "运行中,Stop 后才能切换",
    "settings.volume": "音量",
    "settings.head.title": "硅胶头机芯",
    "settings.head.hint":
      "连接本地桥接程序后,智能体可以驱动表情、使用头部喇叭,也可以从头部麦克风采集。",
    "settings.head.ip": "头部 IP",
    "settings.head.endpoint": "桥接地址",
    "settings.head.detect": "检测",
    "settings.head.detectOk": "硅胶头连接正常",
    "settings.head.reset": "复位",
    "settings.head.resetOk": "复位命令已发送",
    "settings.head.testSpeaker": "喇叭",
    "settings.head.speakerOk": "喇叭测试已播放",
    "settings.head.testMic": "测试头部麦克风",
    "settings.head.micOk": "头部麦克风采样成功",
    "settings.head.micLevel": "音量",
    "settings.head.motion": "语音回复时联动表情动作",
    "settings.head.speaker": "AI 回复同时从头部喇叭播放",
    "settings.head.volume": "头部音量",
    "settings.head.computerMic": "使用电脑麦克风收音",
    "settings.head.mic": "使用头部麦克风收音",
    "settings.background": "背景",
    "settings.backgroundCustom": "自定义",
    "settings.backgroundUploadHint":
      "自定义图片不会上传服务器,只存在你浏览器里。最大 20MB,过大的图会自动压缩。",
    "settings.character": "角色",
    "settings.characterLockedHint": "运行中,Stop 后才能切换角色。",
    "settings.characterHint": "切换角色会同时换形象和人设;下次 Start 生效。",
    "settings.characterThumbnailHint":
      "切换并对话过的角色,缩略图会自动生成。",
    "settings.footer": "所有设置只存在你浏览器本地。",

    "settings.bg.default": "默认",
    "settings.bg.dawn": "黎明",
    "settings.bg.forest": "森林",
    "settings.bg.ocean": "海洋",
    "settings.bg.dusk": "黄昏",
    "settings.bg.night": "夜空",
    "settings.bg.warm": "暖光",
    "tour.welcome.title": "先认识一下界面",
    "tour.welcome.body": "花 20 秒带你逛一圈，知道点哪儿就能开始聊天 👇",
    "tour.start.title": "① 点这里开始",
    "tour.start.body": "点「开始」，她就会上线，几秒后就能开口和你说话。",
    "tour.mic.title": "② 说话和静音",
    "tour.mic.body": "开始后直接对着麦克风说话就行；想安静一下，点这里静音。",
    "tour.settings.title": "③ 这里是设置",
    "tour.settings.body": "选人物、换模型、换背景都在这儿。这就带你看看。",
    "tour.character.title": "选人物",
    "tour.character.body": "每个角色形象和性格都不一样，挑一个你喜欢的。",
    "tour.model.title": "换模型",
    "tour.model.body": "不同的 AI「大脑」，说话风格略有差别，随时可以切换。",
    "tour.background.title": "换背景",
    "tour.background.body": "选个喜欢的背景，或上传自己的图片当背景。",
    "tour.done.title": "就这些，开始吧！🎉",
    "tour.done.body": "随时点右上角的设置可以再调整。现在点「开始」试试吧。",
    "tour.next": "下一步",
    "tour.back": "上一步",
    "tour.skip": "跳过",
    "tour.done": "知道了",

    "settings.upload.notImage": "只支持图片文件",
    "settings.upload.tooLarge": "图片太大,请选 20MB 以内的",
    "settings.upload.quotaExceeded": "浏览器存储空间不足",
    "settings.upload.quotaExceededDesc": "试试更小的图,或清下浏览器缓存",
    "settings.upload.success": "背景已更新",
    "settings.upload.failed": "图片处理失败",

    "settings.desktop.title": "桌面版",
    "settings.desktop.intro": "下载完美恋人桌面版,体验额外能力:",
    "settings.desktop.feature1": "语音读取本机文件、运行终端命令",
    "settings.desktop.feature2": "独立窗口,不用开浏览器",
    "settings.desktop.downloadMac": "下载 macOS 版 (Apple Silicon)",
    "settings.desktop.macHint":
      '首次启动如提示"无法核实开发者",右键 .app → 打开 → 确认即可。Intel Mac / Windows 版本制作中。',
    "settings.desktop.windowsPending":
      "Windows 版本制作中,先用 Edge / Chrome 在网页上体验完整功能。",
    "settings.desktop.otherPending":
      "桌面版目前支持 macOS Apple Silicon。其他平台用浏览器即可。",
  },

  en: {
    "toolbar.start": "Start",
    "toolbar.starting": "Starting…",
    "toolbar.stop": "Stop",
    "toolbar.cameraOn": "Turn camera on",
    "toolbar.cameraOff": "Turn camera off",
    "toolbar.micOn": "Click to unmute",
    "toolbar.micOff": "Click to mute",

    "status.connected": "Connected",
    "status.disconnected": "Disconnected",
    "status.listening": "Listening…",
    "status.muted": "Muted",
    "status.waking": "Xiaoling is waking up…",
    "status.connecting": "Connecting…",
    "status.clickMicToSpeak": "Click the mic to speak",
    "status.connectionError": "Connection Error",

    "chat.conversation": "Conversation",
    "chat.emptyHint": "Start speaking or typing — the chat shows up here",
    "chat.placeholderConnectedPortrait": "Say something…",
    "chat.placeholderConnectedLandscape": "Type a message, press Enter to send…",
    "chat.placeholderDisconnectedPortrait": "Type now, send after Start",
    "chat.placeholderDisconnectedLandscape": "Type now, send after Start",
    "chat.send": "Send",
    "chat.sendBeforeStart": "Click Start first",
    "chat.sendBeforeStartDesc":
      "Xiaoling needs to wake up before it can receive messages",
    "chat.sendFailed": "Send failed, please retry",

    "avatar.loading": "Loading avatar…",
    "camera.off": "Camera off",
    "camera.unavailable": "Camera unavailable",

    "tool.calling": "Calling…",
    "tool.returned": "Returned",
    "tool.failed": "Failed",
    "tool.genericName": "Tool",
    "consent.title": "Welcome to Perfect Lover",
    "consent.subtitle": "Before you start, here's how we use your data.",
    "consent.voiceTitle": "Voice",
    "consent.voice": "When you speak, your audio is sent to the server in real time for speech recognition so she can understand you.",
    "consent.videoTitle": "Camera",
    "consent.video": "The camera is only used to show your own preview on your side. It is never uploaded or processed. You can turn it off anytime from the toolbar.",
    "consent.dataTitle": "Data storage & usage",
    "consent.data": "Conversations are logged to improve the service; things you share may be remembered so they can come up naturally next time. UI settings (background, volume, character, language) are stored only in your browser.",
    "consent.featuresTitle": "You can",
    "consent.features": "Switch between different characters (each with its own persona and look), change the AI model, and change the background and UI language anytime in Settings.",
    "consent.accept": "I've read and agree - Start",
    "consent.footnote": "Continuing means you agree to the above.",
    "consent.loadingNote": "First load may take 1-2 minutes (the character model is large). Please be patient.",
    "tool.name.fetch_url": "Fetch page",
    "tool.name.bocha_search": "Web search",
    "tool.name.get_hotnews": "Trending",
    "tool.name.get_poetry": "Poetry",
    "tool.name.get_jieqi_info": "Solar term",
    "tool.name.map_geocode": "Geocode",
    "tool.name.map_search_poi": "Find place",
    "tool.name.map_route_driving": "Route",
    "tool.name.map_traffic": "Traffic",
    "tool.name.get_current_time": "Time",
    "tool.name.get_lunar_date": "Lunar date",
    "tool.name.get_weather": "Weather",
    "tool.name.recall": "Recall",
    "tool.name.remember": "Remember",

    "settings.title": "Settings",
    "settings.language": "UI Language",
    "settings.model": "Model",
    "settings.modelLockedHint": "Running — Stop first to switch",
    "settings.volume": "Volume",
    "settings.head.title": "Robot head",
    "settings.head.hint":
      "Connect the local bridge to drive expressions, play replies on the head speaker, and capture the head microphone.",
    "settings.head.ip": "Head IP",
    "settings.head.endpoint": "Bridge endpoint",
    "settings.head.detect": "Detect",
    "settings.head.detectOk": "Robot head connected",
    "settings.head.reset": "Reset",
    "settings.head.resetOk": "Reset command sent",
    "settings.head.testSpeaker": "Speaker",
    "settings.head.speakerOk": "Speaker test played",
    "settings.head.testMic": "Test head mic",
    "settings.head.micOk": "Head mic capture OK",
    "settings.head.micLevel": "Level",
    "settings.head.motion": "Move expressions during voice replies",
    "settings.head.speaker": "Play AI replies through the head speaker",
    "settings.head.volume": "Head volume",
    "settings.head.computerMic": "Use the computer microphone",
    "settings.head.mic": "Use the head microphone",
    "settings.background": "Background",
    "settings.backgroundCustom": "Custom",
    "settings.backgroundUploadHint":
      "Custom images aren't uploaded to a server — stored in your browser only. Max 20 MB; large images are auto-compressed.",
    "settings.character": "Character",
    "settings.characterLockedHint": "Running — Stop first to switch characters.",
    "settings.characterHint":
      "Switching characters swaps both avatar and persona. Takes effect on next Start.",
    "settings.characterThumbnailHint":
      "Thumbnails are captured automatically the first time you switch to a character.",
    "settings.footer": "All settings stay in your browser locally.",

    "settings.bg.default": "Default",
    "settings.bg.dawn": "Dawn",
    "settings.bg.forest": "Forest",
    "settings.bg.ocean": "Ocean",
    "settings.bg.dusk": "Dusk",
    "settings.bg.night": "Night",
    "settings.bg.warm": "Warm",
    "tour.welcome.title": "Quick tour",
    "tour.welcome.body": "20 seconds to show you around so you know where to begin 👇",
    "tour.start.title": "① Start here",
    "tour.start.body": "Tap Start and she comes online — you can talk to her within seconds.",
    "tour.mic.title": "② Talk & mute",
    "tour.mic.body": "Just speak into your mic once started. Tap here to mute when you need quiet.",
    "tour.settings.title": "③ This is Settings",
    "tour.settings.body": "Pick a character, switch the model, change the background — all in here. Let us peek inside.",
    "tour.character.title": "Pick a character",
    "tour.character.body": "Each one has its own look and personality. Choose whoever you like.",
    "tour.model.title": "Switch the model",
    "tour.model.body": "Different AI brains with slightly different styles. Switch anytime.",
    "tour.background.title": "Change the background",
    "tour.background.body": "Pick a preset, or upload your own image as the background.",
    "tour.done.title": "That is it — enjoy! 🎉",
    "tour.done.body": "Open Settings (top right) anytime to tweak things. Now tap Start to try it.",
    "tour.next": "Next",
    "tour.back": "Back",
    "tour.skip": "Skip",
    "tour.done": "Got it",

    "settings.upload.notImage": "Image files only",
    "settings.upload.tooLarge": "Image too large — please pick one under 20 MB",
    "settings.upload.quotaExceeded": "Browser storage is full",
    "settings.upload.quotaExceededDesc":
      "Try a smaller image, or clear your browser cache",
    "settings.upload.success": "Background updated",
    "settings.upload.failed": "Image processing failed",

    "settings.desktop.title": "Desktop app",
    "settings.desktop.intro": "Download the Xiaoling desktop app for extras:",
    "settings.desktop.feature1": "Read local files & run terminal commands by voice",
    "settings.desktop.feature2": "Standalone window — no browser needed",
    "settings.desktop.downloadMac": "Download macOS (Apple Silicon)",
    "settings.desktop.macHint":
      'If macOS warns "unidentified developer" on first launch, right-click the .app → Open → Confirm. Intel Mac / Windows builds in progress.',
    "settings.desktop.windowsPending":
      "Windows build in progress — use Edge / Chrome in the meantime.",
    "settings.desktop.otherPending":
      "Desktop currently supports macOS Apple Silicon. Use the browser on other platforms.",
  },

  ja: {
    "toolbar.start": "開始",
    "toolbar.starting": "起動中…",
    "toolbar.stop": "停止",
    "toolbar.cameraOn": "カメラをオン",
    "toolbar.cameraOff": "カメラをオフ",
    "toolbar.micOn": "クリックでマイクをオン",
    "toolbar.micOff": "クリックでミュート",

    "status.connected": "接続済み",
    "status.disconnected": "未接続",
    "status.listening": "聞いています…",
    "status.muted": "ミュート中",
    "status.waking": "起動中…",
    "status.connecting": "接続中…",
    "status.clickMicToSpeak": "マイクをクリックして話す",
    "status.connectionError": "接続エラー",

    "chat.conversation": "会話",
    "chat.emptyHint": "話すか入力すると、会話がここに表示されます",
    "chat.placeholderConnectedPortrait": "話してみてください…",
    "chat.placeholderConnectedLandscape": "メッセージを入力、Enter で送信…",
    "chat.placeholderDisconnectedPortrait": "Start 後に送信できます",
    "chat.placeholderDisconnectedLandscape": "Start 後に送信できます",
    "chat.send": "送信",
    "chat.sendBeforeStart": "先に Start を押してください",
    "chat.sendBeforeStartDesc": "起動が完了するとメッセージを受け取れます",
    "chat.sendFailed": "送信に失敗、再試行してください",

    "avatar.loading": "アバター読込中…",
    "camera.off": "カメラ オフ",
    "camera.unavailable": "カメラが使えません",

    "tool.calling": "呼び出し中…",
    "tool.returned": "完了",
    "tool.failed": "失敗",
    "tool.genericName": "ツール",
    "consent.title": "完美恋人へようこそ",
    "consent.subtitle": "始める前に、データの扱いについてご確認ください。",
    "consent.voiceTitle": "音声",
    "consent.voice": "話すと、音声はリアルタイムでサーバーに送られ、音声認識に使われます(あなたの言葉を理解するため)。",
    "consent.videoTitle": "カメラ",
    "consent.video": "カメラはあなた側で自分のプレビューを表示するためだけに使われ、アップロードも処理もされません。ツールバーからいつでもオフにできます。",
    "consent.dataTitle": "データの保存と利用",
    "consent.data": "会話はサービス改善のため記録されます。あなたが話した内容は記憶され、次回自然に話題に出ることがあります。UI設定(背景・音量・キャラ・言語)はブラウザ内にのみ保存されます。",
    "consent.featuresTitle": "できること",
    "consent.features": "設定からいつでも、別のキャラクター(それぞれ個別の人格と見た目)への切り替え、AIモデルの変更、背景やUI言語の変更ができます。",
    "consent.accept": "同意して始める",
    "consent.footnote": "続行すると上記に同意したことになります。",
    "consent.loadingNote": "初回読み込みには1〜2分かかります(キャラクターモデルが大きいため)。少々お待ちください。",
    "tool.name.fetch_url": "ページ取得",
    "tool.name.bocha_search": "ウェブ検索",
    "tool.name.get_hotnews": "トレンド",
    "tool.name.get_poetry": "漢詩",
    "tool.name.get_jieqi_info": "二十四節気",
    "tool.name.map_geocode": "住所検索",
    "tool.name.map_search_poi": "場所検索",
    "tool.name.map_route_driving": "ルート",
    "tool.name.map_traffic": "交通状況",
    "tool.name.get_current_time": "時刻",
    "tool.name.get_lunar_date": "旧暦",
    "tool.name.get_weather": "天気",
    "tool.name.recall": "記憶",
    "tool.name.remember": "記録",

    "settings.title": "設定",
    "settings.language": "表示言語",
    "settings.model": "モデル",
    "settings.modelLockedHint": "実行中 — Stop してから切り替え",
    "settings.volume": "音量",
    "settings.head.title": "ロボットヘッド",
    "settings.head.hint":
      "ローカルブリッジに接続すると、表情動作・ヘッドスピーカー再生・ヘッドマイク収音を使えます。",
    "settings.head.ip": "ヘッド IP",
    "settings.head.endpoint": "ブリッジ",
    "settings.head.detect": "検出",
    "settings.head.detectOk": "ヘッド接続 OK",
    "settings.head.reset": "リセット",
    "settings.head.resetOk": "リセット送信済み",
    "settings.head.testSpeaker": "スピーカー",
    "settings.head.speakerOk": "スピーカーテスト再生済み",
    "settings.head.testMic": "ヘッドマイクテスト",
    "settings.head.micOk": "ヘッドマイク取得 OK",
    "settings.head.micLevel": "音量",
    "settings.head.motion": "音声返信に表情動作を連動",
    "settings.head.speaker": "AI 返信をヘッドスピーカーでも再生",
    "settings.head.volume": "ヘッド音量",
    "settings.head.computerMic": "PC マイクを使う",
    "settings.head.mic": "ヘッドマイクを使う",
    "settings.background": "背景",
    "settings.backgroundCustom": "カスタム",
    "settings.backgroundUploadHint":
      "カスタム画像はサーバーに送信されず、ブラウザ内のみに保存されます。最大 20MB、大きい画像は自動圧縮します。",
    "settings.character": "キャラクター",
    "settings.characterLockedHint":
      "実行中 — Stop してからキャラクター切り替え。",
    "settings.characterHint":
      "切り替えると外見と人格の両方が変わります。次回 Start で反映。",
    "settings.characterThumbnailHint":
      "キャラクターに切り替えると、サムネイルが自動で生成されます。",
    "settings.footer": "すべての設定はブラウザにローカル保存されます。",

    "settings.bg.default": "デフォルト",
    "settings.bg.dawn": "夜明け",
    "settings.bg.forest": "森林",
    "settings.bg.ocean": "海",
    "settings.bg.dusk": "夕暮れ",
    "settings.bg.night": "夜空",
    "settings.bg.warm": "暖色",
    "tour.welcome.title": "かんたんツアー",
    "tour.welcome.body": "20秒で画面をご案内します。どこを押せば始められるか見てみましょう 👇",
    "tour.start.title": "① ここから開始",
    "tour.start.body": "「開始」を押すと彼女が起動し、数秒で話しかけられます。",
    "tour.mic.title": "② 話す・ミュート",
    "tour.mic.body": "開始後はマイクに話すだけ。静かにしたい時はここでミュート。",
    "tour.settings.title": "③ ここが設定",
    "tour.settings.body": "キャラ選び・モデル変更・背景変更はすべてここ。中を見てみましょう。",
    "tour.character.title": "キャラクターを選ぶ",
    "tour.character.body": "それぞれ見た目も性格も違います。好きな子を選んでください。",
    "tour.model.title": "モデルを変える",
    "tour.model.body": "AIの「頭脳」が違うと話し方も少し変わります。いつでも切り替え可能。",
    "tour.background.title": "背景を変える",
    "tour.background.body": "プリセットを選ぶか、自分の画像をアップロードできます。",
    "tour.done.title": "以上です。お楽しみを！🎉",
    "tour.done.body": "右上の設定からいつでも調整できます。では「開始」を押してみましょう。",
    "tour.next": "次へ",
    "tour.back": "戻る",
    "tour.skip": "スキップ",
    "tour.done": "OK",

    "settings.upload.notImage": "画像ファイルのみ対応",
    "settings.upload.tooLarge": "画像が大きすぎます — 20MB 以下を選んでください",
    "settings.upload.quotaExceeded": "ブラウザのストレージが不足しています",
    "settings.upload.quotaExceededDesc":
      "より小さい画像を試すか、ブラウザのキャッシュを削除してください",
    "settings.upload.success": "背景を更新しました",
    "settings.upload.failed": "画像の処理に失敗しました",

    "settings.desktop.title": "デスクトップ版",
    "settings.desktop.intro": "デスクトップ版で追加機能を体験:",
    "settings.desktop.feature1":
      "ローカルファイル読み取り・ターミナル操作を音声で",
    "settings.desktop.feature2": "独立ウィンドウ — ブラウザ不要",
    "settings.desktop.downloadMac": "macOS 版をダウンロード (Apple Silicon)",
    "settings.desktop.macHint":
      '初回起動で「開発元を確認できません」と出たら、.app を右クリック → 開く → 確認。Intel Mac / Windows 版は準備中。',
    "settings.desktop.windowsPending":
      "Windows 版は準備中 — 当面は Edge / Chrome をご利用ください。",
    "settings.desktop.otherPending":
      "デスクトップ版は現在 macOS Apple Silicon のみ対応。他のプラットフォームはブラウザでどうぞ。",
  },
};

/** Sync read of current language. For non-React code paths (event
 *  handlers, utility functions). */
export function getLanguage(): Language {
  return getSettings().language;
}

/** Persist the language choice + update <html lang> for a11y. All
 *  components subscribed via useT() / useSettings() re-render automatically. */
export function setLanguage(lang: Language): void {
  setSettings({ language: lang });
  if (typeof document !== "undefined") {
    document.documentElement.lang =
      lang === "zh" ? "zh-CN" : lang === "ja" ? "ja-JP" : "en";
  }
}

/** Non-React translation lookup. Falls back to Chinese, then to the key. */
export function translate(
  key: string,
  lang: Language = getLanguage(),
): string {
  return translations[lang]?.[key] ?? translations.zh[key] ?? key;
}

/** React hook returning a `t` function tied to the current language.
 *  Re-renders the calling component whenever language changes. */
export function useT(): (key: string) => string {
  const [settings] = useSettings();
  return (key: string) => translate(key, settings.language);
}

/** Returns the current language code; re-renders on change. Use when
 *  you need to branch on language rather than just translate. */
export function useLanguage(): Language {
  const [settings] = useSettings();
  return settings.language;
}

# GPU 数字人路线

目标是在现有 TEN 语音对话链路之外，新增一个 GPU 视频数字人渲染层。对话、ASR、LLM、TTS 仍然沿用当前项目；GPU worker 只负责把回复音频变成带口型的视频。

## 选型结论

第一版推荐接入 [TMElyralab/MuseTalk](https://github.com/TMElyralab/MuseTalk) 作为核心口型渲染器。

原因：

- MuseTalk 明确定位为实时高质量 lip-sync，官方 README 写明 V100 上 30fps+，并提供 realtime inference。
- 支持中文、英文、日文等音频输入，适合我们当前中文语音对话。
- MuseTalk 1.5 已开放推理、训练代码和权重，Windows 也有 realtime inference 命令。
- 8GB 显存可先用 fp16 / 256 face-region 路线做单路测试；产品化实时体验再考虑 16GB+ 或云端 GPU。

可借鉴但不作为第一版直接整体搬入：

| 项目 | 适合点 | 不直接整体接入的原因 |
| --- | --- | --- |
| [PunithVT/ai-avatar-system](https://github.com/PunithVT/ai-avatar-system) | Next.js + FastAPI + MuseTalk V1.5，完整产品架构，WebSocket chunk 思路很适合参考 | 它是完整对话系统，我们已经有 TEN + 前端，整套迁移会重复 |
| [shibing624/AIAvatar](https://github.com/shibing624/AIAvatar) | Apache-2.0，Wav2Lip256，WebRTC 输出，GPU/CPU 前后端分离，中文文档友好 | Wav2Lip 轻量、实时性强，但面部自然度通常不如 MuseTalk 1.5 |
| [Kedreamix/Linly-Talker](https://github.com/Kedreamix/Linly-Talker) / Stream | 模块多，中文生态强，已集成 MuseTalk / Wav2Lip / ER-NeRF | 系统很大，适合作参考和拆接口，不适合直接嵌入当前产品 |
| [OpenTalker/SadTalker](https://github.com/OpenTalker/SadTalker) | 单图说话效果成熟，适合离线生成 | 实时对话延迟偏高 |
| [KlingAIResearch/LivePortrait](https://github.com/KlingAIResearch/LivePortrait) | 形象生动、驱动效果好 | 更偏图片/视频驱动动画，音频口型实时链路需要再组合 |
| [fudan-generative-vision/hallo2](https://github.com/fudan-generative-vision/hallo2) | 高分辨率长时长音频驱动人像 | 更重，8GB 显存压力较大 |

## 本项目新增的 GPU worker 协议

前端现在支持两种显示模式：

- `Live2D / CPU`：现有 Cubism/Live2D 浏览器渲染。
- `GPU 数字人`：连接本机或私有局域网 worker。

设置入口：

```text
首页 → 设置 → 显示模式
```

默认 worker：

```text
http://127.0.0.1:8810
```

worker 需要实现两个接口：

### `GET /health`

返回示例：

```json
{
  "ok": true,
  "provider": "musetalk-v1.5",
  "mode": "gpu",
  "gpu": {
    "name": "NVIDIA GeForce RTX 3080 Laptop GPU",
    "memory": "8GB"
  },
  "avatars": [
    {
      "id": "default",
      "name": "Default",
      "posterUrl": "/avatars/default/poster.png"
    }
  ]
}
```

### `POST /render`

请求：

```json
{
  "avatarId": "default",
  "audio": "<base64 pcm/wav/mp3>",
  "metadata": {
    "sample_rate": 24000,
    "channels": 1,
    "bytes_per_sample": 2
  },
  "output": "mp4"
}
```

返回：

```json
{
  "ok": true,
  "provider": "musetalk-v1.5",
  "avatarId": "default",
  "videoUrl": "/outputs/turn_001.mp4",
  "posterUrl": "/avatars/default/poster.png",
  "durationMs": 2100
}
```

前端会把 TEN TTS 返回的音频同时发给这个 worker。现阶段视频默认静音播放，声音仍由当前 TTS 播放链路负责，避免双重播放。

## 下一步实现 MuseTalk worker

1. 克隆 MuseTalk：

```powershell
cd C:\Users\sunat\xiaoling_local_dev
git clone https://github.com/TMElyralab/MuseTalk.git
```

2. 按 MuseTalk README 安装 Python 3.10、CUDA 版 PyTorch、MMLab、FFmpeg、模型权重。

3. 先跑官方 realtime inference，确认本机 GPU 能生成视频。

4. 写一个 FastAPI wrapper：

- 启动时加载/准备 avatar。
- `/health` 返回 GPU 和 avatar 状态。
- `/render` 接收回复音频，调用 MuseTalk realtime pipeline，输出 mp4。
- 输出目录以静态文件方式暴露给前端。

5. 以后如果要低延迟，再从 `POST /render -> mp4` 升级到 WebRTC 或视频 chunk streaming。可以参考 AIAvatar 和 Linly-Talker-Stream 的做法。

## Local image worker for UI testing

Before MuseTalk is installed, the project includes a tiny local worker that
keeps the same `/health` and `/render` contract. It is only for validating the
frontend GPU-avatar mode and displaying a selected still image.

Start it:

```powershell
cd C:\Users\sunat\xiaoling_local_dev\AI-Lover
.\start_gpu_avatar_image_worker.ps1 -ImagePath C:\path\to\avatar.jpg -AvatarName "AI机械姬"
```

Then open:

```text
http://127.0.0.1:8810/
http://127.0.0.1:8810/health
```

The worker returns `videoUrl: ""` from `/render`; the browser keeps showing the
poster image. Replace this worker with the MuseTalk/FastAPI worker when real
lip-sync rendering is ready.

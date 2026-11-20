# 硅胶头机械芯本地调试

本目录提供一个本地 HTTP 桥接服务，让 Web 前端通过电脑控制 RK3566 头部机械芯。

## 控制链路

```text
Web 前端 -> http://127.0.0.1:8787 -> head_motion_bridge.py -> ADB -> RK3566 -> /dev/ttyS4
```

页面里填写的控制端点应保持：

```text
http://127.0.0.1:8787
```

头部真实 IP 不填在页面控制端点里，而是在启动 bridge 时传入，例如：

```powershell
.\start_local_robot_agent.ps1 -HeadIp 192.168.110.139
```

## 启动

```powershell
cd C:\Users\sunat\xiaoling_local_dev\AI-Lover
.\start_local_robot_agent.ps1 -HeadIp 192.168.110.139
```

健康检查：

```powershell
Invoke-WebRequest http://127.0.0.1:8787/health -UseBasicParsing
adb devices
```

正常时可以看到：

```text
192.168.110.139:5555 device
```

`/health` 返回的 `adb_serial` 也应该是当前头部 IP：

```json
{
  "ok": true,
  "transport": "adb",
  "dry_run": false,
  "adb_serial": "192.168.110.139:5555"
}
```

## 控制台

打开：

```text
http://127.0.0.1:3000/head-control
```

可以测试：

- 复位
- 说话/停嘴
- 微笑、伤心、亲吻、鬼脸
- 眨眼、左眨、右眨、转眼、转头
- 每个舵机的角度
- 头部音箱
- 头部麦克风
- 头部音量

## HTTP API

动作：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/action `
  -ContentType application/json `
  -Body '{"action":"smile"}'
```

舵机：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/action `
  -ContentType application/json `
  -Body '{"action":"servo","servo":5,"angle":90}'
```

播放头部喇叭：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/audio/play `
  -ContentType application/json `
  -Body '{"audio_base64":"...","format":"wav","drive_mouth":true}'
```

采集头部麦克风：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/audio/capture `
  -ContentType application/json `
  -Body '{"duration_sec":2}'
```

停止播放：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/audio/stop
```

## 头部喇叭和麦克风

不同头部的声卡号可能不同。当前默认配置：

```text
HEAD_AUDIO_CARD=auto
HEAD_AUDIO_CARD_MATCH=realtek,rt5651,codec
HEAD_AUDIO_CARD_FALLBACK=1
HEAD_AUDIO_PLAYBACK_SETUP=tinymix -D {card} 'OUT Playback Volume' {volume} {volume}
HEAD_AUDIO_PLAYBACK_SAMPLE_RATE=16000
```

如果头部能动但没有声音，优先检查：

1. `/head-control` 的“测试音箱”是否有声音。
2. 首页“头部音量”是否为 0。
3. ADB 是否能连上头部。
4. 头部声卡是否为 realtek/rt5651。

在头部 shell 里检查声卡：

```powershell
adb shell tinymix -D 0
adb shell tinymix -D 1
```

如果 realtek/rt5651 在 `-D 1`，但程序播放到了 HDMI 声卡，就需要把声卡配置改成 `1` 或保持 `auto` 并确认匹配规则。

## 常见问题

### 头部 IP 改了

重新启动 bridge：

```powershell
.\start_local_robot_agent.ps1 -HeadIp 新IP
```

或在网页设置里修改头部 IP，再点击启动/重连。

### 页面控制端点要不要改成头部 IP？

不要。控制端点永远是本机桥接地址：

```text
http://127.0.0.1:8787
```

头部 IP 是 bridge 内部通过 ADB 使用的地址。

### 网络调试不稳定，能否用 USB？

可以。打开头部 USB 调试后，ADB 能看到 USB 设备即可。bridge 支持 USB fallback，网络 ADB 连接失败时会尝试使用 USB 设备。

### 服务器上的网页能否直接控制内网头部？

公网服务器不能直接访问客户内网的 `192.168.x.x` 头部。推荐方案是：网页在服务器，客户电脑运行本地 bridge；网页通过客户电脑本地服务或 relay command bus 控制头部。

## 日志

客户包日志默认在：

```text
%LOCALAPPDATA%\AI-Lover\local_logs
```

调试时重点看：

- `head_motion_bridge.*.out.log`
- `head_motion_bridge.*.err.log`

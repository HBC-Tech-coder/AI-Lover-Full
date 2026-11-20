# AI-Lover

AI-Lover 是基于 [TEN-framework](https://github.com/TEN-framework/ten-framework) 改造的实时语音对话智能体项目。当前版本支持 Web 端实时语音对话、Live2D 数字人展示、本地硅胶头机械芯控制、Arduino/ORCA 机械手控制、手势识别和客户一键启动包。

仓库地址：

```text
https://github.com/HBC-Tech-coder/AI-Lover
```

## 功能概览

- Web 端语音对话和文字对话。
- 多角色管理：头像、性别、性格、人设、私有/公开属性、Live2D 模型上传。
- 硅胶头机械芯控制：表情、眨眼、转头、嘴部动作、头部喇叭播放、头部麦克风测试。
- 机械手控制：Arduino 手、ORCA 17 舵机手、手腕跟随选项、手势模仿。
- 手势识别：摄像头骨架叠加、动作切片录制、导入和回放。
- 粒子特效：单手比心爱心、双手比心铜钱下落、张开手掌闪光、握拳脉冲光环。
- 画面交换：桌面端双击数字人/摄像头切到大画面，手机竖屏点击主画面或小窗交换大小。
- 外部摄像头眼球追踪：用电脑摄像头检测人脸，驱动硅胶头眼球方向，必要时可开启脖子跟随。
- 本地 Live2D/Cubism 工具链：图片预处理、PSD/图层包、Cubism Editor 打开桥接。
- GPU 数字人接入：默认本机 8810 预览 worker，可通过 Local Connector 调用局域网 4090 上的 MuseTalk/SoulX/LiveAct 服务。
- HeyGen、Trulience、单张照片说话测试页，用于评估不同数字人方案。

## 关键路径

主仓库：

```text
C:\Users\sunat\xiaoling_local_dev\AI-Lover
```

客户包输出：

```text
C:\Users\sunat\xiaoling_local_dev\AI-Lover\dist-customer
```

## 常用端口

| 端口 | 用途 |
| --- | --- |
| `3000` | Web 前端 |
| `3443` | 局域网 HTTPS 访问，用于手机/Mac 摄像头和麦克风权限 |
| `8787` | 硅胶头机械芯本地 HTTP 桥接 |
| `8790` | Live2D 本地 worker |
| `8791` | 手势识别/机械手本地 HTTP 桥接 |
| `8810` | GPU 数字人本地 worker adapter |
| `8080` | TEN agent API 服务；本地或云端通过 `AGENT_SERVER_URL` 指向 |
| `8000-9000` | 语音 WebSocket 动态端口 |

## 本地启动

### 1. 启动 Web 前端和本地硬件服务

```powershell
cd C:\Users\sunat\xiaoling_local_dev\AI-Lover
.\start_local_robot_agent.ps1 -HeadIp 192.168.110.63
```

打开：

```text
http://127.0.0.1:3000/
```

### 2. 头部测试页

```text
http://127.0.0.1:3000/head-control
```

页面里“控制端点”保持：

```text
http://127.0.0.1:8787
```

真正变化的是启动参数里的头部 IP，例如：

```powershell
.\start_local_robot_agent.ps1 -HeadIp 192.168.110.139
```

### 3. 机械手测试页

```text
http://127.0.0.1:3000/hand-control
```

在这个页面可以检测串口、区分 Arduino/ORCA、测试 Arduino 六位手势、测试 ORCA 17 个关节、录制和回放手部动作切片。

### 4. Local Connector 本地离线控制台

```text
http://127.0.0.1:3000/local-control
```

客户电脑运行 Local Connector 后，即使没有互联网也可以打开这个页面。它不包含 AI 对话，但可以低延迟测试仿生头、头部喇叭/麦克风、Arduino 手、ORCA 手、浏览器摄像头手势骨架和粒子特效。多个 Arduino 手臂用英文逗号填写，例如 `COM5,COM6`，同一手势会同步广播到所有端口。

### 5. GPU 数字人

设置页里切换“显示模式”为“GPU 数字人”。默认 `http://127.0.0.1:8810` 会由本地程序自动启动预览 worker；如果局域网有 4090 模型服务，可填写它的地址，例如：

```text
http://192.168.110.50:7860
```

云端网页访问客户内网 GPU 服务时，必须先启用并运行 Local Connector。详细接口契约见：

```text
docs/gpu-digital-human-worker.md
```

## 客户包

生成完整客户包：

```powershell
.\build_customer_package.ps1
```

生成热更新包：

```powershell
.\scripts\build_hot_update_package.ps1
```

输出位置：

```text
dist-customer\AI-Lover-<version>-customer-win64.zip
dist-customer\AI-Lover-<version>-hot-update.zip
```

完整客户包包含 Node.js、Python、ADB、手势识别 Python 环境、前端页面、本地 bridge 和一键启动器。新电脑优先发完整客户包；已经安装过的电脑可以发热更新包覆盖 `app` 目录。

生成云端/离线两用 Local Connector 包：

```powershell
.\scripts\build_local_connector_packages.ps1
```

输出位置：

```text
release\AI-Lover-Local-Connector-<version>.zip
```

Local Connector 包包含 `START-HERE.bat`、完整运行环境、中文 HTML/TXT 手册和本地离线控制台 `/local-control`。

## 文档

- [同事/客户使用说明](docs/AI-Lover同事使用说明.md)
- [交接文档](docs/colleague-handoff.md)
- [硅胶头机械芯调试](hardware/README_HEAD_MOTION.md)
- [手势识别与机械手控制](docs/gesture-arm-control.md)
- [Live2D 生成流程](docs/live2d-generation-pipeline.md)
- [密钥管理流程](docs/secret-management.md)
- [2.0 服务器部署说明](docs/server-deployment-2.0.md)

## 常见问题

### 127.0.0.1:3000 打不开

先停止旧进程，再重新启动：

```powershell
.\tools\customer-package\customer_stop.ps1
.\tools\customer-package\customer_start.ps1
```

### 对话开始失败

检查：

- `AGENT_SERVER_URL` 指向的 TEN agent API 是否可访问。
- `secrets.env` 是否存在并包含所需 API Key。
- 防火墙是否拦截本地端口。

### 头部能动但不发声

打开 `/head-control`：

1. 点击“启动/重连头部桥接”。
2. 点击“检测”。
3. 点击“测试音箱”。
4. 检查首页“头部音量”不是 0。

如果测试音箱有声音，但对话没有声音，查看：

```text
%LOCALAPPDATA%\AI-Lover\local_logs
```

### Arduino 手不动

检查 `/hand-control`：

- `Dry-run` 必须关闭才会真实控制硬件。
- 页面串口提示里的 `CH340/WCH/Arduino/CP210/FTDI` 通常是 Arduino 手。
- 波特率默认 `9600`。

### ORCA 手不动

检查 `/hand-control`：

- `Dry-run` 必须关闭。
- `ORCA 手` 必须启用。
- 页面串口提示里的 `Dynamixel/U2D2/Robotis/ORCA` 通常是 ORCA 手。
- ORCA 先用 17 个关节滑杆小幅测试，再开启手势跟随。

## 版本记录

完整记录见 [CHANGELOG.md](CHANGELOG.md)。

当前服务器里程碑版本为 `2.0.1`。

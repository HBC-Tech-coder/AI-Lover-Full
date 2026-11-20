# AI-Lover 同事交接文档

仓库地址：

```text
https://github.com/HBC-Tech-coder/AI-Lover
```

## 一句话介绍

AI-Lover 是基于 TEN-framework 的语音对话智能体。前端使用 Live2D 数字人展示，同时接入硅胶头机械芯、Arduino/ORCA 机械手、摄像头手势识别、Live2D/Cubism 本地生成工具链。

## 本机关键路径

```text
C:\Users\sunat\xiaoling_local_dev\AI-Lover
```

客户包输出目录：

```text
C:\Users\sunat\xiaoling_local_dev\AI-Lover\dist-customer
```

## 启动顺序

### 1. 一键启动

```powershell
cd C:\Users\sunat\xiaoling_local_dev\AI-Lover
.\tools\customer-package\customer_start.ps1
```

打开：

```text
http://127.0.0.1:3000/
```

### 2. 指定头部 IP 启动

头部 IP 会随网络变化。先在路由器或设备页面确认 IP，再启动：

```powershell
.\tools\customer-package\customer_start.ps1 -HeadIp 192.168.110.139
```

也可以在网页右上角“设置”里修改头部 IP。保存后下次启动会优先读取本地保存的 IP。

### 3. 头部验证

```powershell
adb devices
Invoke-WebRequest http://127.0.0.1:8787/health -UseBasicParsing
```

页面：

```text
http://127.0.0.1:3000/head-control
```

注意：页面里的控制端点保持 `http://127.0.0.1:8787`。不要把它改成机器人头部 IP。头部 IP 是本地 bridge 通过 ADB 连接时使用的地址。

### 4. 机械手验证

页面：

```text
http://127.0.0.1:3000/hand-control
```

先点“检测”看串口提示：

- `CH340/WCH/Arduino/CP210/FTDI` 通常是 Arduino 手。
- `Dynamixel/U2D2/Robotis/ORCA` 通常是 ORCA 手。

真实控制前关闭 `Dry-run`。ORCA 手建议先用 17 个关节滑杆小幅测试，再开启手势跟随。

## 重要页面

| 页面 | 地址 | 说明 |
| --- | --- | --- |
| 首页 | `/` | 对话、Live2D、头部音量、摄像头手势 |
| 头部控制台 | `/head-control` | 头部动作、舵机、音箱、麦克风测试 |
| 机械手控制台 | `/hand-control` | Arduino/ORCA 测试、手势切片录制和回放 |
| 角色管理 | `/characters` | 上传手工 Live2D 模型和角色资料 |
| Live2D 生成 | `/live2d-generate` | 上传照片生成 PSD/图层包 |
| 单张照片说话 | `/photo-avatar-test` | CPU 级别的单图口型测试 |
| HeyGen 测试 | `/heygen-test` | HeyGen 页面测试 |
| Trulience 测试 | `/trulience-test` | Trulience 页面测试 |

## 当前交付重点

- 客户完整包包含 Node.js、Python、ADB 和手势识别 Python 环境。
- 启动时会自动检查 OpenCV、MediaPipe、pyserial、PyYAML、dynamixel_sdk 等依赖，缺少时尝试自动安装。
- 头部喇叭播放和嘴部动作走同一段音频，减少“嘴动但不发声”的问题。
- 首页支持头部音量控制和“小声点/大声点”的语音命令。
- 手势识别支持骨架叠加、动作切片、爱心粒子和双手比心铜钱效果。

## 常用脚本

| 脚本 | 用途 |
| --- | --- |
| `tools\customer-package\customer_start.ps1` | 客户启动入口 |
| `tools\customer-package\customer_stop.ps1` | 停止本地服务 |
| `build_customer_package.ps1` | 生成完整客户包 |
| `scripts\build_hot_update_package.ps1` | 生成热更新包 |
| `start_local_robot_agent.ps1` | 开发用本地启动脚本 |

## 打包交付

完整包：

```powershell
.\build_customer_package.ps1
```

热更新包：

```powershell
.\scripts\build_hot_update_package.ps1
```

输出：

```text
dist-customer\AI-Lover-<version>-customer-win64.zip
dist-customer\AI-Lover-<version>-hot-update.zip
```

新电脑发完整包；已经装过同版本运行环境的电脑发热更新包。

## 故障排查

### 网页打不开

先停止旧进程，再启动：

```powershell
.\tools\customer-package\customer_stop.ps1
.\tools\customer-package\customer_start.ps1
```

### 头部 IP 变了

重新启动：

```powershell
.\tools\customer-package\customer_start.ps1 -HeadIp 新IP
```

或在首页设置里修改头部 IP 后点击启动/重连。

### 手机/Mac 访问无法打开摄像头或麦克风

局域网访问请使用 HTTPS 地址：

```text
https://本机局域网IP:3443/
```

首次访问会提示证书不受信任，选择继续访问即可。

### 日志位置

```text
%LOCALAPPDATA%\AI-Lover\local_logs
```

遇到客户问题时，让客户发启动窗口截图、网页错误截图、头部 IP、Arduino/ORCA 串口号和上述日志。

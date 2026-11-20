# 手势识别与机械手臂控制

本项目已经把 `Co-DexterousHand` 的核心能力接入到 AI-Lover：

- 浏览器设置面板中配置手势识别；
- 本地 Python bridge 负责摄像头识别、串口下发、可选 OrcaHand 映射；
- 默认 dry-run，不插机械手臂也可以先验证 bridge、依赖和页面流程；
- 真机模式下向 Arduino 下发 6 位手指状态字符串。

## 端口

| 端口 | 用途 |
| --- | --- |
| `3000` | AI-Lover 前端 |
| `8787` | 硅胶头机械芯 bridge |
| `8791` | 手势识别 / 机械手臂 bridge |

健康检查：

```text
http://127.0.0.1:8791/health
```

## 安装依赖

普通 Arduino 手势识别依赖：

```powershell
cd C:\Users\sunat\xiaoling_local_dev\AI-Lover
.\setup_hand_gesture_bridge.ps1
```

如果还要启用 OrcaHand / Dynamixel 映射：

```powershell
.\setup_hand_gesture_bridge.ps1 -WithOrca
```

## 启动

推荐一键启动：

```powershell
.\start_local_robot_agent.ps1
```

这会同时启动：

- 前端 `http://localhost:3000/`
- 硅胶头 bridge `http://127.0.0.1:8787/health`
- 手势 bridge `http://127.0.0.1:8791/health`

单独启动手势 bridge：

```powershell
.\start_hand_gesture_bridge.ps1
```

真机 Arduino 串口模式示例：

```powershell
.\start_hand_gesture_bridge.ps1 -RealSerial -ArduinoPorts COM5
```

## 网页设置

打开首页：

```text
http://localhost:3000/
```

点击右上角设置按钮，在“手势识别 / 机械手臂”区域：

1. 点击“检测”，确认 bridge 和依赖状态；
2. dry-run 打开时不会控制机械臂，只看识别状态；
3. 填写 Arduino 串口，例如 `COM5` 或 `COM5,COM6`；
4. 关闭 dry-run 后点击“启动”，摄像头识别到手势变化会自动下发；
5. “张开 / 握拳 / 食指”按钮可手动测试动作下发。

## ORCA Hand 17 关节跟随

ORCA Hand v1/v2 配置里有 17 个可控关节：拇指 4 个关节，四指各 3 个关节，加 1 个手腕关节。当前系统支持两种 ORCA 控制方式：

- `ORCA 17 joint continuous mapping`：默认开启。浏览器 MediaPipe 识别到 21 个手部关键点后，会连续发送给本地 bridge，bridge 直接映射到 ORCA 的 17 个关节。这个模式不依赖 `torch` / `pytorch_kinematics`，适合客户电脑稳定演示。
- `ORCA wrist follows human wrist`：默认关闭。开启后会根据手部关键点估算手腕翻折角度并驱动 ORCA wrist。因为只有手部关键点，没有完整前臂姿态，建议先确认五指张合稳定后再打开。

建议测试顺序：

1. 关闭 `dry-run`。
2. 填写 ORCA / Dynamixel 串口，例如 `COM6`，或者留空让系统自动检测。
3. 打开 `启用 OrcaHand / Dynamixel 映射`。
4. 保持 `ORCA 17 joint continuous mapping` 开启。
5. 先不要开启 `ORCA wrist follows human wrist`，点击“启动”，观察五指张开、弯曲、握拳是否跟随真人手。
6. 五指跟随稳定后，再开启手腕跟随测试翻折自由度。

如果状态里显示缺少 `torch`、`pytorch_kinematics` 或 `orca_teleop`，但 `ORCA 17 joint continuous mapping` 已开启，可以先忽略；这些只影响高级 IK retargeter，不影响直接 17 关节模式。真正必须检查的是 `orca_core`、`dynamixel_sdk`、ORCA 串口、dry-run 是否关闭，以及 ORCA 手是否通电并启用扭矩。

## Arduino 六位状态

发送格式是 6 个 `0/1` 字符加换行，例如：

```text
011111\n
```

位序：

```text
wrist,index,middle,ring,thumb,pinky
```

内置动作：

| 动作 | Pattern |
| --- | --- |
| 张开 `open` | `000000` |
| 握拳 `fist` | `011111` |
| 全握 `full_fist` | `111111` |
| 食指 `point` | `001111` |
| 二指 `two` | `000111` |
| 三指 `three` | `000011` |

## Windows 可执行文件

当前提供的是 Windows 本地启动器 exe。它会从项目目录启动 PowerShell 脚本、本地 bridge 和前端服务。

编译：

```powershell
.\build_windows_exe.ps1
```

输出：

```text
dist-windows\AI-Lover.exe
```

注意：启动器 exe 需要放在项目目录或构建输出目录中运行，让它能找到 `start_local_robot_agent.ps1`、`frontend`、`hardware` 等文件。

## 常见问题

### localhost:3000 打不开

说明前端没有运行。执行：

```powershell
.\start_local_robot_agent.ps1
```

### 手势 bridge 显示缺少 mediapipe/opencv

执行：

```powershell
.\setup_hand_gesture_bridge.ps1
```

### 摄像头打不开

关闭正在占用摄像头的软件，或者在设置里把摄像头编号从 `0` 改成 `1` 后重新启动。

### 机械手臂没动作

先保持 dry-run 打开，确认页面能检测到 bridge。再确认：

- Arduino 串口号正确；
- dry-run 已关闭；
- “启用 Arduino 六位手指串口输出”已打开；
- Arduino 端程序按行读取 6 位 pattern。

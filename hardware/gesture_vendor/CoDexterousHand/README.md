# Co-DexterousHand 遥控系统

多手机器人遥控平台，支持 OrcaHand（Dynamixel 舵机）和 Arduino 机械手同时控制。

## 目录结构

```
Co-DexterousHand/
├── start_unified.bat         ← 一键启动
├── setup_venv.bat            ← 首次运行：创建虚拟环境 + 安装依赖
├── calibrate_orca.bat        ← 一键打开电机标定
├── set_zero.bat              ← 一键记录零点
├── ui_unified.py             ← 主程序
├── config_paths.py           ← 路径配置（自动检测，无需手动改）
├── common.py                 ← 辅助函数
├── hand_landmarker.task      ← MediaPipe 手部识别模型
├── test7.py                  ← 音乐可视化模块
├── manual_calibrate.py       ← 电机标定程序
├── set_current_as_neutral.py ← 零点记录程序
├── picture/
│   └── example.png           ← 演奏模式提示图
├── audio/
│   └── canhaiyi.wav          ← 演奏模式音频
├── orca_teleop/src/orca_teleop/retargeting/
│   ├── retargeter.py         ← IK 映射算法
│   ├── utils.py
│   ├── constants.py
│   └── urdf_offsets.py
└── orcahand_desc/urdf/
    └── orcahand_right.urdf   ← OrcaHand 运动学模型
```

## 首次安装

### 1. 安装 Python 3.11

从 https://www.python.org/downloads/ 下载安装，勾选 "Add Python to PATH"。

### 2. 运行安装脚本

双击 `setup_venv.bat`，等待安装完成（约 10-20 分钟，需联网）。

### 3. 安装 orca_core

如果 setup 脚本提示 `orca_core` 未安装，从旧电脑复制：
```
旧电脑: orca_teleop-main\.venv\Lib\site-packages\orca_core\
复制到新电脑: Co-DexterousHand\.venv\Lib\site-packages\orca_core\
```
同时确保 `orca_core\models\v1\` 和 `orca_core\models\v2\` 目录也在。

## 调零与标定（安装后必须先做）

### 设置零点

双击 `set_zero.bat`。先将 OrcaHand 手动摆到期望的零点姿势，再运行，记录当前离线位姿为零点。

### 电机标定

双击 `calibrate_orca.bat`，打开标定界面。逐个电机记录运动极限（flex / extend），完成后点 SAVE 保存。电机圈数漂移或首次使用时必须标定。

## 使用说明

### 启动

双击 `start_unified.bat`，或在命令行运行：
```powershell
.\.venv\Scripts\python.exe ui_unified.py
```

### UI 布局

```
┌──────────────────────┬──────────────────────┐
│                      │  OrcaHand 遥控        │
│                      │  [手数量] [COM口×N]   │
│     摄像头画面       │  [Connect All]       │
│                      │──────────────────────│
│                      │  Arduino 遥控         │
│                      │  [手数量] [COM口×N]   │
│                      │  [开始程序] [演示]    │
│                      │──────────────────────│
│                      │  摄像头 & 设置        │
│                      │  [摄像头] [开启]      │
│                      │  [演奏模式] [退出]    │
│                      │──────────────────────│
│                      │  运行日志             │
└──────────────────────┴──────────────────────┘
```

### 操作流程

1. **打开摄像头** → 设置框点 "开启摄像头"
2. **连接 OrcaHand** → 选数量、选 COM 口，点 "Connect All"
3. **连接 Arduino** → 选数量、选 COM 口，点 "开始程序"
4. 手部动作自动映射到所有已连接的手

### 左右手自动适配

MediaPipe 自动识别左右手。左手时系统自动翻转映射，无需手动切换。

**注意**：OrcaHand 的 URDF 模型是右手配置，右手控制效果最佳。

### 演奏模式

点 "开启演奏模式" 进入音乐可视化。手指动作变化时音量自动提升。

## 故障排查

| 问题 | 解决 |
|------|------|
| `ModuleNotFoundError: No module named 'xxx'` | 运行 `setup_venv.bat` 安装依赖 |
| 摄像头打不开 | 关闭其他视频软件（Zoom/Teams），换摄像头索引 |
| OrcaHand 连接 COM 口失败 | 检查硬件电源和 USB 线，确认 COM 口号 |
| Arduino 串口乱码 | 正常现象，不影响使用 |
| 手指映射反了 | 确认用的是右手（左手会自动镜像） |
| Motor ID X is out of bounds | 电机圈数漂移，运行 `calibrate_orca.bat` 重新标定 |

## 配置

所有路径在 `config_paths.py` 中，基于 `__file__` 自动检测，复制到任何位置无需修改。

运行日志实时输出到 UI 右下方的日志框中。

AI-Lover Local Connector 快速说明

云端网页：
https://ai.vituralmodel.com

本地离线控制台：
http://127.0.0.1:3000/local-control

推荐现场调试流程：

1. 解压整个 Local Connector 压缩包。
2. 双击 START-HERE.bat。
3. 等待浏览器打开。
4. 调机械手和仿生头时，优先打开本地离线控制台：
   http://127.0.0.1:3000/local-control
5. 需要云端 AI 对话时，再打开 https://ai.vituralmodel.com 并在设置中配对 Local Connector。

多个 Arduino 手：

在 Arduino 串口输入框里写多个端口，用英文逗号分隔：

COM5,COM6

Local Connector 会把同一个手势命令同步发送给所有填写的 Arduino 串口。

常见问题：

- Connector 未连接：START-HERE.bat 没运行，或云端配对码不一致。
- 手部异常 502：本机机械手 bridge 没启动，打开本地离线控制台后点击“启动/重连机械手 bridge”。
- 骨架能识别但手不动：关闭 Dry-run，确认 Arduino 输出已开启，确认 COM 口和外接电源。
- 没有 COM 口：检查 USB 数据线、CH340/CP210x/FTDI/Robotis 驱动、设备管理器。

# 云端网页连接本地头部和机械手

AI-Lover 2.0.2 支持用户打开云端网页 `https://ai.vituralmodel.com`，同时控制自己局域网里的硅胶头机芯、Arduino 手、ORCA Hand 和摄像头手势识别。

## 为什么需要 Local Connector

云端服务器不能直接访问客户家里或公司内网里的 `192.168.x.x`、`10.x.x.x` 或 `172.16-31.x.x` 地址。浏览器从公网 HTTPS 页面直接访问内网 HTTP 服务，也会受到混合内容、CORS 和 Private Network Access 限制。

所以我们采用“本地连接器主动连云端”的方式：

1. 云端服务器运行 AI-Lover Web UI 和 `/device-bridge` WebSocket 中继。
2. 客户电脑运行 `AI-Lover Local Connector`。
3. Local Connector 在本机启动或复用 AI-Lover 本地服务，连接头部桥接和手部桥接。
4. Local Connector 主动连接 `wss://ai.vituralmodel.com/device-bridge`。
5. 云端网页使用同一个配对码连接 `/device-bridge`。
6. 网页里的头部、手部 HTTP 请求通过云端中继转发到客户本机执行。

这种方式不需要客户做公网端口映射，也不要把 ADB 或串口服务暴露到公网。

## 用户操作流程

1. 打开 `https://ai.vituralmodel.com`。
2. 进入右上角“设置”。
3. 找到“连接本地设备向导”。
4. 点击“启用云端 Local Connector”。
5. 生成或填写配对码。
6. 在客户电脑运行本地连接器。

Windows 可以直接运行：

```powershell
tools\local-connector\start_local_connector_windows.cmd
```

macOS 可以运行：

```bash
tools/local-connector/start_local_connector_macos.command
```

也可以手动运行：

```powershell
node tools/local-connector/ai-lover-local-connector.js --bridge "wss://ai.vituralmodel.com/device-bridge" --code "配对码" --name "客户电脑"
```

7. 回到网页点击“检测 Local Connector”。
8. 继续在设置里配置头部 IP、头部音量、手势识别、Arduino/ORCA 串口。

## 打包本地连接器

构建基础 zip：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_local_connector_packages.ps1 -Version 2.0.2
```

构建离线包，包含完整 `frontend/node_modules`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_local_connector_packages.ps1 -Version 2.0.2
```

输出位置：

```text
release\AI-Lover-Local-Connector-2.0.2.zip
```

## WebSocket 协议

连接地址：

```text
/device-bridge
```

浏览器连接参数：

```text
role=browser&pairingCode=ABCDE
```

本地连接器连接参数：

```text
role=connector&pairingCode=ABCDE&deviceName=客户电脑
```

浏览器发起本地硬件请求：

```json
{
  "type": "bridge.request",
  "id": "request-id",
  "method": "POST",
  "path": "/api/local-services/head/action",
  "headers": { "content-type": "application/json" },
  "bodyBase64": "eyJhY3Rpb24iOiJzbWlsZSJ9"
}
```

本地连接器返回：

```json
{
  "type": "bridge.response",
  "id": "request-id",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "bodyBase64": "eyJvayI6dHJ1ZX0="
}
```

当前只允许转发 `/api/local-services/*`，用于头部、手部和本地硬件服务。禁止转发任意 URL。

## 前端行为

本机或内网打开：

- 默认继续直连 `http://127.0.0.1:8787` 和 `http://127.0.0.1:8791`。
- 不启用 Connector 也能正常调试。

云端打开：

- 用户启用 Local Connector 并填写配对码后，`headMotion.ts` 和 `handGesture.ts` 会自动把 `/api/local-services/*` 请求通过 `/device-bridge` 转发。
- 如果 Connector 未在线，网页会提示 `Local connector is not online`。

## 安全规则

- 不要把机器人头部 ADB 暴露到公网。
- 不要把 Arduino/ORCA 串口服务暴露到公网。
- 配对码只用于临时调试和设备绑定；生产环境还需要账号登录、设备 token、过期时间和权限控制。
- 机械手动作必须保留紧急停止按钮。
- 后续控制头、手、设置、角色切换都应走统一 command bus。

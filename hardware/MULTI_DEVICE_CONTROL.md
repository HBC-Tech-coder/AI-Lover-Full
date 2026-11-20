# Multi-Device Head Control Plan

## Goal

The website should control each silicone head motion core by device ID.

## Local Debug Mode

For local debugging, each head exposes an HTTP bridge:

```text
Website /head-control -> http://127.0.0.1:8787/action -> serial /dev/ttyS4
```

The control page stores multiple device entries in browser localStorage:

```json
{
  "id": "local-head-01",
  "name": "本地机械芯",
  "endpoint": "http://127.0.0.1:8787"
}
```

This works when the browser and the robot head control service are on the same
machine or same reachable LAN.

## Production Mode

For cloud control, do not make the browser connect directly to each head.
Many heads will be behind NAT, mobile routers, or private LANs. Instead, each
head should keep an outbound connection to the server:

```text
Head bridge / Android service -> WebSocket/MQTT -> server relay
Website -> HTTPS API -> server relay -> selected device_id
```

Suggested endpoints:

```text
POST /api/head/devices/{device_id}/action
GET  /api/head/devices
WS   /api/head/bridge?device_id=...
```

Suggested command payload:

```json
{
  "id": "cmd_20260614_0001",
  "device_id": "head-01",
  "action": "servo",
  "location": 6,
  "angle": 120,
  "speed": 5
}
```

Suggested device heartbeat:

```json
{
  "device_id": "head-01",
  "name": "展厅 1 号头",
  "online": true,
  "mode": "serial",
  "serial_port": "/dev/ttyS4",
  "baud": 9600,
  "last_seen": "2026-06-14T00:00:00+08:00"
}
```

## Safety

- Clamp all servo angles on the device side, not only in the website.
- Allow speeds only: `5`, `10`, `15`.
- Add a per-device command rate limit.
- Require login/admin permission on the cloud API.
- Keep `stopspeak` and `init` available even if expression commands are blocked.

## Android Packaging Target

The Android APK should eventually contain the same command contract:

```text
POST /action
GET  /health
```

Internally it can reuse the vendor Java code:

```java
SomeUtils.writCommonDate(location, angle, speed)
SomeUtils.smile()
SomeUtils.blinkeyes()
SomeUtils.turnNeck()
```

If Android cannot run an HTTP service reliably in the final OS image, use a
foreground service plus WebSocket/MQTT client instead.

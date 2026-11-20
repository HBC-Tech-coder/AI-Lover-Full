# 密钥管理和部署方式

本项目的代码仓库不保存真实密钥。代码里只保留 `${env:NAME}` 或 `process.env.NAME` 这类环境变量引用，真实值放在本机或服务器环境里。

## 本地测试

1. 在项目根目录复制模板：

```powershell
cd C:\Users\sunat\xiaoling_local_dev\AI-Lover
Copy-Item .\secrets.env.example .\secrets.env
```

2. 用记事本或编辑器打开 `secrets.env`，填入已经轮换后的真实 key。

3. 启动脚本会自动读取根目录的 `secrets.env`：

```powershell
.\start_local_robot_agent.ps1 -HeadIp 192.168.110.139
.\start_live2d_worker.ps1
.\start_live2d_worker_cubism_open.ps1
```

4. 如果直接启动 TEN：

```powershell
cd C:\Users\sunat\xiaoling_local_dev\AI-Lover\tenapp
python .\scripts\start.py
```

`tenapp/scripts/start.py` 会先读取项目根目录的 `secrets.env`，再读取 `tenapp/.env`。

5. 如果你单独从 `frontend` 目录启动前端，可以继续使用 `frontend/.env.local`；这个文件也被 Git 忽略。通过 `start_local_robot_agent.ps1` 启动时，前端会继承根目录 `secrets.env` 里的变量。

## 推送代码

正常提交和推送代码即可：

```powershell
git status
git add .
git commit -m "..."
git push origin main
```

不要提交：

- `secrets.env`
- `frontend/.env.local`
- `tenapp/.env`
- 任何包含真实 token/password/key 的备份文件

这些文件已经在 `.gitignore` 里，但提交前仍然要看一眼 `git status`。

## 服务器更新

服务器上也不要从 GitHub 下载真实密钥。推荐方式：

1. 在服务器项目目录放一份服务器自己的 `secrets.env`。
2. 权限设置成只有当前部署用户可读：

```bash
chmod 600 secrets.env
```

3. 更新代码：

```bash
git fetch origin
git reset --hard origin/main
```

4. 重启服务。服务启动脚本或 systemd 应该读取同一份 `secrets.env`，或者把这些变量写进 systemd 的 `EnvironmentFile`。

## 必须轮换的密钥

因为仓库曾经公开过，以下旧值要视为已经泄露，必须在对应平台作废并重新生成：

- 阿里云 / DashScope ASR key
- OpenAI 或 `api.gpt.ge` key
- MiniMax TTS key
- Microsoft Azure Speech TTS key and region
- ElevenLabs TTS key
- Deepgram ASR key
- Agora App ID and App Certificate
- 钉钉机器人 access token 和 secret
- 其他曾经写进本地配置的第三方 API key

轮换后，把新值写入本地和服务器的 `secrets.env`，不要写回代码。

## 语音供应商切换

线上现在优先使用 Microsoft Azure Speech。切换或轮换时，先在服务器私有环境里
填好 `AZURE_TTS_API_KEY` 和 `AZURE_TTS_REGION`，确认 Azure Speech SDK 已安装，
再做一次真实合成测试。当前验证通过的 region 是 `eastus`。MiniMax 保留为回滚方案，
但真实 key 仍然只放在本机或服务器私有环境中。

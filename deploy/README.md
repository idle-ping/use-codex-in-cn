# 服务器部署与远程访问指南

> 适用场景：把整套服务部署在**境外服务器**（Codex 可直连 OpenAI），从境内或任意地点用浏览器访问操作。
> 适用系统：Ubuntu 22.04 / 24.04（其他发行版命令自行对应）。

## 架构总览

```
┌─ 你的浏览器（任意地点） ─┐         ┌──────────── 境外服务器 ────────────────┐
│  打字 / 审批 / 看Diff / 终端 │ ─HTTPS─▶ Caddy (443, 自动证书)                │
└──────────────────────────┘         │   └─▶ codex-webui (127.0.0.1:8899)     │
                                     │         └─▶ codex app-server           │
                                     │               └─▶ OpenAI ✅ 无障碍直连  │
                                     │ 工作项目代码 / git 仓库（AI 在这里干活） │
                                     └────────────────────────────────────────┘
```

核心原则：**WebUI 永远只监听 `127.0.0.1`，由反向代理或 SSH 隧道负责对外**。不要把 8899 端口直接暴露公网。

## 前置条件

| 项目 | 要求 |
|---|---|
| 服务器 | 境外 VPS（建议香港/日本/新加坡，或美西 CN2 GIA，对境内访问延迟低）；1 核 2G / 20G 盘起步 |
| 网络 | 服务器可直连 `api.openai.com` / `chatgpt.com` |
| 域名（推荐） | 一条 A 记录指向服务器 IP；无域名可走 SSH 隧道方案 |
| 防火墙/安全组 | 放行 22（SSH）、80/443（HTTP(S)）；**不要**放行 8899 |
| 账号 | ChatGPT 订阅账号，或 OpenAI/兼容网关的 API Key |

---

## 一、安装基础环境

```bash
sudo apt update && sudo apt install -y git curl build-essential

# Node.js 20+（PTY 终端 worker 需要）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Bun 1.3+
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Codex CLI
npm install -g @openai/codex
```

## 二、登录 Codex CLI（一次性）

两种方式任选：

- **ChatGPT 账号 OAuth**（有订阅推荐）：服务器执行 `codex login`，把它打印的 URL 在你本地浏览器打开（境内浏览器需本地代理才能访问 chatgpt.com），登录后把 code 粘贴回终端
- **API Key 模式**（无订阅 / 走中转网关）：`codex login --api-key "sk-..."`，中转网关还需编辑 `~/.codex/config.toml` 配置 `model_providers`

详细步骤与注意事项见 [../docs/codex-login-modes.md](../docs/codex-login-modes.md)。

## 三、获取代码并安装依赖

```bash
# 换成你的仓库地址（Codeup / GitHub 均可）
git clone https://codeup.aliyun.com/你的组织/tools/codex-webui.git
cd codex-webui
bun install
```

## 四、初始化访问密码（仅本机执行）

```bash
HOST=127.0.0.1 bun run server.ts --setup-password
```

打开 `http://127.0.0.1:8899`，设置 ≥12 字符的强密码（建议 16+ 随机串），然后 Ctrl+C 停止。
密码以加盐 `scrypt` 凭据存于 `~/.codex/codex-webui-auth.json`（权限 0600）。

## 五、选择运行方式（二选一）

### 方式 A：systemd（裸机，排查直接）

```bash
sudo cp deploy/codex-webui.service.example /etc/systemd/system/codex-webui.service
sudo nano /etc/systemd/system/codex-webui.service   # 改 User / 路径 / 可选环境变量
sudo systemctl daemon-reload
sudo systemctl enable --now codex-webui
sudo systemctl status codex-webui          # 应为 active (running)
```

### 方式 B：Docker Compose（隔离性好，自愈）

```bash
cp deploy/env.production.example .env
nano .env    # 按注释填写：CODEX_BIN、CODEX_HOME_HOST、CODEX_WEBUI_REVIEW_ROOT 等
docker compose up -d --build
```

`.env` 关键变量说明：

| 变量 | 说明 |
|---|---|
| `WEBUI_BIND_IP` | **保持 `127.0.0.1`**，只让反代访问 |
| `CODEX_BIN` | 宿主机 `which codex` 的结果，compose 会只读挂进容器 |
| `CODEX_HOME_HOST` | 宿主机 `~/.codex`（含登录凭据与 WebUI 密码文件） |
| `CODEX_WEBUI_REVIEW_ROOT` | 允许 Undo/Reapply 的 git 仓库根目录，如 `~/projects` |
| `CODEX_WEBUI_PROJECTLESS` | `true` 时启动页不绑定默认项目，从页面选择 |
| `TZ` | `Asia/Shanghai` |

### 验证服务已就绪（服务器上执行）

```bash
curl -s http://127.0.0.1:8899/api/health
# 期望：{"status":"ok","codex":true,...}  —— codex:false 说明第二步登录没完成
```

## 六、配置 HTTPS 反向代理

### 推荐：Caddy（自动申请/续期证书，原生支持 WebSocket）

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile    # 把 codex.example.com 换成你的域名
sudo systemctl reload caddy
```

完成后浏览器访问 `https://你的域名` 即可。

如果偏好 Nginx，注意 **必须透传 WebSocket upgrade**（`/ws`、`/terminal` 两条通道依赖它）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8899;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;   # 长连接（终端/流式输出）需要
}
```

### 备选：无域名走 SSH 隧道（零暴露面，最安全）

```bash
# 在你的本地电脑执行：
ssh -N -L 8899:127.0.0.1:8899 用户名@服务器IP
# 然后浏览器访问 http://127.0.0.1:8899

# 长期使用可加 autossh 保活：
autossh -M 0 -f -N -L 8899:127.0.0.1:8899 \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 用户名@服务器IP
```

## 七、开始使用

1. 把要开发的项目 clone 到服务器，例如 `~/projects/my-app`
2. 浏览器打开 WebUI → 左下角 **Choose project** 选中该项目
3. 正常对话、审批、看 Diff；Undo/Reapply 只影响 `CODEX_WEBUI_REVIEW_ROOT` 指定根目录下的 git 仓库

## 八、多用户团队模式（可选）

多人共用一台服务器时开启，每人独立密码登录、独立 `CODEX_HOME` 与工作区隔离：

```bash
# systemd 方式追加环境变量（或写进 .env）：
CODEX_WEBUI_MULTI_USER=true
CODEX_WEBUI_MULTI_USER_ROOT=/srv/codex-webui     # 用户数据根目录
```

首次启动后访问页面，按引导创建第一个用户（自动成为 admin），后续用户由 admin 在 `/api/auth/users` 管理。
单用户数据迁移工具：`bun run migrate:single-user --username <名字>`。
设计细节见 [../README-zh.md](../README-zh.md) 的「多用户模式」与 [../docs/design/multi-user-runtime.md](../docs/design/multi-user-runtime.md)。

## 九、日常运维

```bash
# 看日志
journalctl -u codex-webui -f          # systemd 方式
docker compose logs -f                # Docker 方式

# 升级（更新代码 + 重启）
cd ~/codex-webui && git pull && bun install
sudo systemctl restart codex-webui    # 或 docker compose up -d --build

# 健康检查
curl -s http://127.0.0.1:8899/api/health
```

**需要备份的文件**：

- `~/.codex/auth.json`（Codex 登录凭据，丢了要重新登录）
- `~/.codex/codex-webui-auth.json`（WebUI 密码）
- `~/projects/`（工作代码，建议另接远端仓库）
- 多用户模式：`/srv/codex-webui/`（全部用户数据）+ SQLite 库

## 十、安全清单（必读）

- [ ] `WEBUI_BIND_IP` / `HOST` 保持 `127.0.0.1`，绝不直接对公网开 8899
- [ ] WebUI 密码 ≥16 位随机串（**这个网页约等于服务器 shell**，AI 可执行命令/改文件/开终端）
- [ ] 使用专用 VPS，不放其他业务和敏感数据
- [ ] 公网访问必须 HTTPS（Caddy 自动处理；自签/Nginx 需自行确保）
- [ ] `CODEX_WEBUI_REVIEW_ROOT` 只指向工作仓库根，不要指到家目录
- [ ] 跟随 Codex CLI 升级（依赖的 app-server 协议是 experimental API，CLI 大版本升级后需验证）
- [ ] 服务器 SSH 本身：密钥登录、禁用密码、fail2ban 照常配置

## 常见问题

| 症状 | 原因与处理 |
|---|---|
| 浏览器 502 | WebUI 没起（`systemctl status` / `docker compose ps`）或反代指向端口不对 |
| 页面能开但一直 connecting / 模型列表为空 | Codex 未登录或登录失效：`curl http://127.0.0.1:8899/api/health` 看 `codex` 字段，重做第二步 |
| 对话/通知正常但终端打不开 | PTY worker 依赖 Node 20+：`node -v` 检查；容器方式确认镜像内 node 正常 |
| 反代后 WS 反复断开重连 | Nginx 未透传 `Upgrade` 头（见第六节配置）或读超时太短 |
| 时间显示不对 | 环境变量 `TZ=Asia/Shanghai` 后重启 |
| 推送被拒 `! [rejected]` | 服务器代码落后：`git pull --rebase` 后再操作 |

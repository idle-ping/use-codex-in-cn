# Codex CLI 登录方式指南

> 本项目（codex-webui）自身不实现 AI 能力，所有模型调用都来自官方 `codex app-server` 子进程。
> 因此使用前**必须**先在本机/服务器完成 Codex CLI 的登录，二选一即可。

登录状态存放在 `~/.codex/auth.json`，一次登录长期有效（失效后重新登录即可）。

验证登录是否成功：

```bash
codex login status        # 或启动 WebUI 后访问 /api/health 看 codex 字段
```

---

## 方式 A：ChatGPT 账号 OAuth（有订阅的用户推荐）

适用：ChatGPT Plus / Pro / Team / Enterprise 订阅用户，直接复用订阅额度，无额外计费。

### 步骤

```bash
codex login
```

1. 终端会打印一个 URL 和一个一次性 code
2. **在任意一台能访问 chatgpt.com 的设备浏览器**打开该 URL（无头服务器上操作时，就用你本地电脑的浏览器打开）
3. 登录 ChatGPT 账号，把终端提示的 code 粘贴到页面
4. 页面确认后，服务器上的 `~/.codex/auth.json` 即写入登录凭据

### 网络受限地区注意事项（如境内本地电脑）

- OAuth 页面是 `chatgpt.com`，境内直连打不开——本地浏览器需配置代理（系统代理或浏览器插件均可）再完成第 2 步
- **只有登录这一次**需要浏览器能访问 chatgpt.com；登录完成后，WebUI 与 codex 的日常请求都由境外服务器发出，境内浏览器访问 WebUI 本身无任何网络障碍
- 如果部署在境外服务器上执行 `codex login`，则整条链路都在境外，无任何阻碍

### 登出 / 切换账号

```bash
codex logout
codex login      # 重新登录
```

---

## 方式 B：API Key 模式（无订阅 / 中转网关）

适用：没有 ChatGPT 订阅但持 OpenAI API Key 的用户；或通过 OpenAI 兼容的网关/中转服务接入。

### B1. 官方 API Key

```bash
codex login --api-key "sk-..."
```

按 token 用量计费，与订阅额度互不相干。

### B2. 中转网关 / 自定义端点（OpenAI 兼容）

编辑 `~/.codex/config.toml`，声明自定义 provider：

```toml
model_provider = "relay"
model = "gpt-5-codex"          # 按你的网关实际支持的模型填写

[model_providers.relay]
name = "relay"
base_url = "https://your-relay.example.com/v1"
env_key = "RELAY_API_KEY"       # 从这个环境变量读取 key，而不是写进配置文件
# wire_api = "responses"        # 网关支持 Responses API 时可显式指定
```

```bash
export RELAY_API_KEY="sk-..."   # 建议写入 systemd 单元或 .env，勿硬编码进代码
```

> ⚠️ 字段细节（`wire_api`、模型命名等）随 Codex CLI 版本演进，以 [官方文档](https://developers.openai.com/codex/) 的 config 说明为准。

### 安全提醒（中转场景必读）

- **你的全部请求内容（代码、提示词）都会经过中转方服务器**，选可信服务，敏感代码慎用
- API Key 泄露可直接产生账单消费；`env_key` 方式比把 key 写进 `config.toml` 更安全
- 定期在网关侧轮换 key

---

## 常见问题

| 问题 | 处理 |
|---|---|
| WebUI 页面正常但模型列表为空 / 一直 connecting | `codex login status` 检查；多半是没登录或凭据失效 |
| `codex login` 打印的 URL 在境内打不开 | 本地浏览器配代理后重试，或改在境外服务器上执行登录 |
| OAuth 登录成功但调用报 401/403 | 订阅过期或账号无 Codex 权限；`codex logout` 后换号重登 |
| API Key 模式报模型不存在 | `config.toml` 的 `model` 名称与网关支持列表不符 |

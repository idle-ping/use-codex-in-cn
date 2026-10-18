# Windows 已知问题（实测记录）

> 本项目 README 声明「Windows 尚未完整测试」。以下是 2026-10 在 Windows 10 (19044) x64 + Bun 1.4.3 + Node 22 环境下的实测结果，供 Windows 用户参考。
> **结论：本地开发/浏览可用，生产部署请用 Linux 或 WSL2。**

## ✅ 可正常工作的部分

| 项目 | 状态 |
|---|---|
| `bun install` | 正常（87 包） |
| `bun build server.ts` / 前端 bundle | 正常 |
| 服务启动、页面加载、HTTP API | 正常 |
| 单元测试 | **135 / 151 通过** |

## ❌ 已知问题

### 1. 16 个单元测试失败（环境差异，非功能缺陷）

失败用例集中在四类，均源于 Windows 与 POSIX 的差异：

| 类别 | 原因 |
|---|---|
| symlink 相关用例 | 创建符号链接需要管理员权限或开发者模式 |
| 文件权限断言（0700/0600） | Windows 无 POSIX 权限位 |
| Unix domain socket 检测用例 | `statSync().isSocket()` 在 Windows 上行为不同 |
| 个别 git 仓库 / jsdom sanitizer 用例 | 路径与测试环境差异 |

### 2. `bun run check` 脚本不可用

`package.json` 的 `check` 脚本把输出路径硬编码为 `/tmp/...`，Windows 无该路径，直接失败。
替代方案：

```bash
bun build server.ts --target=bun --outfile=.tmp-check/server.js && rm -rf .tmp-check
```

### 3. 运行模式的平台限制

- **shared 模式不可用**：依赖 Unix domain socket（`app-server-control.sock`），Windows 上 Codex CLI 也不产生该文件；`auto` 模式会自动回落到 **isolated**（stdio 子进程），功能完整，只是无法与 SSH CLI 共享会话
- **PTY 终端**：worker 会启动 PowerShell 作为 shell，可用但与文档中 bash 行为有差异

## 建议

| 用途 | 建议 |
|---|---|
| 本地开发、阅读代码 | 直接用，遇到上述失败可忽略（或先开「开发者模式」解决 symlink 用例） |
| 运行完整测试矩阵 | 在 WSL2 或 CI（Linux）里跑 |
| 生产部署 | Linux 服务器（见 [../deploy/README.md](../deploy/README.md)） |

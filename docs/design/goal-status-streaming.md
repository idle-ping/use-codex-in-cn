# Goal 状态与持续输出设计

## 结论

Goal 状态不能从当前 `thread/read`、`thread/list` 或普通 `turn/*` 状态可靠推导。Goal 由 Codex TUI 的编排层维护，而 WebUI 连接的是 app-server 的 Thread/Turn 流。

本设计沿用现有已认证的 WebSocket/SSE 通知通道，增加可选的 Goal 通知类型，不新增 HTTP 接口、轮询接口或新的 RPC 查询。没有 Goal 通知时，WebUI 隐藏 Goal 状态，不显示推测出的假进度。

## 当前证据

对 session `01a13238-d115-7e03-9211-af0f8fde9d7a` 的运行记录显示：

- `thread.status` 为 `idle`。
- `host/thread/live` 返回 `active: false`。
- 最后事件是 `task_complete`，之后没有新的 rollout 事件。
- Thread 和 Turn 结构中没有 `goal`、`goalStatus` 或 `objective` 字段。
- session 的 `originator` 是 `codex-tui`，不是 WebUI。
- Codex 本机的 `/home/coding/.codex/goals_1.sqlite` 中存在 `thread_goals` 记录；该 session 当前状态为 `blocked`，并包含完整 objective、Goal ID、tokens/time 用量和更新时间。

因此，WebUI 当前没有可订阅的 Goal 数据源；页面没有持续输出是因为 app-server 没有收到新的 Goal 或 Turn 事件。

## 目标

Goal 运行期间，用户应能看到：

- 当前 Goal 是否正在运行、暂停、阻塞或已完成。
- 最近一次进度消息及其时间。
- 当前 Goal 绑定的 Session，避免切换 Session 后串状态。
- 断线重连后恢复最近状态，不需要重新触发 Goal。

## 非目标

- 不把普通 Turn 的 `inProgress` 伪装成 Goal 进度。
- 不通过定时轮询文件、计划文档或 Session 文本猜测 Goal 状态。
- 不新增 `goal/read` HTTP/RPC 查询。
- 不把完整 Goal 文档、token、凭据或内部推理内容广播给浏览器。

## 事件协议

Goal 编排层的持久状态来自 `goals_1.sqlite`。WebUI 服务端以只读方式轮询 `thread_goals`，并通过现有 app-server 通知通道广播以下可选事件。WebUI 的 HTTP、WebSocket、SSE 外层协议保持不变，旧客户端会忽略未知通知。

### `goal/status/changed`

```json
{
  "method": "goal/status/changed",
  "params": {
    "threadId": "01a13238-d115-7e03-9211-af0f8fde9d7a",
    "goalId": "goal-01a13238",
    "status": "active",
    "objective": "获得 ANPWEB shopping/search 的完整业务通过",
    "detail": "P2：定位 Chrome 152 与 sv8 的第一个可观察分叉",
    "progress": { "completed": 1, "total": 4 },
    "updatedAt": 1791862115
  }
}
```

允许的 `status` 值：

```text
active | paused | blocked | completed | failed
```

`objective`、`detail`、`progress` 都是可选字段。状态事件必须携带 `threadId` 和 `goalId`，这样前端能丢弃过期 Goal 的事件。

### `goal/progress`

```json
{
  "method": "goal/progress",
  "params": {
    "threadId": "01a13238-d115-7e03-9211-af0f8fde9d7a",
    "goalId": "goal-01a13238",
    "message": "已完成 P1 调用点采集，开始进入 P2",
    "phase": "P2",
    "updatedAt": 1791862115
  }
}
```

`goal/progress` 只承载用户可见的短进度摘要，不承载推理内容。它应在阶段变化、阻塞原因变化或有实质性进展时发送，不能按固定频率制造心跳消息。

## 服务端改动

`server.ts` 已经把 Codex 通知包装为：

```text
codex/notification -> WebSocket/SSE browser clients
```

服务端不新增 HTTP/RPC 接口，而是增加只读 GoalStore：

1. 从 `thread_goals` 读取 `thread_id`、`goal_id`、`objective`、`status`、token/time 用量和更新时间。
2. 首次读取 Thread 或检测到 SQLite 行变化时广播 `goal/status/changed`。
3. 保留 `threadId`、`goalId` 和 `updatedAt`，不记录或广播敏感字段。
4. 在共享 Session 场景下，让所有已认证 WebUI 客户端收到同一事件。

`goal/progress` 仍可由未来的 Goal 编排层发送，用于短进度消息；SQLite 状态变化负责可靠的状态快照和最终状态。

## 前端状态模型

在 `state` 中增加一个按 Thread 保存的 Goal Map：

```js
goals: new Map()
```

归一化后的值：

```js
{
  threadId,
  goalId,
  status,
  objective,
  detail,
  progress,
  message,
  updatedAt
}
```

事件处理规则：

1. `goal/status/changed` 替换同一 `threadId + goalId` 的快照。
2. `goal/progress` 只更新 `message`、`detail`、`updatedAt`，保留已有状态。
3. 收到不同 `goalId` 的旧事件时丢弃。
4. 切换 Session 时只读取当前 Thread 的 Goal。
5. `completed`、`failed`、`blocked` 保留最终状态，直到收到新的 Goal 或用户创建新任务。
6. WebSocket/SSE 重连后不清空快照；重新打开 Thread 时若没有 Goal 快照则隐藏 Goal 区域。

## UI 位置与状态表现

复用当前 composer 上方的状态区域，在 `#sessionStatus` 上方增加一个独立的 `#goalStatus`。两个区域职责不同：

| Goal 状态 | 表现 |
|---|---|
| `active` | 蓝色进行中图标、目标摘要、最近进度；有阶段时显示阶段 |
| `paused` | 暂停图标和暂停原因 |
| `blocked` | 红色警告图标和阻塞原因 |
| `completed` | 绿色勾选图标和完成摘要 |
| `failed` | 红色警告图标和失败原因 |

Goal 状态区域使用 `role="status"` 和 `aria-live="polite"`。进度文本截断显示，完整内容放在 `title` 和 `aria-label`，避免长目标撑开 Composer。

## 持续输出规则

Goal 的“持续输出”不等于每秒刷新一条消息。正确行为是：

- 编排层在 Goal 阶段变化或有实质进展时发送 `goal/progress`。
- WebUI 收到后立即更新 Goal 区域，不等待下一次 `thread/read`。
- 如果同时有普通 Turn，Turn 的活动状态和 Goal 的阶段状态并行显示。
- Goal 没有新事件时保持最后一次有效状态，并显示更新时间。
- 连接断开时显示“状态同步中”，重连后继续使用最后快照并接收后续事件。

## 验收用例

1. `active -> progress -> active`：目标摘要和最近进度实时更新。
2. `active -> blocked`：显示阻塞原因，普通 Turn 完成不覆盖 Goal 状态。
3. `active -> completed`：显示完成状态，后续旧进度事件不能回退状态。
4. 同一 Thread 创建新 `goalId`：新 Goal 替换旧 Goal。
5. 切换 Session：旧 Goal 不出现在新 Session。
6. WebSocket 断开后切到 SSE，再收到进度事件：状态继续更新。
7. 没有 Goal 事件的普通 Session：不显示 Goal 区域，现有 Session 状态行为不变。
8. 目标或进度包含 HTML、超长文本或敏感字段：安全转义、截断并不泄露原始内部数据。

## 实施顺序

1. 从 `thread_goals` 读取并广播 Goal 快照。
2. 在 WebUI 增加 Goal Map、事件归一化和 Session 绑定。
3. 增加 Goal 状态 UI、样式和国际化文案。
4. 增加事件顺序、断线恢复和多 Session 端到端测试。
5. 用真实 Goal session 验证 `blocked`、`complete` 和用量限制状态。

在第 1 步完成前，不应把普通 Turn 状态标记为 Goal 状态；否则页面会显示看似实时、实际无法证明的进度。

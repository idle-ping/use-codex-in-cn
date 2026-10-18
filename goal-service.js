import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

function normalizeRow(row) {
  if (!row) return null;
  const tokenBudget = Number.isInteger(row.token_budget) ? row.token_budget : null;
  const tokensUsed = Number.isInteger(row.tokens_used) ? row.tokens_used : 0;
  const timeUsedSeconds = Number.isInteger(row.time_used_seconds) ? row.time_used_seconds : 0;
  const updatedAtMs = Number.isInteger(row.updated_at_ms) ? row.updated_at_ms : 0;
  return {
    threadId: String(row.thread_id),
    goalId: String(row.goal_id),
    status: String(row.status),
    objective: String(row.objective || ""),
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAtMs: Number.isInteger(row.created_at_ms) ? row.created_at_ms : 0,
    updatedAtMs,
    updatedAt: updatedAtMs,
    progress: tokenBudget && tokenBudget > 0
      ? { completed: tokensUsed, total: tokenBudget, kind: "tokens" }
      : { elapsedSeconds: timeUsedSeconds, kind: "time" },
  };
}

function sameGoal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class GoalStore {
  #path;
  #onChange;
  #intervalMs;
  #db = null;
  #timer = null;
  #goals = new Map();

  constructor({ path, home = process.env.HOME || process.cwd(), onChange = () => {}, intervalMs = 1000 } = {}) {
    this.#path = resolve(path || join(process.env.CODEX_HOME || join(home, ".codex"), "goals_1.sqlite"));
    this.#onChange = onChange;
    this.#intervalMs = intervalMs;
  }

  #open() {
    if (this.#db || !existsSync(this.#path)) return this.#db;
    try {
      this.#db = new Database(this.#path, { readonly: true, create: false });
      return this.#db;
    } catch {
      this.#db = null;
      return null;
    }
  }

  refresh() {
    const db = this.#open();
    if (!db) return;
    let rows;
    try {
      rows = db.query("SELECT thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals").all();
    } catch {
      return;
    }
    const next = new Map(rows.map(row => {
      const goal = normalizeRow(row);
      return [goal.threadId, goal];
    }));
    const ids = new Set([...this.#goals.keys(), ...next.keys()]);
    for (const threadId of ids) {
      const previous = this.#goals.get(threadId) || null;
      const current = next.get(threadId) || null;
      if (!sameGoal(previous, current)) this.#onChange(current, previous);
    }
    this.#goals = next;
  }

  get(threadId) {
    return this.#goals.get(threadId) || null;
  }

  emit(threadId) {
    const goal = this.get(threadId);
    if (goal) this.#onChange(goal, null);
  }

  start() {
    if (this.#timer) return;
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), this.#intervalMs);
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#db?.close();
    this.#db = null;
  }
}

export function goalNotification(goal) {
  if (!goal) return null;
  return {
    method: "goal/status/changed",
    params: goal,
  };
}

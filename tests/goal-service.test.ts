import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoalStore } from "../goal-service.js";

test("reads and emits thread goal changes from the shared goal store", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-store-"));
  const path = join(dir, "goals_1.sqlite");
  const db = new Database(path);
  db.run(`CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`);
  db.run("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["thread-a", "goal-a", "Ship it", "blocked", 100, 25, 8, 10, 20]);
  db.close();

  const events: any[] = [];
  const store = new GoalStore({ path, onChange: goal => events.push(goal), intervalMs: 60_000 });
  try {
    store.start();
    expect(store.get("thread-a")).toMatchObject({ threadId: "thread-a", goalId: "goal-a", status: "blocked", objective: "Ship it", tokensUsed: 25, tokenBudget: 100 });
    expect(events).toHaveLength(1);

    const writer = new Database(path);
    writer.run("UPDATE thread_goals SET status = ?, tokens_used = ?, updated_at_ms = ? WHERE thread_id = ?", ["complete", 100, 30, "thread-a"]);
    writer.close();
    store.refresh();
    expect(events.at(-1)).toMatchObject({ threadId: "thread-a", status: "complete", tokensUsed: 100, updatedAtMs: 30 });

    const remover = new Database(path);
    remover.run("DELETE FROM thread_goals WHERE thread_id = ?", ["thread-a"]);
    remover.close();
    store.refresh();
    expect(events.at(-1)).toBeNull();
  } finally {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

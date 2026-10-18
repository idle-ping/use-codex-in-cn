import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MultiUserStore } from "../multi-user-store.ts";

test("stores password hashes, user roots and revocable sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-user-store-"));
  const store = new MultiUserStore({ path: join(dir, "control", "auth.sqlite"), rootBase: join(dir, "users") });
  try {
    const user = store.createUser({ username: "Alice", password: "correct horse battery staple", now: 100 });
    expect(user.username).toBe("alice");
    expect(user.role).toBe("admin");
    expect(user.rootDirectory.startsWith(join(dir, "users") + "/")).toBe(true);
    expect(store.verifyCredentials("alice", "wrong password")).toBeNull();
    expect(store.verifyCredentials("ALICE", "correct horse battery staple")).toMatchObject({ id: user.id, username: "alice" });
    const session = store.createSession(user.id, { ttlMs: 1000, now: 100 });
    expect(store.getSession(session.token, { now: 500, touch: false })?.user.id).toBe(user.id);
    expect(store.revokeSession(session.token, 600)).toBe(true);
    expect(store.getSession(session.token, { now: 700, touch: false })).toBeNull();
    const member = store.createUser({ username: "bob", password: "another correct horse", now: 200 });
    expect(member.role).toBe("member");
    expect(store.listUsers()).toHaveLength(2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("rejects roots outside the configured base", () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-user-store-"));
  const store = new MultiUserStore({ path: join(dir, "auth.sqlite"), rootBase: join(dir, "users") });
  try { expect(() => store.createUser({ username: "alice", password: "correct horse battery staple", rootDirectory: join(dir, "outside") })).toThrow("inside"); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

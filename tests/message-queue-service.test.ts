import { expect, test } from "bun:test";
import { createQueueRecovery } from "../message-queue-service.js";

test("queue recovery skips active turns and coalesces concurrent recovery requests", async () => {
  const calls: any[] = [];
  let active = true;
  const recover = createQueueRecovery(async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { turns: [{ status: active ? "inProgress" : "interrupted" }] } };
    if (method === "thread/queue/list") return { data: [{ id: "first" }, { id: "second" }] };
    if (method === "thread/queue/start") active = true;
    return {};
  });
  await recover("A");
  expect(calls.map(call => call.method)).toEqual(["thread/read"]);
  calls.length = 0;
  active = false;
  await Promise.all([recover("A"), recover("A")]);
  expect(calls.map(call => call.method)).toEqual(["thread/read", "thread/queue/list", "thread/queue/start", "thread/read"]);
  expect(calls[2].params).toEqual({ threadId: "A", queuedSubmissionId: "first" });
});

test("a completion arriving during an active snapshot check is checked again", async () => {
  let release: (value: any) => void;
  let reads = 0, starts = 0;
  const recover = createQueueRecovery(async (method: string) => {
    if (method === "thread/read") {
      if (++reads === 1) return new Promise(resolve => { release = resolve; });
      return { thread: { turns: [{ status: "completed" }] } };
    }
    if (method === "thread/queue/list") return { data: [{ id: "next" }] };
    starts++;
    return {};
  });
  const checking = recover("A");
  const completed = recover("A");
  release!({ thread: { turns: [{ status: "inProgress" }] } });
  await Promise.all([checking, completed]);
  expect(starts).toBe(1);
});

test("recovery does not retry a start after a lost acknowledgement", async () => {
  const calls: string[] = [], errors: Error[] = [];
  const recover = createQueueRecovery(async (method: string) => {
    calls.push(method);
    if (method === "thread/read") return { thread: { turns: [] } };
    if (method === "thread/queue/list") return { data: [{ id: "first" }] };
    throw new Error("Codex request timed out");
  }, (error: Error) => errors.push(error));
  await recover("A");
  expect(calls.filter(method => method === "thread/queue/start")).toHaveLength(1);
  expect(errors).toHaveLength(1);
});

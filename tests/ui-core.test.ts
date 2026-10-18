import { describe, expect, test } from "bun:test";
import { DEFAULT_TURN_PAGE_SIZE, applyComposerSuggestion, createLatestRequestGate, createComposerHistory, createTurnWindow, filterAppModels, formatActivityAge, threadLastActivityAt, getComposerAutocomplete, resolveComposerPlaceholder, selectModelState } from "../public/ui-core.js";

describe("conversation turn window", () => {
  test("uses a small default page for fast first paint", () => {
    expect(DEFAULT_TURN_PAGE_SIZE).toBe(20);
  });

  test("opens a long conversation with only the newest turns", () => {
    const turns = Array.from({ length: 2693 }, (_, i) => ({ id: `turn-${i}` }));
    const view = createTurnWindow(turns, 80);
    expect(view.visible).toHaveLength(80);
    expect(view.visible[0].id).toBe("turn-2613");
    expect(view.hiddenCount).toBe(2613);
  });

  test("loads an older page without losing the newest turns", () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({ id: `turn-${i}` }));
    const first = createTurnWindow(turns, 80);
    const second = createTurnWindow(turns, 80, first.start, 80);
    expect(second.visible).toHaveLength(160);
    expect(second.visible[0].id).toBe("turn-40");
    expect(second.visible.at(-1)?.id).toBe("turn-199");
    expect(second.hiddenCount).toBe(40);
  });
});

describe("latest request gate", () => {
  test("invalidates an older async response when a new request starts", () => {
    const gate = createLatestRequestGate();
    const oldRequest = gate.next();
    const currentRequest = gate.next();
    expect(gate.isCurrent(oldRequest)).toBe(false);
    expect(gate.isCurrent(currentRequest)).toBe(true);
  });
});

describe("model selection", () => {
  test("keeps only GPT models for the desktop model picker", () => {
    const models = [
      { model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
      { model: "o3", displayName: "o3" },
      { model: "codex-mini", displayName: "Codex Mini" },
      { id: "gpt-5.5", displayName: "GPT-5.5" },
    ];
    expect(filterAppModels(models).map((model) => model.model || model.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  });

  test("selects a model and its advertised default effort", () => {
    const models = [
      { model: "gpt-5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
      { model: "gpt-5.6-sol", defaultReasoningEffort: "xhigh", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
    ];
    expect(selectModelState(models, "gpt-5.6-sol")).toEqual({ model: "gpt-5.6-sol", effort: "xhigh", efforts: ["high", "xhigh"] });
  });

  test("falls back to the catalog default when saved model is missing", () => {
    const models = [
      { model: "gpt-5.5", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
    ];
    expect(selectModelState(models, "removed-model").model).toBe("gpt-5.5");
  });
});

describe("composer placeholder", () => {
  test("matches the native state priority and follow-up variants", () => {
    expect(resolveComposerPlaceholder({ isGoalModeActive: true, isPlanModeActive: true })).toBe("Describe your goal, define measurable outcomes for best results");
    expect(resolveComposerPlaceholder({ isPlanModeActive: true })).toBe("Describe your task to generate a plan...");
    expect(resolveComposerPlaceholder({ placeholderText: "Waiting for worktree setup…" })).toBe("Waiting for worktree setup…");
    expect(resolveComposerPlaceholder({ followUpType: "local", composerMode: "local" })).toBe("Ask for follow-up changes");
    expect(resolveComposerPlaceholder({ followUpType: "local", composerMode: "local", isBackgroundSubagentsPanelVisible: true })).toBe("Ask for follow up changes or @ to tag an agent");
    expect(resolveComposerPlaceholder({ followUpType: "cloud", composerMode: "local" })).toBe("Create a new local task that references this cloud task");
    expect(resolveComposerPlaceholder({ followUpType: "cloud", composerMode: "cloud", cloudStartingState: "working-tree" })).toBe("Create a new cloud task that includes your current code and will reference this task");
    expect(resolveComposerPlaceholder({ composerMode: "cloud" })).toBe("Ask Codex to do anything in the cloud");
    expect(resolveComposerPlaceholder({ isHome: true, composerMode: "local" })).toBe("Do anything");
  });
});

describe("composer autocomplete", () => {
  test("recognizes slash commands only in the leading composer token", () => {
    expect(getComposerAutocomplete("/pla", 4)).toEqual({ type: "slash", query: "pla", start: 0, end: 4 });
    expect(getComposerAutocomplete("  /model", 8)).toEqual({ type: "slash", query: "model", start: 2, end: 8 });
    expect(getComposerAutocomplete("explain /plan", 13)).toBeNull();
  });

  test("recognizes skill tokens after a dollar sign", () => {
    expect(getComposerAutocomplete("$image", 6)).toEqual({ type: "skill", query: "image", start: 0, end: 6 });
    expect(getComposerAutocomplete("use $image", 10)).toEqual({ type: "skill", query: "image", start: 4, end: 10 });
  });

  test("recognizes an at mention at the cursor and replaces only that token", () => {
    const match = getComposerAutocomplete("review @pack next", 12);
    expect(match).toEqual({ type: "mention", query: "pack", start: 7, end: 12 });
    expect(applyComposerSuggestion("review @pack next", match!, "@package.json")).toEqual({ text: "review @package.json next", cursor: 20 });
  });

  test("adds a trailing space when completing at the end", () => {
    const slash = getComposerAutocomplete("/plan", 5)!;
    expect(applyComposerSuggestion("/plan", slash, "/plan")).toEqual({ text: "/plan ", cursor: 6 });
  });
});

describe("session activity metadata", () => {
  const now = 2_000_000_000_000;
  test("uses real activity updates and falls back when timestamps are missing", () => {
    expect(threadLastActivityAt({updatedAt: 100, recencyAt: 200})).toBe(100);
    expect(threadLastActivityAt({updatedAt: 100, lastActivityAt: 150})).toBe(150);
    expect(threadLastActivityAt({recencyAt: 200})).toBe(200);
    expect(threadLastActivityAt({updatedAt: NaN})).toBe(0);
    expect(threadLastActivityAt({})).toBe(0);
  });
  test("shows elapsed time across minutes, hours and days in either language", () => {
    const timestamp = now / 1000;
    expect(formatActivityAge(timestamp, {now, locale:'en'})).toBe('now');
    expect(formatActivityAge(timestamp + 100, {now, locale:'en'})).toBe('now');
    expect(formatActivityAge(timestamp - 300, {now, locale:'en'})).toBe('5 min. ago');
    expect(formatActivityAge(timestamp - 7200, {now, locale:'en'})).toBe('2 hr. ago');
    expect(formatActivityAge(timestamp - 172800, {now, locale:'en'})).toBe('2 days ago');
    expect(formatActivityAge(timestamp - 300, {now, locale:'zh-CN'})).toBe('5分钟前');
    expect(formatActivityAge(timestamp - 7200, {now, locale:'zh-CN'})).toBe('2小时前');
    expect(formatActivityAge(undefined, {now})).toBe('');
    expect(formatActivityAge(NaN, {now})).toBe('');
    expect(formatActivityAge(0, {now})).toBe('');
  });
});


describe("CLI composer history", () => {
  test("traverses older/newer entries and clears past newest without wrapping", () => {
    const history=createComposerHistory();
    history.setPersistent([{text:"old"},{text:"new"}]);
    expect(history.navigate(1,"",0)).toBeNull();
    expect(history.navigate(-1,"",0)?.text).toBe("new");
    expect(history.navigate(-1,"new",3)?.text).toBe("old");
    expect(history.navigate(-1,"old",3)).toBeNull();
    expect(history.navigate(1,"old",0)?.text).toBe("new");
    expect(history.navigate(1,"new",3)?.text).toBe("");
    expect(history.navigate(1,"",0)).toBeNull();
  });
  test("protects fresh drafts, edits, selections and interior multiline cursors", () => {
    const history=createComposerHistory(),text="first\nsecond";
    history.record({text});
    expect(history.navigate(-1,"draft",0)).toBeNull();
    expect(history.navigate(-1,"",0)?.text).toBe(text);
    expect(history.navigate(1,text,6)).toBeNull();
    expect(history.navigate(1,text,0,3)).toBeNull();
    expect(history.navigate(1,text+"!",text.length+1)).toBeNull();
    expect(history.navigate(1,text,text.length)?.text).toBe("");
  });
  test("restores mention metadata, collapses adjacent local duplicates and seeds resumed turns", () => {
    const history=createComposerHistory(),entry={text:"@file",mentions:[{id:"file:a",path:"a"}]};
    history.setPersistent([{text:"cli"}]);
    history.setReplay([{text:"cli"},{text:"resumed"}]);
    history.record(entry);history.record(entry);
    const recalled=history.navigate(-1,"",0);
    expect(recalled).toEqual(entry);
    recalled.mentions[0].path="mutated";
    expect(history.navigate(-1,entry.text,entry.text.length)?.text).toBe("resumed");
    expect(history.navigate(1,"resumed",7)).toEqual(entry);
    history.reset();
    expect(history.navigate(-1,"",0)).toEqual(entry);
  });
});

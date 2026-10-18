import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSkills } from "../skill-service.js";

describe("skill service", () => {
  test("lists and filters skill metadata without exposing file contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-skills-"));
    const skill = join(root, ".agents", "skills", "demo-skill");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: demo-skill\ndescription: Demo skill description\n---\n\nPrivate instructions\n");
    const globalSkill = join(root, ".codex", "skills", "mv8-build");
    await mkdir(globalSkill, { recursive: true });
    await writeFile(join(globalSkill, "SKILL.md"), "---\nname: mv8-build\ndescription: Should stay out of project skills\n---\n");
    expect(await listSkills({ cwd: root })).toEqual([{ id: "demo-skill", name: "demo-skill", title: "demo-skill", description: "Demo skill description", source: "project" }]);
    expect(await listSkills({ cwd: root, query: "missing" })).toEqual([]);
  });
});

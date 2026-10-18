import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

function frontmatterValue(source, key) {
  const block = String(source || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return "";
  const match = block[1].match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2") || "";
}

async function skillRootEntries(root, source) {
  try {
    const directory = await realpath(resolve(root));
    const entries = await readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name, "SKILL.md");
      try {
        const text = await readFile(path, "utf8");
        result.push({
          id: entry.name,
          name: entry.name,
          title: entry.name,
          description: frontmatterValue(text, "description") || `Use the ${entry.name} skill`,
          source,
        });
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

export async function listSkills({ cwd = process.cwd(), query = "", limit = 50 } = {}) {
  const roots = [
    [join(cwd, ".agents", "skills"), "project"],
    [join(cwd, "docs", "skills"), "project"],
  ];
  const all = (await Promise.all(roots.map(([root, source]) => skillRootEntries(root, source)))).flat();
  const unique = new Map(all.map(skill => [skill.id, skill]));
  const needle = String(query || "").trim().toLowerCase();
  return [...unique.values()]
    .filter(skill => !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)));
}

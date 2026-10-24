import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The skills/ folder ships next to dist/ in the npm package and in the repo. */
export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");

export interface SkillInfo {
  name: string;
  description: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function parseSkill(text: string, fallbackName: string): SkillInfo {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field = (key: string): string => {
    const line = match?.[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : "";
  };
  return { name: field("name") || fallbackName, description: field("description") };
}

export async function listSkills(): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(SKILLS_DIR);
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries.sort()) {
    if (!NAME_PATTERN.test(entry)) continue;
    try {
      skills.push(parseSkill(await fs.readFile(path.join(SKILLS_DIR, entry, "SKILL.md"), "utf8"), entry));
    } catch {
      // not a skill folder
    }
  }
  return skills;
}

export async function readSkill(name: string): Promise<string> {
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid skill name "${name}".`);
  try {
    return await fs.readFile(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
  } catch {
    throw new Error(`Unknown skill "${name}".`);
  }
}

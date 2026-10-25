export const GROUPS = [
  "project",
  "database",
  "maps",
  "tiles",
  "render",
  "plugins",
  "playtest",
  "search",
  "maintenance",
  "connect",
  "balance",
  "localization",
  "authoring",
  "generation",
  "analysis",
  "assets",
] as const;

export type Group = (typeof GROUPS)[number];

/**
 * Parses a tool profile ("all" or a comma-separated list of group names) into
 * the set of enabled tool groups. `project` is always enabled because
 * `set_project` is needed to use any other tool. Throws on an unknown group.
 */
export function parseProfile(value: string | undefined): Set<Group> {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "" || trimmed.toLowerCase() === "all") return new Set(GROUPS);

  const enabled = new Set<Group>(["project"]);
  const unknown: string[] = [];
  for (const raw of trimmed.split(",")) {
    const name = raw.trim().toLowerCase();
    if (name === "") continue;
    if ((GROUPS as readonly string[]).includes(name)) enabled.add(name as Group);
    else unknown.push(raw.trim());
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown tool group(s): ${unknown.join(", ")}. Valid groups: ${GROUPS.join(", ")} (or "all").`,
    );
  }
  return enabled;
}

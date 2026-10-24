import path from "node:path";

export interface ChangesetSummary {
  id: string;
  label: string;
  files: { path: string; change: "created" | "modified" | "restored" | "removed"; summary: string }[];
}

/** On-disk journal entry: `<root>/.mcp-backups/changesets/<id>/manifest.json`. */
export interface ChangesetManifest {
  id: string;
  label: string;
  files: { path: string; existed: boolean }[];
}

const MAX_LISTED_IDS = 10;

/** Compare two id-indexed arrays (index 0 / holes are null): added, removed and changed indices. */
function diffById(before: unknown[], after: unknown[]): { added: number; removed: number; changed: number[] } {
  let added = 0;
  let removed = 0;
  const changed: number[] = [];
  const len = Math.max(before.length, after.length);
  for (let i = 0; i < len; i++) {
    const b = before[i] ?? null;
    const a = after[i] ?? null;
    if (b === null && a === null) continue;
    if (b === null) added++;
    else if (a === null) removed++;
    else if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(i);
  }
  return { added, removed, changed };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One-line human summary of what a changeset did to a file.
 * Maps: `events +2 −0 ~1, tiles changed: 38`; 1-indexed database arrays:
 * `records +1 −0 ~3 (ids 4, 7, 9)`; anything else `created` / `changed`.
 */
export function summarizeChange(relPath: string, before: unknown | null, after: unknown): string {
  if (before === null || before === undefined) return "created";
  const base = path.basename(relPath.replace(/\\/g, "/"));

  if (/^Map\d+\.json$/i.test(base) && isRecord(before) && isRecord(after)) {
    const ev = diffById(
      Array.isArray(before.events) ? before.events : [],
      Array.isArray(after.events) ? after.events : []
    );
    const bData = Array.isArray(before.data) ? before.data : [];
    const aData = Array.isArray(after.data) ? after.data : [];
    let tiles = 0;
    for (let i = 0; i < Math.max(bData.length, aData.length); i++) {
      if (bData[i] !== aData[i]) tiles++;
    }
    return `events +${ev.added} −${ev.removed} ~${ev.changed.length}, tiles changed: ${tiles}`;
  }

  if (Array.isArray(before) && Array.isArray(after) && before[0] === null && (after.length === 0 || after[0] === null)) {
    const d = diffById(before, after);
    let text = `records +${d.added} −${d.removed} ~${d.changed.length}`;
    if (d.changed.length > 0) {
      const ids = d.changed.slice(0, MAX_LISTED_IDS).join(", ");
      text += ` (ids ${ids}${d.changed.length > MAX_LISTED_IDS ? ", …" : ""})`;
    }
    return text;
  }

  return "changed";
}

// Field-path access and bulk change operations on database records.
import { PARAM_NAMES } from "./curves.js";

export class BulkError extends Error {}

type Path = (string | number)[];

/** "params.atk", "params[2]", "damage.formula", "traits[0].value" -> path segments. */
export function parsePath(field: string): Path {
  const segments: Path = [];
  for (const part of field.split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) throw new BulkError(`Invalid field path "${field}".`);
    if (m[1]) segments.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) segments.push(Number(idx[1]));
  }
  if (!segments.length) throw new BulkError("Empty field path.");
  if (segments.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
    throw new BulkError(`Field path "${field}" is not allowed.`);
  }
  if (segments[0] === "params" && typeof segments[1] === "string") {
    const i = PARAM_NAMES.indexOf(segments[1].toLowerCase() as (typeof PARAM_NAMES)[number]);
    if (i >= 0) segments[1] = i;
  }
  return segments;
}

function parent(obj: unknown, path: Path): { holder: Record<string | number, unknown> | null; key: string | number } {
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return { holder: null, key: path[path.length - 1] };
    cur = (cur as Record<string | number, unknown>)[path[i]];
  }
  if (cur == null || typeof cur !== "object") return { holder: null, key: path[path.length - 1] };
  return { holder: cur as Record<string | number, unknown>, key: path[path.length - 1] };
}

export function getField(record: unknown, field: string): unknown {
  const { holder, key } = parent(record, parsePath(field));
  return holder ? holder[key] : undefined;
}

export type CompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "matches" | "exists";

export interface Condition {
  field: string;
  op: CompareOp;
  value?: unknown;
}

export function matches(record: unknown, cond: Condition): boolean {
  const actual = getField(record, cond.field);
  const expected = cond.value;
  switch (cond.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "eq":
      return actual === expected || (typeof actual === "number" && Number(expected) === actual);
    case "ne":
      return !matches(record, { ...cond, op: "eq" });
    case "gt":
      return typeof actual === "number" && actual > Number(expected);
    case "gte":
      return typeof actual === "number" && actual >= Number(expected);
    case "lt":
      return typeof actual === "number" && actual < Number(expected);
    case "lte":
      return typeof actual === "number" && actual <= Number(expected);
    case "contains":
      return typeof actual === "string" && actual.toLowerCase().includes(String(expected).toLowerCase());
    case "matches":
      try {
        return typeof actual === "string" && new RegExp(String(expected), "i").test(actual);
      } catch {
        throw new BulkError(`Invalid regular expression "${String(expected)}".`);
      }
  }
}

export type ChangeOp = "set" | "add" | "multiply" | "percent";
export type RoundMode = "auto" | "none" | "round" | "floor" | "ceil";

export interface Change {
  field: string;
  op: ChangeOp;
  value: unknown;
  round?: RoundMode;
  min?: number;
  max?: number;
}

export interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

function numeric(change: Change): number {
  if (typeof change.value !== "number" || !Number.isFinite(change.value)) {
    throw new BulkError(`Change "${change.op}" on "${change.field}" needs a numeric value.`);
  }
  return change.value;
}

/** Apply changes to `record` in place and return the fields that actually changed. */
export function applyChanges(record: unknown, changes: Change[]): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const change of changes) {
    const { holder, key } = parent(record, parsePath(change.field));
    if (!holder) throw new BulkError(`Field "${change.field}" does not exist on this record.`);
    const before = holder[key];
    let after: unknown;
    if (change.op === "set") {
      if (change.value === undefined) throw new BulkError(`Change "set" on "${change.field}" needs a value.`);
      after = change.value;
    } else {
      if (typeof before !== "number") {
        throw new BulkError(`Field "${change.field}" is not a number (it is ${before === undefined ? "missing" : typeof before}); use op "set".`);
      }
      const n = numeric(change);
      let result = change.op === "add" ? before + n : change.op === "multiply" ? before * n : before * (1 + n / 100);
      const mode = change.round ?? "auto";
      if (mode === "round" || (mode === "auto" && Number.isInteger(before))) result = Math.round(result);
      else if (mode === "floor") result = Math.floor(result);
      else if (mode === "ceil") result = Math.ceil(result);
      else result = Math.round(result * 1e6) / 1e6;
      if (change.min !== undefined) result = Math.max(change.min, result);
      if (change.max !== undefined) result = Math.min(change.max, result);
      after = result;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      holder[key] = after;
      diffs.push({ field: change.field, before, after });
    }
  }
  return diffs;
}

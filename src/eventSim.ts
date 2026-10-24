// Pure interpreter for a subset of RPG Maker MV event commands. It never touches the project:
// callers supply the command list, a starting state and a common-event lookup, and get a trace back.
import type { Cmd } from "./commandList.js";
import { mulberry32 } from "./battle.js";

export interface SimState {
  switches: Record<number, boolean>;
  variables: Record<number, number>;
  /** Self switches of the simulated event, keyed by letter ("A" to "D"). */
  selfSwitches: Record<string, boolean>;
  gold: number;
  items: Record<number, number>;
}

export interface SimOptions {
  /** Answers for Show Choices, consumed in order; a missing answer is 0. */
  choices?: number[];
  /** Seed for the random operand of Control Variables (default 0). */
  seed?: number;
  /** What an unsupported condition does: take the then branch, take the else branch, or stop. */
  unknownCondition: "then" | "else" | "stop";
  commonEvents: (id: number) => Cmd[] | null;
  /** Identify the simulated event; the interpreter itself does not need them. */
  mapId: number;
  eventId: number;
}

export interface SimTrace {
  messages: string[];
  changes: string[];
  transfers: { mapId: number; x: number; y: number }[];
  /** Commands that were not simulated. index is the position in the list that holds the command (a common event's own list for calls made inside one). */
  unsupported: { index: number; code: number; message: string }[];
  ended: "end" | "exit" | "transfer" | "stepLimit" | "unsupported";
  finalState: SimState;
  /** Entries dropped from messages, changes and unsupported once each reached MAX_TRACE_ENTRIES; only present when something was dropped. finalState stays exact. */
  omitted?: { changes: number; messages: number; unsupported: number };
}

export const MAX_STEPS = 10000;
export const MAX_COMMON_EVENT_DEPTH = 8;
/** Longest messages, changes and unsupported list in a trace. */
export const MAX_TRACE_ENTRIES = 2000;
/** Longest switch/variable range one command may touch. */
const MAX_RANGE = 1000;
const MAX_ITEMS = 99;
const SELF_SWITCHES = ["A", "B", "C", "D"];
/** Code of the stand-in for an entry that is not a usable command. */
const MALFORMED = -1;

type Signal = "exit" | "transfer" | "stepLimit" | "unsupported" | undefined;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Valid entries pass through; anything else becomes an inert placeholder at the previous indent (original code kept in parameters[0]). */
function normalize(raw: unknown): Cmd[] {
  if (!Array.isArray(raw)) return [];
  const out: Cmd[] = [];
  raw.forEach((entry, i) => {
    const e = entry as Partial<Cmd> | null;
    if (typeof e === "object" && e !== null && typeof e.code === "number" && typeof e.indent === "number" && Array.isArray(e.parameters)) {
      out.push(e as Cmd);
    } else {
      const code = typeof e === "object" && e !== null && typeof e.code === "number" ? e.code : MALFORMED;
      out.push({ code: MALFORMED, indent: i > 0 ? out[i - 1].indent : 0, parameters: [code] });
    }
  });
  return out;
}

/** Index of the first command after `from` at `indent` whose code is in `codes`, or -1. */
function findForward(cmds: Cmd[], from: number, indent: number, codes: number[]): number {
  for (let j = from + 1; j < cmds.length; j++) {
    if (cmds[j].indent === indent && codes.includes(cmds[j].code)) return j;
  }
  return -1;
}

/** Index of the Repeat Above (413) that closes the loop the command at `from` sits in, or -1. */
function findLoopEnd(cmds: Cmd[], from: number): number {
  let nested = 0;
  for (let j = from + 1; j < cmds.length; j++) {
    if (cmds[j].code === 112) nested++;
    else if (cmds[j].code === 413) {
      if (nested === 0) return j;
      nested--;
    }
  }
  return -1;
}

function compare(op: unknown, a: number, b: number): boolean | undefined {
  switch (op) {
    case 0: return a === b;
    case 1: return a >= b;
    case 2: return a <= b;
    case 3: return a > b;
    case 4: return a < b;
    case 5: return a !== b;
    default: return undefined;
  }
}

/** Evaluates a Conditional Branch; a string is the reason the condition cannot be evaluated. */
function evalCondition(p: unknown[], s: SimState): boolean | string {
  const type = p[0];
  switch (type) {
    case 0: {
      if (!isInt(p[1]) || (p[2] !== 0 && p[2] !== 1)) break;
      return (s.switches[p[1]] === true) === (p[2] === 0);
    }
    case 1: {
      if (!isInt(p[1]) || (p[2] !== 0 && p[2] !== 1) || !isInt(p[3])) break;
      const rhs = p[2] === 0 ? p[3] : s.variables[p[3]] ?? 0;
      const r = compare(p[4], s.variables[p[1]] ?? 0, rhs);
      if (r === undefined) break;
      return r;
    }
    case 2: {
      if (typeof p[1] !== "string" || !SELF_SWITCHES.includes(p[1]) || (p[2] !== 0 && p[2] !== 1)) break;
      return (s.selfSwitches[p[1]] === true) === (p[2] === 0);
    }
    case 7: {
      if (!isInt(p[1])) break;
      if (p[2] === 0) return s.gold >= p[1];
      if (p[2] === 1) return s.gold <= p[1];
      if (p[2] === 2) return s.gold < p[1];
      break;
    }
    case 8: {
      if (!isInt(p[1])) break;
      return (s.items[p[1]] ?? 0) > 0;
    }
    default:
      return `condition type ${String(type)} is not simulated`;
  }
  return "condition has malformed parameters";
}

export function simulateEvent(list: Cmd[], state: SimState, opts: SimOptions): SimTrace {
  const s: SimState = {
    switches: { ...state.switches },
    variables: { ...state.variables },
    selfSwitches: { ...state.selfSwitches },
    gold: state.gold,
    items: { ...state.items },
  };
  const trace: SimTrace = { messages: [], changes: [], transfers: [], unsupported: [], ended: "end", finalState: s };
  const rng = mulberry32(opts.seed ?? 0);
  const answers = opts.choices ?? [];
  let nextAnswer = 0;
  let steps = 0;

  const omitted = { changes: 0, messages: 0, unsupported: 0 };
  const emit = <T>(key: keyof typeof omitted, list: T[], entry: T): void => {
    if (list.length < MAX_TRACE_ENTRIES) list.push(entry);
    else omitted[key]++;
  };
  const change = (text: string): void => emit("changes", trace.changes, text);
  const note = (index: number, code: number, message: string): void => {
    emit("unsupported", trace.unsupported, { index, code, message });
  };

  /** Reads `p[i]` as a variable id (type 1) or the value itself (type 0). */
  const operand = (type: unknown, v: unknown): number | undefined => {
    if (type === 0) return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    if (type === 1) return isInt(v) ? s.variables[v] ?? 0 : undefined;
    return undefined;
  };

  const range = (a: unknown, b: unknown): number[] | undefined => {
    if (!isInt(a) || !isInt(b) || a < 1 || b < a || b - a + 1 > MAX_RANGE) return undefined;
    return Array.from({ length: b - a + 1 }, (_, k) => a + k);
  };

  function controlVariables(p: unknown[], index: number): void {
    const ids = range(p[0], p[1]);
    const op = p[2];
    const type = p[3];
    if (!ids || !isInt(op) || op < 0 || op > 5) return note(index, 122, "malformed Control Variables parameters");
    if (type === 3 || type === 4) return note(index, 122, `Control Variables operand type ${type} (${type === 3 ? "game data" : "script"}) is not simulated`);
    if (type === 2 && (!isInt(p[4]) || !isInt(p[5]))) return note(index, 122, "malformed Control Variables random range");
    if ((type === 0 || type === 1) && operand(type, p[4]) === undefined) return note(index, 122, "malformed Control Variables operand");
    if (type !== 0 && type !== 1 && type !== 2) return note(index, 122, "malformed Control Variables operand type");
    // The operand is evaluated once for the whole range, as the engine does.
    let value: number;
    if (type === 2) {
      const lo = Math.min(p[4] as number, p[5] as number);
      const hi = Math.max(p[4] as number, p[5] as number);
      value = lo + Math.floor(rng() * (hi - lo + 1));
    } else {
      value = operand(type, p[4])!;
    }
    const label = ids.length === 1 ? `variable ${ids[0]}` : `variables ${ids[0]}..${ids[ids.length - 1]}`;
    if ((op === 4 || op === 5) && value === 0) {
      change(`${label} unchanged (${op === 4 ? "division" : "modulo"} by zero)`);
      return;
    }
    for (const id of ids) {
      const old = s.variables[id] ?? 0;
      let next: number;
      switch (op) {
        case 0: next = value; break;
        case 1: next = old + value; break;
        case 2: next = old - value; break;
        case 3: next = old * value; break;
        case 4: next = old / value; break;
        default: next = old % value;
      }
      s.variables[id] = Math.floor(next); // the engine's Game_Variables.setValue floors numbers
      if (ids.length === 1) change(`variable ${id} → ${s.variables[id]}`);
    }
    if (ids.length > 1) change(`${label} ${["=", "+=", "-=", "*=", "/=", "%="][op]} ${value}`);
  }

  function run(rawList: unknown, depth: number): Signal {
    const cmds = normalize(rawList);
    let i = 0;
    while (i < cmds.length) {
      if (++steps > MAX_STEPS) return "stepLimit";
      const c = cmds[i];
      const p = c.parameters;
      const index = i;
      i++;
      switch (c.code) {
        case 0: // terminator or end of a branch body
        case 101: case 108: case 408: case 112: case 118: case 404: case 412:
        case 655:
          break;
        case MALFORMED:
          note(index, isInt(p[0]) ? p[0] : MALFORMED, "malformed command (not an object with numeric code and indent and an array of parameters)");
          break;
        case 401:
          if (typeof p[0] === "string") emit("messages", trace.messages, p[0]);
          else note(index, 401, "malformed message text");
          break;
        case 102: {
          const end = findForward(cmds, index, c.indent, [404]);
          const stop = end === -1 ? cmds.length : end;
          if (!Array.isArray(p[0])) {
            note(index, 102, "malformed Show Choices parameters");
            if (end !== -1) i = end;
            break;
          }
          const answer = answers[nextAnswer++] ?? 0;
          let target = -1;
          for (let j = index + 1; j < stop; j++) {
            if (cmds[j].indent !== c.indent) continue;
            if (answer >= 0 && answer < p[0].length && cmds[j].code === 402 && cmds[j].parameters[0] === answer) { target = j; break; }
            if ((answer < 0 || answer >= p[0].length) && cmds[j].code === 403) { target = j; break; }
          }
          i = target === -1 ? stop : target + 1;
          break;
        }
        case 402: case 403: {
          const end = findForward(cmds, index, c.indent, [404]);
          i = end === -1 ? cmds.length : end;
          break;
        }
        case 111: {
          let result = evalCondition(p, s);
          if (typeof result === "string") {
            note(index, 111, result);
            if (opts.unknownCondition === "stop") return "unsupported";
            result = opts.unknownCondition === "then";
          }
          if (!result) {
            const j = findForward(cmds, index, c.indent, [411, 412]);
            i = j === -1 ? cmds.length : cmds[j].code === 411 ? j + 1 : j;
          }
          break;
        }
        case 411: {
          const j = findForward(cmds, index, c.indent, [412]);
          i = j === -1 ? cmds.length : j;
          break;
        }
        case 413: {
          for (let j = index - 1; j >= 0; j--) {
            if (cmds[j].indent === c.indent && cmds[j].code === 112) { i = j + 1; break; }
          }
          break;
        }
        case 113: {
          const j = findLoopEnd(cmds, index);
          i = j === -1 ? cmds.length : j + 1;
          break;
        }
        case 115:
          return "exit";
        case 117: {
          const id = p[0];
          if (!isInt(id)) { note(index, 117, "malformed Common Event parameters"); break; }
          if (depth + 1 > MAX_COMMON_EVENT_DEPTH) {
            note(index, 117, `Common Event ${id} not run: nesting is deeper than ${MAX_COMMON_EVENT_DEPTH} (depth limit)`);
            break;
          }
          const sub = opts.commonEvents(id);
          if (!sub) { note(index, 117, `Common Event ${id} does not exist`); break; }
          const signal = run(sub, depth + 1);
          if (signal && signal !== "exit") return signal; // Exit Event Processing only ends the common event
          break;
        }
        case 121: {
          const ids = range(p[0], p[1]);
          if (!ids || (p[2] !== 0 && p[2] !== 1)) { note(index, 121, "malformed Control Switches parameters"); break; }
          for (const id of ids) s.switches[id] = p[2] === 0;
          const on = p[2] === 0 ? "ON" : "OFF";
          change(ids.length === 1 ? `switch ${ids[0]} → ${on}` : `switches ${ids[0]}..${ids[ids.length - 1]} → ${on}`);
          break;
        }
        case 122:
          controlVariables(p, index);
          break;
        case 123: {
          if (typeof p[0] !== "string" || !SELF_SWITCHES.includes(p[0]) || (p[1] !== 0 && p[1] !== 1)) {
            note(index, 123, "malformed Control Self Switch parameters");
            break;
          }
          s.selfSwitches[p[0]] = p[1] === 0;
          change(`self switch ${p[0]} → ${p[1] === 0 ? "ON" : "OFF"}`);
          break;
        }
        case 125: {
          const amount = p[0] === 0 || p[0] === 1 ? operand(p[1], p[2]) : undefined;
          if (amount === undefined) { note(index, 125, "malformed Change Gold parameters"); break; }
          s.gold = Math.max(0, s.gold + (p[0] === 0 ? amount : -amount));
          change(`gold ${p[0] === 0 ? "+" : "-"}${amount} → ${s.gold}`);
          break;
        }
        case 126: {
          const amount = isInt(p[0]) && p[0] >= 1 && (p[1] === 0 || p[1] === 1) ? operand(p[2], p[3]) : undefined;
          if (amount === undefined || !isInt(p[0])) { note(index, 126, "malformed Change Items parameters (the item id must be an integer of at least 1)"); break; }
          const count = Math.min(MAX_ITEMS, Math.max(0, (s.items[p[0]] ?? 0) + (p[1] === 0 ? amount : -amount)));
          s.items[p[0]] = count;
          change(`item ${p[0]} ${p[1] === 0 ? "+" : "-"}${amount} → ${count}`);
          break;
        }
        case 201: {
          const [designation, a, x, y] = p;
          let target: { mapId: number; x: number; y: number } | undefined;
          if (designation === 0 && isInt(a) && isInt(x) && isInt(y)) target = { mapId: a, x, y };
          else if (designation === 1 && isInt(a) && isInt(x) && isInt(y)) target = { mapId: s.variables[a] ?? 0, x: s.variables[x] ?? 0, y: s.variables[y] ?? 0 };
          if (!target) { note(index, 201, "malformed Transfer Player parameters"); break; }
          trace.transfers.push(target);
          return "transfer";
        }
        case 356:
          if (typeof p[0] === "string") change(`plugin: ${p[0]}`);
          else note(index, 356, "malformed Plugin Command parameters");
          break;
        case 355:
          note(index, 355, "script commands are not executed");
          break;
        default:
          note(index, c.code, "command is not simulated");
      }
    }
    return undefined;
  }

  const signal = run(list, 0);
  trace.ended = signal ?? "end";
  if (omitted.changes + omitted.messages + omitted.unsupported > 0) trace.omitted = omitted;
  return trace;
}

/** True when the event page's conditions hold under `state` (the actor condition counts as met). */
export function pageConditionsHold(conditions: unknown, state: SimState): boolean {
  if (typeof conditions !== "object" || conditions === null) return true;
  const c = conditions as Record<string, unknown>;
  if (c.switch1Valid === true && state.switches[c.switch1Id as number] !== true) return false;
  if (c.switch2Valid === true && state.switches[c.switch2Id as number] !== true) return false;
  if (c.variableValid === true) {
    const need = typeof c.variableValue === "number" ? c.variableValue : 0;
    if ((state.variables[c.variableId as number] ?? 0) < need) return false;
  }
  if (c.selfSwitchValid === true && state.selfSwitches[c.selfSwitchCh as string] !== true) return false;
  if (c.itemValid === true && (state.items[c.itemId as number] ?? 0) <= 0) return false;
  return true;
}

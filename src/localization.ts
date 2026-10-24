// Collects every translatable text of an RPG Maker MV project as addressable items and writes
// translations back. Pure of MCP concerns; used by export_texts / import_texts.
import { DatabaseType, Project } from "./project.js";

export const SCOPES = ["database", "system", "maps", "commonEvents", "troops"] as const;
export type Scope = (typeof SCOPES)[number];

export interface TextItem {
  key: string;
  context: string;
  category: Scope;
  original: string;
  /** Items in the same command list must be applied from the highest index down. */
  listId?: string;
  index?: number;
  apply(text: string): void;
}

export interface Collected {
  items: TextItem[];
  /** Files that apply() touched; pass to write(). */
  dirty: Set<string>;
  write(): Promise<void>;
}

interface Command {
  code: number;
  indent: number;
  parameters: unknown[];
}

type Rec = Record<string, any>;

const DB_FIELDS: Partial<Record<DatabaseType, { label: string; singular: string; fields: string[] }>> = {
  actors: { label: "Actors", singular: "Actor", fields: ["name", "nickname", "profile"] },
  classes: { label: "Classes", singular: "Class", fields: ["name"] },
  skills: { label: "Skills", singular: "Skill", fields: ["name", "description", "message1", "message2"] },
  items: { label: "Items", singular: "Item", fields: ["name", "description"] },
  weapons: { label: "Weapons", singular: "Weapon", fields: ["name", "description"] },
  armors: { label: "Armors", singular: "Armor", fields: ["name", "description"] },
  enemies: { label: "Enemies", singular: "Enemy", fields: ["name"] },
  states: { label: "States", singular: "State", fields: ["name", "message1", "message2", "message3", "message4"] },
};

const SYSTEM_STRING_KEYS = ["gameTitle", "currencyUnit"];
const SYSTEM_ARRAY_KEYS = ["elements", "skillTypes", "weaponTypes", "armorTypes", "equipTypes"];
const MAX_LINES_PER_BOX = 4;

const pad = (n: number): string => String(n).padStart(3, "0");

/** The control codes (\C[2], \N[1], \G, \{ ...) in a text, sorted, for comparing original and translation. */
export function controlCodes(text: string): string[] {
  return (text.match(/\\(?:[A-Za-z]+\[\d+\]|[A-Za-z]+|[$.|!><^{}\\])/g) ?? []).sort();
}

export async function collectTexts(project: Project, scopes: readonly Scope[]): Promise<Collected> {
  const items: TextItem[] = [];
  const dirty = new Set<string>();
  const writers = new Map<string, () => Promise<void>>();
  const want = (s: Scope): boolean => scopes.includes(s);

  const addField = (source: string, category: Scope, key: string, context: string, holder: Rec, field: string | number): void => {
    const value = holder[field];
    if (typeof value !== "string" || value === "") return;
    items.push({
      key, context, category, original: value,
      apply: (text) => { holder[field] = text; dirty.add(source); },
    });
  };

  // ---- database
  if (want("database")) {
    for (const [type, spec] of Object.entries(DB_FIELDS) as [DatabaseType, NonNullable<(typeof DB_FIELDS)[DatabaseType]>][]) {
      const records = (await project.readDatabase(type)) as (Rec | null)[];
      const source = `db:${type}`;
      writers.set(source, () => project.writeDatabase(type, records));
      for (const rec of records) {
        if (!rec) continue;
        for (const field of spec.fields) {
          addField(source, "database", `${spec.label}/${rec.id}/${field}`,
            `${spec.singular} ${rec.id}${field === "name" ? "" : ` "${rec.name ?? ""}"`} · ${field}`, rec, field);
        }
      }
    }
  }

  // ---- system
  if (want("system")) {
    const file = project.dataFile("System.json");
    const system = await project.readJson<Rec>(file);
    writers.set("system", () => project.writeJson(file, system));
    for (const key of SYSTEM_STRING_KEYS) addField("system", "system", `System/${key}`, `System · ${key}`, system, key);
    for (const key of SYSTEM_ARRAY_KEYS) {
      (system[key] as unknown[] | undefined)?.forEach((_, i) =>
        addField("system", "system", `System/${key}/${i}`, `System · ${key} ${i}`, system[key], i));
    }
    const terms = system.terms as Rec | undefined;
    for (const group of ["basic", "commands", "params"]) {
      (terms?.[group] as unknown[] | undefined)?.forEach((_, i) =>
        addField("system", "system", `System/terms/${group}/${i}`, `System · terms ${group} ${i}`, terms![group], i));
    }
    for (const k of Object.keys(terms?.messages ?? {})) {
      addField("system", "system", `System/terms/messages/${k}`, `System · message ${k}`, terms!.messages, k);
    }
  }

  // ---- event command lists (maps, common events, troop pages)
  const walkList = (list: Command[], source: string, category: Scope, prefix: string, where: string): void => {
    for (let i = 0; i < list.length; i++) {
      const cmd = list[i];
      const base = { category, listId: prefix, index: i };
      if (cmd.code === 101 || cmd.code === 105) {
        const textCode = cmd.code === 101 ? 401 : 405;
        let n = 0;
        while (list[i + 1 + n]?.code === textCode) n++;
        const lines = list.slice(i + 1, i + 1 + n).map((c) => String(c.parameters[0] ?? ""));
        const original = lines.join("\n");
        if (original !== "") {
          const start = i;
          items.push({
            ...base, key: `${prefix}/${i}`,
            context: `${where} · ${cmd.code === 101 ? "dialogue" : "scrolling text"}${cmd.code === 101 && cmd.parameters[0] ? ` (face ${cmd.parameters[0]})` : ""}`,
            original,
            apply: (text) => {
              const out = text.split(/\r?\n/);
              const replacement: Command[] = [];
              if (cmd.code === 101) {
                for (let c = 0; c < out.length; c += MAX_LINES_PER_BOX) {
                  replacement.push({ code: 101, indent: cmd.indent, parameters: structuredClone(cmd.parameters) });
                  for (const line of out.slice(c, c + MAX_LINES_PER_BOX)) replacement.push({ code: 401, indent: cmd.indent, parameters: [line] });
                }
              } else {
                replacement.push({ code: 105, indent: cmd.indent, parameters: structuredClone(cmd.parameters) });
                for (const line of out) replacement.push({ code: 405, indent: cmd.indent, parameters: [line] });
              }
              list.splice(start, 1 + n, ...replacement);
              dirty.add(source);
            },
          });
        }
        i += n;
      } else if (cmd.code === 102 && Array.isArray(cmd.parameters[0])) {
        const choices = cmd.parameters[0] as string[];
        choices.forEach((choice, c) => {
          if (typeof choice !== "string" || choice === "") return;
          items.push({
            ...base, key: `${prefix}/${i}/c${c}`, context: `${where} · choice ${c + 1}`, original: choice,
            apply: (text) => {
              choices[c] = text;
              // keep the editor's branch labels (402) in sync
              for (let j = list.indexOf(cmd) + 1; j < list.length; j++) {
                const o = list[j];
                if (o.indent === cmd.indent && o.code === 404) break;
                if (o.indent === cmd.indent && o.code === 402 && o.parameters[0] === c) o.parameters[1] = text;
              }
              dirty.add(source);
            },
          });
        });
      } else if ((cmd.code === 320 || cmd.code === 324 || cmd.code === 325) && typeof cmd.parameters[1] === "string" && cmd.parameters[1] !== "") {
        const what = cmd.code === 320 ? "name" : cmd.code === 324 ? "nickname" : "profile";
        items.push({
          ...base, key: `${prefix}/${i}`, context: `${where} · change actor ${cmd.parameters[0]} ${what}`,
          original: cmd.parameters[1] as string,
          apply: (text) => { cmd.parameters[1] = text; dirty.add(source); },
        });
      }
    }
  };

  // ---- maps
  if (want("maps")) {
    const infos = await project.readJson<(Rec | null)[]>(project.dataFile("MapInfos.json"));
    for (const info of infos) {
      if (!info) continue;
      const file = project.mapFile(info.id);
      let map: Rec;
      try {
        map = await project.readJson<Rec>(file);
      } catch {
        continue;
      }
      const source = `map:${info.id}`;
      writers.set(source, () => project.writeJson(file, map));
      const label = `Map ${info.id} "${info.name}"`;
      addField(source, "maps", `Map${pad(info.id)}/displayName`, `${label} · display name`, map, "displayName");
      for (const ev of (map.events ?? []) as (Rec | null)[]) {
        if (!ev) continue;
        (ev.pages as Rec[] | undefined)?.forEach((page, p) => {
          if (Array.isArray(page.list)) {
            walkList(page.list, source, "maps", `Map${pad(info.id)}/ev${ev.id}/p${p}`, `${label} · event ${ev.id} "${ev.name}" · page ${p + 1}`);
          }
        });
      }
    }
  }

  if (want("commonEvents")) {
    const events = (await project.readDatabase("commonEvents")) as (Rec | null)[];
    writers.set("commonEvents", () => project.writeDatabase("commonEvents", events));
    for (const ev of events) {
      if (ev && Array.isArray(ev.list)) walkList(ev.list, "commonEvents", "commonEvents", `CommonEvents/${ev.id}`, `Common event ${ev.id} "${ev.name}"`);
    }
  }

  if (want("troops")) {
    const troops = (await project.readDatabase("troops")) as (Rec | null)[];
    writers.set("troops", () => project.writeDatabase("troops", troops));
    for (const troop of troops) {
      (troop?.pages as Rec[] | undefined)?.forEach((page, p) => {
        if (Array.isArray(page.list)) walkList(page.list, "troops", "troops", `Troops/${troop!.id}/p${p}`, `Troop ${troop!.id} "${troop!.name}" · battle page ${p + 1}`);
      });
    }
  }

  return {
    items,
    dirty,
    write: async () => {
      for (const source of dirty) await writers.get(source)!();
    },
  };
}

/** Apply translations (by key) to collected items. List items go from the highest index down. */
export function applyTranslations(items: TextItem[], translations: Map<string, string>): number {
  const todo = items.filter((it) => translations.has(it.key));
  const lists = new Map<string, TextItem[]>();
  let applied = 0;
  for (const item of todo) {
    if (item.listId) {
      (lists.get(item.listId) ?? lists.set(item.listId, []).get(item.listId)!).push(item);
    } else {
      item.apply(translations.get(item.key)!);
      applied++;
    }
  }
  for (const group of lists.values()) {
    group.sort((a, b) => b.index! - a.index!);
    for (const item of group) {
      item.apply(translations.get(item.key)!);
      applied++;
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function toCsv(rows: string[][]): string {
  const cell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

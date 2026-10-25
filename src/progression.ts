// analyze_progression core: a bounded monotone fixpoint over the project index (src/eventIndex.ts). Pure, no I/O.
//
// Model (an over-approximation of a real playthrough): a page may run whenever its page conditions COULD hold, and
// when it runs ALL of its commands take effect (conditions inside the list — 111 branches, choices — are ignored,
// and nothing is ever undone: OFF switches, lost items and removed actors are not tracked). Facts only ever become
// true, so a claim "this map can never be reached" / "this page can never run" is sound under the model. Scripts,
// plugin commands, enabled plugins and variable-designated transfers or battles are outside the model; they only
// lower `confidence`. A page's autonomous move route (moveType 3) counts as part of the page.
//
// The fixpoint is event-driven: each page waits on the facts its conditions need and runs once when they all hold,
// so the work is linear in pages + commands. Facts are strings:
//   m<map>  s<switch>  v<variable>  g<kind>:<id>  a<actor>  f<map>:<event>:<ch>  c<commonEvent>  t<troop>
//   x<commonEvent>:<map>:<event>  (the common event runs as a call from that map event, see "Common events" below)
//
// Common events: a 117 call runs the common event with the CALLER's event id (Game_Interpreter.command117), so a
// 123 inside it switches the calling map event's self switch; autorun/parallel, item/skill and battle calls have no
// event and their 123 does nothing. Item effects (code 44) call their common event once the item is obtainable;
// skill effects always may (any actor might learn the skill).
import type { Cmd } from "./commandList.js";
import { commandRefs, routeCommands, type EventPage, type ProjectIndex } from "./eventIndex.js";

export type Goal = { switch: number } | { mapId: number } | { event: { mapId: number; eventId: number } };

export interface DeadPage {
  kind: "map" | "commonEvent" | "troop";
  mapId?: number;
  eventId: number;
  /** 0-based page index, like the index (texts say "page N" 1-based, like the editor). */
  page: number;
  reason: string;
}

export interface ProgressionReport {
  startMapId: number;
  reachableMaps: number[];
  unreachableMaps: number[];
  deadEndMaps: number[];
  deadPages: DeadPage[];
  switches: { neverSet: number[]; neverRead: number[] };
  variables: { neverSet: number[]; neverRead: number[] };
  goal?: { target: string; reachable: boolean; blockedBy: string[] };
  uncertainty: {
    scriptCommands: number;
    pluginCommands: number;
    variableTransfers: number;
    variableBattles: number;
    confidence: "high" | "low";
  };
  edges: { from: number; to: number }[];
  notes: string[];
  truncated: boolean;
}

/** Most fixpoint rounds (one round = every fact found in the previous round has been propagated). */
const MAX_ROUNDS = 10_000;
/** Most common-event call contexts (common event x calling map event) tracked; see analyzeProgression. */
export const MAX_CONTEXTS = 100_000;
/** Most `goal.blockedBy` entries. */
const MAX_BLOCKERS = 10;

const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31 - 1;

const fact = {
  map: (id: unknown) => `m${String(id)}`,
  switch: (id: unknown) => `s${String(id)}`,
  variable: (id: unknown) => `v${String(id)}`,
  goods: (kind: string, id: unknown) => `g${kind}:${String(id)}`,
  actor: (id: unknown) => `a${String(id)}`,
  self: (mapId: number, eventId: number, ch: string) => `f${mapId}:${eventId}:${ch}`,
  called: (id: number) => `c${id}`,
  troop: (id: number) => `t${id}`,
  context: (ce: number, mapId: number, eventId: number) => `x${ce}:${mapId}:${eventId}`,
};

/** A fact a page needs, with the plain-English reason used when it never becomes true. */
interface Req {
  fact: string;
  why: string;
}

interface Plan {
  page: EventPage;
  /** The page can run once every requirement of ANY alternative holds. */
  alts: Req[][];
  /** Facts the page makes true whoever runs it. */
  effects: string[];
  /** Direct 201 targets. */
  transfers: number[];
  /** 117 targets and 123-ON channels: they act for the calling map event (map pages: for the page's own event). */
  calls: number[];
  selfOn: string[];
  /** Any 201, direct or variable-designated. */
  anyTransfer: boolean;
  /** No command besides the list terminator. */
  empty: boolean;
}

const pad3 = (n: number): string => String(n).padStart(3, "0");

function pageLabel(p: EventPage): string {
  if (p.kind === "map") return `Map${pad3(p.mapId ?? 0)} event ${p.eventId} page ${p.page + 1}`;
  if (p.kind === "commonEvent") return `CommonEvent ${p.eventId}`;
  return `Troop ${p.eventId} page ${p.page + 1}`;
}

const switchWhy = (id: unknown): string => `switch ${String(id)} is never switched ON by any reachable event`;

/** Requirements of a page, in the order the engine checks them (Game_Event.meetsConditions). */
function requirements(p: EventPage): Req[][] {
  const c = p.conditions;
  if (p.kind === "commonEvent") {
    const alts: Req[][] = [[{ fact: fact.called(p.eventId), why: `common event ${p.eventId} is never called by a reachable event` }]];
    if (p.trigger === 1 || p.trigger === 2) {
      // Autorun/parallel: runs while its switch is ON; without a valid switch it is treated as always running.
      alts.push(
        c?.switch1Valid === true
          ? [{ fact: fact.switch(c.switch1Id), why: `its trigger switch ${String(c.switch1Id)} is never switched ON by any reachable event` }]
          : [],
      );
    }
    return alts;
  }
  if (p.kind === "troop") {
    const reqs: Req[] = [
      {
        fact: fact.troop(p.eventId),
        why: `troop ${p.eventId} is never fought: no reachable map encounters it and no reachable event starts a battle with it`,
      },
    ];
    // The troop actor condition only tests the actor's HP (Game_Troop.meetsConditions), not party membership: ignored.
    if (c?.switch1Valid === true) reqs.push({ fact: fact.switch(c.switch1Id), why: switchWhy(c.switch1Id) });
    return [reqs];
  }
  const mapId = p.mapId ?? 0;
  const reqs: Req[] = [{ fact: fact.map(mapId), why: `map ${mapId} is unreachable` }];
  if (c !== undefined) {
    if (c.switch1Valid === true) reqs.push({ fact: fact.switch(c.switch1Id), why: switchWhy(c.switch1Id) });
    if (c.switch2Valid === true) reqs.push({ fact: fact.switch(c.switch2Id), why: switchWhy(c.switch2Id) });
    if (c.variableValid === true) {
      // "variable >= value"; every variable starts at 0. A non-numeric value is treated as 0 (over-approximation).
      const value = typeof c.variableValue === "number" ? c.variableValue : 0;
      if (!(0 >= value)) {
        reqs.push({
          fact: fact.variable(c.variableId),
          why: `variable ${String(c.variableId)} is never set by any reachable event, so it stays 0 (the page needs >= ${value})`,
        });
      }
    }
    if (c.selfSwitchValid === true) {
      const ch = String(c.selfSwitchCh);
      reqs.push({ fact: fact.self(mapId, p.eventId, ch), why: `self switch ${ch} of this event is never switched ON by a reachable page` });
    }
    if (c.itemValid === true) reqs.push({ fact: fact.goods("item", c.itemId), why: `item ${String(c.itemId)} can never be obtained` });
    if (c.actorValid === true) reqs.push({ fact: fact.actor(c.actorId), why: `actor ${String(c.actorId)} never joins the party` });
  }
  return [reqs];
}

/** Ids in start..end that some condition (or the goal) asks about; cheap even for absurd ranges. */
function idsInRange(start: number, end: number, interesting: Set<number>): number[] {
  if (end < start) return [];
  const out: number[] = [];
  if (end - start + 1 <= interesting.size) {
    for (let id = start; id <= end; id++) if (interesting.has(id)) out.push(id);
  } else {
    for (const id of interesting) if (id >= start && id <= end) out.push(id);
  }
  return out;
}

/** What a page does when it runs (all commands, guards ignored). */
function planEffects(plan: Plan, switches: Set<number>, variables: Set<number>): void {
  for (const raw of plan.page.list) {
    if (typeof raw !== "object" || raw === null) continue;
    const cmd = raw as Cmd;
    if (cmd.code === 0) continue;
    plan.empty = false;
    const p: unknown[] = Array.isArray(cmd.parameters) ? cmd.parameters : [];
    switch (cmd.code) {
      case 121: // [start, end, value]; value 0 = ON
        if (isId(p[0]) && isId(p[1]) && p[2] === 0) for (const id of idsInRange(p[0], p[1], switches)) plan.effects.push(fact.switch(id));
        break;
      case 122: // any operation writes the variable
        if (isId(p[0]) && isId(p[1])) for (const id of idsInRange(p[0], p[1], variables)) plan.effects.push(fact.variable(id));
        break;
      case 123: // [ch, value]; value 0 = ON
        if (typeof p[0] === "string" && p[1] === 0) plan.selfOn.push(p[0]);
        break;
      case 201:
        if (p[0] === 0 && isId(p[1])) plan.transfers.push(p[1]);
        if (p[0] === 0 || p[0] === 1) plan.anyTransfer = true;
        break;
      case 117:
        if (isId(p[0])) plan.calls.push(p[0]);
        break;
      case 126:
      case 127:
      case 128: // [id, operation (0 gain), ...]
        if (p[1] === 0) for (const r of commandRefs(cmd)) if (r.role === "write") plan.effects.push(fact.goods(r.kind, r.id));
        break;
      case 302:
      case 605: // shop goods can be bought
        for (const r of commandRefs(cmd)) plan.effects.push(fact.goods(r.kind, r.id));
        break;
      case 129: // [actor, operation (0 add), initialize]
        if (isId(p[0]) && p[1] === 0) plan.effects.push(fact.actor(p[0]));
        break;
      case 301:
        if (p[0] === 0 && isId(p[1])) plan.effects.push(fact.troop(p[1]));
        break;
      case 205: // [character, route]
        routeSwitchesOn(routeCommands(p[1]), plan);
        break;
      default:
        // other variable writes (103, 104, 285)
        for (const r of commandRefs(cmd)) if (r.role === "write" && r.kind === "variable") plan.effects.push(fact.variable(r.id));
    }
  }
  // An autonomous move route (moveType 3) runs while the page is active, like its commands.
  if (plan.page.moveRoute !== undefined) routeSwitchesOn(plan.page.moveRoute, plan);
}

/** Route code 27 is "Switch ON" (28, switch OFF, never adds anything). */
function routeSwitchesOn(route: Record<string, unknown>[], plan: Plan): void {
  for (const entry of route) {
    const ep = entry.parameters;
    if (entry.code === 27 && Array.isArray(ep) && isId(ep[0])) plan.effects.push(fact.switch(ep[0]));
  }
}

const byNumber = (a: number, b: number): number => a - b;

/** `maxContexts` overrides MAX_CONTEXTS (tests use a small value). */
export function analyzeProgression(index: ProjectIndex, opts: { goal?: Goal; limit: number; maxContexts?: number }): ProgressionReport {
  const limit = Math.max(0, opts.limit);
  const goal = opts.goal;
  const notes: string[] = [];
  const start = index.startMapId;
  const listed = new Set(index.mapIds);

  // ---- plans: requirements first (they decide which switch/variable ids matter for ranges), then effects ----
  const plans: Plan[] = index.pages.map((page) => ({
    page,
    alts: requirements(page),
    effects: [],
    transfers: [],
    calls: [],
    selfOn: [],
    anyTransfer: false,
    empty: true,
  }));
  const switches = new Set<number>();
  const variables = new Set<number>();
  for (const plan of plans) {
    for (const alt of plan.alts) {
      for (const r of alt) {
        // Keys use String(id), so a condition id "5" meets a 121 on 5 like the engine's `_data["5"]` does.
        const id = Number(r.fact.slice(1));
        if (!isId(id)) continue;
        if (r.fact[0] === "s") switches.add(id);
        else if (r.fact[0] === "v") variables.add(id);
      }
    }
  }
  if (goal !== undefined && "switch" in goal && isId(goal.switch)) switches.add(goal.switch);
  for (const plan of plans) planEffects(plan, switches, variables);

  const cePlans = new Map<number, Plan[]>();
  for (const plan of plans) {
    if (plan.page.kind !== "commonEvent") continue;
    const list = cePlans.get(plan.page.eventId) ?? [];
    list.push(plan);
    cePlans.set(plan.page.eventId, list);
  }

  // ---- static implications from the database and the maps ----
  const implies = new Map<string, string[]>();
  const imply = (from: string, to: string): void => {
    const list = implies.get(from) ?? [];
    list.push(to);
    implies.set(from, list);
  };
  const seeds: string[] = [fact.map(start), ...index.partyMembers.map((a) => fact.actor(a))];
  const itemCommonEvents = new Set<number>();
  const globalCommonEvents = new Set<number>();
  for (const r of index.refs) {
    const w = r.where;
    if (w.source === "map" && w.field === "encounterList" && r.kind === "troop") imply(fact.map(w.mapId), fact.troop(r.id));
    else if (w.source === "database" && w.table === "Enemies" && w.field === "dropItems") seeds.push(fact.goods(r.kind, r.id));
    else if (w.source === "database" && w.field === "effects" && r.kind === "commonEvent") {
      if (w.table === "Items") {
        imply(fact.goods("item", w.recordId), fact.called(r.id));
        itemCommonEvents.add(r.id);
      } else if (w.table === "Skills") {
        seeds.push(fact.called(r.id));
        globalCommonEvents.add(r.id);
      }
    }
  }

  // ---- the fixpoint ----
  const facts = new Set<string>();
  let queue: string[] = [];
  const add = (f: string): void => {
    if (!facts.has(f)) {
      facts.add(f);
      queue.push(f);
    }
  };
  // Call contexts are capped. Past the cap none are created; instead every map event that has a page calling a
  // common event gets every self switch any common event can turn ON — coarser, but still never too small, since
  // every call chain starts at such a page.
  const maxContexts = opts.maxContexts ?? MAX_CONTEXTS;
  const contexts = new Map<string, { ce: number; mapId: number; eventId: number }>();
  let contextOverflow = false;
  const callerPages: EventPage[] = [];
  const ceChannels = [...new Set(plans.filter((p) => p.page.kind === "commonEvent").flatMap((p) => p.selfOn))];
  const coarseSelf = (pg: EventPage): void => {
    for (const ch of ceChannels) add(fact.self(pg.mapId ?? 0, pg.eventId, ch));
  };
  const addContext = (ce: number, mapId: number, eventId: number): void => {
    const key = fact.context(ce, mapId, eventId);
    if (facts.has(key)) return;
    if (contexts.size >= maxContexts) {
      if (!contextOverflow) {
        contextOverflow = true;
        for (const pg of callerPages) coarseSelf(pg);
      }
      return;
    }
    contexts.set(key, { ce, mapId, eventId });
    add(key);
  };
  const fired = new Array<boolean>(plans.length).fill(false);
  const edges = new Map<string, { from: number; to: number }>();
  const fire = (pi: number): void => {
    if (fired[pi]) return;
    fired[pi] = true;
    const plan = plans[pi];
    const pg = plan.page;
    for (const f of plan.effects) add(f);
    for (const to of plan.transfers) {
      add(fact.map(to));
      if (pg.kind === "map" && pg.mapId !== undefined) edges.set(`${pg.mapId}>${to}`, { from: pg.mapId, to });
    }
    if (pg.kind === "map" && plan.calls.length > 0) {
      callerPages.push(pg);
      if (contextOverflow) coarseSelf(pg);
    }
    for (const ce of plan.calls) {
      add(fact.called(ce));
      if (pg.kind === "map" && pg.mapId !== undefined) addContext(ce, pg.mapId, pg.eventId);
    }
    if (pg.kind === "map" && pg.mapId !== undefined) for (const ch of plan.selfOn) add(fact.self(pg.mapId, pg.eventId, ch));
  };

  const altPlan: number[] = [];
  const altMissing: number[] = [];
  const waiters = new Map<string, number[]>();
  plans.forEach((plan, pi) => {
    for (const alt of plan.alts) {
      const needed = new Set(alt.map((r) => r.fact));
      const ai = altPlan.length;
      altPlan.push(pi);
      altMissing.push(needed.size);
      for (const f of needed) {
        const list = waiters.get(f) ?? [];
        list.push(ai);
        waiters.set(f, list);
      }
    }
  });
  for (const s of seeds) add(s);
  altMissing.forEach((missing, ai) => {
    if (missing === 0) fire(altPlan[ai]);
  });

  let rounds = 0;
  let capped = false;
  while (queue.length > 0) {
    if (rounds === MAX_ROUNDS) {
      capped = true;
      break;
    }
    rounds++;
    const current = queue;
    queue = [];
    for (const f of current) {
      for (const ai of waiters.get(f) ?? []) if (--altMissing[ai] === 0) fire(altPlan[ai]);
      for (const g of implies.get(f) ?? []) add(g);
      const ctx = contexts.get(f);
      if (ctx !== undefined) {
        for (const plan of cePlans.get(ctx.ce) ?? []) {
          for (const callee of plan.calls) addContext(callee, ctx.mapId, ctx.eventId);
          for (const ch of plan.selfOn) add(fact.self(ctx.mapId, ctx.eventId, ch));
        }
      }
    }
  }

  // ---- results ----
  const firedPlans = new Set(plans.filter((_, pi) => fired[pi]));
  let truncated = capped || contextOverflow;
  const cap = <T>(list: T[]): T[] => {
    if (list.length <= limit) return list;
    truncated = true;
    return list.slice(0, limit);
  };
  const reachable = (mapId: number): boolean => facts.has(fact.map(mapId));
  const firstMissing = (alt: Req[]): string => alt.find((r) => !facts.has(r.fact))?.why ?? "";
  const reasonOf = (plan: Plan): string => plan.alts.map(firstMissing).join(" and ");

  const reachableMaps = index.mapIds.filter(reachable);
  const unreachableMaps = index.mapIds.filter((m) => !reachable(m));

  const kindOrder = { map: 0, commonEvent: 1, troop: 2 };
  const deadPages: DeadPage[] = plans
    .filter((plan, pi) => !fired[pi] && (plan.page.kind === "map" ? reachable(plan.page.mapId ?? 0) : !plan.empty))
    .map((plan) => {
      const { kind, mapId, eventId, page } = plan.page;
      const dead: DeadPage = { kind, eventId, page, reason: reasonOf(plan) };
      if (kind === "map") dead.mapId = mapId;
      return dead;
    })
    .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.mapId ?? 0) - (b.mapId ?? 0) || a.eventId - b.eventId || a.page - b.page);

  // Dead ends: no 201 of any designation on the map's pages, and no call into a common event that can transfer.
  const callers = new Map<number, number[]>();
  for (const plan of plans) {
    if (plan.page.kind !== "commonEvent") continue;
    for (const callee of plan.calls) {
      const list = callers.get(callee) ?? [];
      list.push(plan.page.eventId);
      callers.set(callee, list);
    }
  }
  const transferring = new Set<number>();
  const pending = plans.filter((p) => p.page.kind === "commonEvent" && p.anyTransfer).map((p) => p.page.eventId);
  while (pending.length > 0) {
    const ce = pending.pop() as number;
    if (transferring.has(ce)) continue;
    transferring.add(ce);
    pending.push(...(callers.get(ce) ?? []));
  }
  const exits = new Set<number>();
  for (const plan of plans) {
    if (plan.page.kind === "map" && (plan.anyTransfer || plan.calls.some((ce) => transferring.has(ce)))) exits.add(plan.page.mapId ?? 0);
  }
  // A transferring common event that runs on its own or from an item/skill can move the player off any map.
  const anywhere = plans.find(
    (plan, pi) =>
      fired[pi] &&
      plan.page.kind === "commonEvent" &&
      transferring.has(plan.page.eventId) &&
      (plan.page.trigger === 1 || plan.page.trigger === 2 || itemCommonEvents.has(plan.page.eventId) || globalCommonEvents.has(plan.page.eventId)),
  );
  let deadEndMaps: number[] = [];
  if (anywhere !== undefined) {
    notes.push(
      `common event ${anywhere.page.eventId} can transfer the player from any map (it runs by itself or through an item or skill), so no map is reported as a dead end`,
    );
  } else {
    deadEndMaps = reachableMaps.filter((m) => !exits.has(m) && !index.unreadableMaps.includes(m));
  }

  const refUsage = (kind: "switch" | "variable"): { neverSet: number[]; neverRead: number[] } => {
    const reads = new Set<number>();
    const writes = new Set<number>();
    for (const r of index.refs) {
      if (r.kind !== kind) continue;
      if (r.role === "read") reads.add(r.id);
      else if (r.role === "write") writes.add(r.id);
    }
    return {
      neverSet: cap([...reads].filter((id) => !writes.has(id)).sort(byNumber)),
      neverRead: cap([...writes].filter((id) => !reads.has(id)).sort(byNumber)),
    };
  };

  // ---- uncertainty and notes ----
  const { scriptCommands, pluginCommands, variableTransfers, variableBattles, truncatedRanges } = index.hidden;
  const hiddenTotal = scriptCommands + pluginCommands + variableTransfers + variableBattles;
  let low = hiddenTotal > 0 || capped;
  if (hiddenTotal > 0) {
    notes.push(
      `${hiddenTotal} script, plugin or variable-designated transfer/battle commands are in the project (counted over all pages, reachable or not); what they do is unknown here, so 'unreachable' and 'dead' claims may be wrong`,
    );
  }
  if (!listed.has(start)) {
    low = true;
    notes.push(`the start map ${start} is not listed in MapInfos.json, so nothing could be explored from it`);
  }
  const unreadable = index.unreadableMaps.filter(reachable);
  if (unreadable.length > 0) {
    low = true;
    notes.push(`reachable maps that could not be read: ${unreadable.map((m) => `map ${m}`).join(", ")} (what their events do is unknown)`);
  }
  const unlisted = [...new Set([...firedPlans].flatMap((p) => p.transfers))].filter((m) => !listed.has(m)).sort(byNumber);
  if (unlisted.length > 0) {
    low = true;
    notes.push(
      `transfer targets not listed in MapInfos.json: ${unlisted.map((m) => `map ${m}`).join(", ")} (a map file may still exist with events that were never indexed, so claims that depend on these maps may be wrong)`,
    );
  }
  const { enabledPlugins, enabledPluginNames } = index.hidden;
  if (enabledPlugins > 0) {
    low = true;
    notes.push(
      `${enabledPlugins} enabled plugin(s) (${enabledPluginNames.join(", ")}${enabledPlugins > enabledPluginNames.length ? ", …" : ""}) can call common events, set switches or move the player through parameters or notetags that this analysis cannot see.`,
    );
  }
  if (contextOverflow) {
    low = true;
    notes.push(
      `more than ${maxContexts} common-event call contexts; past that, self switches set inside called common events are approximated coarsely (any map event that calls a common event may get them), so the results are less precise`,
    );
  }
  if (truncatedRanges > 0) {
    notes.push(`${truncatedRanges} switch/variable range commands are longer than 1000 ids; neverSet/neverRead only count their first 1000 ids`);
  }
  if (capped) {
    notes.push(
      `the analysis stopped after ${MAX_ROUNDS} rounds (a dependency chain that long); the results are incomplete, so 'unreachable' and 'dead' claims are not reliable`,
    );
  }

  // ---- goal ----
  let goalReport: ProgressionReport["goal"];
  if (goal !== undefined) {
    const blockers = (setters: Plan[], none: string): string[] => {
      const list = setters.filter((p) => !firedPlans.has(p)).map((p) => `${pageLabel(p.page)}: ${reasonOf(p)}`);
      return setters.length === 0 ? [none] : list;
    };
    const mapBlockers = (mapId: number): string[] =>
      blockers(
        plans.filter((p) => p.transfers.includes(mapId)),
        `no event transfers to map ${mapId}`,
      );
    if ("switch" in goal) {
      const key = fact.switch(goal.switch);
      const ok = facts.has(key);
      goalReport = {
        target: `switch ${goal.switch}`,
        reachable: ok,
        blockedBy: ok ? [] : blockers(plans.filter((p) => p.effects.includes(key)), `no event ever sets switch ${goal.switch}`),
      };
    } else if ("mapId" in goal) {
      const ok = reachable(goal.mapId);
      goalReport = { target: `map ${goal.mapId}`, reachable: ok, blockedBy: ok ? [] : mapBlockers(goal.mapId) };
    } else {
      const { mapId, eventId } = goal.event;
      const own = plans.filter((p) => p.page.kind === "map" && p.page.mapId === mapId && p.page.eventId === eventId);
      const ok = own.some((p) => firedPlans.has(p));
      let blockedBy: string[] = [];
      if (!ok) {
        if (own.length === 0) {
          blockedBy = [index.unreadableMaps.includes(mapId) ? `map ${mapId} could not be read` : `map ${mapId} has no event ${eventId}`];
        } else if (!reachable(mapId)) {
          blockedBy = [`map ${mapId} is unreachable`, ...mapBlockers(mapId)];
        } else {
          blockedBy = own.map((p) => `page ${p.page.page + 1}: ${reasonOf(p)}`);
        }
      }
      goalReport = { target: `map ${mapId} event ${eventId}`, reachable: ok, blockedBy };
    }
    goalReport.blockedBy = goalReport.blockedBy.slice(0, MAX_BLOCKERS);
  }

  const report: ProgressionReport = {
    startMapId: start,
    reachableMaps: cap(reachableMaps),
    unreachableMaps: cap(unreachableMaps),
    deadEndMaps: cap(deadEndMaps),
    deadPages: cap(deadPages),
    switches: refUsage("switch"),
    variables: refUsage("variable"),
    uncertainty: { scriptCommands, pluginCommands, variableTransfers, variableBattles, confidence: low ? "low" : "high" },
    edges: cap([...edges.values()].sort((a, b) => a.from - b.from || a.to - b.to)),
    notes,
    truncated: false,
  };
  if (goalReport !== undefined) report.goal = goalReport;
  report.truncated = truncated;
  return report;
}

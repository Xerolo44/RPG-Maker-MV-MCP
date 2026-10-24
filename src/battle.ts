// Battle maths for balance reports and simulations: battler stats from the project's data,
// the engine's damage formula pipeline (Game_Action.makeDamageValue) and a turn-based
// simulator. States, buffs, items and most special effects are deliberately not modelled.
import { PARAM_NAMES } from "./curves.js";
import { FormulaContext, evalFormula } from "./formula.js";

export type Rec = Record<string, any>;

export interface GameData {
  actors: (Rec | null)[];
  classes: (Rec | null)[];
  skills: (Rec | null)[];
  weapons: (Rec | null)[];
  armors: (Rec | null)[];
  enemies: (Rec | null)[];
  troops: (Rec | null)[];
}

export interface Trait {
  code: number;
  dataId: number;
  value: number;
}

const XPARAMS = ["hit", "eva", "cri", "cev", "mev", "mrf", "cnt", "hrg", "mrg", "trg"];
const SPARAMS = ["tgr", "grd", "rec", "pha", "mcr", "tcr", "pdr", "mdr", "fdr", "exr"];

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export class Battler {
  hp = 0;
  mp = 0;
  tp = 0;
  /** Formula view: what `a` / `b` refer to inside damage formulas. */
  readonly view: Record<string, unknown> = {};

  constructor(
    readonly name: string,
    readonly isActor: boolean,
    readonly level: number | undefined,
    private readonly base: number[],
    readonly traits: Trait[],
    readonly actions: Rec[] = [],
    public skillIds: number[] = [1]
  ) {
    this.hp = this.param(0);
    this.mp = this.param(1);
    const def = (key: string, get: () => unknown): void => {
      Object.defineProperty(this.view, key, { get, enumerable: true });
    };
    PARAM_NAMES.forEach((n, i) => def(n, () => this.param(i)));
    XPARAMS.forEach((n, i) => def(n, () => this.xparam(i)));
    SPARAMS.forEach((n, i) => def(n, () => this.sparam(i)));
    def("hp", () => this.hp);
    def("mp", () => this.mp);
    def("tp", () => this.tp);
    def("level", () => this.level);
    this.view.isStateAffected = () => false;
    this.view.isActor = () => this.isActor;
    this.view.isEnemy = () => !this.isActor;
    this.view.isDead = () => this.hp <= 0;
    this.view.isAlive = () => this.hp > 0;
    this.view.isDying = () => this.hp > 0 && this.hp < this.param(0) / 4;
  }

  private traitsOf(code: number, dataId?: number): Trait[] {
    return this.traits.filter((t) => t.code === code && (dataId === undefined || t.dataId === dataId));
  }
  private pi(code: number, dataId: number): number {
    return this.traitsOf(code, dataId).reduce((p, t) => p * t.value, 1);
  }
  private sum(code: number, dataId: number): number {
    return this.traitsOf(code, dataId).reduce((s, t) => s + t.value, 0);
  }

  param(i: number): number {
    const min = i === 1 ? 0 : 1;
    const max = i === 0 ? 999999 : 9999;
    const value = (this.base[i] ?? 0) * this.pi(21, i);
    return Math.round(Math.min(max, Math.max(min, value)));
  }
  get maxHp(): number {
    return this.param(0);
  }
  get agi(): number {
    return this.param(6);
  }
  xparam(i: number): number {
    return this.sum(22, i);
  }
  sparam(i: number): number {
    return this.pi(23, i);
  }
  elementRate(elementId: number): number {
    return this.pi(11, elementId);
  }
  attackElements(): number[] {
    return this.traitsOf(31).map((t) => t.dataId);
  }
  get alive(): boolean {
    return this.hp > 0;
  }
  /** Extra actions per turn: each Action Times+ trait gives that chance of one more. */
  actionTimesPlus(): number[] {
    return this.traitsOf(61).map((t) => t.value);
  }
}

function traitList(rec: Rec | null | undefined): Trait[] {
  return Array.isArray(rec?.traits) ? (rec!.traits as Trait[]) : [];
}

export interface ActorSpec {
  actorId?: number;
  classId?: number;
  level?: number;
  skillIds?: number[];
}

export function makeActor(data: GameData, spec: ActorSpec, rawMode = false): Battler {
  const actor = spec.actorId !== undefined ? data.actors[spec.actorId] : null;
  if (spec.actorId !== undefined && !actor) throw new Error(`Actor ${spec.actorId} does not exist.`);
  const classId = spec.classId ?? actor?.classId;
  const cls = classId !== undefined ? data.classes[classId] : null;
  if (!cls) throw new Error(`Class ${classId} does not exist.`);
  const level = Math.max(1, Math.min(spec.level ?? actor?.initialLevel ?? 1, actor?.maxLevel ?? 99));

  const base = PARAM_NAMES.map((_, i) => Number(cls.params?.[i]?.[level] ?? 0));
  const traits = [...traitList(actor), ...traitList(cls)];
  if (actor && !rawMode) {
    (actor.equips as number[] | undefined)?.forEach((itemId, slot) => {
      const item = itemId > 0 ? (slot === 0 ? data.weapons : data.armors)[itemId] : null;
      if (!item) return;
      item.params?.forEach((p: number, i: number) => (base[i] += Number(p) || 0));
      traits.push(...traitList(item));
    });
  }
  return new Battler(actor?.name ?? cls.name, true, level, base, traits, [], spec.skillIds?.length ? spec.skillIds : [1]);
}

export function makeEnemy(data: GameData, enemyId: number, label?: string): Battler {
  const enemy = data.enemies[enemyId];
  if (!enemy) throw new Error(`Enemy ${enemyId} does not exist.`);
  return new Battler(label ?? enemy.name, false, undefined, (enemy.params as number[]).map(Number), traitList(enemy), enemy.actions ?? []);
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

export interface DamageResult {
  missed: boolean;
  evaded: boolean;
  critical: boolean;
  /** Positive = damage, negative = recovery (engine convention). */
  value: number;
}

const VARIABLES = new Array<number>(1000).fill(0);

function mathFor(rng: () => number): FormulaContext["math"] {
  return {
    max: Math.max, min: Math.min, floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs,
    pow: Math.pow, sqrt: Math.sqrt, PI: Math.PI, log: Math.log, exp: Math.exp, sign: Math.sign, trunc: Math.trunc,
    random: rng,
  };
}

const EXPECTED_MATH = mathFor(() => 0.5);

function elementRate(skill: Rec, a: Battler, b: Battler): number {
  const id = skill.damage?.elementId ?? 0;
  if (id < 0) {
    const els = a.attackElements();
    return els.length ? Math.max(...els.map((e) => b.elementRate(e))) : 1;
  }
  return id === 0 ? 1 : b.elementRate(id);
}

/** Damage of one use of `skill` by `a` on `b`, following Game_Action.makeDamageValue. */
export function calcDamage(skill: Rec, a: Battler, b: Battler, rng: (() => number) | null): DamageResult {
  const dmg = skill.damage ?? { type: 0, formula: "0", variance: 0, critical: false };
  const sign = dmg.type === 3 || dmg.type === 4 ? -1 : 1;
  const ctx: FormulaContext = { a: a.view, b: b.view, v: VARIABLES, math: rng ? mathFor(rng) : EXPECTED_MATH };
  const baseValue = evalFormula(String(dmg.formula ?? "0"), ctx) * sign;
  const physical = skill.hitType === 1;
  const magical = skill.hitType === 2;

  let missed = false;
  let evaded = false;
  let critical = false;
  if (rng) {
    const itemHit = (skill.successRate ?? 100) * 0.01 * (physical ? a.xparam(0) : 1);
    missed = rng() >= itemHit;
    evaded = !missed && rng() < (physical ? b.xparam(1) : magical ? b.xparam(4) : 0);
    critical = rng() < (dmg.critical ? a.xparam(2) * (1 - b.xparam(3)) : 0);
  }

  let value = baseValue * elementRate(skill, a, b);
  if (physical) value *= b.sparam(6);
  if (magical) value *= b.sparam(7);
  if (baseValue < 0) value *= b.sparam(2);
  if (critical) value *= 3;
  if (rng) {
    const amp = Math.floor(Math.max((Math.abs(value) * (dmg.variance ?? 0)) / 100, 0));
    const v = Math.floor(rng() * (amp + 1)) + Math.floor(rng() * (amp + 1)) - amp;
    value = value >= 0 ? value + v : value - v;
  }
  return { missed, evaded, critical, value: Math.round(value) };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface SimStats {
  name: string;
  isActor: boolean;
  /** Per-run values averaged over all runs. */
  avgDamageDealt: number;
  avgDamageTaken: number;
  /** Fraction of runs in which this battler died. */
  deathRate: number;
  avgHpLeftPercent: number;
  avgDeathTurn: number | null;
}

export interface SimResult {
  runs: number;
  winRate: number;
  lossRate: number;
  timeoutRate: number;
  avgTurns: number;
  avgTurnsWhenWon: number | null;
  avgPartyHpLeftPercentWhenWon: number | null;
  battlers: SimStats[];
  sampleLog: string[];
}

export interface SimOptions {
  runs: number;
  maxTurns: number;
  seed: number;
  /** Expected party level, used for enemy action conditions. */
  partyLevel: number;
}

function labelEnemies(data: GameData, enemyIds: number[]): string[] {
  const counts = new Map<string, number>();
  for (const id of enemyIds) counts.set(data.enemies[id]?.name ?? "?", (counts.get(data.enemies[id]?.name ?? "?") ?? 0) + 1);
  const seen = new Map<string, number>();
  return enemyIds.map((id) => {
    const name = data.enemies[id]?.name ?? "?";
    if ((counts.get(name) ?? 0) < 2) return name;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return `${name} ${String.fromCharCode(65 + (n % 26))}`;
  });
}

function validEnemyAction(action: Rec, e: Battler, turn: number, partyLevel: number, data: GameData): boolean {
  const skill = data.skills[action.skillId];
  if (!skill || e.mp < (skill.mpCost ?? 0)) return false;
  const p1 = action.conditionParam1 ?? 0;
  const p2 = action.conditionParam2 ?? 0;
  switch (action.conditionType ?? 0) {
    case 1: return p2 === 0 ? turn === p1 : turn > 0 && turn >= p1 && turn % p2 === p1 % p2;
    case 2: { const r = e.hp / e.maxHp; return r >= p1 && r <= p2; }
    case 3: { const r = e.mp / Math.max(1, e.param(1)); return r >= p1 && r <= p2; }
    case 5: return partyLevel >= p1;
    case 4: case 6: return false; // states and switches are not modelled
    default: return true;
  }
}

export function simulateBattles(
  data: GameData,
  party: ActorSpec[],
  enemyIds: number[],
  opts: SimOptions
): SimResult {
  if (!party.length) throw new Error("The party is empty.");
  if (!enemyIds.length) throw new Error("The troop has no enemies.");
  const rng = mulberry32(opts.seed);
  const randInt = (n: number): number => Math.floor(rng() * n);
  const enemyLabels = labelEnemies(data, enemyIds);

  const totals = [...party.map(() => ({ dealt: 0, taken: 0, deaths: 0, hpLeft: 0, deathTurns: 0 })), ...enemyIds.map(() => ({ dealt: 0, taken: 0, deaths: 0, hpLeft: 0, deathTurns: 0 }))];
  let wins = 0, losses = 0, timeouts = 0, turnsAll = 0, turnsWon = 0, partyHpWon = 0;
  let sampleLog: string[] = [];

  for (let run = 0; run < opts.runs; run++) {
    const members = party.map((spec) => makeActor(data, spec));
    const foes = enemyIds.map((id, i) => makeEnemy(data, id, enemyLabels[i]));
    const all = [...members, ...foes];
    const log: string[] = [];
    const record = run === 0;
    const dealt = all.map(() => 0);
    const taken = all.map(() => 0);
    const deathTurn = all.map(() => 0);
    const idx = (b: Battler): number => all.indexOf(b);
    const sideOf = (b: Battler): Battler[] => (b.isActor ? members : foes);
    const otherSide = (b: Battler): Battler[] => (b.isActor ? foes : members);
    const alive = (list: Battler[]): Battler[] => list.filter((x) => x.alive);
    let turn = 0;
    let outcome: "win" | "loss" | "timeout" = "timeout";

    const pickTarget = (list: Battler[]): Battler => {
      const sum = list.reduce((s, x) => s + x.sparam(0), 0);
      let r = rng() * sum;
      for (const x of list) { r -= x.sparam(0); if (r <= 0) return x; }
      return list[list.length - 1];
    };

    const chooseSkill = (b: Battler): Rec | null => {
      if (!b.isActor) {
        const valid = b.actions.filter((a) => validEnemyAction(a, b, turn, opts.partyLevel, data));
        if (!valid.length) return null;
        const max = Math.max(...valid.map((a) => a.rating ?? 5));
        const zero = max - 3;
        const pool = valid.filter((a) => (a.rating ?? 5) > zero);
        let r = rng() * pool.reduce((s, a) => s + (a.rating ?? 5) - zero, 0);
        for (const a of pool) { r -= (a.rating ?? 5) - zero; if (r <= 0) return data.skills[a.skillId] ?? null; }
        return data.skills[pool[pool.length - 1].skillId] ?? null;
      }
      const friends = alive(sideOf(b));
      for (const id of b.skillIds) {
        const s = data.skills[id];
        if (!s || b.mp < (s.mpCost ?? 0)) continue;
        const type = s.damage?.type ?? 0;
        if (type === 0) continue; // state/buff-only skills cannot be simulated
        if (type === 3 && !friends.some((f) => f.hp < f.maxHp * 0.6)) continue;
        if (type === 4) continue;
        return s;
      }
      return data.skills[1] ?? null;
    };

    const execute = (user: Battler, skill: Rec): void => {
      const foesAlive = alive(otherSide(user));
      const friendsAlive = alive(sideOf(user));
      let targets: Battler[] = [];
      switch (skill.scope) {
        case 1: if (foesAlive.length) targets = [pickTarget(foesAlive)]; break;
        case 2: targets = foesAlive; break;
        case 3: case 4: case 5: case 6:
          if (foesAlive.length) for (let i = 0; i < skill.scope - 2; i++) targets.push(pickTarget(foesAlive));
          break;
        case 7: targets = friendsAlive.length ? [friendsAlive.reduce((m, x) => (x.hp / x.maxHp < m.hp / m.maxHp ? x : m))] : []; break;
        case 8: targets = friendsAlive; break;
        case 11: targets = [user]; break;
        default: targets = [];
      }
      if (!targets.length) return;
      user.mp -= skill.mpCost ?? 0;
      const type = skill.damage?.type ?? 0;
      for (let rep = 0; rep < Math.max(1, skill.repeats ?? 1); rep++) {
        for (const t of targets) {
          if (!t.alive && skill.scope !== 9) continue;
          const r = calcDamage(skill, user, t, rng);
          if (r.missed || r.evaded) {
            if (record) log.push(`T${turn} ${user.name} uses ${skill.name} on ${t.name}: ${r.missed ? "miss" : "evaded"}`);
            continue;
          }
          const v = r.value;
          if (type === 1 || type === 5) {
            const applied = Math.min(Math.max(v, 0), t.hp);
            t.hp -= Math.max(v, 0);
            dealt[idx(user)] += applied;
            taken[idx(t)] += applied;
            if (type === 5) user.hp = Math.min(user.maxHp, user.hp + applied);
          } else if (type === 2 || type === 6) {
            const applied = Math.min(Math.max(v, 0), t.mp);
            t.mp -= applied;
            if (type === 6) user.mp = Math.min(user.param(1), user.mp + applied);
          } else if (type === 3) t.hp = Math.min(t.maxHp, t.hp - v);
          else if (type === 4) t.mp = Math.min(t.param(1), t.mp - v);
          if (record) log.push(`T${turn} ${user.name} uses ${skill.name} on ${t.name}: ${v}${r.critical ? " (critical)" : ""}${t.hp <= 0 ? " - defeated" : ""}`);
          if (t.hp <= 0 && !deathTurn[idx(t)]) deathTurn[idx(t)] = turn;
        }
      }
    };

    while (turn < opts.maxTurns) {
      turn++;
      const queue: { b: Battler; skill: Rec; speed: number }[] = [];
      for (const b of all) {
        if (!b.alive) continue;
        const times = 1 + b.actionTimesPlus().filter((p) => rng() < p).length;
        for (let i = 0; i < times; i++) {
          const skill = chooseSkill(b);
          if (skill) queue.push({ b, skill, speed: b.agi + randInt(Math.floor(5 + b.agi / 4)) + (skill.speed ?? 0) });
        }
      }
      queue.sort((x, y) => y.speed - x.speed);
      for (const { b, skill } of queue) {
        if (!b.alive) continue;
        execute(b, skill);
        if (!alive(foes).length || !alive(members).length) break;
      }
      if (!alive(foes).length) { outcome = "win"; break; }
      if (!alive(members).length) { outcome = "loss"; break; }
    }

    if (outcome === "win") wins++;
    else if (outcome === "loss") losses++;
    else timeouts++;
    turnsAll += turn;
    if (outcome === "win") {
      turnsWon += turn;
      const maxTotal = members.reduce((s, m) => s + m.maxHp, 0);
      partyHpWon += (members.reduce((s, m) => s + Math.max(0, m.hp), 0) / maxTotal) * 100;
    }
    all.forEach((b, i) => {
      const t = totals[i];
      t.dealt += dealt[i];
      t.taken += taken[i];
      t.hpLeft += (Math.max(0, b.hp) / b.maxHp) * 100;
      if (deathTurn[i]) { t.deaths++; t.deathTurns += deathTurn[i]; }
    });
    if (record) sampleLog = log;
  }

  const n = opts.runs;
  const names = [...party.map((p, i) => makeActor(data, p).name || `member ${i + 1}`), ...enemyLabels];
  return {
    runs: n,
    winRate: wins / n,
    lossRate: losses / n,
    timeoutRate: timeouts / n,
    avgTurns: turnsAll / n,
    avgTurnsWhenWon: wins ? turnsWon / wins : null,
    avgPartyHpLeftPercentWhenWon: wins ? partyHpWon / wins : null,
    battlers: totals.map((t, i) => ({
      name: names[i],
      isActor: i < party.length,
      avgDamageDealt: Math.round((t.dealt / n) * 10) / 10,
      avgDamageTaken: Math.round((t.taken / n) * 10) / 10,
      deathRate: t.deaths / n,
      avgHpLeftPercent: Math.round((t.hpLeft / n) * 10) / 10,
      avgDeathTurn: t.deaths ? Math.round((t.deathTurns / t.deaths) * 10) / 10 : null,
    })),
    sampleLog,
  };
}

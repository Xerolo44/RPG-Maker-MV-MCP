import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DATABASE_TYPES, Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";
import {
  BulkError, Change, Condition, FieldDiff, applyChanges, matches,
} from "../bulk.js";
import { CURVE_SHAPES, CurveShape, PARAM_NAMES, curveValue, paramIndex } from "../curves.js";
import { formulaProblem } from "../formula.js";
import {
  ActorSpec, GameData, Rec, calcDamage, makeActor, makeEnemy, simulateBattles,
} from "../battle.js";

async function loadGameData(project: Project): Promise<GameData> {
  const read = (type: (typeof DATABASE_TYPES)[number]): Promise<(Rec | null)[]> =>
    project.readDatabase(type) as Promise<(Rec | null)[]>;
  const [actors, classes, skills, weapons, armors, enemies, troops] = await Promise.all([
    read("actors"), read("classes"), read("skills"), read("weapons"), read("armors"), read("enemies"), read("troops"),
  ]);
  return { actors, classes, skills, weapons, armors, enemies, troops };
}

async function partyFromSystem(project: Project, data: GameData): Promise<ActorSpec[]> {
  const system = await project.readJson<{ partyMembers?: number[] }>(project.dataFile("System.json"));
  return (system.partyMembers ?? []).filter((id) => data.actors[id]).map((actorId) => ({ actorId }));
}

const paramSchema = z.union([z.enum(PARAM_NAMES), z.number().int().min(0).max(7)]);

const curveSchema = z.object({
  start: z.number().describe("Value at the first point of the curve"),
  end: z.number().describe("Value at the last point"),
  shape: z.enum(CURVE_SHAPES).default("linear"),
  exponent: z.number().positive().optional().describe("Power for ease shapes (default 2), steepness for logistic (default 8)"),
});

const SAMPLE_LEVELS = [1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99];

const hits = (n: number): string => (n === 1 ? '1 hit' : `${n} hits`);

function hitsToKill(hp: number, damage: number): number | null {
  return damage > 0 ? Math.max(1, Math.ceil(hp / damage)) : null;
}

export function registerBalanceTools(server: McpServer, project: Project): void {
  // ---------------------------------------------------------------- bulk
  server.registerTool(
    "bulk_update_records",
    {
      title: "Bulk update records",
      description:
        "Change one or more fields on many database records at once, with a diff. Example - all weapons +10% attack: {type: 'weapons', changes: [{field: 'params.atk', op: 'percent', value: 10}]}. " +
        "Select records with `ids` and/or `where` conditions (all must match); with neither, every record is selected. " +
        "Fields are paths such as 'price', 'params.atk' (mhp/mmp/atk/def/mat/mdf/agi/luk), 'params[2]', 'damage.formula', 'traits[0].value'. " +
        "Ops: set (any value), add, multiply, percent (+value%) - numeric ops round to whole numbers for integer fields (round: auto), with optional min/max clamps. " +
        "DRY RUN BY DEFAULT: nothing is written until you pass dryRun=false, so show the diff to the user first. If any record fails, nothing is written.",
      inputSchema: {
        type: z.enum(DATABASE_TYPES),
        ids: z.array(z.number().int().min(1)).optional().describe("Only these record ids"),
        where: z
          .array(
            z.object({
              field: z.string(),
              op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "matches", "exists"]),
              value: z.unknown().optional(),
            })
          )
          .optional()
          .describe("Conditions, e.g. [{field: 'wtypeId', op: 'eq', value: 1}, {field: 'name', op: 'contains', value: 'sword'}]"),
        changes: z
          .array(
            z.object({
              field: z.string(),
              op: z.enum(["set", "add", "multiply", "percent"]),
              value: z.unknown(),
              round: z.enum(["auto", "none", "round", "floor", "ceil"]).optional(),
              min: z.number().optional(),
              max: z.number().optional(),
            })
          )
          .min(1),
        dryRun: z.boolean().default(true).describe("true = only preview the diff (default), false = write the changes"),
        maxPreview: z.number().int().min(1).max(500).default(50).describe("Maximum records shown in the diff"),
      },
    },
    safe(async ({ type, ids, where, changes, dryRun, maxPreview }) => {
      const records = (await project.readDatabase(type)) as (Rec | null)[];
      const idSet = ids ? new Set(ids) : null;
      const missingIds = ids ? ids.filter((id) => !records[id]) : [];
      const selected = records.filter(
        (r, i): r is Rec => r != null && (!idSet || idSet.has(i)) && (where ?? []).every((c) => matches(r, c as Condition))
      );

      const updated = new Map<number, Rec>();
      const preview: { id: number; name: string; changes: FieldDiff[] }[] = [];
      const errors: string[] = [];
      for (const rec of selected) {
        const clone = structuredClone(rec);
        try {
          const diffs = applyChanges(clone, changes as Change[]);
          if (diffs.length) {
            updated.set(rec.id, clone);
            preview.push({ id: rec.id, name: rec.name ?? "", changes: diffs });
          }
        } catch (err) {
          errors.push(`#${rec.id} ${rec.name ?? ""}: ${err instanceof BulkError || err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (errors.length && !dryRun) {
        throw new ProjectError(`No changes written, ${errors.length} record(s) failed: ${errors.slice(0, 5).join(" | ")}${errors.length > 5 ? " ..." : ""}`);
      }
      if (!dryRun && updated.size) {
        for (const [id, rec] of updated) records[id] = rec;
        await project.writeDatabase(type, records);
      }
      return textResult({
        type,
        dryRun,
        applied: !dryRun && updated.size > 0,
        matched: selected.length,
        changed: updated.size,
        unchanged: selected.length - updated.size - errors.length,
        errors: errors.slice(0, 20),
        missingIds: missingIds.length ? missingIds : undefined,
        diff: preview.slice(0, maxPreview),
        truncated: preview.length > maxPreview ? `${preview.length - maxPreview} more changed records not shown` : undefined,
        note: selected.length === 0 ? "No records matched the ids/where filter, so nothing can change." : undefined,
        next: dryRun && updated.size ? "Review the diff, then call again with dryRun=false to apply." : undefined,
      });
    })
  );

  // ---------------------------------------------------------------- curves
  server.registerTool(
    "generate_param_curve",
    {
      title: "Generate class parameter curve",
      description:
        "Generate stat curves over levels and (optionally) write them into a class. Each curve goes from `start` at minLevel to `end` at maxLevel with a shape: linear, ease-in (slow start), ease-out (fast start), ease-in-out, exponential (constant growth factor) or logistic (S-curve). " +
        "Without classId this is a pure preview of the numbers. With classId the class's params table is rewritten for minLevel..maxLevel (other levels are untouched) - dry run by default, pass dryRun=false to apply. " +
        "Follow up with balance_report to see how the new curve plays against enemies.",
      inputSchema: {
        curves: z
          .array(curveSchema.extend({ param: paramSchema.describe("mhp, mmp, atk, def, mat, mdf, agi, luk (or 0-7)") }))
          .min(1)
          .max(8),
        minLevel: z.number().int().min(1).max(99).default(1),
        maxLevel: z.number().int().min(1).max(99).default(99),
        classId: z.number().int().min(1).optional().describe("Write the curves into this class"),
        dryRun: z.boolean().default(true),
      },
    },
    safe(async ({ curves, minLevel, maxLevel, classId, dryRun }) => {
      if (maxLevel < minLevel) throw new ProjectError("maxLevel must be at least minLevel.");
      const table: Record<string, number[]> = {};
      const idxs = curves.map((c) => paramIndex(c.param));
      if (new Set(idxs).size !== idxs.length) throw new ProjectError("Each parameter may appear only once.");
      const values = curves.map((c) => {
        const out: number[] = [];
        for (let lv = minLevel; lv <= maxLevel; lv++) {
          const t = maxLevel === minLevel ? 0 : (lv - minLevel) / (maxLevel - minLevel);
          out.push(Math.round(curveValue(c.shape as CurveShape, c.start, c.end, t, c.exponent)));
        }
        return out;
      });
      curves.forEach((c, i) => (table[PARAM_NAMES[idxs[i]]] = values[i]));

      const sample = SAMPLE_LEVELS.filter((l) => l >= minLevel && l <= maxLevel);
      if (!sample.includes(maxLevel)) sample.push(maxLevel);

      let before: Record<string, number[]> | undefined;
      let cls: Rec | null = null;
      let classes: (Rec | null)[] = [];
      if (classId !== undefined) {
        classes = (await project.readDatabase("classes")) as (Rec | null)[];
        cls = classes[classId];
        if (!cls) throw new ProjectError(`No classes record with id ${classId}.`);
        before = {};
        idxs.forEach((idx, i) => {
          const row = cls!.params?.[idx];
          if (!Array.isArray(row)) throw new ProjectError(`Class ${classId} has no params table for ${PARAM_NAMES[idx]}.`);
          before![PARAM_NAMES[idx]] = sample.map((l) => row[l]);
          if (!dryRun) for (let lv = minLevel; lv <= maxLevel; lv++) row[lv] = values[i][lv - minLevel];
        });
        if (!dryRun) await project.writeDatabase("classes", classes);
      }

      return textResult({
        classId,
        className: cls?.name,
        applied: classId !== undefined && !dryRun,
        levels: sample,
        curves: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, sample.map((l) => v[l - minLevel])])),
        before,
        next: classId === undefined ? "Pass classId to write these into a class." : dryRun ? "Dry run: call again with dryRun=false to apply." : undefined,
      });
    })
  );

  server.registerTool(
    "generate_enemy_scaling",
    {
      title: "Generate enemy scaling",
      description:
        "Spread enemy stats along a curve for smooth difficulty progression. Give the enemies ordered from weakest to strongest; the first gets each curve's `start`, the last its `end`, the rest are interpolated with the chosen shape. " +
        "Curves can target any parameter (mhp, mmp, atk, def, mat, mdf, agi, luk) plus `exp` and `gold`. Dry run by default - shows before and after per enemy; pass dryRun=false to write.",
      inputSchema: {
        enemyIds: z.array(z.number().int().min(1)).min(1).max(200).describe("Enemy ids from weakest to strongest"),
        curves: z
          .array(curveSchema.extend({ param: z.union([paramSchema, z.enum(["exp", "gold"])]) }))
          .min(1)
          .max(10),
        dryRun: z.boolean().default(true),
      },
    },
    safe(async ({ enemyIds, curves, dryRun }) => {
      const enemies = (await project.readDatabase("enemies")) as (Rec | null)[];
      for (const id of enemyIds) if (!enemies[id]) throw new ProjectError(`No enemies record with id ${id}.`);
      const n = enemyIds.length;
      const rows = enemyIds.map((id, i) => {
        const enemy = enemies[id]!;
        const t = n === 1 ? 0 : i / (n - 1);
        const row: Record<string, { before: number; after: number }> = {};
        for (const c of curves) {
          const after = Math.round(curveValue(c.shape as CurveShape, c.start, c.end, t, c.exponent));
          if (c.param === "exp" || c.param === "gold") {
            row[c.param] = { before: enemy[c.param], after };
            if (!dryRun) enemy[c.param] = after;
          } else {
            const idx = paramIndex(c.param);
            row[PARAM_NAMES[idx]] = { before: enemy.params[idx], after };
            if (!dryRun) enemy.params[idx] = after;
          }
        }
        return { id, name: enemy.name, ...row };
      });
      if (!dryRun) await project.writeDatabase("enemies", enemies);
      return textResult({ dryRun, applied: !dryRun, enemies: rows, next: dryRun ? "Dry run: call again with dryRun=false to apply." : undefined });
    })
  );

  // ---------------------------------------------------------------- report
  server.registerTool(
    "balance_report",
    {
      title: "Balance report",
      description:
        "Measure the game's balance from its data: (1) class stat curves at chosen levels, (2) the attack skill's damage by level against a reference enemy, (3) a matrix of attackers vs enemies (average damage and hits to kill) and (4) enemy threat vs the same characters (damage of the enemy's best attack and hits to kill them). " +
        "Ends with warnings: unevaluable damage formulas, curves that go down, enemies killed in one hit or immune, enemies that one-shot a character. " +
        "Attackers default to the starting party. Numbers are averages with no variance, crits or misses and ignore states, items and elements beyond what the skill/traits specify - use simulate_battle for a full fight.",
      inputSchema: {
        levels: z.array(z.number().int().min(1).max(99)).min(1).max(8).default([1, 10, 25, 50, 99]).describe("Levels for the curve tables"),
        classIds: z.array(z.number().int().min(1)).max(10).optional().describe("Classes for the curve tables (default: the first 6)"),
        attackers: z
          .array(
            z.object({
              actorId: z.number().int().min(1).optional(),
              classId: z.number().int().min(1).optional(),
              level: z.number().int().min(1).max(99).optional(),
              skillId: z.number().int().min(1).default(1).describe("Skill the attacker uses (default 1 = Attack)"),
            })
          )
          .max(6)
          .optional()
          .describe("Characters for the matrices; default: the starting party at their initial level"),
        enemyIds: z.array(z.number().int().min(1)).max(60).optional().describe("Enemies to list (default: the first 40)"),
        referenceEnemyId: z.number().int().min(1).optional().describe("Enemy for the damage-by-level table (default: the one with median HP)"),
      },
    },
    safe(async ({ levels, classIds, attackers, enemyIds, referenceEnemyId }) => {
      const data = await loadGameData(project);
      const warnings: string[] = [];
      const real = <T>(list: (T | null)[]): T[] => list.filter((x): x is T => x != null);

      // Formula sanity over all damaging skills.
      for (const s of real(data.skills)) {
        if ((s.damage?.type ?? 0) > 0) {
          const problem = formulaProblem(String(s.damage.formula ?? ""));
          if (problem) warnings.push(`Skill ${s.id} "${s.name}": damage formula "${s.damage.formula}" cannot be evaluated here (${problem}).`);
        }
      }

      const classList = classIds ? classIds.map((id) => data.classes[id]).filter((c): c is Rec => !!c) : real(data.classes).slice(0, 6);
      const lv = [...levels].sort((a, b) => a - b);

      // 1. Class curves
      const classCurves = classList.map((cls) => {
        const rows = lv.map((level) => {
          const b = makeActor(data, { classId: cls.id, level });
          return `L${level}: ` + PARAM_NAMES.map((n, i) => `${n} ${b.param(i)}`).join("  ");
        });
        PARAM_NAMES.forEach((n, i) => {
          const row = cls.params?.[i] as number[] | undefined;
          if (!row) return;
          for (let l = 2; l < row.length; l++) {
            if (row[l] < row[l - 1]) { warnings.push(`Class ${cls.id} "${cls.name}": ${n} drops from ${row[l - 1]} to ${row[l]} at level ${l}.`); break; }
          }
        });
        return { classId: cls.id, name: cls.name, levels: rows };
      });

      // Enemies
      const enemyList = (enemyIds ? enemyIds.map((id) => data.enemies[id]).filter((e): e is Rec => !!e) : real(data.enemies).filter((e) => e.name)).slice(0, enemyIds ? 60 : 40);
      if (!enemyList.length) throw new ProjectError("The project has no enemies to compare against.");
      const reference =
        (referenceEnemyId !== undefined ? data.enemies[referenceEnemyId] : null) ??
        [...enemyList].sort((a, b) => a.params[0] - b.params[0])[Math.floor(enemyList.length / 2)];

      const attackSkill = (id: number): Rec => {
        const s = data.skills[id];
        if (!s) throw new ProjectError(`Skill ${id} does not exist.`);
        return s;
      };

      // 2. Attack damage by level vs the reference enemy
      const refBattler = makeEnemy(data, reference.id);
      const damageByLevel = classList.map((cls) => ({
        classId: cls.id,
        name: cls.name,
        vsEnemy: `#${reference.id} ${reference.name} (HP ${refBattler.maxHp}, DEF ${refBattler.param(3)})`,
        levels: lv.map((level) => {
          const dmg = Math.max(0, calcDamage(attackSkill(1), makeActor(data, { classId: cls.id, level }, true), refBattler, null).value);
          const htk = hitsToKill(refBattler.maxHp, dmg);
          return `L${level}: ${dmg} dmg, ${htk === null ? "cannot kill" : hits(htk)}`;
        }),
      }));

      // Attackers / defenders
      let specs: { spec: ActorSpec; skillId: number }[] = (attackers ?? []).map((a) => ({
        spec: { actorId: a.actorId, classId: a.classId, level: a.level },
        skillId: a.skillId ?? 1,
      }));
      if (!specs.length) specs = (await partyFromSystem(project, data)).slice(0, 4).map((spec) => ({ spec, skillId: 1 }));
      if (!specs.length) specs = classList.slice(0, 2).map((c) => ({ spec: { classId: c.id, level: 10 }, skillId: 1 }));
      const chars = specs.map(({ spec, skillId }) => ({ b: makeActor(data, spec), skill: attackSkill(skillId) }));
      const label = (c: (typeof chars)[number]): string => `${c.b.name} L${c.b.level} (HP ${c.b.maxHp})`;

      // 3 + 4. Matrices
      const attackRows: string[] = [];
      const threatRows: string[] = [];
      for (const enemy of enemyList) {
        const e = makeEnemy(data, enemy.id);
        const cells = chars.map((c) => {
          const dmg = Math.max(0, calcDamage(c.skill, c.b, e, null).value);
          return { dmg, htk: hitsToKill(e.maxHp, dmg) };
        });
        attackRows.push(`#${enemy.id} ${enemy.name} (HP ${e.maxHp}): ` + cells.map((c, i) => `${chars[i].b.name} ${c.dmg}${c.htk === null ? " (immune)" : ` / ${hits(c.htk)}`}`).join(" | "));
        if (cells.every((c) => c.htk === null)) warnings.push(`Enemy ${enemy.id} "${enemy.name}" cannot be damaged by any listed attacker.`);
        else if (cells.every((c) => c.htk !== null && c.htk <= 1)) warnings.push(`Enemy ${enemy.id} "${enemy.name}" dies in one hit to every listed attacker.`);

        const best = [...(enemy.actions ?? [])]
          .filter((a: Rec) => [1, 5].includes(data.skills[a.skillId]?.damage?.type))
          .sort((a: Rec, b: Rec) => (b.rating ?? 5) - (a.rating ?? 5))[0];
        const skill = (best ? data.skills[best.skillId] : null) ?? data.skills[1];
        if (!skill) continue;
        const tcells = chars.map((c) => {
          const dmg = Math.max(0, calcDamage(skill, e, c.b, null).value);
          return { dmg, htk: hitsToKill(c.b.maxHp, dmg) };
        });
        threatRows.push(`#${enemy.id} ${enemy.name} using ${skill.name}: ` + tcells.map((c, i) => `${chars[i].b.name} takes ${c.dmg}${c.htk === null ? "" : ` (dead in ${c.htk})`}`).join(" | "));
        tcells.forEach((c, i) => {
          if (c.htk === 1 && c.dmg > 0) warnings.push(`Enemy ${enemy.id} "${enemy.name}" can one-shot ${chars[i].b.name} (L${chars[i].b.level}) with ${skill.name}.`);
        });
        if (!enemy.exp && !enemy.gold) warnings.push(`Enemy ${enemy.id} "${enemy.name}" gives no EXP and no gold.`);
      }

      return textResult({
        classCurves,
        damageByLevel,
        attackers: chars.map((c) => `${label(c)} using ${c.skill.name}`),
        attackerVsEnemy: attackRows,
        enemyVsAttackers: threatRows,
        warnings: warnings.slice(0, 60),
        note: "Averages without variance, crits or misses; states, items and AI conditions are not modelled. Use simulate_battle for whole fights.",
      });
    })
  );

  // ---------------------------------------------------------------- simulate
  server.registerTool(
    "simulate_battle",
    {
      title: "Simulate a battle",
      description:
        "Run many simulated battles of a troop against a party and report win rate, turns, how much HP the party keeps and who does the damage or dies. " +
        "Uses the project's real stats (class curves, equipment, traits), damage formulas, variance, critical hits, hit/evasion rates, agility turn order, target weighting (TGR) and enemy action ratings. " +
        "Party members use `skillIds` in order (first affordable one, healing only when an ally is below 60% HP), falling back to the Attack skill. " +
        "Not modelled: states, buffs, items, guarding, TP, enemy conditions on states/switches (treated as false). Seeded, so results are reproducible. Default party: the starting party at their initial level.",
      inputSchema: {
        troopId: z.number().int().min(1),
        party: z
          .array(
            z.object({
              actorId: z.number().int().min(1),
              level: z.number().int().min(1).max(99).optional().describe("Default: the actor's initial level"),
              skillIds: z.array(z.number().int().min(1)).optional().describe("Skills in order of preference (default [1])"),
            })
          )
          .min(1)
          .max(8)
          .optional(),
        level: z.number().int().min(1).max(99).optional().describe("Set every party member to this level"),
        runs: z.number().int().min(1).max(5000).default(300),
        maxTurns: z.number().int().min(1).max(200).default(40),
        seed: z.number().int().default(1),
      },
    },
    safe(async ({ troopId, party, level, runs, maxTurns, seed }) => {
      const data = await loadGameData(project);
      const troop = data.troops[troopId];
      if (!troop) throw new ProjectError(`No troops record with id ${troopId}.`);
      const enemyIds: number[] = [];
      const warnings: string[] = [];
      for (const m of troop.members ?? []) {
        if (data.enemies[m.enemyId]) enemyIds.push(m.enemyId);
        else warnings.push(`Troop member refers to missing enemy ${m.enemyId}; skipped.`);
      }
      if (!enemyIds.length) throw new ProjectError(`Troop ${troopId} has no enemies.`);

      let specs: ActorSpec[] = party ?? (await partyFromSystem(project, data));
      if (!specs.length) throw new ProjectError("No party given and System.json has no starting party members.");
      if (level !== undefined) specs = specs.map((s) => ({ ...s, level }));
      for (const s of specs) {
        const missing = (s.skillIds ?? []).filter((id) => !data.skills[id]);
        if (missing.length) throw new ProjectError(`Skill(s) ${missing.join(", ")} do not exist.`);
      }
      for (const s of specs) {
        if ((data.actors[s.actorId!]?.name ?? "") === "") warnings.push(`Actor ${s.actorId} has no name.`);
      }

      const members = specs.map((s) => makeActor(data, s));
      const result = simulateBattles(data, specs, enemyIds, {
        runs, maxTurns, seed,
        partyLevel: Math.max(...members.map((m) => m.level ?? 1)),
      });

      const pct = (x: number): number => Math.round(x * 1000) / 10;
      let verdict: string;
      if (result.timeoutRate > 0.2) verdict = `Stalls: ${pct(result.timeoutRate)}% of fights are not decided within ${maxTurns} turns - neither side can finish.`;
      else if (result.winRate >= 0.99 && (result.avgPartyHpLeftPercentWhenWon ?? 0) >= 80) verdict = "Trivial: the party wins almost every time with most of its HP.";
      else if (result.winRate >= 0.9) verdict = "Comfortable: the party usually wins, with some losses of HP.";
      else if (result.winRate >= 0.6) verdict = "Challenging: a real fight with a fair chance of losing.";
      else if (result.winRate >= 0.3) verdict = "Hard: the party loses more often than not.";
      else verdict = "Very hard or unwinnable for this party.";

      return textResult({
        troop: `#${troopId} ${troop.name}`,
        party: members.map((m, i) => `${m.name} L${m.level} | ` + PARAM_NAMES.map((n, p) => `${n} ${m.param(p)}`).join(" ") + ` | skills ${JSON.stringify(specs[i].skillIds ?? [1])}`),
        enemies: enemyIds.map((id) => { const e = makeEnemy(data, id); return `${e.name} | ` + PARAM_NAMES.map((n, p) => `${n} ${e.param(p)}`).join(" "); }),
        runs: result.runs,
        winRatePercent: pct(result.winRate),
        lossRatePercent: pct(result.lossRate),
        timeoutPercent: pct(result.timeoutRate),
        avgTurns: Math.round(result.avgTurns * 10) / 10,
        avgTurnsWhenWon: result.avgTurnsWhenWon === null ? null : Math.round(result.avgTurnsWhenWon * 10) / 10,
        partyHpLeftPercentWhenWon: result.avgPartyHpLeftPercentWhenWon === null ? null : Math.round(result.avgPartyHpLeftPercentWhenWon * 10) / 10,
        verdict,
        battlers: result.battlers.map((b) => ({ ...b, deathRate: undefined, deathRatePercent: pct(b.deathRate) })),
        sampleBattle: result.sampleLog.slice(0, 40),
        warnings: warnings.length ? warnings : undefined,
      });
    })
  );
}

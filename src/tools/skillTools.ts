import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";

/**
 * High-level skill creation helpers. Each builds a complete, editor-valid
 * MV skill record so clients don't have to reconstruct all ~20 fields.
 *
 * MV reference values used below:
 *   damage.type: 1 HP damage, 2 MP damage, 3 HP recover, 4 MP recover, 5 HP drain, 6 MP drain
 *   hitType:     0 certain hit, 1 physical, 2 magical
 *   effects:     21 add state, 22 remove state, 31 add buff, 32 add debuff (value1 = chance or turns)
 */

interface MvEffect {
  code: number;
  dataId: number;
  value1: number;
  value2: number;
}

interface MvSkill {
  id: number;
  name: string;
  animationId: number;
  damage: {
    critical: boolean;
    elementId: number;
    formula: string;
    type: number;
    variance: number;
  };
  description: string;
  effects: MvEffect[];
  hitType: number;
  iconIndex: number;
  message1: string;
  message2: string;
  mpCost: number;
  note: string;
  occasion: number;
  repeats: number;
  requiredWtypeId1: number;
  requiredWtypeId2: number;
  scope: number;
  speed: number;
  stypeId: number;
  successRate: number;
  tpCost: number;
  tpGain: number;
}

const SCOPE_DESCRIPTION =
  "Target scope: 1 one enemy, 2 all enemies, 3-6 random enemies (1-4), 7 one ally, 8 all allies, 9 one dead ally, 10 all dead allies, 11 the user";

const scopeSchema = z.number().int().min(0).max(11);

const commonSkillFields = {
  name: z.string(),
  description: z.string().default("").describe("Two-line description shown in menus"),
  mpCost: z.number().int().min(0).default(0),
  tpCost: z.number().int().min(0).default(0),
  iconIndex: z.number().int().min(0).default(0).describe("Icon sheet index"),
  animationId: z
    .number()
    .int()
    .min(-1)
    .default(0)
    .describe("Animation id from the Animations database (0 = none, -1 = normal attack)"),
  stypeId: z.number().int().min(0).default(1).describe("Skill type id (1 = Magic by default)"),
  occasion: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe("When usable: 0 always, 1 battle only, 2 menu only, 3 never"),
  note: z.string().default(""),
};

function baseSkill(id: number, name: string): MvSkill {
  return {
    id,
    name,
    animationId: 0,
    damage: { critical: false, elementId: 0, formula: "0", type: 0, variance: 20 },
    description: "",
    effects: [],
    hitType: 0,
    iconIndex: 0,
    message1: " casts %1!",
    message2: "",
    mpCost: 0,
    note: "",
    occasion: 0,
    repeats: 1,
    requiredWtypeId1: 0,
    requiredWtypeId2: 0,
    scope: 1,
    speed: 0,
    stypeId: 1,
    successRate: 100,
    tpCost: 0,
    tpGain: 0,
  };
}

type CommonArgs = {
  name: string;
  description: string;
  mpCost: number;
  tpCost: number;
  iconIndex: number;
  animationId: number;
  stypeId: number;
  occasion?: number;
  note: string;
};

function applyCommon(skill: MvSkill, args: CommonArgs, defaultOccasion: number): void {
  skill.description = args.description;
  skill.mpCost = args.mpCost;
  skill.tpCost = args.tpCost;
  skill.iconIndex = args.iconIndex;
  skill.animationId = args.animationId;
  skill.stypeId = args.stypeId;
  skill.occasion = args.occasion ?? defaultOccasion;
  skill.note = args.note;
}

async function appendSkill(project: Project, skill: MvSkill): Promise<MvSkill> {
  const records = await project.readDatabase("skills");
  skill.id = records.length;
  records.push(skill);
  await project.writeDatabase("skills", records);
  return skill;
}

export function registerSkillTools(server: McpServer, project: Project): void {
  server.registerTool(
    "create_damage_skill",
    {
      title: "Create damage skill",
      description:
        "Create a complete damaging skill in one call. The formula uses MV damage syntax where `a` is the user and `b` the target, e.g. 'a.mat * 4 - b.mdf * 2' or 'a.atk * 2 - b.def'. Returns the new skill id.",
      inputSchema: {
        ...commonSkillFields,
        formula: z.string().describe("Damage formula, e.g. 'a.mat * 4 - b.mdf * 2'"),
        damageType: z
          .enum(["hp", "mp", "hp_drain", "mp_drain"])
          .default("hp")
          .describe("What the damage hits (drain variants absorb into the user)"),
        elementId: z
          .number()
          .int()
          .min(-1)
          .default(0)
          .describe("Element id from System types (0 = none, -1 = normal attack element)"),
        hitType: z
          .enum(["certain", "physical", "magical"])
          .default("magical")
          .describe("Hit type (affects evasion/reflection rules)"),
        scope: scopeSchema.default(1).describe(SCOPE_DESCRIPTION),
        variance: z.number().int().min(0).max(100).default(20).describe("Damage variance %"),
        critical: z.boolean().default(true).describe("Can critically hit"),
        tpGain: z.number().int().min(0).default(0).describe("TP the user gains on use"),
      },
    },
    safe(async (args) => {
      const skill = baseSkill(0, args.name);
      applyCommon(skill, args, 1);
      skill.damage = {
        critical: args.critical,
        elementId: args.elementId,
        formula: args.formula,
        type: { hp: 1, mp: 2, hp_drain: 5, mp_drain: 6 }[args.damageType],
        variance: args.variance,
      };
      skill.hitType = { certain: 0, physical: 1, magical: 2 }[args.hitType];
      skill.scope = args.scope;
      skill.tpGain = args.tpGain;
      const created = await appendSkill(project, skill);
      return textResult({ created: { type: "skills", id: created.id }, skill: created });
    })
  );

  server.registerTool(
    "create_healing_skill",
    {
      title: "Create healing skill",
      description:
        "Create a complete healing skill in one call. The formula uses MV damage syntax (`a` = user), e.g. 'a.mat * 2 + 200'. Heals HP or MP; optionally also removes states (e.g. a cure spell).",
      inputSchema: {
        ...commonSkillFields,
        formula: z.string().describe("Recovery formula, e.g. 'a.mat * 2 + 200'"),
        recoverType: z.enum(["hp", "mp"]).default("hp"),
        scope: scopeSchema.default(7).describe(SCOPE_DESCRIPTION + " (default: one ally)"),
        variance: z.number().int().min(0).max(100).default(20),
        removeStates: z
          .array(z.number().int().min(1))
          .default([])
          .describe("State ids to remove from the target (100% chance), e.g. poison"),
      },
    },
    safe(async (args) => {
      const skill = baseSkill(0, args.name);
      applyCommon(skill, args, 0);
      skill.damage = {
        critical: false,
        elementId: 0,
        formula: args.formula,
        type: args.recoverType === "hp" ? 3 : 4,
        variance: args.variance,
      };
      skill.hitType = 0;
      skill.scope = args.scope;
      skill.effects = args.removeStates.map((stateId) => ({
        code: 22,
        dataId: stateId,
        value1: 1,
        value2: 0,
      }));
      const created = await appendSkill(project, skill);
      return textResult({ created: { type: "skills", id: created.id }, skill: created });
    })
  );

  server.registerTool(
    "create_buff_skill",
    {
      title: "Create buff/debuff skill",
      description:
        "Create a skill that applies parameter buffs and/or debuffs. Parameter ids: 0 Max HP, 1 Max MP, 2 Attack, 3 Defense, 4 M.Attack, 5 M.Defense, 6 Agility, 7 Luck. If only debuffs are given the scope defaults to one enemy, otherwise one ally.",
      inputSchema: {
        ...commonSkillFields,
        buffs: z
          .array(
            z.object({
              param: z.number().int().min(0).max(7).describe("Parameter id (0-7)"),
              turns: z.number().int().min(1).default(5),
            })
          )
          .default([])
          .describe("Buffs to add to the target"),
        debuffs: z
          .array(
            z.object({
              param: z.number().int().min(0).max(7).describe("Parameter id (0-7)"),
              turns: z.number().int().min(1).default(5),
            })
          )
          .default([])
          .describe("Debuffs to add to the target"),
        scope: scopeSchema.optional().describe(SCOPE_DESCRIPTION),
      },
    },
    safe(async (args) => {
      if (args.buffs.length === 0 && args.debuffs.length === 0) {
        throw new ProjectError("Provide at least one buff or debuff.");
      }
      const skill = baseSkill(0, args.name);
      applyCommon(skill, args, 1);
      const debuffOnly = args.buffs.length === 0;
      skill.scope = args.scope ?? (debuffOnly ? 1 : 7);
      skill.hitType = debuffOnly ? 2 : 0;
      skill.effects = [
        ...args.buffs.map((b) => ({ code: 31, dataId: b.param, value1: b.turns, value2: 0 })),
        ...args.debuffs.map((d) => ({ code: 32, dataId: d.param, value1: d.turns, value2: 0 })),
      ];
      const created = await appendSkill(project, skill);
      return textResult({ created: { type: "skills", id: created.id }, skill: created });
    })
  );

  server.registerTool(
    "create_state_skill",
    {
      title: "Create state skill",
      description:
        "Create a skill that adds or removes states (poison, sleep, etc.) on the target, each with its own success chance. State ids come from the States database (list_records type=states).",
      inputSchema: {
        ...commonSkillFields,
        action: z.enum(["add", "remove"]).default("add"),
        states: z
          .array(
            z.object({
              stateId: z.number().int().min(1),
              chance: z.number().min(0).max(100).default(100).describe("Success chance in %"),
            })
          )
          .min(1)
          .describe("States to add/remove"),
        scope: scopeSchema.optional().describe(SCOPE_DESCRIPTION + " (default: one enemy for add, one ally for remove)"),
      },
    },
    safe(async (args) => {
      const skill = baseSkill(0, args.name);
      applyCommon(skill, args, 1);
      const adding = args.action === "add";
      skill.scope = args.scope ?? (adding ? 1 : 7);
      skill.hitType = adding ? 2 : 0;
      skill.effects = args.states.map((s) => ({
        code: adding ? 21 : 22,
        dataId: s.stateId,
        value1: s.chance / 100,
        value2: 0,
      }));
      const created = await appendSkill(project, skill);
      return textResult({ created: { type: "skills", id: created.id }, skill: created });
    })
  );
}

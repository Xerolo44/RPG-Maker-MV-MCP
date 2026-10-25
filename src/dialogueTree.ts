// Compiles a nested dialogue tree (say / choices / if / switches / transfer, plus cutscene presentation
// nodes: screen effects, audio, pictures, animations and move routes, and game-flow nodes: battles, shops,
// party and inventory changes, labels, scenes) into an RPG Maker MV event command list with correct
// indents and block terminators.
import { z } from "zod";
import { branchEnd, cmd, type Cmd } from "./commandList.js";
import { shopCommands } from "./shopCommands.js";

export const MAX_DIALOGUE_DEPTH = 8;
export const MAX_CHOICES = 6;
const LINES_PER_BOX = 4;

export type Condition =
  | { switch: number; is?: boolean }
  | { variable: number; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: number }
  | { selfSwitch: "A" | "B" | "C" | "D"; is?: boolean }
  | { gold: number }
  | { item: number };

/** Who a presentation node acts on: the player, the running event, or an event id. */
export type Target = "player" | "this" | number;

const ROUTE_CODES = {
  down: 1, left: 2, right: 3, up: 4,
  turnDown: 16, turnLeft: 17, turnRight: 18, turnUp: 19,
  walkAnimOn: 31, walkAnimOff: 32, stepAnimOn: 33, stepAnimOff: 34,
  dirFixOn: 35, dirFixOff: 36, throughOn: 37, throughOff: 38, transparentOn: 39, transparentOff: 40,
} as const;

export type RouteStep =
  | keyof typeof ROUTE_CODES
  | { jump: { x: number; y: number } }
  | { wait: number }
  | { switchOn: number }
  | { switchOff: number }
  | { speed: number }
  | { frequency: number };

export type PresentationNode =
  | { wait: number }
  | { fade: "out" | "in" }
  | { tint: { r: number; g: number; b: number; gray: number; frames?: number; wait?: boolean } }
  | { flash: { r: number; g: number; b: number; intensity: number; frames?: number; wait?: boolean } }
  | { shake: { power?: number; speed?: number; frames?: number; wait?: boolean } }
  | { weather: { type: "none" | "rain" | "storm" | "snow"; power?: number; frames?: number; wait?: boolean } }
  | { playAudio: { kind: "bgm" | "bgs" | "me" | "se"; name: string; volume?: number; pitch?: number; pan?: number } }
  | { fadeAudio: { kind: "bgm" | "bgs"; seconds: number } }
  | {
      showPicture: {
        id: number;
        name: string;
        origin?: "upperLeft" | "center";
        x: number;
        y: number;
        scaleX?: number;
        scaleY?: number;
        opacity?: number;
        blend?: "normal" | "add" | "multiply" | "screen";
      };
    }
  | { erasePicture: number }
  | { animation: { target: Target; animationId: number; wait?: boolean } }
  | { balloon: { target: Target; balloonId: number; wait?: boolean } }
  | { moveRoute: { target: Target; steps: RouteStep[]; repeat?: boolean; skippable?: boolean; wait?: boolean } };

export type ShopGood = { type: "item" | "weapon" | "armor"; id: number; price?: number };

export type FlowNode =
  | {
      battle: {
        troopId: number;
        canEscape?: boolean;
        canLose?: boolean;
        onWin?: DialogueNode[];
        onEscape?: DialogueNode[];
        onLose?: DialogueNode[];
      };
    }
  | { shop: { goods: ShopGood[]; purchaseOnly?: boolean } }
  | { callCommon: number }
  | { label: string }
  | { jump: string }
  | { exit: true }
  | { comment: string | string[] }
  | { gold: number }
  | { item: { kind: "item" | "weapon" | "armor"; id: number; count: number } }
  | { party: { actorId: number; action: "add" | "remove"; initialize?: boolean } }
  | { learnSkill: { actorId: number; skillId: number; forget?: boolean } }
  | { recoverAll: true }
  | { nameInput: { actorId: number; maxChars: number } }
  | { plugin: string }
  | { scene: "menu" | "save" | "gameOver" | "title" };

export type DialogueNode =
  | PresentationNode
  | FlowNode
  | { say: string | string[]; face?: { name: string; index: number }; background?: 0 | 1 | 2; position?: 0 | 1 | 2 }
  | { choices: { label: string; then?: DialogueNode[] }[]; cancel?: "disallow" | "branch" | number }
  | { if: Condition; then?: DialogueNode[]; else?: DialogueNode[] }
  | { setSwitch: { id: number; value: boolean } }
  | { setVariable: { id: number; op: "set" | "add" | "sub"; value: number } }
  | { setSelfSwitch: { ch: "A" | "B" | "C" | "D"; value: boolean } }
  | { transfer: { mapId: number; x: number; y: number; direction?: 0 | 2 | 4 | 6 | 8; fade?: 0 | 1 | 2 } }
  | { raw: Cmd[] };

/** Show Text (101) + one 401 per line, starting a new message box every 4 lines. */
export function messageCommands(
  lines: string[],
  face: string,
  faceIndex: number,
  background: number,
  position: number,
  indent: number,
): Cmd[] {
  const out: Cmd[] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_BOX) {
    out.push(cmd(101, indent, face, faceIndex, background, position));
    for (const line of lines.slice(i, i + LINES_PER_BOX)) out.push(cmd(401, indent, line));
  }
  return out;
}

// ---------------------------------------------------------------- schema

const switchCh = z.enum(["A", "B", "C", "D"]);

const conditionSchema = z.union([
  z.object({ switch: z.number().int().min(1), is: z.boolean().optional() }).strict(),
  z
    .object({
      variable: z.number().int().min(1),
      op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
      value: z.number().int(),
    })
    .strict(),
  z.object({ selfSwitch: switchCh, is: z.boolean().optional() }).strict(),
  z.object({ gold: z.number().int().min(0) }).strict(),
  z.object({ item: z.number().int().min(1) }).strict(),
]);

const rawCmdSchema = z.object({
  code: z.number().int().min(0),
  indent: z.number().int().min(0).default(0),
  parameters: z.array(z.unknown()).default([]),
});

// Presentation nodes. Defaults are applied by the compiler, not stored here, so the schema output is the input.

const intIn = (min: number, max: number) => z.number().int().min(min).max(max);
const frames = intIn(1, 600);
const optionalBool = z.boolean().optional();
// Audio and picture names end up in event parameters; keep newlines, NUL and other control characters out.
const assetName = z.string().max(255).regex(/^[^\u0000-\u001f\u007f]*$/, "name must not contain control characters (newlines, NUL, ...)");

const targetSchema = z.union([z.literal("player"), z.literal("this"), z.number().int().min(1)], {
  errorMap: (issue, ctx) =>
    issue.code === "invalid_union"
      ? { message: 'target must be "player", "this" or a positive event id' }
      : { message: ctx.defaultError },
});

const STEP_HELP =
  "Invalid move route step: use one of " +
  `${Object.keys(ROUTE_CODES).join(", ")} or {jump: {x, y}}, {wait: 1-999}, {switchOn: id}, {switchOff: id}, {speed: 1-6}, {frequency: 1-5}.`;

const routeStepUnion = z.union(
  [
    z.enum(Object.keys(ROUTE_CODES) as [keyof typeof ROUTE_CODES, ...(keyof typeof ROUTE_CODES)[]]),
    z.object({ jump: z.object({ x: intIn(-1000, 1000), y: intIn(-1000, 1000) }).strict() }).strict(),
    z.object({ wait: intIn(1, 999) }).strict(),
    z.object({ switchOn: z.number().int().min(1) }).strict(),
    z.object({ switchOff: z.number().int().min(1) }).strict(),
    z.object({ speed: intIn(1, 6) }).strict(),
    z.object({ frequency: intIn(1, 5) }).strict(),
  ],
  { errorMap: (issue, ctx) => (issue.code === "invalid_union" ? { message: STEP_HELP } : { message: ctx.defaultError }) },
);

// A custom check (not the union itself) so a bad step is reported as one clear issue instead of an aborted union.
const routeStepSchema = z.custom<RouteStep>().superRefine((step, ctx) => {
  const r = routeStepUnion.safeParse(step);
  if (!r.success) for (const issue of r.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path });
});

const presentationSchemas = {
  wait: z.object({ wait: intIn(1, 6000) }).strict(),
  fade: z.object({ fade: z.enum(["out", "in"]) }).strict(),
  tint: z
    .object({
      tint: z
        .object({ r: intIn(-255, 255), g: intIn(-255, 255), b: intIn(-255, 255), gray: intIn(0, 255), frames: frames.optional(), wait: optionalBool })
        .strict(),
    })
    .strict(),
  flash: z
    .object({
      flash: z
        .object({ r: intIn(0, 255), g: intIn(0, 255), b: intIn(0, 255), intensity: intIn(0, 255), frames: frames.optional(), wait: optionalBool })
        .strict(),
    })
    .strict(),
  shake: z
    .object({
      shake: z.object({ power: intIn(1, 9).optional(), speed: intIn(1, 9).optional(), frames: frames.optional(), wait: optionalBool }).strict(),
    })
    .strict(),
  weather: z
    .object({
      weather: z
        .object({ type: z.enum(["none", "rain", "storm", "snow"]), power: intIn(1, 9).optional(), frames: frames.optional(), wait: optionalBool })
        .strict(),
    })
    .strict(),
  playAudio: z
    .object({
      playAudio: z
        .object({
          kind: z.enum(["bgm", "bgs", "me", "se"]),
          name: assetName,
          volume: intIn(0, 100).optional(),
          pitch: intIn(50, 150).optional(),
          pan: intIn(-100, 100).optional(),
        })
        .strict(),
    })
    .strict(),
  fadeAudio: z.object({ fadeAudio: z.object({ kind: z.enum(["bgm", "bgs"]), seconds: intIn(1, 60) }).strict() }).strict(),
  showPicture: z
    .object({
      showPicture: z
        .object({
          id: intIn(1, 100),
          name: assetName.min(1, "name must not be empty"),
          origin: z.enum(["upperLeft", "center"]).optional(),
          x: z.number().int(),
          y: z.number().int(),
          scaleX: intIn(0, 2000).optional(),
          scaleY: intIn(0, 2000).optional(),
          opacity: intIn(0, 255).optional(),
          blend: z.enum(["normal", "add", "multiply", "screen"]).optional(),
        })
        .strict(),
    })
    .strict(),
  erasePicture: z.object({ erasePicture: intIn(1, 100) }).strict(),
  animation: z
    .object({ animation: z.object({ target: targetSchema, animationId: z.number().int().min(1), wait: optionalBool }).strict() })
    .strict(),
  balloon: z.object({ balloon: z.object({ target: targetSchema, balloonId: intIn(1, 10), wait: optionalBool }).strict() }).strict(),
  moveRoute: z
    .object({
      moveRoute: z
        .object({
          target: targetSchema,
          steps: z.array(routeStepSchema).min(1, "moveRoute needs at least 1 step").max(100, "moveRoute allows at most 100 steps"),
          repeat: optionalBool,
          skippable: optionalBool,
          wait: optionalBool,
        })
        .strict()
        .superRefine((m, ctx) => {
          if (m.repeat === true && m.wait === true) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["wait"],
              message: "a repeating route never finishes, so the event cannot wait for it (use wait: false, or omit wait)",
            });
          }
        }),
    })
    .strict(),
} as const;

// Game-flow nodes without nested bodies (battle, which nests, is handled separately).

const GOODS_KINDS = ["item", "weapon", "armor"] as const;
const SCENE_CODES = { menu: 351, save: 352, gameOver: 353, title: 354 } as const;
const MAX_GOLD = 99999999; // $gameParty.maxGold()
const MAX_ITEM_COUNT = 99; // default $gameParty.maxItems(); the editor's constant operand stops there too
// A single event-command line (label, plugin command): no NUL, escapes or line breaks.
// NEL and the Unicode line/paragraph separators (U+0085, U+2028, U+2029) count as line breaks too.
const singleLine = (what: string) =>
  z.string().regex(/^[^\u0000-\u001f\u007f\u0085\u2028\u2029]*$/, `${what} must not contain control characters (newlines, NUL, ...)`);
const nonEmptyLine = (what: string) => singleLine(what).min(1, `${what} must not be empty`);
const actorId = z.number().int().min(1);

/** The rows of a comment: line breaks split it, and trailing empty rows (a final newline) are dropped. */
function commentLines(value: string | string[]): string[] {
  const lines = (Array.isArray(value) ? value : [value]).flatMap((l) => l.split(/\r?\n/));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const commentSchema = z
  .union([z.string(), z.array(z.string())], {
    errorMap: (issue, ctx) =>
      issue.code === "invalid_union" ? { message: "comment must be a string or an array of strings" } : { message: ctx.defaultError },
  })
  .superRefine((value, ctx) => {
    const lines = typeof value === "string" ? [value] : value;
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (lines.length === 0) return fail("comment needs at least one line");
    if (commentLines(value).length === 0) return fail("comment must not be empty");
    // line breaks split the comment into 408 rows and tabs are fine; other control characters are not
    if (lines.some((l) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(l))) {
      fail("comment must not contain control characters (other than line breaks)");
    }
  });

const flowSchemas = {
  shop: z
    .object({
      shop: z
        .object({
          goods: z
            .array(z.object({ type: z.enum(GOODS_KINDS), id: z.number().int().min(1), price: z.number().int().min(0).optional() }).strict())
            .min(1, "shop needs at least 1 good")
            .max(40, "shop allows at most 40 goods"),
          purchaseOnly: optionalBool,
        })
        .strict(),
    })
    .strict(),
  callCommon: z.object({ callCommon: z.number().int().min(1) }).strict(),
  label: z.object({ label: nonEmptyLine("label") }).strict(),
  jump: z.object({ jump: nonEmptyLine("jump label") }).strict(),
  exit: z.object({ exit: z.literal(true) }).strict(),
  comment: z.object({ comment: commentSchema }).strict(),
  gold: z
    .object({ gold: intIn(-MAX_GOLD, MAX_GOLD).refine((n) => n !== 0, "gold must not be 0 (positive gives gold, negative takes it)") })
    .strict(),
  item: z
    .object({
      item: z
        .object({
          kind: z.enum(GOODS_KINDS),
          id: z.number().int().min(1),
          count: intIn(-MAX_ITEM_COUNT, MAX_ITEM_COUNT).refine((n) => n !== 0, "count must not be 0 (positive adds, negative removes)"),
        })
        .strict(),
    })
    .strict(),
  party: z.object({ party: z.object({ actorId, action: z.enum(["add", "remove"]), initialize: optionalBool }).strict() }).strict(),
  learnSkill: z.object({ learnSkill: z.object({ actorId, skillId: z.number().int().min(1), forget: optionalBool }).strict() }).strict(),
  recoverAll: z.object({ recoverAll: z.literal(true) }).strict(),
  nameInput: z.object({ nameInput: z.object({ actorId, maxChars: intIn(1, 16) }).strict() }).strict(),
  plugin: z.object({ plugin: nonEmptyLine("plugin command") }).strict(),
  scene: z.object({ scene: z.enum(["menu", "save", "gameOver", "title"]) }).strict(),
} as const;

// battle: the head fields are shared by the recursive node schema (branch bodies are node arrays) and the
// compiler's own check (the branch bodies are checked as they are compiled).
const battleHead = {
  troopId: z.number().int().min(1),
  canEscape: optionalBool,
  canLose: optionalBool,
};

function battleRules(b: { canEscape?: boolean; canLose?: boolean; onEscape?: unknown[]; onLose?: unknown[] }, ctx: z.RefinementCtx): void {
  // An escape / lose branch the battle can never reach is an authoring mistake, not something to emit silently.
  if (b.onEscape && b.onEscape.length > 0 && b.canEscape !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["onEscape"], message: "onEscape needs canEscape: true, otherwise that branch can never run" });
  }
  if (b.onLose && b.onLose.length > 0 && b.canLose !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["onLose"], message: "onLose needs canLose: true, otherwise that branch can never run" });
  }
}

const battleCheckSchema = z
  .object({
    battle: z
      .object({ ...battleHead, onWin: z.array(z.unknown()).optional(), onEscape: z.array(z.unknown()).optional(), onLose: z.array(z.unknown()).optional() })
      .strict()
      .superRefine(battleRules),
  })
  .strict();

const leafSchemas = { ...presentationSchemas, ...flowSchemas } as const;
type LeafKey = keyof typeof leafSchemas;
const LEAF_KEYS = Object.keys(leafSchemas) as LeafKey[];

const nodeSchema: z.ZodType<DialogueNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    z
      .object({
        say: z.union([z.string().min(1, "say must not be empty"), z.array(z.string().min(1, "say lines must not be empty")).min(1, "say must have at least one line")]),
        face: z.object({ name: z.string(), index: z.number().int().min(0).max(7) }).strict().optional(),
        background: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        position: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
      })
      .strict(),
    z
      .object({
        choices: z
          .array(z.object({ label: z.string().min(1, "choice label must not be empty"), then: z.array(nodeSchema).optional() }).strict())
          .min(1, "choices must have at least 1 entry")
          .max(MAX_CHOICES, `choices must have at most ${MAX_CHOICES} entries`),
        cancel: z.union([z.enum(["disallow", "branch"]), z.number().int().min(0).max(MAX_CHOICES - 1)]).optional(),
      })
      .strict(),
    z.object({ if: conditionSchema, then: z.array(nodeSchema).optional(), else: z.array(nodeSchema).optional() }).strict(),
    z.object({ setSwitch: z.object({ id: z.number().int().min(1), value: z.boolean() }).strict() }).strict(),
    z
      .object({
        setVariable: z.object({ id: z.number().int().min(1), op: z.enum(["set", "add", "sub"]), value: z.number().int() }).strict(),
      })
      .strict(),
    z.object({ setSelfSwitch: z.object({ ch: switchCh, value: z.boolean() }).strict() }).strict(),
    z
      .object({
        transfer: z
          .object({
            mapId: z.number().int().min(1),
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            direction: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).optional(),
            fade: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ raw: z.array(rawCmdSchema).min(1, "raw must have at least one command") }).strict(),
    z
      .object({
        battle: z
          .object({
            ...battleHead,
            onWin: z.array(nodeSchema).optional(),
            onEscape: z.array(nodeSchema).optional(),
            onLose: z.array(nodeSchema).optional(),
          })
          .strict()
          .superRefine(battleRules),
      })
      .strict(),
    ...Object.values(presentationSchemas),
    ...Object.values(flowSchemas),
  ]),
);

function depthOf(nodes: readonly DialogueNode[] | undefined): number {
  let max = 0;
  for (const n of nodes ?? []) {
    let d = 1;
    if ("choices" in n) d += Math.max(0, ...n.choices.map((c) => depthOf(c.then)));
    else if ("if" in n) d += Math.max(depthOf(n.then), depthOf(n.else));
    else if ("battle" in n) d += Math.max(depthOf(n.battle.onWin), depthOf(n.battle.onEscape), depthOf(n.battle.onLose));
    max = Math.max(max, d);
  }
  return max;
}

const depthMessage = (depth: number) =>
  `Dialogue tree is nested ${depth} levels deep (choices/if/battle bodies count as a level); the maximum is ${MAX_DIALOGUE_DEPTH}.`;

/** A single dialogue node, recursively validated; nesting deeper than 8 levels is rejected. */
export const dialogueNodeSchema: z.ZodType<DialogueNode, z.ZodTypeDef, unknown> = nodeSchema.superRefine((node, ctx) => {
  const depth = depthOf([node]);
  if (depth > MAX_DIALOGUE_DEPTH) ctx.addIssue({ code: z.ZodIssueCode.custom, message: depthMessage(depth) });
});

// --------------------------------------------------------------- compile

const VAR_OPS = { eq: 0, gte: 1, lte: 2, gt: 3, lt: 4, ne: 5 } as const;
const VAR_ASSIGN = { set: 0, add: 1, sub: 2 } as const;

function conditionParams(c: Condition): unknown[] {
  if ("switch" in c) return [0, c.switch, c.is === false ? 1 : 0];
  if ("variable" in c) return [1, c.variable, 0, c.value, VAR_OPS[c.op]];
  if ("selfSwitch" in c) return [2, c.selfSwitch, c.is === false ? 1 : 0];
  if ("gold" in c) return [7, c.gold, 0];
  return [8, c.item];
}

/** Event id for a presentation target: the player is -1, the running event 0, otherwise a positive event id. */
export function resolveTarget(t: Target): number {
  if (t === "player") return -1;
  if (t === "this") return 0;
  if (typeof t === "number" && Number.isInteger(t) && t >= 1) return t;
  throw new Error(`Invalid target ${JSON.stringify(t)}: target must be "player", "this" or a positive event id.`);
}

function routeCommand(step: RouteStep): { code: number; parameters: unknown[]; indent: null } {
  const route = (code: number, ...parameters: unknown[]) => ({ code, parameters, indent: null });
  if (typeof step === "string") return route(ROUTE_CODES[step]);
  if ("jump" in step) return route(14, step.jump.x, step.jump.y);
  if ("wait" in step) return route(15, step.wait);
  if ("switchOn" in step) return route(27, step.switchOn);
  if ("switchOff" in step) return route(28, step.switchOff);
  if ("speed" in step) return route(29, step.speed);
  return route(30, step.frequency);
}

const AUDIO_CODES = { bgm: 241, bgs: 245, me: 249, se: 250 } as const;
const BLEND_MODES = { normal: 0, add: 1, multiply: 2, screen: 3 } as const;

type LeafNode = Exclude<PresentationNode | FlowNode, { battle: unknown }>;

/** Validates a node without nested bodies against its schema (so direct callers get the same limits) and compiles it. */
function leafCommands(n: LeafNode, indent: number): Cmd[] {
  const key = LEAF_KEYS.find((k) => k in n);
  if (key === undefined) throw new Error(`Unknown dialogue node: ${JSON.stringify(n)}`);
  const checked = leafSchemas[key].safeParse(n);
  if (!checked.success) {
    const detail = checked.error.issues.map((i) => `${i.path.join(".") || key}: ${i.message}`).join("; ");
    throw new Error(`Invalid ${key} node: ${detail}`);
  }
  if ("shop" in n) return shopCommands(n.shop.goods, n.shop.purchaseOnly ?? false, indent);
  if ("callCommon" in n) return [cmd(117, indent, n.callCommon)];
  if ("label" in n) return [cmd(118, indent, n.label)];
  if ("jump" in n) return [cmd(119, indent, n.jump)];
  if ("exit" in n) return [cmd(115, indent)];
  if ("comment" in n) {
    return commentLines(n.comment).map((line, i) => cmd(i === 0 ? 108 : 408, indent, line));
  }
  if ("gold" in n) return [cmd(125, indent, n.gold > 0 ? 0 : 1, 0, Math.abs(n.gold))];
  if ("item" in n) {
    const { kind, id, count } = n.item;
    const op = count > 0 ? 0 : 1;
    const amount = Math.abs(count);
    return [kind === "item" ? cmd(126, indent, id, op, 0, amount) : cmd(kind === "weapon" ? 127 : 128, indent, id, op, 0, amount, false)];
  }
  if ("party" in n) return [cmd(129, indent, n.party.actorId, n.party.action === "add" ? 0 : 1, n.party.initialize ? 1 : 0)];
  if ("learnSkill" in n) return [cmd(318, indent, 0, n.learnSkill.actorId, n.learnSkill.forget ? 1 : 0, n.learnSkill.skillId)];
  if ("recoverAll" in n) return [cmd(314, indent, 0, 0)];
  if ("nameInput" in n) return [cmd(303, indent, n.nameInput.actorId, n.nameInput.maxChars)];
  if ("plugin" in n) return [cmd(356, indent, n.plugin)];
  if ("scene" in n) return [cmd(SCENE_CODES[n.scene], indent)];
  if ("wait" in n) return [cmd(230, indent, n.wait)];
  if ("fade" in n) return [cmd(n.fade === "out" ? 221 : 222, indent)];
  if ("tint" in n) {
    const t = n.tint;
    return [cmd(223, indent, [t.r, t.g, t.b, t.gray], t.frames ?? 60, t.wait ?? true)];
  }
  if ("flash" in n) {
    const f = n.flash;
    return [cmd(224, indent, [f.r, f.g, f.b, f.intensity], f.frames ?? 60, f.wait ?? true)];
  }
  if ("shake" in n) {
    const s = n.shake;
    return [cmd(225, indent, s.power ?? 5, s.speed ?? 5, s.frames ?? 30, s.wait ?? true)];
  }
  if ("weather" in n) {
    const w = n.weather;
    return [cmd(236, indent, w.type, w.power ?? 5, w.frames ?? 60, w.wait ?? false)];
  }
  if ("playAudio" in n) {
    const a = n.playAudio;
    return [cmd(AUDIO_CODES[a.kind], indent, { name: a.name, volume: a.volume ?? 90, pitch: a.pitch ?? 100, pan: a.pan ?? 0 })];
  }
  if ("fadeAudio" in n) return [cmd(n.fadeAudio.kind === "bgm" ? 242 : 246, indent, n.fadeAudio.seconds)];
  if ("showPicture" in n) {
    const p = n.showPicture;
    const origin = p.origin === "center" ? 1 : 0;
    const blend = BLEND_MODES[p.blend ?? "normal"];
    return [cmd(231, indent, p.id, p.name, origin, 0, p.x, p.y, p.scaleX ?? 100, p.scaleY ?? 100, p.opacity ?? 255, blend)];
  }
  if ("erasePicture" in n) return [cmd(235, indent, n.erasePicture)];
  if ("animation" in n) {
    const a = n.animation;
    return [cmd(212, indent, resolveTarget(a.target), a.animationId, a.wait ?? true)];
  }
  if ("balloon" in n) {
    const b = n.balloon;
    return [cmd(213, indent, resolveTarget(b.target), b.balloonId, b.wait ?? true)];
  }
  const m = n.moveRoute;
  const route = {
    list: [...m.steps.map(routeCommand), { code: 0, parameters: [] }],
    repeat: m.repeat ?? false,
    skippable: m.skippable ?? false,
    // A repeating route never finishes, so waiting for it would freeze the event: default to not waiting.
    wait: m.wait ?? m.repeat !== true,
  };
  // The 505 rows repeat the route commands (without the terminator) as separate objects.
  return [cmd(205, indent, resolveTarget(m.target), route), ...m.steps.map((step) => cmd(505, indent, routeCommand(step)))];
}

/**
 * Compiles the body of a block branch and ends it with the blank row the MV editor writes there: `{code:0}` at the body's
 * indent, also for an empty branch (which then consists of that row alone). The engine skips code 0 rows.
 */
function compileBranch(nodes: readonly DialogueNode[] | undefined, indent: number, depth: number, out: Cmd[]): void {
  compileNodes(nodes, indent, depth, out);
  out.push(branchEnd(indent));
}

function compileNodes(nodes: readonly DialogueNode[] | undefined, indent: number, depth: number, out: Cmd[]): void {
  if (!nodes || nodes.length === 0) return;
  if (depth > MAX_DIALOGUE_DEPTH) throw new Error(depthMessage(depth));
  for (const n of nodes) {
    if ("say" in n) {
      const lines = (Array.isArray(n.say) ? n.say : [n.say]).flatMap((l) => l.split(/\r?\n/));
      if (lines.every((l) => l === "")) throw new Error("A say node must contain some text.");
      out.push(...messageCommands(lines, n.face?.name ?? "", n.face?.index ?? 0, n.background ?? 0, n.position ?? 2, indent));
    } else if ("choices" in n) {
      const { choices } = n;
      if (choices.length < 1 || choices.length > MAX_CHOICES) {
        throw new Error(`A choices node needs 1-${MAX_CHOICES} entries, got ${choices.length}.`);
      }
      if (choices.some((c) => typeof c.label !== "string" || c.label === "")) {
        throw new Error("Every choice needs a non-empty label.");
      }
      const cancel = n.cancel ?? "disallow";
      if (typeof cancel === "number" && (!Number.isInteger(cancel) || cancel < 0 || cancel >= choices.length)) {
        throw new Error(`cancel ${cancel} is not a valid choice index (0-${choices.length - 1}).`);
      }
      const cancelType = cancel === "disallow" ? -1 : cancel === "branch" ? -2 : cancel;
      out.push(cmd(102, indent, choices.map((c) => c.label), cancelType, 0, 2, 0));
      choices.forEach((c, i) => {
        out.push(cmd(402, indent, i, c.label));
        compileBranch(c.then, indent + 1, depth + 1, out);
      });
      if (cancel === "branch") {
        out.push(cmd(403, indent));
        compileBranch(undefined, indent + 1, depth + 1, out);
      }
      out.push(cmd(404, indent));
    } else if ("if" in n) {
      out.push(cmd(111, indent, ...conditionParams(n.if)));
      compileBranch(n.then, indent + 1, depth + 1, out);
      if (n.else !== undefined && n.else.length > 0) {
        out.push(cmd(411, indent));
        compileBranch(n.else, indent + 1, depth + 1, out);
      }
      out.push(cmd(412, indent));
    } else if ("setSwitch" in n) {
      out.push(cmd(121, indent, n.setSwitch.id, n.setSwitch.id, n.setSwitch.value ? 0 : 1));
    } else if ("setVariable" in n) {
      const v = n.setVariable;
      out.push(cmd(122, indent, v.id, v.id, VAR_ASSIGN[v.op], 0, v.value));
    } else if ("setSelfSwitch" in n) {
      out.push(cmd(123, indent, n.setSelfSwitch.ch, n.setSelfSwitch.value ? 0 : 1));
    } else if ("transfer" in n) {
      const t = n.transfer;
      out.push(cmd(201, indent, 0, t.mapId, t.x, t.y, t.direction ?? 0, t.fade ?? 0));
    } else if ("raw" in n) {
      for (const c of n.raw) out.push({ code: c.code, indent: (c.indent ?? 0) + indent, parameters: c.parameters ?? [] });
    } else if ("battle" in n) {
      const checked = battleCheckSchema.safeParse(n);
      if (!checked.success) {
        const detail = checked.error.issues.map((i) => `${i.path.slice(1).join(".") || "battle"}: ${i.message}`).join("; ");
        throw new Error(`Invalid battle node: ${detail}`);
      }
      const b = n.battle;
      const canEscape = b.canEscape === true;
      const canLose = b.canLose === true;
      out.push(cmd(301, indent, 0, b.troopId, canEscape, canLose));
      // The editor writes branches only when "Can Escape" or "Continue when Loss" is on (If Win, plus If Escape /
      // If Lose for the boxes that are checked, each even when empty) and closes them with 604. A battle with
      // neither box and no win body is the lone 301, so the commands after it simply run after the battle.
      const winBody = b.onWin ?? [];
      if (canEscape || canLose || winBody.length > 0) {
        out.push(cmd(601, indent));
        compileBranch(winBody, indent + 1, depth + 1, out);
        if (canEscape) {
          out.push(cmd(602, indent));
          compileBranch(b.onEscape, indent + 1, depth + 1, out);
        }
        if (canLose) {
          out.push(cmd(603, indent));
          compileBranch(b.onLose, indent + 1, depth + 1, out);
        }
        out.push(cmd(604, indent));
      }
    } else {
      out.push(...leafCommands(n, indent));
    }
  }
}

/**
 * Compiles a dialogue tree to event commands starting at `indent`. The result has no
 * terminator: callers wrap it with `terminated(...)` or insert it into an existing list.
 */
export function compileDialogue(tree: DialogueNode[], indent = 0): Cmd[] {
  const out: Cmd[] = [];
  compileNodes(tree, indent, 1, out);
  return out;
}

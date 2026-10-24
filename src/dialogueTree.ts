// Compiles a nested dialogue tree (say / choices / if / switches / transfer) into an
// RPG Maker MV event command list with correct indents and block terminators.
import { z } from "zod";
import { cmd, type Cmd } from "./commandList.js";

export const MAX_DIALOGUE_DEPTH = 8;
export const MAX_CHOICES = 6;
const LINES_PER_BOX = 4;

export type Condition =
  | { switch: number; is?: boolean }
  | { variable: number; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: number }
  | { selfSwitch: "A" | "B" | "C" | "D"; is?: boolean }
  | { gold: number }
  | { item: number };

export type DialogueNode =
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
  ]),
);

function depthOf(nodes: readonly DialogueNode[] | undefined): number {
  let max = 0;
  for (const n of nodes ?? []) {
    let d = 1;
    if ("choices" in n) d += Math.max(0, ...n.choices.map((c) => depthOf(c.then)));
    else if ("if" in n) d += Math.max(depthOf(n.then), depthOf(n.else));
    max = Math.max(max, d);
  }
  return max;
}

const depthMessage = (depth: number) =>
  `Dialogue tree is nested ${depth} levels deep (choices/if bodies count as a level); the maximum is ${MAX_DIALOGUE_DEPTH}.`;

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
        compileNodes(c.then, indent + 1, depth + 1, out);
      });
      if (cancel === "branch") out.push(cmd(403, indent));
      out.push(cmd(404, indent));
    } else if ("if" in n) {
      out.push(cmd(111, indent, ...conditionParams(n.if)));
      compileNodes(n.then, indent + 1, depth + 1, out);
      if (n.else !== undefined && n.else.length > 0) {
        out.push(cmd(411, indent));
        compileNodes(n.else, indent + 1, depth + 1, out);
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
    } else {
      throw new Error(`Unknown dialogue node: ${JSON.stringify(n)}`);
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

// Ready-made event templates (chest, locked door, inn, shop, save point, NPC) that
// compile to complete RPG Maker MV event pages.
import { z } from "zod";
import { cmd, terminated, type Cmd } from "./commandList.js";
import { messageCommands } from "./dialogueTree.js";
import { shopCommands } from "./shopCommands.js";
import { DEFAULT_EVENT_PAGE } from "./tools/mapTools.js";

// Kept exported from here so existing importers of eventTemplates keep working.
export { shopCommands };

// ---------------------------------------------------------------- schema

const goodsType = z.enum(["item", "weapon", "armor"]);
const direction8 = z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]);

const imageSchema = z
  .object({
    characterName: z.string().describe("Character sheet name in img/characters, e.g. \"People1\" or \"!Chest\""),
    characterIndex: z.number().int().min(0).max(7).describe("Which of the 8 characters on the sheet (0-7)"),
    direction: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).optional().describe("Facing, default 2 (down)"),
    pattern: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional().describe("Animation frame, default 1 (middle)"),
  })
  .strict();

const faceSchema = z.object({ name: z.string(), index: z.number().int().min(0).max(7) }).strict();

const chestReward = z
  .object({
    gold: z.number().int().min(1).optional(),
    item: z
      .object({ type: goodsType, id: z.number().int().min(1), count: z.number().int().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((r) => r.gold !== undefined || r.item !== undefined, { message: "reward needs gold, item, or both" });

const destination = z
  .object({
    mapId: z.number().int().min(1),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    direction: direction8.optional(),
  })
  .strict();

const shopGood = z.object({ type: goodsType, id: z.number().int().min(1), price: z.number().int().min(0).optional() }).strict();

export const templateParamsSchema = z.discriminatedUnion("template", [
  z
    .object({
      template: z.literal("chest"),
      reward: chestReward,
      message: z.string().min(1).optional(),
      closedImage: imageSchema.optional(),
      openImage: imageSchema.optional(),
    })
    .strict(),
  z
    .object({
      template: z.literal("locked_door"),
      keyItemId: z.number().int().min(1),
      destination,
      lockedMessage: z.string().min(1).optional(),
      consumeKey: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ template: z.literal("inn"), price: z.number().int().min(0), greeting: z.string().min(1).optional() })
    .strict(),
  z
    .object({
      template: z.literal("shop"),
      goods: z.array(shopGood).min(1).max(40),
      purchaseOnly: z.boolean().optional(),
    })
    .strict(),
  z.object({ template: z.literal("save_point") }).strict(),
  z
    .object({
      template: z.literal("npc"),
      lines: z.array(z.string().min(1)).min(1),
      face: faceSchema.optional(),
      image: imageSchema.optional(),
    })
    .strict(),
]);

export type TemplateParams = z.infer<typeof templateParamsSchema>;
type Image = z.infer<typeof imageSchema>;

export const TEMPLATE_NAMES = ["chest", "locked_door", "inn", "shop", "save_point", "npc"] as const;

/** Every template parameter as an optional field, for tools whose input must be a flat object. */
export const templateFieldShape = {
  template: z.enum(TEMPLATE_NAMES).describe("Which template to build; the other fields depend on it"),
  reward: chestReward.optional().describe("chest: { gold?: number, item?: {type: item|weapon|armor, id, count?} }, at least one"),
  message: z.string().optional().describe("chest: text shown when opened (default \"You found treasure!\")"),
  closedImage: imageSchema.optional().describe("chest: graphic before opening"),
  openImage: imageSchema.optional().describe("chest: graphic after opening (default: closedImage facing up)"),
  keyItemId: z.number().int().optional().describe("locked_door: item id of the key"),
  destination: destination.optional().describe("locked_door: { mapId, x, y, direction?: 0|2|4|6|8 }"),
  lockedMessage: z.string().optional().describe("locked_door: text when the player has no key (default \"It's locked.\")"),
  consumeKey: z.boolean().optional().describe("locked_door: remove one key on use"),
  price: z.number().int().optional().describe("inn: gold per night (>= 0)"),
  greeting: z.string().optional().describe("inn: text shown first"),
  goods: z.array(shopGood).optional().describe("shop: 1-40 entries { type: item|weapon|armor, id, price? }; omit price for the database price"),
  purchaseOnly: z.boolean().optional().describe("shop: disable selling"),
  lines: z.array(z.string()).optional().describe("npc: lines of dialogue (4 per message box)"),
  face: faceSchema.optional().describe("npc: face portrait { name, index }"),
  image: imageSchema.optional().describe("npc: the NPC's character graphic"),
};

// --------------------------------------------------------------- compile

interface PageOptions {
  image?: Image;
  conditions?: Record<string, unknown>;
}

type EventPage = Record<string, any>;

function page(list: Cmd[], options: PageOptions = {}): EventPage {
  const p = structuredClone(DEFAULT_EVENT_PAGE) as EventPage;
  p.list = terminated(list);
  if (options.image) {
    p.image = {
      tileId: 0,
      characterName: options.image.characterName,
      direction: options.image.direction ?? 2,
      pattern: options.image.pattern ?? 1,
      characterIndex: options.image.characterIndex,
    };
  }
  Object.assign(p.conditions, options.conditions);
  return p;
}

const lines = (text: string): string[] => text.split(/\r?\n/);
const say = (text: string, indent: number): Cmd[] => messageCommands(lines(text), "", 0, 0, 2, indent);

const CHANGE_CODE = { item: 126, weapon: 127, armor: 128 } as const;

function chest(p: Extract<TemplateParams, { template: "chest" }>): EventPage[] {
  const list = say(p.message ?? "You found treasure!", 0);
  if (p.reward.gold !== undefined) list.push(cmd(125, 0, 0, 0, p.reward.gold));
  if (p.reward.item) {
    const { type, id, count = 1 } = p.reward.item;
    list.push(
      type === "item" ? cmd(126, 0, id, 0, 0, count) : cmd(CHANGE_CODE[type], 0, id, 0, 0, count, false),
    );
  }
  list.push(cmd(123, 0, "A", 0));
  return [
    page(list, { image: p.closedImage }),
    // Without an openImage the chest would vanish when opened (priority 1 keeps its tile blocked), so reuse
    // the closed graphic facing up, as MV's Quick Event treasure does.
    page([], {
      image: p.openImage ?? (p.closedImage ? { ...p.closedImage, direction: 8 } : undefined),
      conditions: { selfSwitchValid: true, selfSwitchCh: "A" },
    }),
  ];
}

function lockedDoor(p: Extract<TemplateParams, { template: "locked_door" }>): EventPage[] {
  const d = p.destination;
  const list: Cmd[] = [cmd(111, 0, 8, p.keyItemId)];
  if (p.consumeKey) list.push(cmd(126, 1, p.keyItemId, 1, 0, 1));
  list.push(cmd(201, 1, 0, d.mapId, d.x, d.y, d.direction ?? 0, 0));
  list.push(cmd(411, 0), ...say(p.lockedMessage ?? "It's locked.", 1), cmd(412, 0));
  return [page(list)];
}

function inn(p: Extract<TemplateParams, { template: "inn" }>): EventPage[] {
  const stay = `Stay (${p.price}\\G)`; // \G is the engine control code for the currency unit
  const list: Cmd[] = [
    ...say(p.greeting ?? "Welcome! Would you like to stay the night?", 0),
    cmd(102, 0, [stay, "Leave"], 1, 0, 2, 0),
    cmd(402, 0, 0, stay),
    cmd(111, 1, 7, p.price, 0),
    cmd(125, 2, 1, 0, p.price),
    cmd(221, 2),
    cmd(230, 2, 30),
    cmd(314, 2, 0, 0),
    cmd(222, 2),
    ...say("You feel rested.", 2),
    cmd(411, 1),
    ...say("Not enough gold.", 2),
    cmd(412, 1),
    cmd(402, 0, 1, "Leave"),
    cmd(404, 0),
  ];
  return [page(list)];
}

function shop(p: Extract<TemplateParams, { template: "shop" }>): EventPage[] {
  return [page(shopCommands(p.goods, p.purchaseOnly ?? false, 0))];
}

function npc(p: Extract<TemplateParams, { template: "npc" }>): EventPage[] {
  const text = p.lines.flatMap(lines);
  return [page(messageCommands(text, p.face?.name ?? "", p.face?.index ?? 0, 0, 2, 0), { image: p.image })];
}

export function buildTemplate(params: TemplateParams): { defaultName: string; pages: EventPage[] } {
  switch (params.template) {
    case "chest":
      return { defaultName: "Chest", pages: chest(params) };
    case "locked_door":
      return { defaultName: "Door", pages: lockedDoor(params) };
    case "inn":
      return { defaultName: "Inn", pages: inn(params) };
    case "shop":
      return { defaultName: "Shop", pages: shop(params) };
    case "save_point":
      return { defaultName: "Save Point", pages: [page([cmd(352, 0)])] };
    case "npc":
      return { defaultName: "NPC", pages: npc(params) };
  }
}

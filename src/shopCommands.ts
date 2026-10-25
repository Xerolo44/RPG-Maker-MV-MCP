// Shop Processing command builder. A leaf module (it imports only commandList.ts) so that dialogueTree.ts
// and eventTemplates.ts can both use it without importing each other.
import { cmd, type Cmd } from "./commandList.js";

const SHOP_TYPE = { item: 0, weapon: 1, armor: 2 } as const;

/**
 * Shop Processing: 302 for the first good plus one 605 per further good, all at `indent`. A good without
 * `price` uses the database price (priceType 0); with `price` it uses that price (priceType 1).
 * Shared by the shop template and the build_dialogue_tree `shop` node.
 */
export function shopCommands(
  goods: { type: "item" | "weapon" | "armor"; id: number; price?: number }[],
  purchaseOnly: boolean,
  indent: number,
): Cmd[] {
  const row = (g: (typeof goods)[number]): unknown[] => [SHOP_TYPE[g.type], g.id, g.price === undefined ? 0 : 1, g.price ?? 0];
  const [first, ...rest] = goods;
  if (first === undefined) throw new Error("A shop needs at least one good.");
  return [cmd(302, indent, ...row(first), purchaseOnly), ...rest.map((g) => cmd(605, indent, ...row(g)))];
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { terminated, validateCommandList } from "../commandList.js";
import { compileDialogue, dialogueNodeSchema } from "../dialogueTree.js";
import { buildTemplate, templateFieldShape, templateParamsSchema } from "../eventTemplates.js";
import { ProjectError, type Project } from "../project.js";
import { safe, textResult } from "../util.js";
import { insertEventCommands } from "./mapTools.js";

const PREVIEW_LIMIT = 40;

export function registerAuthoringTools(server: McpServer, project: Project): void {
  server.registerTool(
    "build_dialogue_tree",
    {
      title: "Build dialogue tree",
      description:
        "Compiles a nested dialogue tree into correctly indented event commands (messages, choices, conditions, switches, variables, transfers) " +
        "and optionally inserts it into an event page, so you never hand-write indents or block terminators. " +
        "With mapId + eventId the commands are inserted at indent 0 before the page's end (or at `index`), like add_event_command; " +
        "without them, or with dryRun, nothing is written and the compiled commands are returned in `preview`. " +
        "`tree` is an array of nodes, nested at most 8 levels deep. Node vocabulary: " +
        '{say: string | string[], face?: {name, index}, background?: 0|1|2, position?: 0|1|2} (4 lines per message box; "\\n" splits lines; control codes like \\C[2] are kept as written); ' +
        '{choices: [{label, then?: Node[]}] (1-6), cancel?: "disallow" (default) | "branch" | choiceIndex}; ' +
        '{if: Condition, then?: Node[], else?: Node[]} with Condition = {switch, is?} | {variable, op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte", value} | {selfSwitch: "A".."D", is?} | {gold} (party has at least) | {item} (party has item); ' +
        '{setSwitch: {id, value}} | {setVariable: {id, op: "set"|"add"|"sub", value}} | {setSelfSwitch: {ch, value}} | ' +
        "{transfer: {mapId, x, y, direction?: 0|2|4|6|8, fade?: 0|1|2}} | {raw: [{code, indent?, parameters?}]} (indent is relative to the node's position). " +
        "Example: " +
        '[{"say":"Will you help?","face":{"name":"Actor1","index":0}},' +
        '{"choices":[{"label":"Yes","then":[{"setSwitch":{"id":5,"value":true}},{"say":"Thank you!"}]},{"label":"No","then":[{"say":"A pity."}]}],"cancel":"branch"}]. ' +
        "Returns { commands, inserted?, problems, preview? }; preview is included for dry runs and for trees of up to 40 commands.",
      inputSchema: {
        tree: z.array(dialogueNodeSchema).min(1).describe("Dialogue nodes, in order"),
        mapId: z.number().int().min(1).optional().describe("Map to insert into; omit (with eventId) for a dry run"),
        eventId: z.number().int().min(1).optional().describe("Event to insert into; omit (with mapId) for a dry run"),
        pageIndex: z.number().int().min(0).default(0).describe("Which event page (0-based)"),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Position in the page's command list to insert at; defaults to the end (before the terminator)"),
        dryRun: z.boolean().default(false).describe("Compile and validate only; never touches the project files"),
      },
    },
    safe(async ({ tree, mapId, eventId, pageIndex, index, dryRun }) => {
      void project.root; // throws the standard "No project selected" error first
      if ((mapId === undefined) !== (eventId === undefined)) {
        throw new ProjectError("Give both mapId and eventId to insert into an event, or neither for a dry run.");
      }
      const commands = compileDialogue(tree);
      const problems = validateCommandList(terminated(commands));
      const write = !dryRun && mapId !== undefined && eventId !== undefined;
      const showPreview = !write || commands.length <= PREVIEW_LIMIT;

      if (problems.length > 0) {
        return {
          ...textResult({
            commands: commands.length,
            problems,
            note: "Nothing was inserted: the compiled command list is structurally invalid.",
            ...(showPreview ? { preview: commands } : {}),
          }),
          isError: true,
        };
      }

      const inserted = write ? await insertEventCommands(project, mapId, eventId, pageIndex, commands, index) : undefined;
      return textResult({
        commands: commands.length,
        ...(inserted ? { inserted } : {}),
        problems,
        ...(showPreview ? { preview: commands } : {}),
      });
    }),
  );

  server.registerTool(
    "create_event_from_template",
    {
      title: "Create event from template",
      description:
        "Creates a complete, ready-to-use map event at (x, y) from a template, in one write. Refuses out-of-bounds tiles, and refuses a tile that already holds an event unless allowStack is true. " +
        "Graphics default to none: events are INVISIBLE in game until an image is supplied (chest: closedImage/openImage, npc: image; locked_door, inn, shop and save_point never get a graphic and are meant to sit on a tile that already looks right). " +
        "Templates and their params: " +
        "chest {reward: {gold?, item?: {type: item|weapon|armor, id, count?}}, message?, closedImage?, openImage?} (two pages: the action button opens it and sets self switch A, then an empty opened page); " +
        "locked_door {keyItemId, destination: {mapId, x, y, direction?: 0|2|4|6|8}, lockedMessage?, consumeKey?} (transfers the player if the party holds the key); " +
        "inn {price, greeting?} (Stay/Leave choice; staying charges gold, fades out, restores the party, fades in); " +
        "shop {goods: [{type: item|weapon|armor, id, price?}] (1-40; price defaults to the database price), purchaseOnly?}; " +
        "save_point {} (opens the save screen); " +
        "npc {lines: string[], face?: {name, index}, image?}. " +
        "Image = {characterName, characterIndex (0-7), direction?: 2|4|6|8, pattern?: 0|1|2}. " +
        "Returns { eventId, name, pages }.",
      inputSchema: {
        mapId: z.number().int().min(1),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        name: z.string().optional().describe("Event name; defaults to the template name (Chest, Door, Inn, Shop, Save Point, NPC)"),
        allowStack: z.boolean().default(false).describe("Allow placing the event on a tile that already has an event"),
        ...templateFieldShape,
      },
    },
    safe(async ({ mapId, x, y, name, allowStack, ...fields }) => {
      void project.root; // throws the standard "No project selected" error first
      const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      const parsed = templateParamsSchema.safeParse(given);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ` : "") + i.message);
        throw new ProjectError(`Invalid ${fields.template} template params: ${issues.join("; ")}`);
      }
      const { defaultName, pages } = buildTemplate(parsed.data);

      const file = project.mapFile(mapId);
      const map = await project.readJson<{ width: number; height: number; events?: ({ id: number; x: number; y: number } | null)[] }>(file);
      if (x >= map.width || y >= map.height) {
        throw new ProjectError(`Position (${x}, ${y}) is outside map ${mapId} (${map.width}x${map.height}).`);
      }
      if (!Array.isArray(map.events) || map.events.length === 0) map.events = [null];
      const occupant = map.events.find((e) => e && e.x === x && e.y === y);
      if (occupant && !allowStack) {
        throw new ProjectError(
          `Tile (${x}, ${y}) on map ${mapId} is already occupied by event ${occupant.id}. Pick another tile or pass allowStack: true.`,
        );
      }
      const eventId = map.events.length;
      const eventName = name ?? defaultName;
      map.events.push({ id: eventId, name: eventName, x, y, note: "", pages } as never);
      await project.writeJson(file, map);
      return textResult({ eventId, name: eventName, pages: pages.length });
    }),
  );
}

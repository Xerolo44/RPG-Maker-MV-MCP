import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { terminated, validateCommandList } from "../commandList.js";
import { compileDialogue, dialogueNodeSchema } from "../dialogueTree.js";
import { buildTemplate, templateFieldShape, templateParamsSchema } from "../eventTemplates.js";
import { ProjectError, type Project } from "../project.js";
import { safe, textResult } from "../util.js";
import { insertEventCommands, insertionIndent, multiLineContinuationAt } from "./mapTools.js";

const PREVIEW_LIMIT = 40;

export function registerAuthoringTools(server: McpServer, project: Project): void {
  server.registerTool(
    "build_dialogue_tree",
    {
      title: "Build dialogue tree",
      description:
        "Compiles a nested tree of nodes into correctly indented event commands and optionally inserts it into an event page, so you never hand-write indents, " +
        "block terminators or move-route rows. Covers dialogue, branching, switches and variables, cutscenes (screen effects, audio, pictures, animations, move routes) " +
        "and game flow (battles, shops, items, gold, party, scenes, labels). " +
        "With mapId + eventId the commands are inserted at indent 0 before the page's end (or at `index`), like add_event_command; " +
        "without them, or with dryRun, nothing is written and the compiled commands are returned in `preview`. " +
        "`tree` is an array of nodes; every node is an object with one main key, and unknown keys are rejected. choices, if and battle bodies nest at most 8 levels deep (each body counts as a level). " +
        "A node that is invalid anywhere in the tree fails the whole call and nothing is written. Node vocabulary, in three groups. " +
        "(1) MESSAGES AND FLOW: " +
        '{say: string | string[], face?: {name, index}, background?: 0|1|2, position?: 0|1|2} (4 lines per message box; "\\n" splits lines; control codes like \\C[2] are kept as written); ' +
        '{choices: [{label, then?: Node[]}] (1-6), cancel?: "disallow" (default) | "branch" | choiceIndex}; ' +
        '{if: Condition, then?: Node[], else?: Node[]} with Condition = {switch, is?} | {variable, op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte", value} | {selfSwitch: "A".."D", is?} | {gold} (party has at least) | {item} (party has item); ' +
        '{setSwitch: {id, value}} | {setVariable: {id, op: "set"|"add"|"sub", value}} | {setSelfSwitch: {ch, value}} | ' +
        "{transfer: {mapId, x, y, direction?: 0|2|4|6|8, fade?: 0|1|2}} | {raw: [{code, indent?, parameters?}]} (indent is relative to the node's position). " +
        "Example: " +
        '[{"say":"Will you help?","face":{"name":"Actor1","index":0}},' +
        '{"choices":[{"label":"Yes","then":[{"setSwitch":{"id":5,"value":true}},{"say":"Thank you!"}]},{"label":"No","then":[{"say":"A pity."}]}],"cancel":"branch"}]. ' +
        "(2) CUTSCENE, where target is \"player\" | \"this\" (the running event) | a positive event id: " +
        '{wait: 1-6000} (frames; 60 = 1 second) | {fade: "out"|"in"} | ' +
        "{tint: {r, g, b: -255..255, gray: 0-255, frames?: 1-600 (60), wait?: true}} | {flash: {r, g, b: 0-255, intensity: 0-255, frames?: 1-600 (60), wait?: true}} | " +
        "{shake: {power?: 1-9 (5), speed?: 1-9 (5), frames?: 1-600 (30), wait?: true}} | " +
        '{weather: {type: "none"|"rain"|"storm"|"snow", power?: 1-9 (5), frames?: 1-600 (60), wait?: false}} | ' +
        '{playAudio: {kind: "bgm"|"bgs"|"me"|"se", name (use "" to stop that channel), volume?: 0-100 (90), pitch?: 50-150 (100), pan?: -100..100 (0)}} | ' +
        '{fadeAudio: {kind: "bgm"|"bgs", seconds: 1-60}} | ' +
        '{showPicture: {id: 1-100, name, origin?: "upperLeft"|"center", x, y, scaleX?: 0-2000 (100), scaleY?: 0-2000 (100), opacity?: 0-255 (255), blend?: "normal"|"add"|"multiply"|"screen"}} | ' +
        "{erasePicture: 1-100} | {animation: {target, animationId, wait?: true}} | {balloon: {target, balloonId: 1-10, wait?: true}} | " +
        "{moveRoute: {target, steps: 1-100 steps, repeat?: false, skippable?: false, wait?: true}} (compiles to command 205 plus one 505 row per step). " +
        "A route step is one of the strings down, left, right, up, turnDown, turnLeft, turnRight, turnUp, walkAnimOn, walkAnimOff, stepAnimOn, stepAnimOff, dirFixOn, dirFixOff, throughOn, throughOff, transparentOn, transparentOff, " +
        "or an object {jump: {x, y}} (relative tiles, -1000..1000) | {wait: 1-999} | {switchOn: id} | {switchOff: id} | {speed: 1-6} | {frequency: 1-5}. " +
        "A repeating route never finishes, so with repeat: true wait defaults to false and an explicit wait: true is rejected. " +
        'Example: [{"fade":"out"},{"playAudio":{"kind":"bgm","name":"Theme1"}},{"moveRoute":{"target":"player","steps":["up","up",{"wait":10},"turnLeft"]}},{"fade":"in"}]. ' +
        "(3) GAME FLOW: " +
        '{battle: {troopId, canEscape?: false, canLose?: false, onWin?: Node[], onEscape?: Node[] (needs canEscape: true), onLose?: Node[] (needs canLose: true)}} (like the editor, branches are written only when canEscape or canLose is true or onWin has nodes: then 601, plus 602 with canEscape and 603 with canLose even when empty, and the closer 604; with neither, just the battle command is written and what follows runs after the battle; a body for a branch whose box is off is rejected) | ' +
        '{shop: {goods: [{type: "item"|"weapon"|"armor", id, price?}] (1-40; omit price for the database price), purchaseOnly?: false}} | ' +
        "{callCommon: commonEventId} | {label: name} | {jump: label name} (jump to a label in the same list) | {exit: true} (stop this event) | {comment: string | string[]} (not shown in game) | " +
        "{gold: n} (positive gives, negative takes; not 0) | " +
        '{item: {kind: "item"|"weapon"|"armor", id, count}} (positive adds, negative removes, not 0, |count| <= 99; weapons/armors only change the inventory, not equipped gear) | ' +
        '{party: {actorId, action: "add"|"remove", initialize?: false}} (initialize resets the actor when added) | {learnSkill: {actorId, skillId, forget?: false}} | ' +
        "{recoverAll: true} (full HP/MP/states for the whole party) | {nameInput: {actorId, maxChars: 1-16}} | {plugin: \"Command arg1 arg2\"} (plugin command) | " +
        '{scene: "menu"|"save"|"gameOver"|"title"}. ' +
        'Example: [{"battle":{"troopId":3,"canLose":true,"onWin":[{"gold":200},{"item":{"kind":"item","id":1,"count":2}}],"onLose":[{"say":"Defeated..."},{"scene":"gameOver"}]}},' +
        '{"shop":{"goods":[{"type":"item","id":1},{"type":"weapon","id":2,"price":300}]}}]. ' +
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
          .describe("Position in the page's command list to insert at; defaults to the end (before the terminator). Positions inside a conditional, choice or battle body (the branch markers 402, 403, 404, 411, 412, 413, 601, 602, 603, 604 count as inside), or on a continuation line of a multi-line command (text, comment, move route, script or shop lines: 401, 405, 408, 505, 605, 655), are refused"),
        dryRun: z.boolean().default(false).describe("Compile and validate only; never touches the project files"),
      },
    },
    safe(async ({ tree, mapId, eventId, pageIndex, index, dryRun }) => {
      void project.root; // throws the standard "No project selected" error first
      if ((mapId === undefined) !== (eventId === undefined)) {
        throw new ProjectError("Give both mapId and eventId to insert into an event, or neither for a dry run.");
      }
      const write = !dryRun && mapId !== undefined && eventId !== undefined;
      if (write && index !== undefined) {
        // The tree is compiled at indent 0, so refuse a position inside a conditional/choice body instead of
        // silently pulling the new commands out of (or into) that branch.
        const indent = await insertionIndent(project, mapId, eventId, pageIndex, index);
        if (indent !== 0) {
          throw new ProjectError(
            `Index ${index} is inside a block (nesting level ${indent}) of event ${eventId}; build_dialogue_tree only inserts at the top level. ` +
              "Pick an index between top-level commands (or omit it to append), or put the nodes in the tree's own choices/if branches."
          );
        }
      }
      if (write && index !== undefined) {
        const continuation = await multiLineContinuationAt(project, mapId, eventId, pageIndex, index);
        if (continuation !== undefined) {
          throw new ProjectError(
            `Index ${index} is inside a multi-line command of event ${eventId} (it points at a continuation line, code ${continuation}). ` +
              "Pick an index at the start of a command (use get_event to see the list), or omit it to append."
          );
        }
      }
      const commands = compileDialogue(tree);
      const problems = validateCommandList(terminated(commands));
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
        "chest {reward: {gold?, item?: {type: item|weapon|armor, id, count?}}, message?, closedImage?, openImage?} (two pages: the action button opens it and sets self switch A, then an empty opened page; if only closedImage is given, openImage defaults to the same graphic with direction 8 - the opened-chest frame of the standard chest sheets); " +
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

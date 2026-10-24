import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { terminated, validateCommandList } from "../commandList.js";
import { compileDialogue, dialogueNodeSchema } from "../dialogueTree.js";
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
}

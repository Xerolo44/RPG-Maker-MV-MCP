// Knowledge layer: MCP resources (reference texts and skill files), prompts (ready-made
// workflows) and the install_skills tool that copies the skill files into a project.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Project } from "./project.js";
import {
  DATABASE_REFERENCE,
  EVENT_COMMAND_REFERENCE,
  FORMULA_REFERENCE,
  TRAIT_REFERENCE,
} from "./reference.js";
import { SKILLS_DIR, listSkills, readSkill } from "./skills.js";
import { safe, textResult } from "./util.js";

const REFERENCES = [
  {
    id: "event-commands",
    title: "Event command reference",
    description: "Event command codes and their parameters, trigger and priority values.",
    text: EVENT_COMMAND_REFERENCE,
  },
  {
    id: "trait-codes",
    title: "Trait codes",
    description: "All trait (feature) codes with their dataId and value meaning.",
    text: TRAIT_REFERENCE,
  },
  {
    id: "damage-formulas",
    title: "Damage formulas",
    description: "How damage formulas are evaluated, with typical examples.",
    text: FORMULA_REFERENCE,
  },
  {
    id: "database-fields",
    title: "Database record fields",
    description: "Fields of every database record type, params order, scopes and effect codes.",
    text: DATABASE_REFERENCE,
  },
];

function prompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

const SKILL_HINT =
  "Read the matching skill first (resource rpgmaker://skills/<name>): rpgmaker-mv-workflow always, plus ";

export function registerKnowledge(server: McpServer, project: Project): void {
  // ---- Resources -----------------------------------------------------------
  for (const ref of REFERENCES) {
    server.registerResource(
      ref.id,
      `rpgmaker://reference/${ref.id}`,
      { title: ref.title, description: ref.description, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: ref.text }] })
    );
  }

  server.registerResource(
    "skills",
    new ResourceTemplate("rpgmaker://skills/{name}", {
      list: async () => ({
        resources: (await listSkills()).map((s) => ({
          uri: `rpgmaker://skills/${s.name}`,
          name: s.name,
          title: s.name,
          description: s.description,
          mimeType: "text/markdown",
        })),
      }),
      complete: { name: async () => (await listSkills()).map((s) => s.name) },
    }),
    {
      title: "RPG Maker skill files",
      description:
        "Workflow guides (SKILL.md) for building maps, writing events, balancing, localization and plugins. They can also be installed into a project with the install_skills tool.",
      mimeType: "text/markdown",
    },
    async (uri, { name }) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readSkill(String(name)) }],
    })
  );

  // ---- Prompts -------------------------------------------------------------
  server.registerPrompt(
    "new_town",
    {
      title: "Design a new town",
      description: "Build a populated town map: terrain, buildings, NPCs with dialogue and links to existing maps.",
      argsSchema: {
        name: z.string().describe("Map name, e.g. 'Willowbrook'"),
        theme: z.string().optional().describe("Mood or setting, e.g. 'fishing village in autumn'"),
        size: z.string().optional().describe("Width x height in tiles, e.g. '40x30'"),
      },
    },
    ({ name, theme, size }) =>
      prompt(
        `Build a new town map called "${name}"${theme ? ` (theme: ${theme})` : ""}${size ? `, size ${size}` : ""} in the open RPG Maker MV project.\n\n` +
          `${SKILL_HINT}rpgmaker-map-building and rpgmaker-event-writing.\n\n` +
          `1. get_project_info and list_maps to see what exists; list_records on "tilesets" and pick an outdoor tileset (get_tileset_info for its tiles and passability).\n` +
          `2. create_map with a ground fill, then paint water/paths/buildings/trees with paint_tiles. Call render_map_image after each major step and fix what looks wrong.\n` +
          `3. Place 4-6 NPCs with create_event and add_dialogue (distinct voices, a hint or two about the world).\n` +
          `4. Use connect_maps to link the town to an existing map (door tiles on walkable edges), then run list_map_connections.\n` +
          `5. validate_project, then summarize what you built and show the final render_map_image.`
      )
  );

  server.registerPrompt(
    "design_dungeon",
    {
      title: "Design a dungeon",
      description: "Create a multi-floor dungeon with enemies, treasure, a boss and a balance check.",
      argsSchema: {
        name: z.string(),
        theme: z.string().optional().describe("e.g. 'flooded crypt'"),
        floors: z.string().optional().describe("Number of floors, default 3"),
      },
    },
    ({ name, theme, floors }) =>
      prompt(
        `Design the dungeon "${name}"${theme ? ` (theme: ${theme})` : ""} with ${floors ?? "3"} floors.\n\n` +
          `${SKILL_HINT}rpgmaker-map-building, rpgmaker-event-writing and rpgmaker-balancing.\n\n` +
          `1. Look at the existing enemies and troops (list_records) and the party's current strength (balance_report).\n` +
          `2. Create one map per floor with create_map/paint_tiles, checking each with render_map_image.\n` +
          `3. Link floors with connect_maps (stairs up and down), then list_map_connections.\n` +
          `4. Add new enemies/troops if needed (create_record, generate_enemy_scaling for a smooth progression) and a boss troop.\n` +
          `5. Place treasure chests (one-time events with self switches) and encounters.\n` +
          `6. simulate_battle the boss and a typical floor troop against the expected party; adjust until the fights match the intended difficulty.\n` +
          `7. validate_project and report what you created and the simulation results.`
      )
  );

  server.registerPrompt(
    "add_quest",
    {
      title: "Add a quest",
      description: "Implement a quest end to end: switches/variables, NPC dialogue, conditions and rewards.",
      argsSchema: {
        title: z.string(),
        giver: z.string().optional().describe("Who gives the quest, e.g. 'the mayor on map 3'"),
        goal: z.string().describe("What the player must do"),
      },
    },
    ({ title, giver, goal }) =>
      prompt(
        `Implement the quest "${title}"${giver ? ` given by ${giver}` : ""}. Goal: ${goal}.\n\n` +
          `${SKILL_HINT}rpgmaker-event-writing.\n\n` +
          `1. Search first (search_records, search_map_events) so you reuse existing NPCs, items and maps instead of duplicating them.\n` +
          `2. Define the state: pick unused switches/variables, name them with set_switch_name/set_variable_name (quest offered / accepted / done).\n` +
          `3. Give the quest giver pages for each state (conditions on the switches) with add_dialogue; add the goal event(s) and the reward (items, gold, EXP).\n` +
          `4. Make it impossible to break: one-time rewards, no dead ends, sensible dialogue if the player talks again.\n` +
          `5. validate_project and summarize every event, switch and variable you touched.`
      )
  );

  server.registerPrompt(
    "balance_check",
    {
      title: "Balance check",
      description: "Measure the game's balance and propose fixes as dry-run diffs.",
      argsSchema: { focus: z.string().optional().describe("e.g. 'early game', 'boss fights', 'gold economy'") },
    },
    ({ focus }) =>
      prompt(
        `Review the balance of this game${focus ? `, focusing on ${focus}` : ""}.\n\n` +
          `${SKILL_HINT}rpgmaker-balancing.\n\n` +
          `1. Run balance_report and read its warnings; run simulate_battle on the key troops.\n` +
          `2. Explain the problems in plain words with the numbers behind them.\n` +
          `3. Propose concrete fixes using bulk_update_records, generate_param_curve or generate_enemy_scaling - all as DRY RUNS, and show the diffs.\n` +
          `4. Apply only what the user approves, then re-run the report and simulation to confirm the effect.`
      )
  );

  server.registerPrompt(
    "review_dialogue",
    {
      title: "Review dialogue",
      description: "Proofread NPC dialogue for typos, tone, consistency and message-box length.",
      argsSchema: { mapId: z.string().optional().describe("Only review this map id; default all maps") },
    },
    ({ mapId }) =>
      prompt(
        `Proofread the dialogue ${mapId ? `on map ${mapId}` : "across all maps"}.\n\n` +
          `${SKILL_HINT}rpgmaker-event-writing.\n\n` +
          `1. Collect the text: export_texts with scope ["maps"] (or get_event for single events) and read it.\n` +
          `2. List problems: typos, inconsistent names or facts, lines that overflow the message box (over ~45 characters or more than 4 lines), contradictory quest state.\n` +
          `3. Propose fixes as a table (event, old, new). Do not edit anything until the user agrees; then apply with update_event or import_texts (dry run first).`
      )
  );

  server.registerPrompt(
    "translate_game",
    {
      title: "Translate the game",
      description: "Localize all game text into another language with the export/import tools.",
      argsSchema: { language: z.string().describe("Target language, e.g. 'German'") },
    },
    ({ language }) =>
      prompt(
        `Translate this game into ${language}.\n\n` +
          `${SKILL_HINT}rpgmaker-localization.\n\n` +
          `1. export_texts (CSV) and read the file in chunks.\n` +
          `2. Write the translations into the translation column; keep every control code (\\C[n], \\V[n], \\N[n], ...) intact and respect the 4-line message boxes.\n` +
          `3. import_texts with dryRun true, review the report, then apply with dryRun false.\n` +
          `4. validate_project and spot-check scenes with render/playtest. Tell the user which fonts a ${language} game may need.`
      )
  );

  server.registerPrompt(
    "project_health",
    {
      title: "Project health check",
      description: "Run every checker and report a prioritized list of problems.",
      argsSchema: {},
    },
    () =>
      prompt(
        `Check the health of the open RPG Maker MV project.\n\n` +
          `${SKILL_HINT}nothing else.\n\n` +
          `1. validate_project (broken references), list_map_connections (one-way doors, unreachable maps), balance_report (warnings).\n` +
          `2. search_records / search_map_events for leftovers like "TODO", "test" or empty names.\n` +
          `3. Report a prioritized list: what is broken, what is risky, what is polish. Offer to fix the broken items.`
      )
  );

  // ---- Tool ----------------------------------------------------------------
  server.registerTool(
    "install_skills",
    {
      title: "Install skill files",
      description:
        "Copy the bundled RPG Maker skill files (workflow guides for map building, event writing, balancing, localization, plugins) into the project's .claude/skills folder so Claude Code picks them up automatically in that project. " +
        "The same files are always available as resources (rpgmaker://skills/<name>). Existing skill folders are skipped unless overwrite=true.",
      inputSchema: {
        scope: z
          .enum(["project", "user"])
          .default("project")
          .describe("'project' = <project>/.claude/skills, 'user' = ~/.claude/skills (all your projects)"),
        skills: z.array(z.string()).optional().describe("Only these skill names (default: all)"),
        overwrite: z.boolean().default(false).describe("Replace skill files that already exist"),
      },
    },
    safe(async ({ scope, skills, overwrite }) => {
      const available = await listSkills();
      const wanted = skills ?? available.map((s) => s.name);
      const unknown = wanted.filter((n) => !available.some((s) => s.name === n));
      if (unknown.length) throw new Error(`Unknown skills: ${unknown.join(", ")}. Available: ${available.map((s) => s.name).join(", ")}`);

      const base = scope === "user" ? path.join(os.homedir(), ".claude", "skills") : path.join(project.root, ".claude", "skills");
      const installed: string[] = [];
      const skipped: string[] = [];
      for (const name of wanted) {
        const target = path.join(base, name, "SKILL.md");
        const exists = await fs.access(target).then(() => true, () => false);
        if (exists && !overwrite) {
          skipped.push(name);
          continue;
        }
        if (scope === "project") await project.backup(target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(SKILLS_DIR, name, "SKILL.md"), target);
        installed.push(name);
      }
      return textResult({
        directory: base,
        installed,
        skippedBecauseTheyExist: skipped,
        note: skipped.length ? "Pass overwrite=true to replace existing files." : undefined,
      });
    })
  );
}

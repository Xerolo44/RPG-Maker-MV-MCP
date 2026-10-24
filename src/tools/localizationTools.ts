import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import { Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";
import { SCOPES, applyTranslations, collectTexts, controlCodes, parseCsv, toCsv } from "../localization.js";

interface Row {
  key: string;
  context?: string;
  original?: string;
  translation: string;
}

const normalize = (s: string): string => s.replace(/\r\n/g, "\n");

/** Resolve a project-relative path and refuse anything outside the project folder. */
function inProject(project: Project, rel: string): string {
  const full = path.resolve(project.root, rel);
  const relative = path.relative(project.root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProjectError(`"${rel}" is outside the project folder. Use a path relative to the project.`);
  }
  return full;
}

async function readRows(project: Project, file: string): Promise<Row[]> {
  const raw = await project.readText(file);
  const text = raw.replace(/^﻿/, "");
  if (file.toLowerCase().endsWith(".json") || /^\s*[[{]/.test(text)) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new ProjectError(`Invalid JSON in ${file}: ${(err as Error).message}`);
    }
    if (Array.isArray(data)) {
      return data
        .filter((r) => r && typeof r.key === "string")
        .map((r) => ({ key: r.key, context: r.context, original: r.original, translation: String(r.translation ?? "") }));
    }
    if (data && typeof data === "object") {
      return Object.entries(data as Record<string, unknown>).map(([key, translation]) => ({ key, translation: String(translation ?? "") }));
    }
    throw new ProjectError("The JSON file must be an array of {key, original, translation} or an object of key: translation.");
  }
  const table = parseCsv(text);
  const header = table[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const k = header.indexOf("key");
  const t = header.indexOf("translation");
  const o = header.indexOf("original");
  const c = header.indexOf("context");
  if (k < 0 || t < 0) throw new ProjectError('The CSV needs a header row with at least the columns "key" and "translation".');
  return table.slice(1).map((r) => ({ key: r[k] ?? "", context: c >= 0 ? r[c] : undefined, original: o >= 0 ? r[o] : undefined, translation: r[t] ?? "" }));
}

export function registerLocalizationTools(server: McpServer, project: Project): void {
  server.registerTool(
    "export_texts",
    {
      title: "Export all game texts",
      description:
        "Export every translatable text of the project to a CSV or JSON file inside the project (default localization/texts.csv) with columns key, context, original, translation. " +
        "Covers database names/descriptions/messages, System terms and type names, the game title, map display names, and event text (dialogue boxes as one row each with lines joined by newlines, choices, scrolling text, actor name/nickname/profile commands) in maps, common events and troop battle events. " +
        "If the file already exists its translations are carried over by key, so re-exporting after changes never loses work. Fill in the translation column (leave empty to keep the original), then use import_texts. See the rpgmaker-localization skill for rules about control codes and message length.",
      inputSchema: {
        format: z.enum(["csv", "json"]).default("csv"),
        scope: z.array(z.enum(SCOPES)).optional().describe("Limit to some categories (default: all)"),
        file: z.string().optional().describe("Output path relative to the project folder (default localization/texts.<format>)"),
      },
    },
    safe(async ({ format, scope, file }) => {
      const collected = await collectTexts(project, scope ?? SCOPES);
      const target = inProject(project, file ?? `localization/texts.${format}`);

      let carried = new Map<string, string>();
      if (await project.exists(target)) {
        const old = await readRows(project, target).catch(() => []);
        carried = new Map(old.filter((r) => r.translation !== "").map((r) => [r.key, r.translation]));
      }
      const keys = new Set(collected.items.map((i) => i.key));
      const orphans = [...carried.keys()].filter((k) => !keys.has(k)).length;

      const rows: Row[] = collected.items.map((i) => ({
        key: i.key, context: i.context, original: i.original, translation: carried.get(i.key) ?? "",
      }));
      const body =
        format === "json"
          ? JSON.stringify(rows, null, 2)
          : "﻿" + toCsv([["key", "context", "original", "translation"], ...rows.map((r) => [r.key, r.context ?? "", r.original ?? "", r.translation])]);

      await project.writeText(target, body);

      const byCategory: Record<string, number> = {};
      for (const i of collected.items) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
      return textResult({
        file: path.relative(project.root, target).replace(/\\/g, "/"),
        format,
        total: rows.length,
        byCategory,
        translationsCarriedOver: rows.filter((r) => r.translation !== "").length,
        droppedOrphans: orphans || undefined,
        note: orphans ? `${orphans} translation(s) from the previous file belong to texts that no longer exist and were dropped (the old file is in .mcp-backups).` : undefined,
        sample: rows.slice(0, 5),
      });
    })
  );

  server.registerTool(
    "import_texts",
    {
      title: "Import translated texts",
      description:
        "Apply the translation column of a file written by export_texts back into the project's data. DRY RUN BY DEFAULT: reports what would change and nothing is written until dryRun=false. " +
        "Rows with an empty translation are skipped. A row whose `original` no longer matches the project text (the text changed after export) is skipped unless force=true. " +
        "Dialogue translations longer than 4 lines are split into several message boxes automatically; choices are kept in sync. Control codes (\\C[n], \\V[n], \\N[n] ...) are compared with the original and mismatches are reported as warnings.",
      inputSchema: {
        file: z.string().describe("Path relative to the project folder, e.g. localization/texts.csv"),
        dryRun: z.boolean().default(true),
        force: z.boolean().default(false).describe("Apply rows even if their original text no longer matches"),
      },
    },
    safe(async ({ file, dryRun, force }) => {
      const rows = await readRows(project, inProject(project, file));
      const collected = await collectTexts(project, SCOPES);
      const byKey = new Map(collected.items.map((i) => [i.key, i]));

      const accepted = new Map<string, string>();
      const unknownKeys: string[] = [];
      const stale: string[] = [];
      const warnings: string[] = [];
      const preview: { key: string; before: string; after: string }[] = [];
      let withTranslation = 0;
      let unchanged = 0;
      let longDialogues = 0;

      for (const row of rows) {
        if (row.translation === "") continue;
        withTranslation++;
        const item = byKey.get(row.key);
        if (!item) { unknownKeys.push(row.key); continue; }
        const translation = normalize(row.translation);
        if (row.original !== undefined && normalize(row.original) !== normalize(item.original) && !force) {
          stale.push(row.key);
          continue;
        }
        if (translation === normalize(item.original)) { unchanged++; continue; }
        const a = controlCodes(item.original).join(" ");
        const b = controlCodes(translation).join(" ");
        if (a !== b) warnings.push(`${row.key}: control codes differ (original: ${a || "none"}; translation: ${b || "none"})`);
        if (item.context.includes("· dialogue") && translation.split("\n").length > 4) longDialogues++;
        accepted.set(row.key, translation);
        if (preview.length < 15) preview.push({ key: row.key, before: item.original, after: translation });
      }

      const applied = applyTranslations(collected.items, accepted);
      if (!dryRun && applied > 0) await collected.write();

      return textResult({
        file,
        dryRun,
        rows: rows.length,
        withTranslation,
        [dryRun ? "wouldApply" : "applied"]: applied,
        filesTouched: collected.dirty.size,
        unchanged,
        skippedStaleOriginal: stale.length ? { count: stale.length, keys: stale.slice(0, 20) } : undefined,
        unknownKeys: unknownKeys.length ? { count: unknownKeys.length, keys: unknownKeys.slice(0, 20) } : undefined,
        controlCodeWarnings: warnings.length ? { count: warnings.length, first: warnings.slice(0, 20) } : undefined,
        dialoguesSplitIntoExtraBoxes: longDialogues || undefined,
        preview,
        next: dryRun && applied > 0 ? "Review, then call again with dryRun=false to write the translations." : undefined,
      });
    })
  );
}

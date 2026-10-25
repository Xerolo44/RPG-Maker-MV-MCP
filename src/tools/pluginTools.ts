import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { Project, ProjectError } from "../project.js";
import { safe, textResult } from "../util.js";

interface PluginEntry {
  name: string;
  status: boolean;
  description: string;
  parameters: Record<string, string>;
}

function pluginsJsPath(project: Project): string {
  return path.join(project.root, "js", "plugins.js");
}

function pluginFilePath(project: Project, name: string): string {
  if (!/^[\w. -]+$/.test(name)) {
    throw new ProjectError(`Invalid plugin name: ${name}`);
  }
  return path.join(project.root, "js", "plugins", `${name}.js`);
}

// Char codes used by the js/plugins.js scanner.
const SLASH = 47;
const STAR = 42;
const QUOTE = 34;
const APOS = 39;
const BACKSLASH = 92;
const NEWLINE = 10;
const COMMA = 44;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const DOLLAR = 36;
const EQUALS = 61;

/** Index just past a line or block comment starting at i, or i when none starts there. */
function skipComment(raw: string, i: number): number {
  if (raw.charCodeAt(i) !== SLASH) return i;
  const next = raw.charCodeAt(i + 1);
  if (next === SLASH) {
    const eol = raw.indexOf("\n", i + 2);
    return eol === -1 ? raw.length : eol + 1;
  }
  if (next === STAR) {
    const close = raw.indexOf("*/", i + 2);
    return close === -1 ? raw.length : close + 2;
  }
  return i;
}

/** Index of the closing quote of the string that opens at i (raw.length when it never closes). */
function stringEnd(raw: string, i: number): number {
  const quote = raw.charCodeAt(i);
  for (let j = i + 1; j < raw.length; j++) {
    const ch = raw.charCodeAt(j);
    if (ch === BACKSLASH) j++;
    else if (ch === quote || ch === NEWLINE) return j;
  }
  return raw.length;
}

/** Skips whitespace and comments. */
function skipBlank(raw: string, i: number): number {
  for (;;) {
    while (i < raw.length && raw.charCodeAt(i) <= 32) i++;
    const after = skipComment(raw, i);
    if (after === i) return i;
    i = after;
  }
}

/**
 * Index of the `[` that opens the plugin array: the one right after `$plugins =` (comments and strings are skipped,
 * so a decoy in a comment is not found); without such an assignment, the first `[` outside comments and strings.
 */
function findPluginArray(raw: string): number {
  let firstBracket = -1;
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < raw.length) {
    const ch = raw.charCodeAt(i);
    if (ch === SLASH) {
      const after = skipComment(raw, i);
      i = after === i ? i + 1 : after;
    } else if (ch === QUOTE || ch === APOS) {
      i = stringEnd(raw, i) + 1;
    } else if (ch === OPEN_BRACKET) {
      if (firstBracket === -1) firstBracket = i;
      i++;
    } else if (ch === DOLLAR && raw.startsWith("$plugins", i)) {
      let j = skipBlank(raw, i + 8);
      if (raw.charCodeAt(j) === EQUALS) {
        j = skipBlank(raw, j + 1);
        if (raw.charCodeAt(j) === OPEN_BRACKET) return j;
      }
      i += 8;
    } else {
      i++;
    }
  }
  return firstBracket;
}

/** The array that starts at `start` as JSON text: balanced to its closing bracket, trailing commas removed. */
function arrayText(raw: string, start: number): string {
  const parts: string[] = [];
  let from = start;
  let depth = 0;
  let comma = -1; // a comma not yet followed by anything but whitespace
  for (let i = start; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (ch === QUOTE) {
      i = stringEnd(raw, i);
      comma = -1;
    } else if (ch === COMMA) {
      comma = i;
    } else if (ch === OPEN_BRACKET || ch === OPEN_BRACE) {
      depth++;
      comma = -1;
    } else if (ch === CLOSE_BRACKET || ch === CLOSE_BRACE) {
      if (comma !== -1) {
        parts.push(raw.slice(from, comma));
        from = comma + 1;
      }
      comma = -1;
      if (--depth === 0) {
        parts.push(raw.slice(from, i + 1));
        return parts.join("");
      }
    } else if (ch > 32) {
      comma = -1;
    }
  }
  throw new ProjectError("Could not parse plugin list: the plugin array in js/plugins.js is never closed.");
}

/**
 * Parses the text of js/plugins.js: the array assigned to `$plugins` (var/let/const or none, any spacing, BOM, CRLF,
 * header comments that contain brackets, a trailing semicolon, a trailing comma before `]` or `}`). One linear scan.
 */
export function parsePluginsJs(raw: string): PluginEntry[] {
  const start = findPluginArray(raw);
  if (start === -1) {
    throw new ProjectError("js/plugins.js exists but no plugin array was found in it.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayText(raw, start));
  } catch (err) {
    if (err instanceof ProjectError) throw err;
    throw new ProjectError(`Could not parse plugin list: ${(err as Error).message}`);
  }
  return parsed as PluginEntry[];
}

export async function readPluginList(project: Project): Promise<PluginEntry[]> {
  let raw: string;
  try {
    raw = await project.readText(pluginsJsPath(project));
  } catch {
    return [];
  }
  return parsePluginsJs(raw);
}

/**
 * Names of the enabled plugins in js/plugins.js, in file order. Never throws. `unreadable` is true when the file
 * exists and has content but cannot be read or parsed (then `names` is empty and the real list is unknown); a
 * missing or empty file is a project without plugins.
 */
export async function readEnabledPlugins(project: Project): Promise<{ names: string[]; unreadable: boolean }> {
  const file = pluginsJsPath(project);
  let list: unknown;
  try {
    if (!(await project.exists(file))) return { names: [], unreadable: false };
    const raw = await project.readText(file);
    if (raw.trim() === "") return { names: [], unreadable: false };
    list = parsePluginsJs(raw);
  } catch {
    return { names: [], unreadable: true };
  }
  if (!Array.isArray(list)) return { names: [], unreadable: true };
  const names = list
    .filter((p): p is PluginEntry => typeof p === "object" && p !== null && (p as PluginEntry).status === true && typeof (p as PluginEntry).name === "string")
    .map((p) => p.name);
  return { names, unreadable: false };
}

async function writePluginList(project: Project, plugins: PluginEntry[]): Promise<void> {
  const lines = plugins.map((p) => JSON.stringify(p));
  const text =
    "// Generated by RPG Maker.\n" +
    "// Do not edit this file directly.\n" +
    "var $plugins =\n[\n" +
    lines.join(",\n") +
    "\n];\n";
  await project.writeText(pluginsJsPath(project), text);
}

function pluginScaffold(name: string, description: string): string {
  return `//=============================================================================
// ${name}.js
//=============================================================================

/*:
 * @plugindesc ${description}
 * @author
 *
 * @help ${name}.js
 *
 * This plugin does not provide plugin commands.
 */

(function() {
    'use strict';

    // Plugin code goes here.

})();
`;
}

export function registerPluginTools(server: McpServer, project: Project): void {
  server.registerTool(
    "list_plugins",
    {
      title: "List plugins",
      description: "List all plugins registered in js/plugins.js with status and parameters.",
      inputSchema: {},
    },
    safe(async () => textResult(await readPluginList(project)))
  );

  server.registerTool(
    "configure_plugin",
    {
      title: "Configure plugin",
      description:
        "Enable/disable a registered plugin and/or merge new values into its parameters (parameter values are always strings in RPG Maker MV).",
      inputSchema: {
        name: z.string().describe("Plugin name as it appears in list_plugins"),
        status: z.boolean().optional().describe("true = enabled, false = disabled"),
        parameters: z
          .record(z.string())
          .optional()
          .describe("Parameter values to merge into the plugin's parameters"),
      },
    },
    safe(async ({ name, status, parameters }) => {
      const plugins = await readPluginList(project);
      const plugin = plugins.find((p) => p.name === name);
      if (!plugin) {
        throw new ProjectError(
          `No plugin named '${name}' is registered. Registered: ${plugins.map((p) => p.name).join(", ") || "(none)"}`
        );
      }
      if (status !== undefined) plugin.status = status;
      if (parameters) Object.assign(plugin.parameters, parameters);
      await writePluginList(project, plugins);
      return textResult({ configured: plugin });
    })
  );

  server.registerTool(
    "add_plugin",
    {
      title: "Register plugin",
      description:
        "Register an existing js/plugins/<name>.js file in the plugin list. Fails if the file does not exist (use create_plugin to make a new one).",
      inputSchema: {
        name: z.string(),
        status: z.boolean().default(true),
        description: z.string().default(""),
        parameters: z.record(z.string()).default({}),
      },
    },
    safe(async ({ name, status, description, parameters }) => {
      if (!(await project.exists(pluginFilePath(project, name)))) {
        throw new ProjectError(
          `js/plugins/${name}.js does not exist. Use create_plugin to create it.`
        );
      }
      const plugins = await readPluginList(project);
      if (plugins.some((p) => p.name === name)) {
        throw new ProjectError(`Plugin '${name}' is already registered. Use configure_plugin.`);
      }
      plugins.push({ name, status, description, parameters });
      await writePluginList(project, plugins);
      return textResult({ registered: name, totalPlugins: plugins.length });
    })
  );

  server.registerTool(
    "remove_plugin",
    {
      title: "Unregister plugin",
      description:
        "Remove a plugin from js/plugins.js. The plugin's .js file is NOT deleted.",
      inputSchema: { name: z.string() },
    },
    safe(async ({ name }) => {
      const plugins = await readPluginList(project);
      const index = plugins.findIndex((p) => p.name === name);
      if (index === -1) {
        throw new ProjectError(`No plugin named '${name}' is registered.`);
      }
      plugins.splice(index, 1);
      await writePluginList(project, plugins);
      return textResult({ unregistered: name, totalPlugins: plugins.length });
    })
  );

  server.registerTool(
    "create_plugin",
    {
      title: "Create plugin",
      description:
        "Create a new plugin file in js/plugins/ and register it. If no code is given, a standard MV plugin scaffold (with @plugindesc header) is written. Fails if the file already exists.",
      inputSchema: {
        name: z.string().describe("Plugin file name without .js"),
        description: z.string().default(""),
        code: z.string().optional().describe("Full JavaScript source; omit for a scaffold"),
        status: z.boolean().default(true),
      },
    },
    safe(async ({ name, description, code, status }) => {
      const filePath = pluginFilePath(project, name);
      if (await project.exists(filePath)) {
        throw new ProjectError(`js/plugins/${name}.js already exists. Use write_plugin to modify it.`);
      }
      await project.writeText(filePath, code ?? pluginScaffold(name, description));
      const plugins = await readPluginList(project);
      if (!plugins.some((p) => p.name === name)) {
        plugins.push({ name, status, description, parameters: {} });
        await writePluginList(project, plugins);
      }
      return textResult({ created: `js/plugins/${name}.js`, registered: true });
    })
  );

  server.registerTool(
    "read_plugin",
    {
      title: "Read plugin source",
      description: "Read the JavaScript source of js/plugins/<name>.js.",
      inputSchema: { name: z.string() },
    },
    safe(async ({ name }) => {
      const filePath = pluginFilePath(project, name);
      try {
        return textResult(await project.readText(filePath));
      } catch {
        throw new ProjectError(`js/plugins/${name}.js does not exist.`);
      }
    })
  );

  server.registerTool(
    "write_plugin",
    {
      title: "Write plugin source",
      description: "Overwrite the JavaScript source of an existing js/plugins/<name>.js.",
      inputSchema: {
        name: z.string(),
        code: z.string().describe("Complete new file contents"),
      },
    },
    safe(async ({ name, code }) => {
      const filePath = pluginFilePath(project, name);
      if (!(await project.exists(filePath))) {
        throw new ProjectError(`js/plugins/${name}.js does not exist. Use create_plugin first.`);
      }
      await project.writeText(filePath, code);
      return textResult({ written: `js/plugins/${name}.js`, bytes: code.length });
    })
  );
}

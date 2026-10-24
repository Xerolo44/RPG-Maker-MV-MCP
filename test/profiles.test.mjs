import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GROUPS, parseProfile } from "../dist/profiles.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("undefined and 'all' enable every group", () => {
  assert.deepEqual([...parseProfile(undefined)].sort(), [...GROUPS].sort());
  assert.deepEqual([...parseProfile("all")].sort(), [...GROUPS].sort());
});

test("project is always included", () => {
  assert.deepEqual([...parseProfile("maps,tiles")].sort(), ["maps", "project", "tiles"]);
});

test("whitespace and case are tolerated", () => {
  assert.deepEqual([...parseProfile(" Maps , TILES ")].sort(), ["maps", "project", "tiles"]);
});

test("unknown group throws and lists every valid group", () => {
  assert.throws(
    () => parseProfile("maps,bogus"),
    (err) => err instanceof Error && /bogus/.test(err.message) && GROUPS.every((g) => err.message.includes(g)),
  );
});

async function withServer(args, env, fn) {
  const client = new Client({ name: "profiles-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...args],
    env: { ...process.env, RPGMV_TOOLS: "", ...env },
    stderr: "ignore",
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name);

test("--tools project,database serves only those groups but keeps resources and prompts", async () => {
  await withServer(["--tools", "project,database"], {}, async (client) => {
    const names = await toolNames(client);
    assert.ok(names.includes("set_project"));
    assert.ok(names.includes("list_records"));
    assert.ok(!names.includes("paint_tiles"));
    assert.ok((await client.listResources()).resources.length > 0);
    assert.ok((await client.listPrompts()).prompts.length > 0);
  });
});

test("no flag serves every tool", async () => {
  await withServer([], {}, async (client) => {
    assert.ok((await toolNames(client)).includes("paint_tiles"));
  });
});

test("RPGMV_TOOLS env applies and --tools wins over it", async () => {
  await withServer([], { RPGMV_TOOLS: "maps" }, async (client) => {
    const names = await toolNames(client);
    assert.ok(names.includes("create_map"));
    assert.ok(!names.includes("paint_tiles"));
  });
  await withServer(["--tools", "tiles"], { RPGMV_TOOLS: "maps" }, async (client) => {
    const names = await toolNames(client);
    assert.ok(names.includes("paint_tiles"));
    assert.ok(!names.includes("create_map"));
  });
});

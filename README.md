# RPG Maker MV MCP Server

[![CI](https://github.com/Xerolo44/RPG-Maker-MV-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Xerolo44/RPG-Maker-MV-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![MCP](https://img.shields.io/badge/protocol-Model%20Context%20Protocol-blueviolet)](https://modelcontextprotocol.io)

A [Model Context Protocol](https://modelcontextprotocol.io) server that turns AI assistants
(Claude Code, Claude Desktop, or any MCP client) into a co-developer for **RPG Maker MV**
projects — with automatic backups of everything it touches.

Ask your assistant things like:

> *"Create a Fireball skill: magical damage, `a.mat * 4 - b.mdf * 2`, 12 MP, fire element."*
> *"Find every event in the game that mentions the mayor."*
> *"Add a guard to the castle gate who says 'Halt! Who goes there?'"*
> *"Rebalance all weapons: +10% attack across the board."*
> *"Validate the project — anything broken?"*

## Highlights

- **Full database access** — all 12 database types (actors, classes, skills, items, weapons,
  armors, enemies, troops, states, animations, tilesets, common events) plus System.json,
  through a compact generic CRUD interface.
- **High-level skill builders** — create complete, editor-valid damage / healing / buff /
  state skills from just a name and a formula.
- **Maps and events** — create maps, create/edit/delete events, insert event commands in
  batches, add dialogue with automatic message-box splitting, and consult a built-in
  event command code reference.
- **Search everywhere** — substring search across every database, and across every event on
  every map, including *inside* event command lists (find which event shows a line of
  dialogue or runs a script).
- **Plugin management** — enable/disable/configure plugins, scaffold new ones, edit plugin
  source, all in the editor's own `js/plugins.js` format.
- **Playtest control** — launch the game through NW.js (auto-detected from common install
  locations) with stdout/stderr capture, or serve it to a browser via the built-in HTTP server.
- **Safety net** — every file is snapshotted to `.mcp-backups/` before its first modification
  each session; `restore_backup` rolls anything back, and `validate_project` catches broken
  references before you ship.

## Installation

Requires Node.js 18+.

```sh
git clone <this repo>
cd RPG-Maker-MV-MCP
npm install
npm run build
```

### Claude Code

```sh
claude mcp add rpgmaker-mv -- node "/path/to/RPG-Maker-MV-MCP/dist/index.js" --project "/path/to/YourGame"
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rpgmaker-mv": {
      "command": "node",
      "args": [
        "/path/to/RPG-Maker-MV-MCP/dist/index.js",
        "--project", "/path/to/YourGame"
      ]
    }
  }
}
```

`--project` is optional — without it, ask the assistant to call `set_project` first. The
project can also be switched mid-session.

### Custom connector / URL-based clients (HTTPS) — experimental

Some clients (e.g. "Add custom connector" UIs) don't spawn a local process — they connect
to a URL instead. Run the server in HTTPS mode:

```sh
node dist/index.js --http [port]   # default port 3939
```

This starts a Streamable HTTP MCP endpoint at `https://127.0.0.1:<port>/mcp`, bound to
localhost only (never reachable from the network — every request is checked against the
connecting socket's address, not just the bind address). A self-signed TLS certificate for
`localhost`/`127.0.0.1` is generated on first run and cached in `.certs/` (gitignored) next
to the project.

**Status:** the endpoint is fully verified at the protocol level (handshake, session
management, and all 41 tools tested directly over HTTPS with `curl`). What's *not*
guaranteed is that a given GUI connector-adding flow will accept a self-signed localhost
certificate — some do (after a manual "proceed anyway" warning, since they open the URL as
a normal page), others silently reject it because their background connection check doesn't
trust locally-generated certs and gives no user-facing error. If adding the connector spins
and fails with no message, that's very likely what's happening, and it's a limitation of
that client's trust handling, not of this server. The reliable, zero-friction way to use
this server today is the stdio mode above (Claude Code CLI / Claude Desktop's local server
config) — reach for `--http` only if your client specifically requires a URL.

The server process must stay running for the connector to work — start it in its own
terminal window before adding the connector, and leave that window open.

## Tool reference (41 tools)

| Group | Tools |
| --- | --- |
| Project | `set_project`, `get_project_info` |
| Database | `list_records`, `get_record`, `update_record`, `create_record`, `get_system`, `update_system`, `set_switch_name`, `set_variable_name` |
| Skill helpers | `create_damage_skill`, `create_healing_skill`, `create_buff_skill`, `create_state_skill` |
| Search | `search_records`, `search_map_events` |
| Maps & events | `list_maps`, `get_map`, `create_map`, `update_map`, `get_event`, `update_event`, `create_event`, `delete_event`, `add_event_command`, `add_dialogue`, `event_command_reference` |
| Plugins | `list_plugins`, `configure_plugin`, `add_plugin`, `remove_plugin`, `create_plugin`, `read_plugin`, `write_plugin` |
| Playtest | `playtest_start`, `playtest_status`, `playtest_log`, `playtest_stop` |
| Safety | `list_backups`, `restore_backup`, `validate_project` |

Every tool description is written for AI consumption: parameter semantics, RPG Maker quirks
(target scopes, command codes, 1-indexed arrays), and pointers to related tools are all in
the schema, so assistants can use the server without external documentation.

## Backups

The first time a session modifies any file, the original is copied to
`<project>/.mcp-backups/<session-timestamp>/` preserving its relative path. Up to 10
sessions are kept. `list_backups` shows what's available; `restore_backup` restores one
file or a whole session — and backs up the current state first, so restores are undoable.

Add `.mcp-backups/` to your game project's `.gitignore` if the game is under version control.

## Important notes

- **Close the RPG Maker MV editor (or don't save from it) while the server edits files.**
  The editor keeps the whole database in memory and overwrites the JSON files on save,
  discarding external changes. Reopen the project in the editor to see edits made here.
- Database arrays in MV are 1-indexed with `null` at index 0; the tools handle this
  automatically, and ids always match array positions.
- MZ projects (`.rmmzproject`) are accepted too — the data format is nearly identical —
  but only MV is regularly tested.
- Tile data editing is intentionally unsupported (`create_map` makes blank maps;
  `update_map` refuses to touch `data`). Paint tiles in the editor.
- NW.js playtest auto-detects Steam and KADOKAWA install paths, the project's own
  `Game.exe`, and the `RPGMAKER_MV_NWJS` environment variable, in that order.
- In browser playtest mode, console output stays in the browser devtools — use NW.js mode
  when you need `playtest_log`.

## Development

```sh
npm run build   # compile TypeScript to dist/
npm run smoke   # end-to-end test: real stdio client against a generated MV project
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout and guidelines,
[CHANGELOG.md](CHANGELOG.md) for release history, and [SECURITY.md](SECURITY.md) for the
tool's trust model (it has full file-system access — read this before exposing `--http`
mode beyond your own machine).

## License

[MIT](LICENSE)

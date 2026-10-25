# RPG Maker MV MCP Server

[![CI](https://github.com/Xerolo44/RPG-Maker-MV-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Xerolo44/RPG-Maker-MV-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![MCP](https://img.shields.io/badge/protocol-Model%20Context%20Protocol-blueviolet)](https://modelcontextprotocol.io)
[![Rpgmaker MV MCP on mcprush](https://mcprush.com/badge/xerolo44-rpgmaker-mv-mcp/score.svg)](https://mcprush.com/to/xerolo44-rpgmaker-mv-mcp?ref=badge)

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
- **Tilesets and map painting** — inspect a tileset (sheets, autotile kinds, passability), look
  at its sheet images, switch a map's tileset, and paint ground, water, walls and objects with
  rectangles, flood fill and single cells. Autotile edges and corners are computed exactly like
  the editor does, so painted maps look right in game. `render_map` shows the result as text.
- **See your maps** — `render_map_image` renders a map to a PNG with the real tileset graphics,
  autotiles, shadows, event sprites, numbered event markers, region ids and an optional grid, so
  the assistant can look at what it built instead of working blind.
- **Map connector** — `connect_maps` places Transfer Player doors on two maps in both
  directions in one call (with spawn tiles, fades and sounds); `list_map_connections` shows the
  map graph, one-way doors, broken targets and maps you cannot reach.
- **Bulk edits and balancing** — `bulk_update_records` ("all weapons +10% attack") with a
  dry-run diff, `generate_param_curve` / `generate_enemy_scaling` for stat curves,
  `balance_report` (class curves, damage vs enemy HP, enemy threat) and `simulate_battle`
  (Monte-Carlo troop vs party using the real damage formulas).
- **Localization** — `export_texts` / `import_texts` move every text of the game (database,
  system terms, map names, dialogue, choices, battle events) through CSV or JSON, keep
  control codes intact and split long dialogue into extra message boxes.
- **Skill files, prompts and resources** — bundled `SKILL.md` workflow guides, reference
  tables as MCP resources and ready-made prompts (`new_town`, `balance_check`, ...), see
  [Skills, prompts and resources](#skills-prompts-and-resources).
- **Search everywhere** — substring search across every database, and across every event on
  every map, including *inside* event command lists (find which event shows a line of
  dialogue or runs a script).
- **Plugin management** — enable/disable/configure plugins, scaffold new ones, edit plugin
  source, all in the editor's own `js/plugins.js` format.
- **Playtest control** — launch the game through NW.js (auto-detected from common install
  locations) with stdout/stderr capture, or serve it to a browser via the built-in HTTP server.
- **Authoring helpers** — `build_dialogue_tree` compiles nested dialogue and choices, cutscene
  effects (fades, audio, pictures, move routes, ...) and game-flow commands (battles, shops, items,
  party, scenes, ...) into correctly indented event commands, `create_event_from_template` builds
  chests, locked doors, inns, shops, save points and NPCs in one call. See
  [Cutscene and game-flow nodes](#cutscene-and-game-flow-nodes).
- **Assets** — `import_asset` copies images and sounds into the project, `list_assets` shows what
  is there and what uses it, `preview_asset` lets the assistant look at an image. See
  [Assets](#assets).
- **Map generation and stamps** — `generate_map` makes seeded dungeons and caves with
  entrance/exit/chest markers; `capture_stamp` / `place_stamp` reuse a hand-built piece of map.
  See [Map generation and stamps](#map-generation-and-stamps).
- **Analysis** — `audit_assets`, `lint_events` and `simulate_event` check an event or the whole
  project without launching the game, see [Analysis](#analysis). `find_usages` shows everywhere an
  id is read, written or used, and `analyze_progression` asks which maps and events can ever be
  reached, see [Usage and progression analysis](#usage-and-progression-analysis).
- **Safety net** — every file is snapshotted to `.mcp-backups/` before its first modification
  each session; `restore_backup` rolls anything back, `validate_project` catches broken
  references before you ship, and [changesets](#changesets-transactional-edits-with-undo) let
  you stage a batch of edits, commit it in one step and undo it.

## Installation

Requires Node.js 18+.

### Quick start (npm)

The easiest way for Claude Code or Claude Desktop users:

```sh
npm install -g @xerolo44/rpgmaker-mv-mcp
```

Then configure it (see below). The package is available on [npmjs.com](https://www.npmjs.com/package/@xerolo44/rpgmaker-mv-mcp) and in the [MCP Registry](https://registry.modelcontextprotocol.io/).

### Configure Claude Code

```sh
claude mcp add rpgmaker-mv -- npx @xerolo44/rpgmaker-mv-mcp --project "/path/to/YourGame"
```

### Configure Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rpgmaker-mv": {
      "command": "npx",
      "args": [
        "@xerolo44/rpgmaker-mv-mcp",
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
management, and the 41 tools of the first release tested directly over HTTPS with `curl`). What's *not*
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

## Tool reference (77 tools)

| Group | Tools |
| --- | --- |
| Project | `set_project`, `get_project_info` |
| Database | `list_records`, `get_record`, `update_record`, `create_record`, `get_system`, `update_system`, `set_switch_name`, `set_variable_name` |
| Skill helpers | `create_damage_skill`, `create_healing_skill`, `create_buff_skill`, `create_state_skill` |
| Search | `search_records`, `search_map_events` |
| Maps & events | `list_maps`, `get_map`, `create_map`, `update_map`, `get_event`, `update_event`, `create_event`, `delete_event`, `add_event_command`, `add_dialogue`, `event_command_reference` |
| Authoring | `build_dialogue_tree`, `create_event_from_template` |
| Tilesets & painting | `get_tileset_info`, `get_tileset_image`, `set_map_tileset`, `paint_tiles`, `render_map`, `render_map_image`, `render_diff` |
| Generation | `generate_map`, `capture_stamp`, `place_stamp`, `list_stamps` |
| Map connections | `connect_maps`, `list_map_connections` |
| Bulk & balancing | `bulk_update_records`, `generate_param_curve`, `generate_enemy_scaling`, `balance_report`, `simulate_battle` |
| Localization | `export_texts`, `import_texts` |
| Skill files | `install_skills` |
| Plugins | `list_plugins`, `configure_plugin`, `add_plugin`, `remove_plugin`, `create_plugin`, `read_plugin`, `write_plugin` |
| Playtest | `playtest_start`, `playtest_status`, `playtest_log`, `playtest_stop` |
| Analysis | `audit_assets`, `lint_events`, `simulate_event`, `find_usages`, `analyze_progression` |
| Assets | `import_asset`, `list_assets`, `preview_asset` |
| Safety | `list_backups`, `restore_backup`, `validate_project`, `editor_status`, `begin_changeset`, `commit_changeset`, `discard_changeset`, `undo_changeset` |

Every tool description is written for AI consumption: parameter semantics, RPG Maker quirks
(target scopes, command codes, 1-indexed arrays), and pointers to related tools are all in
the schema, so assistants can use the server without external documentation.

### Tool profiles

All 77 tools are registered by default. Some clients cope better with a shorter tool list, so
you can register only some tool groups with `--tools` (a comma-separated list) or the
environment variable `RPGMV_TOOLS`:

```sh
claude mcp add rpgmaker-mv -- npx @xerolo44/rpgmaker-mv-mcp --project "/path/to/YourGame" --tools maps,tiles,render,authoring
```

Groups: `project`, `database`, `maps`, `tiles`, `render`, `plugins`, `playtest`, `search`,
`maintenance` (backups, validation, `editor_status` and the changeset tools), `connect`,
`balance`, `localization`, `authoring`, `generation`, `analysis`, `assets`. `project` (`set_project`,
`get_project_info`) is always on, `all` (the default) enables everything, and an unknown group
name makes the server exit with a message. `install_skills`, resources and prompts are always
available whatever the profile.

Tools per group (76 tools, plus `install_skills`, which is always on = 77):

- `project` (2): `set_project`, `get_project_info`
- `database` (12): `list_records`, `get_record`, `update_record`, `create_record`, `get_system`, `set_switch_name`, `set_variable_name`, `update_system`, `create_damage_skill`, `create_healing_skill`, `create_buff_skill`, `create_state_skill`
- `maps` (11): `list_maps`, `get_map`, `update_map`, `get_event`, `update_event`, `create_event`, `delete_event`, `add_event_command`, `add_dialogue`, `create_map`, `event_command_reference`
- `tiles` (5): `get_tileset_info`, `get_tileset_image`, `set_map_tileset`, `paint_tiles`, `render_map`
- `render` (2): `render_map_image`, `render_diff`
- `plugins` (7): `list_plugins`, `configure_plugin`, `add_plugin`, `remove_plugin`, `create_plugin`, `read_plugin`, `write_plugin`
- `playtest` (4): `playtest_start`, `playtest_status`, `playtest_log`, `playtest_stop`
- `search` (2): `search_records`, `search_map_events`
- `maintenance` (8): `list_backups`, `restore_backup`, `editor_status`, `validate_project`, `begin_changeset`, `commit_changeset`, `discard_changeset`, `undo_changeset`
- `connect` (2): `connect_maps`, `list_map_connections`
- `balance` (5): `bulk_update_records`, `generate_param_curve`, `generate_enemy_scaling`, `balance_report`, `simulate_battle`
- `localization` (2): `export_texts`, `import_texts`
- `authoring` (2): `build_dialogue_tree`, `create_event_from_template`
- `generation` (4): `generate_map`, `capture_stamp`, `place_stamp`, `list_stamps`
- `analysis` (5): `audit_assets`, `lint_events`, `simulate_event`, `find_usages`, `analyze_progression`
- `assets` (3): `import_asset`, `list_assets`, `preview_asset`

### Changesets (transactional edits with undo)

For a multi-step change, wrap it in a changeset instead of letting every call hit the disk:

1. `begin_changeset {label}` — from now on every edit tool stages its result in memory. Reads
   (`get_map`, `get_record`, `list_plugins`, ...) see the staged edits, but **nothing is on disk
   until you commit**; a playtest only sees committed files.
2. Make the edits as usual.
3. `commit_changeset` writes every staged file in one step (staged `.json` files are validated
   first; if any is invalid nothing is written and the changeset stays open) and returns a
   per-file summary. Or `discard_changeset` to drop everything.
4. `undo_changeset` rolls the most recent commit back from its journal in
   `.mcp-backups/changesets/` (call it repeatedly to go further back). It restores the files as
   they were before that commit, so edits made to them since are overwritten too.

Only one changeset can be open at a time, `restore_backup` is refused while one is open and
`set_project` discards it. If the process dies in the middle of a commit, the next time the
project is opened the half-finished commit is rolled back (the files found on disk are backed up
first) and `set_project` / `editor_status` report it. Keep the RPG Maker editor closed, as always.

## Skills, prompts and resources

Besides tools, the server offers three kinds of built-in guidance that MCP clients can use:

**Skill files** (`skills/<name>/SKILL.md`) are short workflow guides for the assistant. They are
served as resources (`rpgmaker://skills/<name>`) and can be copied into your game project with
the `install_skills` tool, so Claude Code loads them automatically in that project
(`.claude/skills/`, or `scope: "user"` for `~/.claude/skills/`):

| Skill | Covers |
| --- | --- |
| `rpgmaker-mv-workflow` | Safety rules, data conventions, which tool to use for what, assets and analysis before release |
| `rpgmaker-map-building` | Plan → paint → look → fix loop, layers, tile choice, connecting maps |
| `rpgmaker-event-writing` | Dialogue, choices, indentation rules, switches, one-time chests, triggers |
| `rpgmaker-balancing` | Targets, report/simulation workflow, curves, bulk edits with dry runs |
| `rpgmaker-localization` | Export/import workflow, control codes, message length |
| `rpgmaker-plugin-dev` | Plugin header, aliasing engine methods, plugin commands, testing |

**Resources** — `rpgmaker://reference/event-commands`, `trait-codes`, `damage-formulas` and
`database-fields` are the lookup tables an assistant needs most, available without a tool call.

**Prompts** — ready-made workflows that show up as commands in clients that support MCP prompts:
`new_town`, `design_dungeon`, `add_quest`, `balance_check`, `review_dialogue`, `translate_game`
and `project_health`.

## Map generation and stamps

`generate_map` builds a **dungeon** (rooms joined by corridors) or a **cave** (one organic
connected region) either into an existing empty map (`mapId`) or into a new one (`create`, which
also registers it in `MapInfos.json`). It is deterministic: the same `seed`, size and options
give the same layout, and the seed used is always returned. A map that already has tiles or
events is refused unless you pass `overwrite: true`.

- **Tile profile.** The map is painted with a profile (`floor`, `wall`, optional `wallTop`,
  optional weighted `decor`). If you give none, one is suggested from the tileset's own data
  (walkable A2 kind for the floor, blocking A4 wall kind for the wall) and returned as
  `profileUsed` / `profileNotes`. Nothing is written if the floor is not walkable, the wall does
  not block movement, or the result is not fully reachable from the entrance.
- **Markers.** `markers` (default: entrance and exit, no chests) places empty events named
  `Entrance`, `Exit` and `Chest 1..n` at priority 0, so they never block the player. They are
  placeholders: wire the doors with `connect_maps` (pass `allowOverlap`, or `delete_event` the
  marker first) and fill the chests with `create_event_from_template`.
- **Sizes.** Dungeons need at least 14x7 (or 7x14); caves are reliable from about 13x13 (MV's
  default 17x13 never failed in testing), while 9x9 to 12x12 and thin maps fail for many seeds; try
  another seed or a larger map.
- **Look at it.** Use `render_map_image` (try `showPassability`) and `render_diff`. Wall faces are
  a one-row simplification and decor is sparse; see [CHANGELOG.md](CHANGELOG.md) for what has and
  has not been checked.

**Stamps** are reusable pieces of map. `capture_stamp` saves a rectangle (up to 64x64, all six
layers and, by default, the events inside it) to `<project>/.mcp-stamps/<name>.json`;
`place_stamp` pastes it with its top-left corner at `(x, y)` on a map that uses the same tileset
and `list_stamps` shows what you have. Placement replaces the rectangle on every layer, re-shapes
autotile edges against the surroundings and never clips; there is no rotate or mirror.

## Assets

Three tools handle the project's image and sound files (`img/*` and `audio/*`, 18 folders):

- `import_asset {source, folder, name?, overwrite?}` copies a file from your computer into
  `<project>/<folder>/<name>.<ext>`. `source` must be an absolute path to a regular file on a local
  drive (no relative paths, network shares, devices or symbolic links). The file type is read from
  the file's **header only** and must fit the folder: `img/*` takes files with a PNG signature and
  header, `audio/*` takes files that start with `OggS` (Ogg) or have an `ftyp` box (M4A). The
  extension is chosen from what the header says, never from the source name. Nothing is converted
  or resized, and the rest of the file is not checked. Size caps are 32 MiB for images and 128 MiB
  for audio.
- `list_assets {folder?, includeUsage?, limit?}` lists the files of one or all folders with size,
  PNG dimensions, warnings (a header that does not match the extension, a sheet size that does not
  fit the folder, interlaced PNGs) and, for the folders the reference scan covers, `usedBy` and
  `unused`. Unused means no reference with exactly that name (case-sensitive) in the database, maps,
  common events or troops; a plugin or script that loads a file by name is not seen.
- `preview_asset {folder, name, maxSize?}` returns a PNG from an `img/*` folder as an image
  (nearest-neighbour scaled to at most `maxSize` pixels on its longer edge), with the sheet layout
  implied by the name for `img/characters` and `img/faces`. Interlaced PNGs, files over 32 MiB and
  images above 16 million pixels are refused; audio cannot be previewed.

**Name rules.** A name is 1-64 characters from `A-Z a-z 0-9 space _ ! $ ( ) -`, starts with a
letter, digit, `!` or `$`, has no trailing space, no dot (the extension is added for you) and no
path separators, and is not a reserved Windows device name (`CON`, `NUL`, `COM1`, `LPT1`, ...). In
`img/characters`, a name whose leading run of `!` and `$` characters contains a `$` (`$Boss`,
`!$Chest`) is a one-character sheet; a `!` means no vertical offset on the map.

**Backups and changesets.** An existing file with the same name (letter case ignored) is only
replaced with `overwrite: true`, and the old file goes to the session backup in `.mcp-backups/` like
any other edit (`list_backups`, `restore_backup`). Binary files cannot be staged, so `import_asset`
is refused while a changeset is open; commit or discard it first. Nothing is written when an import
is refused. For audio, a warning tells you when the `.ogg` or `.m4a` twin is missing (MV's web
build needs both).

## Cutscene and game-flow nodes

Besides dialogue, choices, conditions, switches, variables and transfers, `build_dialogue_tree`
compiles these nodes into correctly indented commands:

- **Cutscene:** `wait`, `fade` (out / in), `tint`, `flash`, `shake`, `weather`, `playAudio`,
  `fadeAudio`, `showPicture`, `erasePicture`, `animation`, `balloon` and `moveRoute`. A route is a
  list of steps (`up`, `turnLeft`, `{wait: 10}`, `{jump: {x, y}}`, `{switchOn: 5}`, `{speed: 4}`,
  ...); a repeating route (`repeat: true`) never finishes, so it cannot be waited for and an
  explicit `wait: true` is rejected.
- **Game flow:** `battle` (`onWin`, `onEscape` and `onLose` bodies; like the editor, the branches
  and their closer are written only when `canEscape` or `canLose` is on, or `onWin` has nodes, and
  with neither the battle is a single command followed by whatever comes next; a body for a branch
  whose box is off is rejected), `shop`, `callCommon`, `label` / `jump`, `exit`, `comment`,
  `gold`, `item` (items, weapons and armors), `party`, `learnSkill`, `recoverAll`, `nameInput`,
  `plugin` (a plugin command line) and `scene` (menu, save, game over, title).

Example, as the `tree` argument (or with `dryRun: true` to only look at the commands):

```json
[
  { "fade": "out" },
  { "battle": { "troopId": 3, "canLose": true,
      "onWin": [{ "gold": 200 }],
      "onLose": [{ "say": "Defeated..." }, { "scene": "gameOver" }] } },
  { "fade": "in" },
  { "shop": { "goods": [{ "type": "item", "id": 1 }, { "type": "weapon", "id": 2, "price": 300 }] } }
]
```

`simulate_event` can dry-run the result: presentation commands are skipped and counted in
`cosmetic`, and `battleResult` (`win`, `escape` or `lose`) chooses which battle branch runs. The
command layouts come from knowledge of the MV engine, not from its source, so playtest important
events; see [CHANGELOG.md](CHANGELOG.md) for the limitations.

## Analysis

Checks that need no running game:

- `audit_assets` — every image and audio file the project references (actors, enemies,
  tilesets, maps, event pages, a set of event commands, System) must exist; also lists case
  mismatches (fine on Windows, broken on Linux/macOS/web) and optionally unused files. The
  result lists what is **not** scanned (for example plugin parameters), so "unused" can include
  files that only plugins use.
- `lint_events` — static checks of event command lists in maps, common events and troops:
  broken block structure and terminators, unreachable commands, over-long message lines,
  transfers to missing maps or out-of-bounds tiles, calls to missing common events, and
  switches/variables without a name. Findings carry a location; the line length limit is an
  approximation.
- `simulate_event {mapId, eventId, ...}` — dry-runs one event page against a state you supply
  (switches, variables, self switches, gold, items, answers to choices) and returns the messages
  shown, the changes made, the transfer it ends in and the commands it could not simulate. It
  covers messages, choices, conditions, loops, common events, switch/variable/self switch/gold/item
  changes, transfers, plugin commands, labels and jumps; battles run the branch chosen by
  `battleResult` (`win`, `escape` or `lose`, default win); animations and balloons (212, 213),
  screen fades, tint, flash and shake (221-225), waits (230), show/erase picture (231, 235),
  weather (236), play/fade audio (241, 242, 245, 246, 249, 250, 251) and move routes (205) are
  ignored and only counted in `cosmetic` (the switch ON/OFF steps of a move route still apply);
  scripts, picture moves (232-234) and other commands are listed as unsupported and skipped. It
  never touches the project.
- `editor_status` — reports whether the RPG Maker editor process appears to be running (Windows
  only; `null` elsewhere) and which files this server wrote have since been modified by something
  else, usually the editor saving over them. It only reports.

## Usage and progression analysis

Both tools read the whole project (staged changeset data included) and never run the game.

- `find_usages {kind, id, limit?}` lists every place one switch, variable, item, weapon, armor,
  skill, state, actor, class, enemy, troop, common event or map is **read**, **written** or
  **used**, as locations like `Map003 event 5 page 1 command index 12` or `Enemies #4 dropItems`
  (map, event and common event ids are the real ids, pages are 1-based like the editor, and
  the command index is the 0-based position that `lint_events` also reports), with exact counts
  and warnings: a switch or variable that is read but never set (or set but never read), a common event
  nothing calls, a map nothing transfers to, an id without a name. Use it before renaming, deleting
  or reusing an id.
- `analyze_progression {goal?, includeGraph?, limit?}` follows the game from the start map and
  reports the reachable and unreachable maps, maps with no way out, event pages that can never
  run (with the first condition that is never met), switches and variables that are read but never
  set or set but never read, and a summary in plain language. `goal` (`{switch}`, `{mapId}` or
  `{event: {mapId, eventId}}`) adds a verdict with the reasons it is blocked, and `includeGraph`
  adds a Mermaid flowchart of the map transfers.

**What the analysis can prove.** It is an over-approximation of a playthrough: a page may run
whenever its page conditions could hold, and when it runs all of its commands take effect. Switches
only ever turn on and items are never lost. So *unreachable* and *never set* are proofs under that
model, while *reachable* only means "not ruled out".

**What it cannot see.** Conditions inside event commands (branches, choices), script commands and
plugin commands, transfers and battles whose target is a variable, enabled plugins and their
parameters and notetags (they can call common events, set switches or move the player), and
vehicles' start maps. It never models switches turning off and does not detect soft-locks.
`find_usages` does not index every command either; the list is in [CHANGELOG.md](CHANGELOG.md).

**Confidence.** `uncertainty.confidence` is `low` as soon as the project contains any of the
things it cannot see (or a map or `js/plugins.js` it could not read), and the summary says why.
Trust *unreachable* and *dead* results only when it is `high`; almost every project with custom
plugins reports `low`. The same applies to the "never ..." warnings of `find_usages`, which carry a
note when script or plugin commands could act on the id.

## Balancing tools in a nutshell

Bulk edits, curve generators and `import_texts` are **dry runs by default** — they return a diff
and write nothing until you pass `dryRun: false`. `simulate_battle` and `balance_report` use the
project's real class curves, equipment, traits and damage formulas (evaluated safely: formulas
are checked against a whitelist before they run). They do not model states, buffs or items, so
treat them as a guide and playtest the important fights.

## Backups

The first time a session modifies any file, the original is copied to
`<project>/.mcp-backups/<session-timestamp>/` preserving its relative path. Up to 10
sessions are kept. `list_backups` shows what's available; `restore_backup` restores one
file or a whole session — and backs up the current state first, so restores are undoable.

Add `.mcp-backups/` and `.mcp-stamps/` to your game project's `.gitignore` if the game is under
version control (leave `.mcp-stamps/` out if you want to share stamps). Changeset journals live
under `.mcp-backups/changesets/` and are not pruned.

## Important notes

- **Close the RPG Maker MV editor (or don't save from it) while the server edits files.**
  The editor keeps the whole database in memory and overwrites the JSON files on save,
  discarding external changes. Reopen the project in the editor to see edits made here.
- Database arrays in MV are 1-indexed with `null` at index 0; the tools handle this
  automatically, and ids always match array positions.
- MZ projects (`.rmmzproject`) are accepted too — the data format is nearly identical —
  but they are untested.
- Known limitations of this release (unverified editor process name, unchecked visual quality of
  generated maps, no scripted playtest runner, ...) are listed in [CHANGELOG.md](CHANGELOG.md).
- Tiles are painted with `paint_tiles` (not `update_map`, which refuses to touch `data`).
  Pick tiles via `get_tileset_info` / `get_tileset_image`; a tile's sheet must have an image
  assigned in the map's tileset, otherwise the tile would be invisible and the call is rejected.
- `render_map_image` reads the tileset and character images from `img/` (encrypted `.rpgmvp`
  deployments cannot be shown); sheets without a usable image are drawn as flat colours and
  listed in the answer. Water is drawn in its first animation frame.
- `export_texts` writes into the project (default `localization/`); the file is backed up
  before it is overwritten and existing translations are carried over by key.
- NW.js playtest auto-detects Steam and KADOKAWA install paths, the project's own
  `Game.exe`, and the `RPGMAKER_MV_NWJS` environment variable, in that order.
- In browser playtest mode, console output stays in the browser devtools — use NW.js mode
  when you need `playtest_log`.

## Building from source

For contributors or if you prefer to build locally:

```sh
git clone https://github.com/Xerolo44/RPG-Maker-MV-MCP.git
cd RPG-Maker-MV-MCP
npm install
npm run build
```

Then use the local build with Claude Code:

```sh
claude mcp add rpgmaker-mv -- node "$(pwd)/dist/index.js" --project "/path/to/YourGame"
```

## Development

```sh
npm run build   # compile TypeScript to dist/
npm run test:unit  # node:test unit tests in test/ (PNG, formulas, renderer, battle maths, generators, ...)
npm run smoke      # end-to-end test: real stdio client against a generated MV project
npm test           # build + unit tests (test/) + smoke test (what CI runs)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout and guidelines,
[CHANGELOG.md](CHANGELOG.md) for release history, and [SECURITY.md](SECURITY.md) for the
tool's trust model (it has full file-system access — read this before exposing `--http`
mode beyond your own machine).

## License

[MIT](LICENSE)

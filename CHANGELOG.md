# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.5.1] - 2026-10-25

### Added
- **1 new tool** (78 in total): `check_references` (group `analysis`) finds references that point
  at records which do not exist: a Battle Processing on a missing troop, a shop item, Learn Skill or
  Change Items on a missing record, a Common Event call, a transfer to a missing map, a page
  condition on a missing item or actor, an enemy drop or action, a class learning, an actor's
  class or equipment, a troop member, an item or skill effect, a map encounter list, System
  `startMapId` and `partyMembers`. It reads the same project index as `find_usages`, so it checks exactly the references
  `find_usages` lists, against the rows of the database files and the maps listed in
  `MapInfos.json`. Findings are grouped by kind and id with a reference count and up to three
  locations, capped by `limit` (default 100) with `truncated`, and every entry has severity
  `error`. Id 0 ("none") is never reported, switches and variables are not checked, and a database
  file that is missing or unreadable is named in `notes` instead of being treated as "everything
  is missing".

### Changed
- `build_dialogue_tree` writes the same blank end-of-branch rows as the MV editor: every choice
  branch (the cancel branch too), every Conditional Branch then and else body and every Battle
  Processing branch (601/602/603) ends with an empty `{code: 0}` row at the body's indent, and an
  empty branch consists of that row alone. The engine skips code 0 rows, so playing the event is
  unchanged. Everything that reads command lists accepts them (`validateCommandList`,
  `lint_events`, `simulate_event`, the project index, `find_usages`, `analyze_progression`,
  `check_references`, the `index` insertion rules); `simulate_event` does not count them as steps,
  so a long loop stops in the same state with or without them. Lists without the rows (older
  output, hand-written lists, empty branches the editor left bare) stay valid. The
  `locked_door` and `inn` templates now write the same rows (they share the helper
  `branchEnd` with the dialogue compiler); the other templates have no blocks.
- `simulate_event` treats Move Picture (232) as cosmetic, like Show Picture (231) and Erase
  Picture (235): it is skipped and counted in `cosmetic` instead of being listed as unsupported.
  Rotate Picture (233) and Tint Picture (234) are still listed as unsupported.
- The project index reads an actor's equipment slots like the engine: slot 1 is a weapon slot when
  the actor or its class has the Dual Wield trait (Slot Type, code 55, data 1), and entries beyond
  the slots in System `equipTypes` are ignored. Before, slot 1 always counted as an armor, so
  `check_references` and `find_usages` mistook a Dual Wield weapon for an armor. Without a usable
  `equipTypes` list, every entry still counts.
- `audit_assets` also scans Change Battle BGM (132), Change Victory ME (133), Change Defeat ME
  (139), Change Vehicle BGM (140), Change Battle Back (283), Change Parallax (284) and Change
  Vehicle Image (323) in map events, common events and troops. Empty names are ignored, as before.
- The `import_asset` description and the README now say precisely when `overwrite` leaves a backup
  (see Known limitations; the 0.5.0 entry below says it always does, which is not quite true).

### Known limitations
- `check_references` only sees what the project index sees. It does not see references made by
  script commands, plugin commands, notetags, plugin parameters, damage formulas or trait codes,
  Transfer Player and Battle Processing commands that name their target by variable, vehicle start
  maps, the Conditional Branch tests of class, skill, weapon, armor and state, the Conditional
  Branch enemy state test, Control Variables (122) game-data operands (item, weapon, armor and
  actor counts or parameters), enemy action conditions of type state, and commands 314, 319, 320,
  324, 325, 336 and 339 (the same gaps as `find_usages`). A map that cannot be read is skipped, and
  a transfer to it is not reported (it is listed in `MapInfos.json`; `validate_project` reports the
  missing file). Its `notes` count the script commands, plugin commands and enabled plugins in the
  project; switches and variables are not checked at all.
- A record exists for `check_references` when its database row has that `id`: the id field is what
  counts, not the position in the array (as in `find_usages`), so a table whose rows' ids differ
  from their positions can give wrong answers.
- The session backup that `import_asset` with `overwrite` relies on snapshots a file once per
  server session, before its first change (calling `set_project` again starts the snapshots over
  and replaces the earlier snapshot of a file). A file created earlier in the same session (for
  example by an earlier `import_asset`) and then overwritten has no backup of the version that was
  replaced; the backup holds only the version from before the session. This applies to every
  project file the server writes, not just assets.
- Checked against the official core scripts (`rpgtkoolmv/corescript`, `Game_Interpreter`,
  `Game_Actor`, `Game_BattlerBase`, `Game_Character`): the parameter layouts of the newly scanned
  commands (132, 133, 139, 140, 283, 284, 323), of the 0.5.0 dialogue nodes (125-129, 212/213,
  205 (its route object), 223-225, 230, 231/232 incl. the variable designation of 232, 235, 236, 242, 246, 301 and its
  branches, 302/605, 303, 313, 314, 318, 351-354, 356, 108/408, 115, 117-119) and of the
  move-route codes, plus the Dual Wield and `equipTypes` handling of actor equipment. That is
  engine source.
- Checked against real data (16 map files from public MV projects, read only, not included in this
  repository): a Battle Processing with neither box checked is a lone 301 followed directly by the
  next command (3 samples), and with a box checked it is 301, 601, body, 602, body, 603, body, 604;
  in 97 real Set Movement Route commands the number of 505 rows equals the number of route steps
  (without the final `{code: 0}`), each 505 has the indent of its 205 and holds the step object in
  its first parameter; and every non-empty block body ended with the blank `{code: 0}` row
  described above (32 of 32), an empty branch being that row alone. Real step objects often omit
  `parameters` and `indent` for parameterless steps, while ours carry `parameters: []` and
  `indent: null`; both are valid and both are accepted. `validateCommandList` accepted 266 of the
  268 real command lists. The two it rejected (one project) have a Battle Processing whose 604
  closer is missing, which `validateCommandList` and `lint_events` report as a block-structure
  error. The real data also contained 3 empty branches without the blank row; they stay accepted.
  Still unchecked: the 0.5.0 dialogue-node commands not listed above, and nothing was run in the
  real game.
- As in 0.5.0, no real RPG Maker MV project or editor was available: nothing in this release was
  run in the real game. The limitations of 0.5.0 and 0.4.0 below still apply.

## [0.5.0] - 2026-10-25

### Added
- **5 new tools** (77 in total):
  - Assets (new profile group `assets`): `import_asset` copies an image or sound from an absolute
    local path into `img/*` or `audio/*` (type read from the file header, name rules, size caps,
    `overwrite` keeps the old file in the session backup), `list_assets` lists the files of the 18
    asset folders with sizes, PNG dimensions, warnings and which places use each file, and
    `preview_asset` shows a PNG (scaled down) with the sheet layout implied by its name and size.
  - Analysis (group `analysis`): `find_usages` lists everywhere a switch, variable, item, weapon,
    armor, skill, state, actor, class, enemy, troop, common event or map is read, written or used,
    with warnings about dead ends, and `analyze_progression` answers "can the player get from the
    start map to X, and what can never happen?" for the whole project without running the game
    (reachable and unreachable maps, dead-end maps, pages that can never run, switches and
    variables that are never set or never read, an optional goal with the reasons it is blocked,
    an optional Mermaid map graph and a `confidence` of `high` or `low`).
- **28 new `build_dialogue_tree` node kinds**:
  - 13 presentation nodes: `wait`, `fade`, `tint`, `flash`, `shake`, `weather`, `playAudio`,
    `fadeAudio`, `showPicture`, `erasePicture`, `animation`, `balloon`, `moveRoute`.
  - 15 game-flow nodes: `battle` (with optional win / escape / lose branches), `shop`,
    `callCommon`, `label`, `jump`, `exit`, `comment`, `gold`, `item`, `party`, `learnSkill`,
    `recoverAll`, `nameInput`, `plugin`, `scene`.
  - Block support for Battle Processing with branches (301 followed by 601-603 and closed by 604) in
    the command-list checks used by `build_dialogue_tree` and `lint_events`, and in the insertion
    checks of `build_dialogue_tree` (an `index` inside a battle branch or on a move-route row is
    refused). Like the editor, a 301 with no branch right after it (neither Can Escape nor Continue
    when Loss) is a single command, not a block, and `build_dialogue_tree` writes a `battle` node
    without `canEscape`, `canLose` or an `onWin` body as that lone 301.
- `simulate_event` understands the new commands: presentation commands (fades, tint, flash,
  shake, weather, waits, audio, pictures, animations, balloons, move routes) are skipped and
  counted in the new `cosmetic` field instead of being listed as unsupported; the new
  `battleResult` input (`win`, `escape` or `lose`, default `win`) picks the Battle Processing
  branch that runs (a Battle Processing without branches changes nothing and the next command
  runs); labels and jumps (118/119) work; and the switch ON/OFF steps of a Set Movement
  Route change the simulated switches.
- `Project.writeBinary`, the write path for binary files (session backup, tracked by
  `editor_status`); PNG header helpers (`pngInfo`, `pngIsInterlaced`) in `src/png.ts`; and the
  project event and reference index (`src/eventIndex.ts`) behind `find_usages` and
  `analyze_progression`.

### Changed
- `shopCommands` moved to a leaf module (`src/shopCommands.ts`), which removes an import cycle
  between `dialogueTree`, `eventTemplates` and `mapTools`; `eventTemplates` still re-exports it.
- `render_map_image` decides the sprite layout of a character sheet like MV does: a name whose
  leading run of `!` and `$` characters contains a `$` (`$Boss`, `!$Chest`) is a single-character
  sheet. Before, only names starting with `$` were.
- `decodePng` rejects PNG data that inflates to more than its header allows (a PNG with more than
  4096 trailing bytes after the image data is now rejected), a PNG whose IHDR is not the first
  chunk, and a second IHDR; it takes an optional `maxPixels` limit (default 64 million).
- Reserved Windows device names `COM0`-`COM9` and `LPT0`-`LPT9` are rejected in asset names.
- `src/reference.ts` (the event command reference, also served as a resource and by
  `event_command_reference`) documents more commands or more exact layouts: 103, 104, 108/408,
  125-129, 201-203, 205/505, 211-213, 223-225, 231, 236, 241-246, 285, 301/601-604, 314-317, 331
  and 332.
- The `js/plugins.js` reader (used by the plugin tools and `validate_project`) is a linear scanner
  instead of a regular expression.

### Fixed
- A `js/plugins.js` whose comments contain square brackets, or whose plugin array ends in a trailing
  comma, could not be parsed: the old reader took everything from the first `[` to the last `]` in
  the file.

### Security
- `decodePng` could be fed a PNG decompression bomb: a PNG of about 1.5 MB that inflates to 1.5 GB
  took `preview_asset` 10 s and 2.8 GB of RAM. Inflating is now bounded by the size the header
  implies.
- `import_asset` safety rules: the source must be an absolute local file (no UNC or device paths, no
  symbolic link), the size cap is checked before the file is read, the file type must match the
  folder by its header bytes, nothing is written when an import is refused, and it refuses to run
  inside an open changeset.
- `preview_asset` refuses images above 16 million pixels: the header size is checked first and the
  decoder enforces the same limit itself. `list_assets` and `import_asset` read the size from the
  first IHDR only, and refuse (or flag as unreadable) a PNG that has a second IHDR right after it.

### Known limitations
- `analyze_progression` is an over-approximation. It ignores conditions inside event commands,
  scripts, plugin commands, enabled plugins and their notetags, and the start maps of vehicles,
  and it never models switches turning OFF. "Unreachable" and "never set" claims are reliable only
  when its `confidence` is `high`; almost every project with custom plugins reports `low`. It does
  not detect soft-locks, and troop pages without any condition are treated as triggerable.
- `find_usages` does not index: the Conditional Branch subtypes class, skill, weapon, armor and
  state (111 with first parameter 4), commands 314, 319, 320, 324, 325, 336 and 339, trait codes,
  vehicle start maps, damage formulas, notetags and plugin parameters. `\\V[n]` (an escaped
  backslash) is counted as a read.
- `import_asset` checks headers only (PNG signature and IHDR; `OggS`; `ftyp`), so for example a HEIC
  file with an `ftyp` header is accepted as `.m4a`. It does not convert or resize, does not run
  inside a changeset, and follows symlinks inside the project like all other writes.
- `list_assets` marks files as unused by exact (case-sensitive) name.
- Damage formulas are evaluated JavaScript and can set switches and variables (for example through
  `$gameSwitches`); they are not analysed, so `analyze_progression` can report `confidence: high`
  while a formula changes state.
- The project index is built in memory. A hostile or machine-generated project with very large
  Control Switches / Control Variables (121/122) commands covering whole id ranges can use a lot of
  memory and time in `find_usages` and `analyze_progression`: a review measured
  about 1.2 GB for 5000 events whose commands expanded to about 10 million references.
- The layouts of the new dialogue nodes (236, 246, the 205/505 move-route shape, the 231
  designation slot, 108/408, 303, 129) come from knowledge of the MV engine, not from engine
  source. Commands 232-234 and 243/244 are not supported by `build_dialogue_tree`; `find_usages`
  and `analyze_progression` do read the variable designation of Move Picture (232), using the
  same parameter layout as 231, which is likewise unverified. That the MV editor writes a Battle
  Processing (301) without branches when neither box is checked also rests on knowledge of the
  editor, not on a real project file.
- No real RPG Maker MV project or engine was available for testing, so nothing in this release was
  run in the real game.
- The scripted browser playtest runner (`playtest_scenario`) is still **not** included.
- The known limitations of 0.4.0 below still apply, except that `simulate_event` now supports
  labels (118/119) and skips fades and waits (221-225, 230) as cosmetic instead of listing them as
  unsupported.

## [0.4.0] - 2026-10-24

### Added
- **15 new tools** (72 in total):
  - Safety and editor awareness: `editor_status` reports whether the RPG Maker MV editor process
    appears to be running and which files this server wrote have since been changed by something
    else. Changesets (transactional edits): `begin_changeset`, `commit_changeset`,
    `discard_changeset`, `undo_changeset` — while one is open every edit tool stages its result in
    memory, reads reflect the staged edits and nothing is on disk until commit. Commit writes all
    staged files as one unit with a per-file summary, journals the pre-images under
    `.mcp-backups/changesets/` so commits can be undone, validates staged `.json` files first, and
    a commit interrupted by a crash is rolled back automatically the next time the project is
    opened.
  - Analysis: `audit_assets` (missing images and audio, case mismatches, optionally unused files),
    `lint_events` (unterminated or mismatched command lists, unreachable commands, over-long
    message lines, transfers to missing or out-of-bounds targets, missing common events, unnamed
    switches and variables) and `simulate_event` (dry-runs one event page against a hypothetical
    game state and returns messages, changes, transfers and the unsupported commands it skipped).
  - Authoring: `build_dialogue_tree` compiles a nested say / choices / if / set-switch /
    set-variable / transfer tree into correctly indented event commands, and
    `create_event_from_template` builds a finished chest, locked door, inn, shop, save point or NPC
    event in one write. A choices node with `cancel: "branch"` is written as cancel type -2 (a
    "when cancel" branch, command 403).
  - Visuals: `render_diff` compares a map with an earlier backup session or changeset and returns
    a PNG of the current map with changed cells and added or moved events outlined.
  - Generation: `generate_map` (seeded dungeons and caves, painted with a tile profile suggested
    from the tileset, with entrance, exit and chest marker events), and `capture_stamp`,
    `place_stamp`, `list_stamps` to save a rectangle of a map (tiles and events) under
    `.mcp-stamps/` and paste it onto another map of the same tileset.
- **Tool profiles**: `--tools a,b` (or the environment variable `RPGMV_TOOLS`) registers only the
  chosen tool groups to keep the tool list short. Groups: `project`, `database`, `maps`, `tiles`,
  `render`, `plugins`, `playtest`, `search`, `maintenance`, `connect`, `balance`, `localization`,
  `authoring`, `generation`, `analysis`; `project` is always on and the default is `all`.
  `install_skills`, resources and prompts are always on.
- `showPassability` option on `render_map_image`: tints cells that are blocked in at least one
  direction translucent red.
- `npm run test:unit`: a `node:test` harness for the tests in `test/`; `npm test` runs build, unit
  tests and the smoke test.

### Changed
- `add_dialogue` now shares its message builder with `build_dialogue_tree` (behaviour unchanged),
  and `create_map` shares its MapInfos registration with `generate_map` (output unchanged).
- Plugin and localization file writes go through `Project.writeText`, so they are backed up,
  tracked by `editor_status` and staged by changesets. As a consequence `create_plugin` now takes
  the session backup of the new scaffold, and a later `write_plugin` in the same session no longer
  saves a copy of the scaffold.
- The event command reference (`src/reference.ts`, also served as a resource and by
  `event_command_reference`) was corrected: command 111 has five parameter slots in the variable
  form and now documents the self switch, gold and item conditions; command 302 is the flat
  `[type, id, priceType, price, purchaseOnly]` form; command 314 is `[0, 0]`.
- `list_backups`, `restore_backup` and backup pruning ignore the `changesets` journal folder.

### Fixed
- The browser playtest static server accepted sibling directories whose name starts with the
  project folder's name (e.g. `/games/mv-secret` next to `/games/mv`). Containment is now checked
  with `path.relative`. Malformed URL escapes no longer crash the server (400), methods other than
  GET and HEAD get 405, and directories get 404.

### Security
- Fixed the path containment bug in the browser playtest static server described above: files in a
  sibling directory sharing the project folder's name prefix could be read through the playtest
  server.

### Known limitations
- The scripted browser playtest runner (`playtest_scenario`) planned for this release is **not**
  included: it needs verification against a real RPG Maker MV engine first.
- Map generation was checked with passability and reachability checks and with unit and end-to-end
  tests, but its visual quality on real RTP tilesets (the one-row wall faces, decor) was not checked
  by eye. Caves are reliable from about 13x13 (MV's default 17x13 never failed in testing); 9x9 to
  12x12 and thin maps fail for many seeds, so try another seed or a larger map. Dungeons need at
  least 14x7 (or 7x14).
- `editor_status` detects the editor process on Windows only, and the process name `RPGMV.exe` is
  unverified. Elsewhere it reports `editorRunning: null`; the check for externally changed files
  works on every platform.
- `undo_changeset` restores the pre-images, so it overwrites edits made to those files after the
  commit. The changeset journal is not pruned, and one server process per project is assumed.
- The static playtest server follows symlinks inside the project folder and serves
  dot-directories.
- `get_tileset_info` labels a kind "passable" unless all four direction bits are set, whereas
  `generate_map`, the tile-profile suggestion and `showPassability` treat any set direction bit as
  blocking. A floor listed as passable can therefore be refused by `generate_map`.
- The static playtest server has no Host-header check: while a browser playtest is running, DNS
  rebinding could let a web page read the project files.
- `build_dialogue_tree`'s `cancel: "branch"` creates an empty "when cancel" branch whose body
  cannot be authored from the tree.
- `simulate_event` lists some commands the templates use as unsupported: the shop and save screens
  (302, 352) and the fades, wait and Recover All (221/222/230/314) that the inn template uses. It
  caps the number of entries, not their size, does not clamp gold above 99,999,999, does not
  support labels (118/119), and ends silently on an unmatched 111 or 102.
- Stamp-name case sensitivity follows the filesystem (case-insensitive on Windows and default macOS
  volumes, case-sensitive on typical Linux), so "Well" and "well" may be one file or two. `list_stamps` does not list stamps staged in an
  open changeset.
- The decor density of generated maps is conservative (about 1-2% of floor cells).
- MZ projects are accepted but untested.
- The event-command layouts used by templates and dialogue trees come from knowledge of the MV
  engine, not from engine source. Playtest important events.

## [0.3.0] - 2026-10-24

### Added
- **Skill files, prompts and resources** (the server previously offered tools only):
  - Six bundled `SKILL.md` workflow guides in `skills/` (`rpgmaker-mv-workflow`,
    `rpgmaker-map-building`, `rpgmaker-event-writing`, `rpgmaker-balancing`,
    `rpgmaker-localization`, `rpgmaker-plugin-dev`), shipped in the npm package.
  - `install_skills` copies them into `<project>/.claude/skills` (or `~/.claude/skills`).
  - Resources: `rpgmaker://skills/{name}` plus the lookup tables `rpgmaker://reference/event-commands`,
    `trait-codes`, `damage-formulas` and `database-fields`.
  - Prompts: `new_town`, `design_dungeon`, `add_quest`, `balance_check`, `review_dialogue`,
    `translate_game`, `project_health`.
- **`render_map_image`** — renders a map to a PNG: all tile layers with engine-exact autotile
  shapes, shadows, tiles that draw above characters, event character sprites, numbered/coloured
  event markers (doors in blue), region ids and a grid. Dependency-free PNG decoder/encoder.
- **Map connector** — `connect_maps` creates Transfer Player doors on two maps in both
  directions (spawn tile and facing, touch/action trigger, fade, sound; validated before anything
  is written, refuses occupied tiles). `list_map_connections` lists all doors, one-way links,
  transfers to missing maps and maps unreachable from the start map.
- **Bulk edits and balancing**:
  - `bulk_update_records` — set/add/multiply/percent on any field path (`params.atk`, `price`,
    `damage.formula`, ...) for filtered records, with rounding and clamps; dry run by default.
  - `generate_param_curve` and `generate_enemy_scaling` — linear, ease, exponential and logistic
    stat curves for classes and ordered enemy tiers (including EXP and gold); dry run by default.
  - `balance_report` — class curves, attack damage by level, attacker-vs-enemy and enemy-vs-attacker
    hits-to-kill matrices and warnings.
  - `simulate_battle` — seeded Monte-Carlo troop-vs-party simulation using the real damage
    pipeline (formulas, variance, crits, hit/evasion, TGR, turn order, enemy action ratings).
    Damage formulas are checked against a whitelist before they are evaluated.
- **Localization** — `export_texts` / `import_texts` for database texts, System terms, map names,
  dialogue, choices, scrolling text and battle events as CSV or JSON. Re-exporting keeps existing
  translations, import is a dry run by default, flags changed originals and control-code
  mismatches, keeps choice labels in sync and splits long dialogue into extra message boxes.
- Unit tests (`npm run test:unit`) for the pure modules; `npm test` runs build, unit and smoke tests.

### Changed
- The event command reference text moved to `src/reference.ts` so it can also be served as a resource.

## [0.2.0] - 2026-10-24

### Added
- **Tilesets and map painting** (5 new tools), so maps can finally be built, not just created blank:
  - `get_tileset_info` — sheets (A1–A5, B–E) and their images, tile id ranges, every autotile
    kind with type, position on the sheet and passability, and a passability grid for A5/B–E.
  - `get_tileset_image` — returns a tileset sheet as an image so the assistant can see the tiles.
  - `set_map_tileset` — switch a map to another tileset (validated against `Tilesets.json`).
  - `paint_tiles` — batch operations (`cells`, `rect`, `fill`) on any of the six map layers,
    with tiles chosen as `{sheet, kind}` / `{sheet, index}` or a raw tile id. Autotile shapes
    (47-shape floors, 16-shape walls, waterfalls) are computed from the neighbours and
    neighbours are re-shaped, matching the editor and the engine's own tables.
  - `render_map` — text view of a map region (symbols with legend, or raw tile ids).
- `create_map` takes an optional `fill` tile for layer 0, so new maps are not empty.
- `--http [port]` mode: exposes the server as a Streamable HTTP + HTTPS endpoint
  (`https://127.0.0.1:<port>/mcp`) for URL-based/custom-connector MCP clients, alongside the
  existing stdio mode. Bound to localhost only, with a per-connection remote-address check.
  Uses a self-signed certificate for `localhost`/`127.0.0.1`, generated once and cached in
  `.certs/`.

## [0.1.0] - 2026-07-18

Initial release. 41 tools across eight groups:

### Added
- **Project**: `set_project`, `get_project_info`; `--project` CLI flag; MV and MZ project detection.
- **Database**: generic CRUD (`list_records`, `get_record`, `update_record`, `create_record`) over all
  12 database types; `get_system` / `update_system`; `set_switch_name` / `set_variable_name`.
- **Skill helpers**: `create_damage_skill`, `create_healing_skill`, `create_buff_skill`,
  `create_state_skill` — build complete, editor-valid skills from a name and a formula.
- **Search**: `search_records` across one or all databases; `search_map_events` across all maps,
  optionally searching inside event command lists.
- **Maps & events**: `list_maps`, `get_map`, `create_map`, `update_map`, event CRUD,
  `add_event_command` (batch insert), `add_dialogue` (auto 101/401 message building),
  `event_command_reference`.
- **Plugins**: list/configure/register/unregister, `create_plugin` scaffolding,
  read/write plugin source.
- **Playtest**: NW.js launch with runtime auto-detection and stdout/stderr capture;
  browser mode via built-in static HTTP server.
- **Safety**: automatic per-session backups of every modified file to `.mcp-backups/`,
  `list_backups` / `restore_backup`, and `validate_project` integrity checking.
- End-to-end smoke test (`npm run smoke`).

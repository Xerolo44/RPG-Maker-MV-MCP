# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

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

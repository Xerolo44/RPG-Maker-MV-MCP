# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

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

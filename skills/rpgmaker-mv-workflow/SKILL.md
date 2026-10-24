---
name: rpgmaker-mv-workflow
description: Core workflow and safety rules for editing an RPG Maker MV project through the rpgmaker-mv MCP server. Use at the start of any session that creates or changes game data, maps, events or plugins.
---

# RPG Maker MV - working with the MCP server

## Before you touch anything
1. Call `get_project_info` (or `set_project` with the project folder if none is selected). It shows the title, start map, counts and plugin list.
2. The RPG Maker editor keeps the whole database in memory and overwrites the JSON files when it saves. Ask the user to **close the editor** (or at least not save from it) while you edit, and to reopen the project afterwards.
3. Every file is snapshotted into `.mcp-backups/<session>/` before its first change. Mention `list_backups` / `restore_backup` when the user worries about a change.

## Data conventions you must respect
- Database arrays are **1-indexed**: index 0 is `null`, and a record's `id` equals its array position. Never write ids yourself - `create_record` assigns them.
- `params` arrays are `[MHP, MMP, ATK, DEF, MAT, MDF, AGI, LUK]`.
- Read the resource `rpgmaker://reference/database-fields` for the fields of every record type, `rpgmaker://reference/trait-codes` for traits and `rpgmaker://reference/damage-formulas` for formulas.
- When creating records, fetch an existing one with `get_record` first and copy its shape - missing fields make the editor choke.

## Picking the right tool
| Goal | Use |
| --- | --- |
| New damage / heal / buff / state skill | `create_damage_skill`, `create_healing_skill`, `create_buff_skill`, `create_state_skill` |
| Change many records at once | `bulk_update_records` (dry run first) |
| Tune stat curves | `generate_param_curve`, `generate_enemy_scaling`, then `balance_report` and `simulate_battle` |
| Find where something is used | `search_records`, `search_map_events` (with `searchCommands`) |
| Build a map | `create_map`, `get_tileset_info`, `paint_tiles`, `render_map_image` |
| Link two maps | `connect_maps`, then `list_map_connections` |
| Events and dialogue | `create_event`, `add_dialogue`, `add_event_command` |
| Translate the game | `export_texts`, `import_texts` |
| Check the result | `validate_project`, `playtest_start` |

## Habits that prevent damage
- **Preview first.** Anything that touches many records (`bulk_update_records`, `import_texts`, the curve tools) defaults to a dry run - show the user the diff, then apply with `dryRun: false`.
- **Look at what you build.** After painting or placing events call `render_map_image` and actually inspect the picture.
- **Validate before you finish.** Run `validate_project` and fix broken references (missing maps, items, skills, common events).
- **Name things.** Use `set_switch_name` / `set_variable_name` for every switch and variable you introduce so the project stays readable in the editor.
- Tile data is edited only through `paint_tiles`; `update_map` refuses `data` and `events`.
- Do not delete or rewrite data the user did not ask about. When in doubt, search first (`search_records`) to see what depends on it.

## Suggested order for a new feature
1. Design it in plain words (what the player sees and does).
2. Create the data (skills, items, enemies, troops).
3. Build or edit maps, then events that reference the data.
4. Name switches/variables, run `validate_project`.
5. `playtest_start` (NW.js mode captures the console via `playtest_log`) and report what you verified and what you could not.

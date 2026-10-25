---
name: rpgmaker-event-writing
description: Writing RPG Maker MV event command lists - dialogue, choices, switches and variables, conditional branches, shops and battles - with the rpgmaker-mv MCP server. Use when creating NPCs, chests, quests or cutscenes.
---

# Writing events

An event has `pages`; each page has `conditions`, an `image`, a `trigger` and a `list` of commands `{code, indent, parameters}`. Every list ends with `{code: 0, indent: 0, parameters: []}`. The full table is in the resource `rpgmaker://reference/event-commands` and the tool `event_command_reference`.

## Fast paths
- **Dialogue:** `add_dialogue {mapId, eventId, lines, faceName?, position?}` builds the 101/401 commands and starts a new message box every 4 lines (the window shows 4 lines).
- **Common patterns (preferred):** `create_event_from_template {mapId, x, y, template, ...}` builds a finished chest, locked door, inn, shop, save point or NPC in one write; it refuses an occupied tile unless `allowStack` is true. Events are invisible until you give them an image.
- **Branching conversations (preferred):** `build_dialogue_tree {tree, mapId?, eventId?}` compiles nested say / choices / if / set-switch / set-variable / transfer nodes into correctly indented commands. Call it without `mapId`/`eventId` (or with `dryRun`) to preview first. Use these two before hand-writing `add_event_command` lists; the hand-built indent and terminator bookkeeping is where most event bugs come from.
- **Anything else:** `add_event_command` with a `commands` array; it inserts before the terminator, or at `index`.
- **New NPC:** `create_event {mapId, name, x, y}` then `add_dialogue`. Give it a sprite by passing a page with `image: {characterName, characterIndex, direction, pattern: 1}` (look at an existing event with `get_event` for the full page shape).

## Indentation rules
Commands inside a branch have `indent` one higher than the command that opens it:

```
{code: 111, indent: 0, parameters: [0, 5, 0]}        // if switch 5 is ON
  {code: 101, indent: 1, parameters: ["", 0, 0, 2]}
  {code: 401, indent: 1, parameters: ["You already have the key."]}
{code: 411, indent: 0, parameters: []}                // else
  {code: 101, indent: 1, ...}
{code: 412, indent: 0, parameters: []}                // end branch
```

Choices work the same: 102 opens, each option starts with 402 `[index, "text"]`, the whole block ends with 404.

## Quests and state
- Use **switches** for yes/no state, **variables** for counters, **self switches** (command 123, with page conditions) for one-time things like chests.
- Name every switch/variable with `set_switch_name` / `set_variable_name`.
- A one-time chest: page 1 shows the closed chest and runs `Change Items`, `Control Self Switch A = ON`; page 2 has condition `selfSwitchValid: true, selfSwitchCh: "A"` and the open-chest image with no commands.
- Gate content on state with page conditions (`switch1Valid` + `switch1Id`) instead of long conditional branches when you can.

## Triggers and priority
Trigger: 0 action button, 1 player touch, 2 event touch, 3 autorun, 4 parallel. Be careful with **autorun**: an autorun page that never turns itself off freezes the game. Priority 0 (below characters) lets the player walk over the event; 1 blocks.

## Common commands (codes)
201 Transfer Player `[0, mapId, x, y, direction, fade]` (prefer `connect_maps`), 301 Battle `[0, troopId, canEscape, canLose]`, 302 Shop, 125 Change Gold, 126 Change Items, 121 Control Switches, 122 Control Variables, 117 Common Event, 241 Play BGM, 355 Script.

## Checks
- `simulate_event {mapId, eventId, switches?, variables?, selfSwitches?, gold?, items?, choices?, battleResult?}` dry-runs one event page against a state you choose and returns the messages, switch/variable/gold/item changes and the transfer it ends in, without playing the game. Use it to confirm a quest gate or one-time chest does what you meant (`choices` lists the answers in order; the page defaults to the one that would be active). `battleResult` (`win`, `escape`, `lose`; default win) picks the branch of every battle, labels and jumps work, and presentation commands (animations, fades and screen effects, waits, show/erase picture 231/235, weather, play/fade audio 241/242/245/246/249/250/251, move routes) are ignored and counted in `cosmetic`. Commands it cannot simulate (scripts, move/rotate/tint picture 232-234, BGM/BGS save and replay 243/244, party and scene commands, ...) are listed under `unsupported` and skipped, so it is a check, not a replacement for a playtest.
- `lint_events` statically checks maps, common events and troops: broken blocks and missing terminators, unreachable commands, over-long message lines, transfers to missing maps or outside a map, missing common events and (with `minSeverity: "info"`) unnamed switches/variables. Run it after hand-built `add_event_command` lists.
- `search_map_events {query, searchCommands: true}` finds where a line or script is used.
- `validate_project` finds transfers to missing maps and references to missing items/skills/common events.
- Read dialogue aloud: keep lines under about 40 characters and no more than 4 lines per box; use `\C[n]` colour codes and `\N[1]` actor names sparingly (in JSON they are written `\\C[n]`).

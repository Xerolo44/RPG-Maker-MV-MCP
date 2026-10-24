---
name: rpgmaker-event-writing
description: Writing RPG Maker MV event command lists - dialogue, choices, switches and variables, conditional branches, shops and battles - with the rpgmaker-mv MCP server. Use when creating NPCs, chests, quests or cutscenes.
---

# Writing events

An event has `pages`; each page has `conditions`, an `image`, a `trigger` and a `list` of commands `{code, indent, parameters}`. Every list ends with `{code: 0, indent: 0, parameters: []}`. The full table is in the resource `rpgmaker://reference/event-commands` and the tool `event_command_reference`.

## Fast paths
- **Dialogue:** `add_dialogue {mapId, eventId, lines, faceName?, position?}` builds the 101/401 commands and starts a new message box every 4 lines (the window shows 4 lines).
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
- `search_map_events {query, searchCommands: true}` finds where a line or script is used.
- `validate_project` finds transfers to missing maps and references to missing items/skills/common events.
- Read dialogue aloud: keep lines under about 40 characters and no more than 4 lines per box; use `\C[n]` colour codes and `\N[1]` actor names sparingly (in JSON they are written `\\C[n]`).

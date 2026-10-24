---
name: rpgmaker-map-building
description: How to build RPG Maker MV maps with the rpgmaker-mv MCP server - choosing tiles, painting layers, previewing as an image, placing events and connecting maps with doors. Use when creating or editing maps.
---

# Building maps

## Loop: plan -> paint -> look -> fix
1. `create_map` with a size and `tilesetId`; pass `fill` (e.g. `{sheet: "A2", kind: 16}`) so layer 0 is not empty.
2. `get_tileset_info {tilesetId}` for the overview, then `get_tileset_info {tilesetId, sheet: "A2"}` for kinds and passability. `get_tileset_image` shows the sheet so you can pick by looks.
3. `paint_tiles` with a list of operations (`cells`, `rect`, `fill`). Autotile edges and corners are computed for you - paint plain rectangles and let the shapes resolve.
4. **`render_map_image` after every few operations.** It draws the real graphics, event sprites and numbered markers. Use `x/y/width/height` to zoom and `showGrid` to read coordinates and `showPassability` to tint blocked cells red.
5. Fix what looks wrong and repeat. `render_map` (text) is the cheap alternative when you only need exact tile ids.

## Layers
| Layer | Holds | Notes |
| --- | --- | --- |
| 0, 1 | ground | A1-A5 tiles default to layer 0 |
| 2, 3 | upper tiles | B-E (objects) default to layer 2 |
| 4 | shadows | bit mask 0-15 (the four quarters) |
| 5 | regions | id 0-255, used by encounters and plugins |

Erasing needs an explicit layer: `{tile: 0, layer: 2, ...}`.

## Tile choice
- A1 water/waterfalls, A2 ground, A3 building tops/walls, A4 wall tops and sides, A5 plain ground tiles, B-E decoration/objects.
- Tiles from a sheet the tileset does not assign are invisible - the tools refuse them. Use `set_map_tileset` to switch sets (existing ids keep their numbers, so repaint if the layouts differ).
- Check passability in `get_tileset_info` before relying on a tile as a floor or a wall: a "wall" you can walk through is the most common map bug.
- A tile painted on layer 0 without ground below it shows black where the tile is transparent - put a ground fill underneath first.

## Composition tips
- Start with the big shapes (ground fill, water, paths), then buildings and walls, then objects (trees, signs) on layer 2, then events.
- Leave a walkable border or an exit; players must be able to reach every event.
- Vary the ground: a second A2 kind in patches looks much better than one flat fill.
- Keep doors and exits 1 tile wide and mark them clearly.

## Connecting maps
Use `connect_maps` instead of hand-writing Transfer Player events:
- `a` and `b` each give `mapId`, the `door` tile (where the exit event sits) and optionally the `spawn` tile and facing direction for arriving players. Put `spawn` on the walkable tile in front of the door when the door itself is in a wall.
- `trigger: "touch"` for floor exits and doors, `"action"` when the player should press OK.
- `twoWay: true` (default) creates both events; run `list_map_connections` to find one-way links and maps no one can reach from the start map.
- Then `render_map_image` both maps: the blue markers are the doors.

## Events on maps
- `create_event` places an event; `add_dialogue` adds NPC speech; see the `rpgmaker-event-writing` skill.
- Do not stack two events on one tile unless you mean to (`connect_maps` refuses it by default).
- After editing, `validate_project` reports transfers to missing maps.

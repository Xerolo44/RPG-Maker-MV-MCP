// Map passability following RPG Maker MV's Game_Map.checkPassage rule.

const LAYERS = 4; // tile layers 0-3; layers 4 (shadow) and 5 (region) do not affect passage

/**
 * Walkability grid (1 = walkable) for a map's tile data and its tileset flags.
 * Layers 3 -> 0 are scanned; tiles whose flag has the star bit (0x10) are skipped;
 * the first remaining non-zero tile decides via `(flag & 0x0f) === 0`.
 * A cell with no deciding tile is walkable, as are tile ids beyond `flags`.
 */
export function passableGrid(map: { width: number; height: number; data: number[] }, flags: number[]): Uint8Array {
  const { width, height, data } = map;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let walkable = 1;
      for (let z = LAYERS - 1; z >= 0; z--) {
        const id = data[(z * height + y) * width + x] ?? 0;
        if (id === 0) continue;
        const flag = flags[id] ?? 0;
        if (flag & 0x10) continue;
        walkable = (flag & 0x0f) === 0 ? 1 : 0;
        break;
      }
      out[y * width + x] = walkable;
    }
  }
  return out;
}

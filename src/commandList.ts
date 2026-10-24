// Helpers for building and checking RPG Maker MV event command lists.

export interface Cmd {
  code: number;
  indent: number;
  parameters: unknown[];
}

export function cmd(code: number, indent: number, ...parameters: unknown[]): Cmd {
  return { code, indent, parameters };
}

/** Returns the list with a trailing `{code:0}` terminator, adding one only if missing. */
export function terminated(list: Cmd[]): Cmd[] {
  if (list.length > 0 && list[list.length - 1].code === 0) return list;
  return [...list, cmd(0, 0)];
}

interface Block {
  name: string;
  closer: number;
  closerName: string;
  siblings: number[];
}

// opener code -> block description
const BLOCKS: Record<number, Block> = {
  102: { name: "Show Choices", closer: 404, closerName: "End Choices", siblings: [402, 403] },
  111: { name: "Conditional Branch", closer: 412, closerName: "Branch End", siblings: [411] },
  112: { name: "Loop", closer: 413, closerName: "Repeat Above", siblings: [] },
  301: { name: "Battle Processing", closer: 604, closerName: "End of Battle", siblings: [601, 602, 603] },
};

const CLOSER_OF = new Map<number, number>(); // closer/sibling code -> opener code
for (const [opener, b] of Object.entries(BLOCKS)) {
  CLOSER_OF.set(b.closer, Number(opener));
  for (const s of b.siblings) CLOSER_OF.set(s, Number(opener));
}

interface Open {
  code: number;
  indent: number;
  index: number;
}

/** Human-readable problems with a command list; `[]` when it is valid. */
export function validateCommandList(list: Cmd[]): string[] {
  const problems: string[] = [];
  const unclosed = (o: Open) => {
    const b = BLOCKS[o.code];
    problems.push(`index ${o.index} (code ${o.code}): ${b.name} has no matching ${b.closerName} (${b.closer})`);
  };

  if (list.length === 0) {
    problems.push("index 0: list is empty and has no terminator (code 0)");
    return problems;
  }
  const last = list.length - 1;
  if (list[last].code !== 0) {
    problems.push(`index ${last} (code ${list[last].code}): list does not end with a terminator (code 0)`);
  }

  const stack: Open[] = [];
  list.forEach((c, i) => {
    if (i > 0 && c.indent > list[i - 1].indent + 1) {
      problems.push(`index ${i} (code ${c.code}): indent jumps from ${list[i - 1].indent} to ${c.indent}`);
    }
    if (BLOCKS[c.code]) {
      stack.push({ code: c.code, indent: c.indent, index: i });
      return;
    }
    const opener = CLOSER_OF.get(c.code);
    if (opener === undefined) return;
    // Anything still open deeper than this command was never closed.
    while (stack.length > 0 && stack[stack.length - 1].indent > c.indent) unclosed(stack.pop()!);
    const top = stack[stack.length - 1];
    if (!top || top.indent !== c.indent || top.code !== opener) {
      problems.push(`index ${i} (code ${c.code}): no matching ${BLOCKS[opener].name} (${opener}) open at indent ${c.indent}`);
    } else if (c.code === BLOCKS[opener].closer) {
      stack.pop();
    }
  });
  while (stack.length > 0) unclosed(stack.pop()!);

  return problems.sort((a, b) => Number(a.match(/index (\d+)/)![1]) - Number(b.match(/index (\d+)/)![1]));
}

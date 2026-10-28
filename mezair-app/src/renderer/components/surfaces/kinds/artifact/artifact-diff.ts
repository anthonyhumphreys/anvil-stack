type DiffOp = { type: 'equal' | 'add' | 'remove'; line: string };

const MAX_MATRIX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffLines(before: string[], after: string[]): DiffOp[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const head = before.slice(0, start).map((line): DiffOp => ({ type: 'equal', line }));
  const tail = before.slice(endBefore).map((line): DiffOp => ({ type: 'equal', line }));
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);

  let middle: DiffOp[];
  if (a.length * b.length > MAX_MATRIX_CELLS) {
    middle = [
      ...a.map((line): DiffOp => ({ type: 'remove', line })),
      ...b.map((line): DiffOp => ({ type: 'add', line })),
    ];
  } else {
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[i] === b[j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        middle.push({ type: 'equal', line: a[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        middle.push({ type: 'remove', line: a[i++] });
      } else {
        middle.push({ type: 'add', line: b[j++] });
      }
    }
    while (i < a.length) middle.push({ type: 'remove', line: a[i++] });
    while (j < b.length) middle.push({ type: 'add', line: b[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** Unified diff between two text versions, with `context` lines around each change. */
export function buildUnifiedDiff(before: string, after: string, path: string, context = 3): string {
  const ops = diffLines(splitLines(before), splitLines(after));
  if (!ops.some((op) => op.type !== 'equal')) return '';

  const output = [`--- a/${path}`, `+++ b/${path}`];
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index].type === 'equal') index++;
    if (index >= ops.length) break;
    const hunkStart = Math.max(0, index - context);
    let hunkEnd = index;
    let lastChange = index;
    while (hunkEnd < ops.length) {
      if (ops[hunkEnd].type !== 'equal') lastChange = hunkEnd;
      else if (hunkEnd - lastChange > context * 2) break;
      hunkEnd++;
    }
    hunkEnd = Math.min(ops.length, lastChange + context + 1);

    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < hunkStart; k++) {
      if (ops[k].type !== 'add') oldLine++;
      if (ops[k].type !== 'remove') newLine++;
    }
    const slice = ops.slice(hunkStart, hunkEnd);
    const oldCount = slice.filter((op) => op.type !== 'add').length;
    const newCount = slice.filter((op) => op.type !== 'remove').length;
    output.push(
      `@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`,
    );
    for (const op of slice) {
      output.push(`${op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' '}${op.line}`);
    }
    index = hunkEnd;
  }
  return `${output.join('\n')}\n`;
}

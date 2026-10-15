export type EditOp = "equal" | "delete" | "insert";

export interface EditStep {
  readonly op: EditOp;
  readonly text: string;
}

/** Bounded Myers search. Cost depends on edit distance, not the line-count product. */
const middleScript = (
  before: readonly string[],
  after: readonly string[],
): readonly EditStep[] | null => {
  if (before.length === 0) return after.map(text => ({ op: "insert", text }));
  if (after.length === 0) return before.map(text => ({ op: "delete", text }));
  const max = before.length + after.length;
  if (max > 20_000) return null;
  const offset = max;
  const trace: Int32Array[] = [];
  const vector = new Int32Array(2 * max + 1);
  let work = 0;
  let done = -1;
  for (let depth = 0; depth <= max && done < 0; depth += 1) {
    if ((trace.length + 1) * vector.length > 1_000_000) return null;
    trace.push(new Int32Array(vector));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      if (++work > 1_000_000) return null;
      const down = diagonal === -depth ||
        (diagonal !== depth &&
          (vector[offset + diagonal - 1] ?? 0) < (vector[offset + diagonal + 1] ?? 0));
      let x = down ? (vector[offset + diagonal + 1] ?? 0) : (vector[offset + diagonal - 1] ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        if (++work > 1_000_000) return null;
        x += 1;
        y += 1;
      }
      vector[offset + diagonal] = x;
      if (x >= before.length && y >= after.length) { done = depth; break; }
    }
  }
  if (done < 0) return null;
  const steps: EditStep[] = [];
  let x = before.length;
  let y = after.length;
  for (let depth = done; depth > 0; depth -= 1) {
    const snapshot = trace[depth];
    if (!snapshot) return null;
    const diagonal = x - y;
    const down = diagonal === -depth ||
      (diagonal !== depth &&
        (snapshot[offset + diagonal - 1] ?? 0) < (snapshot[offset + diagonal + 1] ?? 0));
    const previous = down ? diagonal + 1 : diagonal - 1;
    const previousX = snapshot[offset + previous] ?? 0;
    const previousY = previousX - previous;
    while (x > previousX && y > previousY) {
      x -= 1; y -= 1;
      steps.push({ op: "equal", text: before[x] ?? "" });
    }
    if (down) { y -= 1; steps.push({ op: "insert", text: after[y] ?? "" }); }
    else { x -= 1; steps.push({ op: "delete", text: before[x] ?? "" }); }
  }
  while (x > 0 && y > 0) {
    x -= 1; y -= 1;
    steps.push({ op: "equal", text: before[x] ?? "" });
  }
  return steps.reverse();
};

/** Preserve shared boundaries before budgeting; null means unavailable, not a rewrite. */
export const editScript = (
  before: readonly string[],
  after: readonly string[],
): readonly EditStep[] | null => {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1;
  const middle = middleScript(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix));
  if (!middle) return null;
  return [
    ...before.slice(0, prefix).map(text => ({ op: "equal" as const, text })),
    ...middle,
    ...before.slice(before.length - suffix).map(text => ({ op: "equal" as const, text })),
  ];
};

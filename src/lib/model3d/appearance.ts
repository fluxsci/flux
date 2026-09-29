/** Transient appearance factors never rewrite authored mesh/source opacity. */
export function modelPartOpacity(states?: Record<string, { opacity?: number; visible?: boolean }>, ghost = false): Record<string, number> | undefined {
  const values: Record<string, number> = Object.create(null);
  for (const [id, state] of Object.entries(states ?? {})) {
    const hidden = state.visible === false || state.opacity === 0;
    const value = hidden ? ghost ? .25 : 0 : state.opacity ?? 1;
    if (Number.isFinite(value) && value !== 1) values[id] = Math.max(0, Math.min(1, value));
  }
  return Object.keys(values).length ? values : undefined;
}

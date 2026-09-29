/** A sampled step's appearance of a model's semantic leaves (mesh and furniture). */
export type ModelPartStates = Record<string, { opacity?: number; visible?: boolean }>;
/** Transient appearance factors never rewrite authored mesh/source opacity. */
export function modelPartOpacity(states?: ModelPartStates, ghost = false): Record<string, number> | undefined {
  const values: Record<string, number> = Object.create(null);
  for (const [id, state] of Object.entries(states ?? {})) {
    const hidden = state.visible === false || state.opacity === 0;
    const value = hidden ? ghost ? .25 : 0 : state.opacity ?? 1;
    if (Number.isFinite(value) && value !== 1) values[id] = Math.max(0, Math.min(1, value));
  }
  return Object.keys(values).length ? values : undefined;
}
/** The inverse of modelPartOpacity for a request that carries only factors. */
export function partStatesFromOpacity(partOpacity?: Record<string, number>): ModelPartStates | undefined {
  if (!partOpacity) return undefined;
  const states: ModelPartStates = Object.create(null);
  for (const [id, opacity] of Object.entries(partOpacity)) states[id] = { opacity, visible: opacity > 0 };
  return states;
}

// One queue for destructive shell transitions. New project intents supersede
// stale dialog/load completions; pane close remains independent but serialized.
let pending: Promise<unknown> = Promise.resolve();
let projectIntent = 0;
let projectKey = "";
const inflight = new Map<string, Promise<boolean>>();
export function transitionProjectIntent(key: string): number { if (key !== projectKey) { projectKey = key; ++projectIntent; } return projectIntent; }
export function isCurrentProjectIntent(intent: number): boolean { return intent === projectIntent; }
export function serializeTransition(key: string, task: () => Promise<boolean>): Promise<boolean> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const work = pending.catch(() => {}).then(task);
  pending = work;
  inflight.set(key, work);
  void work.finally(() => { if (inflight.get(key) === work) inflight.delete(key); }).catch(() => {});
  return work;
}

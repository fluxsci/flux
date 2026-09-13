/** Temporary Quarto source rewrites defer autosaves, never editor input. */
const pending = new Map<string, Promise<void>>();
export function waitForDocumentExport(path: string): Promise<void> { return pending.get(path) ?? Promise.resolve(); }
export function holdDocumentExport(paths: readonly string[]): () => void {
  for (const path of paths) if (pending.has(path)) throw new Error(`${path} is already being exported`);
  let done!: () => void;
  const promise = new Promise<void>(resolve => { done = resolve; });
  for (const path of paths) pending.set(path, promise);
  return () => { for (const path of paths) if (pending.get(path) === promise) pending.delete(path); done(); };
}

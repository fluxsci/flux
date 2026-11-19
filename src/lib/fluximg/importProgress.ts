/**
 * "Importing image…" while big bundles are copied (the model3d/importProgress.ts pattern: a one-shot timer, so an
 * import that finishes within a second shows nothing — Nielsen: the 0.1–1 s band needs no feedback). Feedback owns
 * no import work; a destination change retires it for good.
 */
import type { Readable } from "svelte/store";
import { pushToast, dismissToast } from "../toast";

const visible = new Map<symbol, string>();
let toastId: number | undefined;

function refresh(): void {
  if (!visible.size) {
    if (toastId !== undefined) dismissToast(toastId);
    toastId = undefined;
    return;
  }
  const counts = new Map<string, number>();
  for (const name of visible.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const detail = [...counts].map(([name, count]) => (count > 1 ? `${name} (${count} imports)` : name)).join(", ");
  toastId = pushToast("info", visible.size > 1 ? "Importing images…" : "Importing image…", { detail, ttl: 0 });
}

/** Show progress for one import after a second; the returned function ends it (call it exactly when the copy ends). */
export function trackFluximgImport(name: string, current: () => boolean, owners: Readable<unknown>[], delayMs = 1000): () => void {
  const token = Symbol(), unsubscribers: (() => void)[] = [];
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    if (visible.delete(token)) refresh();
  };
  if (!current()) { dispose(); return dispose; }
  timer = setTimeout(() => {
    if (!current()) { dispose(); return; }
    visible.set(token, name);
    refresh();
  }, delayMs);
  for (const owner of owners) {
    if (disposed) break;
    const unsubscribe = owner.subscribe(() => { if (!current()) dispose(); });
    if (disposed) unsubscribe(); else unsubscribers.push(unsubscribe);
  }
  return dispose;
}

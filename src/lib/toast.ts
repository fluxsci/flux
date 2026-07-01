// App-wide toast/notification store (V1 review, W1). One lightweight surface for
// every "this failed silently" and "this succeeded invisibly" moment — rendered by
// src/shell/Toasts.svelte at the shell level so it shows in any mode, and fed from
// both the renderer and the main process (via the `app:error` IPC channel).
//
// Semantics: info/success auto-dismiss (default 3.5s); errors are sticky (ttl 0)
// with a manual ✕ and an optional action (e.g. Retry). Pushing an identical
// (level, msg) pair refreshes the existing toast instead of stacking a duplicate.

import { writable } from "svelte/store";

export type ToastLevel = "info" | "success" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  level: ToastLevel;
  msg: string;
  detail?: string;
  /** ms until auto-dismiss; 0 = sticky (manual dismiss only). */
  ttl: number;
  action?: ToastAction;
}

const MAX_VISIBLE = 5;

export const toasts = writable<Toast[]>([]);

let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
}

export function dismissToast(id: number): void {
  clearTimer(id);
  toasts.update((list) => list.filter((t) => t.id !== id));
}

export function pushToast(
  level: ToastLevel,
  msg: string,
  opts: { detail?: string; ttl?: number; action?: ToastAction } = {},
): number {
  const ttl = opts.ttl ?? (level === "error" ? 0 : 3500);
  let id = 0;
  toasts.update((list) => {
    const dup = list.find((t) => t.level === level && t.msg === msg);
    if (dup) {
      id = dup.id;
      clearTimer(id);
      return list.map((t) =>
        t.id === id ? { ...t, detail: opts.detail, ttl, action: opts.action } : t,
      );
    }
    id = ++seq;
    const next = [...list, { id, level, msg, detail: opts.detail, ttl, action: opts.action }];
    // Cap the stack; drop the oldest non-error first so failures never vanish.
    while (next.length > MAX_VISIBLE) {
      const idx = next.findIndex((t) => t.level !== "error");
      const drop = next.splice(idx === -1 ? 0 : idx, 1)[0];
      clearTimer(drop.id);
    }
    return next;
  });
  if (ttl > 0) timers.set(id, setTimeout(() => dismissToast(id), ttl));
  return id;
}

/** Message text for an unknown thrown value. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

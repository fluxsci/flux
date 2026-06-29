import { writable } from "svelte/store";

export type ForgerySize = "sm" | "md" | "lg";
export type ForgeryPos = "center" | "top" | "left" | "right";
export type ForgeryAnim = "draw" | "fade"; // self-drawing line vs. quick fade

export interface Settings {
  forgerySize: ForgerySize;
  forgeryPos: ForgeryPos;
  forgeryAnim: ForgeryAnim;
  forgeryOpacity: number; // 0.6 .. 1
  flexokiDefault: boolean; // ship the Flexoki palette in new projects
}

const KEY = "flux.settings";
const DEFAULTS: Settings = {
  forgerySize: "md",
  forgeryPos: "center",
  forgeryAnim: "draw",
  forgeryOpacity: 0.94,
  flexokiDefault: true,
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = writable<Settings>(load());
settings.subscribe((v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {}
});

// Transient UI state.
export const settingsOpen = writable(false);
export const forgeryOpen = writable(false);

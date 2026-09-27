// Tiny titlebar dependency; the presence reader and rows load on project open.
import { writable } from "svelte/store";
import type { PresenceSession } from "../../lib/project/presence";

export const sessions = writable<PresenceSession[]>([]);

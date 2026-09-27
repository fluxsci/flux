import { writable } from "svelte/store";

// F5 owns availability and launching; routing only exposes its recipient slot.
export const backgroundAvailable = writable(false);

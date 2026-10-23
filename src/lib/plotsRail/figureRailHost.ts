// The Figure editor's rail host: [Layers | Plots] lives in the GLOBAL figureLayout store (every
// FigureMode instance shows the same view), so one module-level host serves them all.
import { get } from "svelte/store";
import { figureLayout } from "../figureLayoutStore";
import { registerRailHost } from "./railState";

registerRailHost("figure", {
  isPlots: () => get(figureLayout).leftView === "plots",
  setPlots: (on) => figureLayout.update((l) => ({ ...l, leftView: on ? "plots" : "layers" })),
});

// Compatibility shim for one release. Plot projection and its sole DOM writer
// live with the shared plot core; there is no separate data-morph controller.
export { axisFit, projectWith, blendFit, seriesAxes } from "../../plot/project";
export type { Fit, MorphController } from "../../plot/project";

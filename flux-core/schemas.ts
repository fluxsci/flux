// Moved to src/lib/project/schemas.ts (AGT-15 scaffolder consolidation): the
// schemas are part of the PROJECT FORMAT, which the GUI scaffolder now also
// writes — and the repo convention is flux-core → src/lib, never the reverse.
// This shim keeps flux-core's existing imports working unchanged.
export * from "../src/lib/project/schemas";

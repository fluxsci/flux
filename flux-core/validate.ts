// WS-5.1: the load-gate validators are part of the PROJECT FORMAT, one source
// in src/lib/project/validate.ts (repo convention: flux-core → src/lib, never
// the reverse — schemas.ts precedent). This shim keeps flux-core consumers on
// the same compiled validators as the GUI load seams.
export * from "../src/lib/project/validate";

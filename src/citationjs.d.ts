// Citation.js ships no type declarations; we use it dynamically and narrow the
// shapes we touch in bibLoad.ts. Ambient `any` modules are enough here.
declare module "@citation-js/core" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Cite: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}
declare module "@citation-js/plugin-bibtex";
declare module "@citation-js/plugin-doi";
declare module "@citation-js/plugin-csl";

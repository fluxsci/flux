// markdown-it plugins we dynamic-import for the manuscript renderer that don't
// ship type declarations. We only call them as `md.use(plugin)`, so `any` is fine.
declare module "markdown-it-footnote" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin: any;
  export default plugin;
}
declare module "markdown-it-deflist" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin: any;
  export default plugin;
}
declare module "markdown-it-attrs" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin: any;
  export default plugin;
}
declare module "markdown-it-bracketed-spans" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin: any;
  export default plugin;
}

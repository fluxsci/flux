/** Shared recipe parameter/argv and provenance rules for CLI and Electron. */
export function recipeInvocation(recipe, overrides = {}) {
  if (!recipe || typeof recipe.command !== "string" || !recipe.command || recipe.command.includes("\0") || (recipe.args !== undefined && (!Array.isArray(recipe.args) || recipe.args.some(x => typeof x !== "string" || x.includes("\0")))) || (recipe.cwd !== undefined && typeof recipe.cwd !== "string") || (recipe.output !== undefined && typeof recipe.output !== "string")) throw new Error("Invalid recipe invocation");
  recipeOutput(recipe);
  const params = { ...(recipe.params ?? {}), ...overrides };
  // JSON cannot express NaN/Infinity; silently turning them into null changes
  // scientific parameters. Validate before spawning any generating script.
  JSON.stringify(params, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Recipe parameters must contain finite numbers");
    return value;
  });
  const args = [...(recipe.args ?? [])];
  for (const [key, value] of Object.entries(params)) {
    if (key !== "__fluxplot__") args.push(`--${key}`, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return { params, args };
}

export function completedRecipe(emitted, params, overrides, now) {
  return { ...emitted, params: { ...params, ...(emitted.params ?? {}), ...overrides }, lastRun: now };
}

/** One output dispatch for native and Node recipes; binary geometry stays native. */
export function recipeOutput(recipe) {
  const outputs = recipe?.outputs;
  if (outputs != null && (typeof outputs !== 'object' || Array.isArray(outputs))) throw new Error('Invalid recipe outputs');
  for (const value of [recipe?.output, outputs?.svg, outputs?.glb, outputs?.manifest]) if (value != null && (typeof value !== 'string' || !value || value.includes('\0'))) throw new Error('Invalid recipe output path');
  const file = outputs?.glb ?? outputs?.svg ?? recipe?.output;
  const kind = outputs?.glb || /\.glb$/i.test(file ?? '') ? 'glb' : 'svg';
  if (kind === 'glb' && !/\.glb$/i.test(file)) throw new Error('Recipe GLB output must end in .glb');
  return { kind, path: file ?? '', manifest: outputs?.manifest ?? (file ? file.replace(/\.(?:svg|glb)$/i, '.fluxplot.json') : '') };
}

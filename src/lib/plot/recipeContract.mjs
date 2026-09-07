/** Shared recipe parameter/argv and provenance rules for CLI and Electron. */
export function recipeInvocation(recipe, overrides = {}) {
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

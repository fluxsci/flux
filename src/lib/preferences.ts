// Local UI preferences only. Never use this decoder for project geometry or data.
export type PreferenceRule = { min?: number; max?: number; enum?: readonly string[]; nullable?: boolean; strings?: boolean; maxLength?: number };
export function decodePreferences<T extends object>(value: unknown, defaults: T, rules: Partial<Record<keyof T, PreferenceRule>> = {}): T {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const raw = source[String(key)], fallback = defaults[key], rule = rules[key] ?? {};
    let accepted: unknown = fallback;
    if (raw === null && rule.nullable) accepted = null;
    else if (rule.enum) { if (typeof raw === 'string' && rule.enum.includes(raw)) accepted = raw; }
    else if (rule.strings) { if (Array.isArray(raw)) accepted = [...new Set(raw.filter((v): v is string => typeof v === 'string' && v.length <= 4096))].slice(0, rule.maxLength ?? 10000); }
    else if (typeof fallback === 'number' || rule.min !== undefined || rule.max !== undefined) {
      if (typeof raw === 'number' && Number.isFinite(raw)) accepted = Math.min(rule.max ?? Number.MAX_SAFE_INTEGER, Math.max(rule.min ?? -Number.MAX_SAFE_INTEGER, raw));
    } else if (typeof fallback === 'boolean') { if (typeof raw === 'boolean') accepted = raw; }
    else if (typeof fallback === 'string') { if (typeof raw === 'string' && raw.length <= (rule.maxLength ?? 4096)) accepted = raw; }
    result[key] = accepted as T[keyof T];
  }
  return result;
}

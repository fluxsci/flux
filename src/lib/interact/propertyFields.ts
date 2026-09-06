/** Assign unambiguous shortcuts while preserving each field's preferred key
 * wherever possible. Reserved menu commands never become property shortcuts. */
export function uniqueFieldKeys<T extends { key: string }>(fields: T[]): T[] {
  const used = new Set(['f', 's']);
  const preferred = new Set(fields.map(field => field.key));
  const spare = [...'1234567abcdefghijklmnopqrstuvwxyz,./;'].filter(key => !preferred.has(key) && !used.has(key));
  return fields.map(field => {
    const key = used.has(field.key) ? spare.shift() ?? '' : field.key;
    used.add(key);
    return key === field.key ? field : { ...field, key };
  });
}

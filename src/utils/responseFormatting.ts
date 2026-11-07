const integerFields = new Set([
  'id',
  'contact_id',
  'event_id',
  'sequence',
  'count',
  'total',
  'limit',
  'offset',
]);

function formatValue(value: unknown, key?: string, preserveKeys?: ReadonlySet<string>): unknown {
  if (key && preserveKeys?.has(key)) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => formatValue(item, undefined, preserveKeys));
  if (!value || typeof value !== 'object') {
    if (key && integerFields.has(key) && typeof value === 'string' && /^-?\d+$/.test(value)) {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : value;
    }
    return value;
  }

  const formatted: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    formatted[childKey] = formatValue(childValue, childKey, preserveKeys);
  }
  return formatted;
}

export function formatResponseIntegers<T>(value: T, preserveKeys?: ReadonlySet<string>): T {
  return formatValue(value, undefined, preserveKeys) as T;
}

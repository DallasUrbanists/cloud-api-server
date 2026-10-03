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

function formatValue(value: unknown, key?: string): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => formatValue(item));
  if (!value || typeof value !== 'object') {
    if (key && integerFields.has(key) && typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
    return value;
  }

  const formatted: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    formatted[childKey] = formatValue(childValue, childKey);
  }
  return formatted;
}

export function formatResponseIntegers<T>(value: T): T {
  return formatValue(value) as T;
}

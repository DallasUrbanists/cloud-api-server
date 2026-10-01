# PostgreSQL to TypeScript / JSON Type Mappings & Query Guidelines

## Type Mappings

| PostgreSQL Type | TypeScript Type | JSON API Type | Notes |
|---|---|---|---|
| `bigint` / `int8` | `string \| number` | `string \| number` | Use `string` or `number` (pg driver returns `string` for `bigint` to avoid JS precision loss) |
| `integer` / `int4` / `serial` | `number` | `number` | Direct integer mapping |
| `smallint` / `int2` | `number` | `number` | Direct integer mapping |
| `text` / `varchar` / `char` | `string` | `string` | Nullable string if `is_nullable: YES` |
| `boolean` / `bool` | `boolean` | `boolean` | Direct boolean mapping |
| `timestamp with time zone` / `timestamptz` | `Date \| string` | `string` (ISO 8601) | Serialized as ISO string in API responses |
| `timestamp without time zone` | `Date \| string` | `string` (ISO 8601) | Serialized as ISO string |
| `date` | `string` | `string` (YYYY-MM-DD) | Date string format |
| `json` / `jsonb` | `Record<string, unknown> \| unknown[]` | `object \| array` | Parsed JSON object |
| `text[]` / `varchar[]` | `string[]` | `string[]` | Array of strings |
| `numeric` / `decimal` | `number \| string` | `number \| string` | Float or string for high precision |
| `uuid` | `string` | `string` (UUID v4) | Standard UUID string |

## Safe Dynamic Update Pattern

When implementing partial updates (`PATCH` or optional `PUT` fields), construct parameterized SQL queries dynamically:

```typescript
const updates: string[] = [];
const values: unknown[] = [];
let paramIdx = 1;

if (data.fieldA !== undefined) {
  updates.push(`field_a = $${paramIdx++}`);
  values.push(data.fieldA);
}

if (data.fieldB !== undefined) {
  updates.push(`field_b = $${paramIdx++}`);
  values.push(data.fieldB);
}

if (updates.length === 0) {
  // Nothing to update
  return existingRecord;
}

values.push(id);
const query = `
  UPDATE table_name 
  SET ${updates.join(', ')} 
  WHERE id = $${paramIdx} 
  RETURNING *;
`;
const result = await pool.query(query, values);
```

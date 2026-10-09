import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;
const election = {
  label: 'District general election', date: '2028-05-06',
  early_vote_start: '2028-04-24', early_vote_end: '2028-05-02', status: 'Upcoming',
};
const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

before(async () => {
  db = new PGlite();
  await db.exec(await readFile(new URL('../migrations/004_representatives.sql', import.meta.url), 'utf8'));
});
after(async () => { await db.close(); });

async function insertJson(column: string, value: unknown) {
  return db.query(`INSERT INTO representatives (${column}) VALUES ($1::jsonb) RETURNING id`, [JSON.stringify(value)]);
}
async function rejectsJson(column: string, value: unknown) {
  await assert.rejects(insertJson(column, value), (error: any) =>
    error.code === '23514' && error.constraint === `representatives_${column}_check`);
}

test('creates integer identity, optional fields, and empty array defaults', async () => {
  const result = await db.query<any>('INSERT INTO representatives DEFAULT VALUES RETURNING *');
  const row = result.rows[0];
  assert.equal(typeof row.id, 'number');
  for (const field of ['emails', 'phones', 'social_accounts', 'elections']) assert.deepEqual(row[field], []);
  assert.equal(row.district_bounds, null);
  await db.exec('INSERT INTO representatives (id, "start", "end") VALUES (10000, \'2026-01-01\', \'2028-01-01\')');
  await assert.rejects(db.exec('INSERT INTO representatives (id) VALUES (10000)'), (error: any) => error.code === '23505');
});

test('accepts structured contacts, all social platforms, elections, and GeoJSON holes', async () => {
  await insertJson('emails', [{ label: 'Office', email: 'office@example.invalid', when_to_use: 'General inquiries' }]);
  await insertJson('phones', [{ label: 'Office', phone: '2145550100', when_to_use: 'General inquiries', can_sms: false }]);
  await insertJson('social_accounts', ['Facebook page', 'Facebook profile', 'Facebook group', 'Instagram', 'X/Twitter', 'LinkedIn', 'Bluesky']
    .map(type => ({ type, handle: 'representative', url: 'https://example.invalid' })));
  await insertJson('elections', [election, { ...election, date: '2028-02-29' }]);
  await insertJson('district_bounds', { ...polygon, coordinates: [...polygon.coordinates, [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.1]]] });
  await insertJson('district_bounds', { type: 'Polygon', coordinates: [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1]]] });
});

test('allows SQL NULL but rejects JSON null and non-array contact/election values', async () => {
  await db.exec('INSERT INTO representatives (emails, phones, social_accounts, elections, district_bounds) VALUES (NULL, NULL, NULL, NULL, NULL)');
  for (const column of ['emails', 'phones', 'social_accounts', 'elections']) {
    for (const value of [null, {}, 'text', [null], ['text']]) await rejectsJson(column, value);
  }
});

test('enforces required contact properties, ten-digit phones, boolean SMS, and platform enum', async () => {
  for (const value of [[{}], [{ label: 'Office', email: null, when_to_use: 'Any' }]]) await rejectsJson('emails', value);
  for (const phone of ['123', '12345678901', '123456789x', 2145550100]) {
    await rejectsJson('phones', [{ label: 'Office', phone, when_to_use: 'Any', can_sms: true }]);
  }
  await rejectsJson('phones', [{ label: 'Office', phone: '2145550100', when_to_use: 'Any', can_sms: 'true' }]);
  await rejectsJson('phones', [{ label: 'Office', phone: '2145550100', when_to_use: 'Any' }]);
  await rejectsJson('social_accounts', [{ type: 'Mastodon', handle: 'rep', url: 'https://example.invalid' }]);
  await rejectsJson('social_accounts', [{ type: 'Bluesky', handle: 'rep' }]);
});

test('enforces election schema, additionalProperties false, and real calendar dates', async () => {
  for (const field of Object.keys(election)) {
    const missing: Record<string, unknown> = { ...election };
    delete missing[field];
    await rejectsJson('elections', [missing]);
    await rejectsJson('elections', [{ ...election, [field]: null }]);
  }
  await rejectsJson('elections', [{ ...election, extra: 'not allowed' }]);
  for (const field of ['date', 'early_vote_start', 'early_vote_end']) {
    for (const date of ['2027-02-29', '2028-04-31', '2028-13-01', '0000-01-01', '2028-5-06', '2028-05-06T00:00:00Z']) {
      await rejectsJson('elections', [{ ...election, [field]: date }]);
    }
  }
});

test('enforces GeoJSON Polygon type, numeric positions, closed rings, and consistent dimensions', async () => {
  const invalid = [
    null, [], {}, { ...polygon, type: 'MultiPolygon' },
    { type: 'Polygon', coordinates: null }, { type: 'Polygon', coordinates: [] },
    { type: 'Polygon', coordinates: [null] }, { type: 'Polygon', coordinates: [[]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0], ['1', 0], [1, 1], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0, 1], [1, 1], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0], [1], [2], [0]]] },
  ];
  for (const value of invalid) await rejectsJson('district_bounds', value);
});

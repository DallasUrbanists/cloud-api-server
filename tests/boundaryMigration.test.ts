import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { dateString } from '../src/models/boundary.js';

let db: PGlite;
let original: any[];
let seed: string;
const migration = (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
before(async () => {
  db = new PGlite();
  await db.exec(await migration('004_representatives.sql'));
  await db.exec(await migration('005_seed_dallas_city_council.sql'));
  original = (await db.query('SELECT * FROM representatives ORDER BY id')).rows;
  await db.exec(await migration('006_boundaries.sql'));
  seed = await migration('007_seed_boundaries.sql');
  await db.exec(seed);
});
after(async () => { await db.close(); });

test('backfill preserves representative identity, contact/election history, descriptions and geometry', async () => {
  const rows = (await db.query<any>('SELECT r.*, row_to_json(b) AS boundary FROM representatives r JOIN boundaries b ON r.boundary_id = b.id ORDER BY r.id')).rows;
  assert.equal(rows.length, 14);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]; const old = original[index];
    for (const field of ['id', 'name', 'title', 'bio', 'webpage_url', 'photo_url', 'emails', 'phones', 'social_accounts', 'elections', 'start', 'end']) assert.deepEqual(row[field], old[field], field);
    assert.deepEqual(row.boundary.shape, old.district_bounds);
    assert.equal(row.boundary.description, old.district_description);
    assert.equal(row.boundary.entity_name, old.entity);
    assert.equal(row.boundary.body_name, old.body);
    assert.equal(row.boundary.district_name, old.district);
    assert.ok(row.research_service);
    assert.equal(row.research_sync_ttl, 60);
    for (const field of ['entity', 'body', 'district', 'district_description', 'district_bounds']) assert.equal(field in row, false);
  }
});

test('verified seed is complete, full geometry is valid, and statewide Senate needs no shape', async () => {
  const rows = (await db.query<any>('SELECT b.*, b.effective_date::text AS effective_date, b.expiration_date::text AS expiration_date FROM boundaries b ORDER BY id')).rows;
  assert.equal(rows.length, 284);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const source = row.source_key.split(':')[0]; counts[source] = (counts[source] ?? 0) + 1;
    assert.deepEqual(row.states, ['TX']); assert.ok(row.research_service);
    if (row.shape !== null) assert.equal(row.shape_pending, false);
    assert.ok(row.when_to_contact.length > 20);
  }
  assert.deepEqual(counts, { council: 14, texas: 1, congress119: 9, congress120: 9, texasSenate: 5, texasHouse: 20, sboe: 5, countyJudge: 1, commissioners: 4, cpc: 14, parks: 14, disd: 9, pids: 16, neighborhoods: 163 });
  const senate = rows.find(row => row.source_key === 'texas:senate');
  assert.equal(senate.shape, null); assert.equal(senate.shape_service, null); assert.equal(senate.shape_pending, false);
  assert.ok(rows.some(row => row.shape?.type === 'MultiPolygon'));
  assert.deepEqual([...new Set(rows.filter(row => row.source_key.startsWith('congress119:')).map(row => dateString(row.expiration_date)))], ['2027-01-03']);
  assert.ok(rows.filter(row => row.source_key.startsWith('congress120:')).every(row => dateString(row.effective_date) === '2027-01-03'));
  assert.equal(rows.some(row => row.entity_name.includes('Expired')), false);
});

test('seed reruns do not duplicate rows or overwrite local edits', async () => {
  await db.exec("UPDATE boundaries SET description = 'Locally maintained', when_to_contact = 'Local classification', research_sync_ttl = 15 WHERE source_key = 'texas:senate'");
  await db.exec(seed);
  assert.equal((await db.query<any>('SELECT count(*)::integer AS count FROM boundaries')).rows[0].count, 284);
  const senate = (await db.query<any>("SELECT * FROM boundaries WHERE source_key = 'texas:senate'")).rows[0];
  assert.equal(senate.description, 'Locally maintained'); assert.equal(senate.when_to_contact, 'Local classification'); assert.equal(senate.research_sync_ttl, 15);
});

test('conflicting jurisdictions fail transactionally rather than losing geometry', async () => {
  const conflict = new PGlite();
  try {
    await conflict.exec(await migration('004_representatives.sql'));
    const polygons = [
      { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] },
    ];
    for (const shape of polygons) await conflict.query('INSERT INTO representatives(entity, body, district, district_bounds) VALUES ($1, $2, $3, $4::jsonb)', ['Example', 'Board', 'District 1', JSON.stringify(shape)]);
    await assert.rejects(conflict.exec(await migration('006_boundaries.sql')), /Conflicting jurisdiction/);
    await conflict.exec('ROLLBACK');
    assert.equal((await conflict.query<any>('SELECT count(*)::integer AS count FROM representatives')).rows[0].count, 2);
    assert.equal((await conflict.query<any>("SELECT to_regclass('boundaries') AS table_name")).rows[0].table_name, null);
  } finally { await conflict.close(); }
});

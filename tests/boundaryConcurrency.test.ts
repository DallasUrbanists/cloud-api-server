import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { pool } from '../src/config/db.js';
import { BoundarySyncService } from '../src/services/boundarySyncService.js';

const connectionString = process.env.BOUNDARY_TEST_DATABASE_URL;
test('real PostgreSQL connections deduplicate enqueue/claim and fence expired leases', { skip: !connectionString }, async () => {
  const admin = new pg.Pool({ connectionString });
  const schema = `boundary_test_${randomBytes(8).toString('hex')}`;
  const database = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema}` });
  const enabled = process.env.BOUNDARY_SYNC_ENABLED;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ['004_representatives.sql', '006_boundaries.sql']) await database.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    mock.method(pool, 'query', database.query.bind(database));
    mock.method(pool, 'connect', database.connect.bind(database));
    process.env.BOUNDARY_SYNC_ENABLED = 'true';
    const { rows } = await database.query("INSERT INTO boundaries(entity_name, shape_service) VALUES ('Concurrency fixture', $1::jsonb) RETURNING id", [JSON.stringify({ file: 'arcgis.js', function: 'fetchShape', params: { source: 'council', key: 1 } })]);
    const options = { target: 'boundary' as const, id: rows[0].id, kind: 'shape' as const, clientAddress: 'concurrency-fixture' };
    const jobs = await Promise.all(Array.from({ length: 6 }, () => BoundarySyncService.enqueue(options)));
    assert.equal(new Set(jobs.map(job => String(job?.id))).size, 1);
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM boundary_sync_jobs')).rows[0].count, 1);
    const id = String(jobs[0]!.id);
    const representative = await database.query('INSERT INTO representatives(boundary_id, name) VALUES ($1, $2) RETURNING id', [rows[0].id, 'Related fixture']);
    const related = await BoundarySyncService.enqueue({ target: 'representative', id: representative.rows[0].id, clientAddress: 'related-fixture' });
    assert.equal(String(related!.id), id);
    const claims = await Promise.all(Array.from({ length: 6 }, () => BoundarySyncService.claim(id)));
    const first = claims.find(Boolean)!;
    assert.equal(claims.filter(Boolean).length, 1);
    await database.query("UPDATE boundary_sync_jobs SET lease_until = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [id]);
    const second = await BoundarySyncService.claim(id);
    assert.ok(second); assert.notEqual(first.lease_token, second.lease_token);
    const stale = await database.query("UPDATE boundary_sync_jobs SET status = 'succeeded' WHERE id = $1 AND lease_token = $2 AND lease_until > CURRENT_TIMESTAMP RETURNING id", [id, first.lease_token]);
    assert.equal(stale.rowCount, 0);
    await database.query("UPDATE boundary_sync_jobs SET lease_until = CURRENT_TIMESTAMP - INTERVAL '1 second', attempts = 3 WHERE id = $1", [id]);
    assert.equal(await BoundarySyncService.claim(id), null);
    assert.equal((await BoundarySyncService.status(id)).errorCode, 'SYNC_ATTEMPTS_EXHAUSTED');
    assert.equal(await BoundarySyncService.enqueue(options), null);
  } finally {
    mock.restoreAll();
    if (enabled === undefined) delete process.env.BOUNDARY_SYNC_ENABLED; else process.env.BOUNDARY_SYNC_ENABLED = enabled;
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

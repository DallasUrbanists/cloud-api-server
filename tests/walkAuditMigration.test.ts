import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/009_walk_audits.sql', import.meta.url), 'utf8');
const seed = await readFile(new URL('../migrations/010_seed_walk_audit_worksheets.sql', import.meta.url), 'utf8');
const collection = JSON.stringify({ type: 'FeatureCollection', features: [] });

test('feature migration and seed apply to an otherwise empty database', async () => {
  const empty = new PGlite();
  try {
    await empty.exec(migration); await empty.exec(seed);
    const tables = await empty.query<any>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'walk_audit_%'");
    assert.equal(tables.rows.length, 6);
    assert.equal((await empty.query<any>('SELECT count(*)::int AS n FROM walk_audit_worksheets')).rows[0].n, 2);
  } finally { await empty.close(); }
});

test('feature migration and repeatable seed preserve unrelated records and enforce lifecycle', async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE unrelated (id integer PRIMARY KEY, value text); INSERT INTO unrelated VALUES (1, 'keep');");
    await db.exec(migration);
    await db.exec(seed);
    await db.exec("UPDATE walk_audit_worksheets SET title = 'Local title' WHERE slug = 'intersection-observation';");
    await db.exec(seed);
    assert.deepEqual((await db.query('SELECT * FROM unrelated')).rows, [{ id: 1, value: 'keep' }]);
    assert.equal((await db.query<any>('SELECT title FROM walk_audit_worksheets WHERE slug = $1', ['intersection-observation'])).rows[0].title, 'Local title');
    assert.equal((await db.query<any>('SELECT count(*)::int AS count FROM walk_audit_worksheets')).rows[0].count, 2);

    await db.exec("INSERT INTO walk_audit_contributors (firebase_uid, display_name) VALUES ('owner', 'Owner'), ('other', 'Other');");
    await assert.rejects(db.exec("INSERT INTO walk_audit_contributors (firebase_uid, display_name) VALUES ('owner', 'Again')"));
    await assert.rejects(db.exec("INSERT INTO walk_audit_contributors (firebase_uid, display_name) VALUES (' ', 'Blank')"));
    await assert.rejects(db.exec("INSERT INTO walk_audit_worksheets(slug,version,title,description,source_url,recommend_for,prompts) VALUES('bad',1,'Bad','','https://example.org',ARRAY['bridge'],'[]')"));
    const createStudy = `INSERT INTO walk_audit_studies (created_by, neighborhood, location_gps, location_description, area, intersections, segments, thumbnail_png, source_metadata)
      VALUES (1, 'Neighborhood', '{}', '', '{}', $1, $1, decode('89504e47', 'hex'), '{}') RETURNING id`;
    const s1 = (await db.query<any>(createStudy, [collection])).rows[0].id;
    const s2 = (await db.query<any>(createStudy, [collection])).rows[0].id;
    await assert.rejects(db.query(createStudy, ['{}']));
    const audit = (await db.query<any>(`INSERT INTO walk_audit_audits
      (study_id, created_by, worksheet_id, type, feature_id, location_gps, location_description, geojson, answers)
      VALUES ($1, 2, 1, 'intersection', 'node/1', '{}', '', '{}', '{}') RETURNING id`, [s1])).rows[0].id;
    await assert.rejects(db.query(`INSERT INTO walk_audit_drafts (id, study_id, created_by, editing_audit_id, editing_audit_version)
      VALUES ('00000000-0000-4000-8000-000000000001', $1, 2, $2, 1)`, [s2, audit]));
    await db.query(`INSERT INTO walk_audit_drafts (id, study_id, created_by, editing_audit_id, editing_audit_version)
      VALUES ('00000000-0000-4000-8000-000000000001', $1, 2, $2, 1)`, [s1, audit]);
    await db.query(`INSERT INTO walk_audit_reports (study_id, created_by, title, description, audit_ids, completion, captured_data)
      VALUES ($1, 1, 'Report', '', ARRAY[$2::integer], 0.5, '{"snapshot":"kept"}')`, [s1, audit]);
    await assert.rejects(db.query(`INSERT INTO walk_audit_reports (study_id,created_by,title,description,audit_ids,completion,captured_data) VALUES ($1,1,'Bad','',ARRAY[]::integer[],1.5,'{}')`, [s1]));
    await assert.rejects(db.exec('DELETE FROM walk_audit_contributors WHERE id = 2'));
    await assert.rejects(db.exec('DELETE FROM walk_audit_worksheets WHERE id = 1'));
    await db.query('DELETE FROM walk_audit_audits WHERE id = $1', [audit]);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_drafts')).rows[0].n, 0);
    assert.deepEqual((await db.query<any>('SELECT audit_ids, captured_data FROM walk_audit_reports')).rows[0], { audit_ids: [audit], captured_data: { snapshot: 'kept' } });
    await db.query(`INSERT INTO walk_audit_drafts (id, study_id, created_by) VALUES ('00000000-0000-4000-8000-000000000002', $1, 2)`, [s1]);
    await db.query('DELETE FROM walk_audit_studies WHERE id = $1', [s1]);
    for (const table of ['walk_audit_audits', 'walk_audit_drafts', 'walk_audit_reports']) {
      assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    }
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_studies')).rows[0].n, 1);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_contributors')).rows[0].n, 2);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_worksheets')).rows[0].n, 2);
  } finally {
    await db.close();
  }
});

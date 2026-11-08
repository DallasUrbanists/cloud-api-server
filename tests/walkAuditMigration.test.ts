import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/009_walk_audits.sql', import.meta.url), 'utf8');
const seed = await readFile(new URL('../migrations/010_seed_walk_audit_worksheets.sql', import.meta.url), 'utf8');
const questionnaires = await readFile(new URL('../migrations/011_study_questionnaires_routes_photos.sql', import.meta.url), 'utf8');
const collection = JSON.stringify({ type: 'FeatureCollection', features: [] });

test('feature migration and seed apply to an otherwise empty database', async () => {
  const empty = new PGlite();
  try {
    await empty.exec(migration); await empty.exec(seed); await empty.exec(questionnaires);
    const tables = await empty.query<any>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'walk_audit_%'");
    assert.equal(tables.rows.length, 8);
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
    await db.exec(questionnaires);
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

test('backfill pins latest historical worksheet and resolves fallback by slug/version', async () => {
  const db = new PGlite();
  try {
    await db.exec(migration); await db.exec(seed);
    await db.exec(`INSERT INTO walk_audit_contributors(firebase_uid,display_name) VALUES('a','Author');
      INSERT INTO walk_audit_studies(created_by,neighborhood,location_gps,location_description,area,intersections,segments,thumbnail_png,source_metadata)
      VALUES(1,'Study','{}','','{}','{"type":"FeatureCollection","features":[]}','{"type":"FeatureCollection","features":[]}',decode('01','hex'),'{}');
      INSERT INTO walk_audit_worksheets(slug,version,title,description,source_url,recommend_for,prompts)
      SELECT slug,2,'Second version',description,source_url,recommend_for,prompts FROM walk_audit_worksheets WHERE slug='street-observation';
      INSERT INTO walk_audit_worksheets(slug,version,title,description,source_url,recommend_for,prompts)
      VALUES('historical',1,'Historical','','https://example.org',ARRAY['intersection'],'[]');
      INSERT INTO walk_audit_audits(study_id,created_by,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers,created_on)
      VALUES(1,1,1,'intersection','node/1','{}','','{}','{}','2020-01-01'),
            (1,1,4,'intersection','node/2','{}','','{}','{}','2020-01-01');`);
    await db.exec(questionnaires);
    const rows = (await db.query<any>('SELECT audit_type,worksheet_id FROM walk_audit_study_questionnaires ORDER BY audit_type')).rows;
    assert.deepEqual(rows, [{ audit_type: 'intersection', worksheet_id: 4 }, { audit_type: 'street-segment', worksheet_id: 3 }]);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_audits')).rows[0].n, 2);
  } finally { await db.close(); }
});

test('missing fallback aborts the complete migration', async () => {
  const db = new PGlite();
  try {
    await db.exec(migration);
    await db.exec(`INSERT INTO walk_audit_contributors(firebase_uid,display_name) VALUES('a','Author');
      INSERT INTO walk_audit_studies(created_by,neighborhood,location_gps,location_description,area,intersections,segments,thumbnail_png,source_metadata)
      VALUES(1,'Study','{}','','{}','{"type":"FeatureCollection","features":[]}','{"type":"FeatureCollection","features":[]}',decode('01','hex'),'{}');`);
    await assert.rejects(db.exec(questionnaires), /default worksheet slugs/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='walk_audit_worksheets' AND column_name='is_template'")).rows[0].n, 0);
  } finally { await db.close(); }
});

test('photo slots enforce parent ownership, byte counts, uniqueness and cascading deletion', async () => {
  const db = new PGlite();
  try {
    await db.exec(migration); await db.exec(seed); await db.exec(questionnaires);
    await db.exec(`INSERT INTO walk_audit_contributors(firebase_uid,display_name) VALUES('a','Author'),('b','Other');
      INSERT INTO walk_audit_studies(created_by,neighborhood,location_gps,location_description,area,intersections,segments,thumbnail_png,source_metadata)
      VALUES(1,'Study','{}','','{}','{"type":"FeatureCollection","features":[]}','{"type":"FeatureCollection","features":[]}',decode('01','hex'),'{}');
      INSERT INTO walk_audit_drafts(id,study_id,created_by) VALUES('00000000-0000-4000-8000-000000000001',1,1);`);
    const insert = `INSERT INTO walk_audit_photos(id,study_id,created_by,draft_id,slot,content_type,byte_count,image_bytes)
      VALUES($1,1,$2,'00000000-0000-4000-8000-000000000001',$3,'image/png',$4,decode('0102','hex'))`;
    await db.query(insert, ['00000000-0000-4000-8000-000000000010', 1, 1, 2]);
    await assert.rejects(db.query(insert, ['00000000-0000-4000-8000-000000000011', 1, 1, 2]));
    await assert.rejects(db.query(insert, ['00000000-0000-4000-8000-000000000012', 1, 4, 2]));
    await assert.rejects(db.query(insert, ['00000000-0000-4000-8000-000000000013', 2, 2, 2]));
    await assert.rejects(db.query(insert, ['00000000-0000-4000-8000-000000000014', 1, 2, 1]));
    await db.exec("DELETE FROM walk_audit_drafts WHERE id='00000000-0000-4000-8000-000000000001'");
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_photos')).rows[0].n, 0);
    await db.exec("INSERT INTO walk_audit_drafts(id,study_id,created_by) VALUES('00000000-0000-4000-8000-000000000001',1,1)");
    await db.query(insert, ['00000000-0000-4000-8000-000000000015', 1, 2, 2]);
    await db.exec('DELETE FROM walk_audit_studies WHERE id=1');
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_photos')).rows[0].n, 0);
  } finally { await db.close(); }
});

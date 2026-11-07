import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.WALK_AUDIT_TEST_DATABASE_URL;
const enabled = process.env.WALK_AUDIT_TEST_DESTRUCTIVE === 'true' && !!url;
const area = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] } };

test('isolated PostgreSQL serializes submissions and preserves data and deletion across server restarts', { skip: enabled ? false : 'Set WALK_AUDIT_TEST_DATABASE_URL and WALK_AUDIT_TEST_DESTRUCTIVE=true for the dedicated local database.' }, async () => {
  const connection = new URL(url!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname), 'Only a loopback test database is accepted.');
  assert.equal(connection.pathname, '/walk_audit_test', 'Use the dedicated walk_audit_test database.');
  const schema = 'wa_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  let child: ChildProcess | undefined, base = '';
  async function start(): Promise<void> {
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/walkAuditTestServer.ts', import.meta.url))], {
      env: { ...process.env, WALK_AUDIT_TEST_SCHEMA: schema }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    const timeout = setTimeout(() => child?.kill(), 15000);
    try {
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.on('data', chunk => { output += String(chunk); const match = output.match(/WALK_AUDIT_READY=(\d+)/); if (match) { base = `http://127.0.0.1:${match[1]}/api/walk-audits`; resolve(); } });
        child!.stderr!.on('data', chunk => { output += String(chunk); });
        child!.once('exit', code => reject(new Error(`Fixture server exited before readiness (${code}): ${output}`)));
      });
    } finally { clearTimeout(timeout); }
  }
  async function stop(): Promise<void> {
    if (!child || child.exitCode !== null) return;
    const stopped = once(child, 'exit'); child.send!('stop'); await stopped; child = undefined;
  }
  async function call(path: string, method = 'GET', uid?: string, body?: unknown): Promise<Response> {
    return fetch(base + path, { method, headers: { ...(uid ? { 'X-Test-Identity': uid } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function expect(response: Response, status: number): Promise<any> {
    const raw = await response.text(); assert.equal(response.status, status, raw); return raw ? JSON.parse(raw) : undefined;
  }
  try {
    await db.query('CREATE TABLE unrelated (id integer PRIMARY KEY, content text); INSERT INTO unrelated VALUES (1, \'keep\')');
    await db.query(await readFile(new URL('../migrations/009_walk_audits.sql', import.meta.url), 'utf8'));
    const seed = await readFile(new URL('../migrations/010_seed_walk_audit_worksheets.sql', import.meta.url), 'utf8');
    await db.query(seed); await db.query(seed);
    await start();
    for (const uid of ['organizer', 'contributor']) await expect(await call('/contributors/me', 'POST', uid, { displayName: uid }), 201);
    const starts = await Promise.all([call('/studies', 'POST', 'organizer', { neighborhood: 'First', area }), call('/studies', 'POST', 'organizer', { neighborhood: 'First', area })]);
    assert.deepEqual(starts.map(response => response.status).sort(), [201, 429]);
    const study = (await starts.find(response => response.status === 201)!.json()).study;
    const other = (await expect(await call('/studies', 'POST', 'contributor', { neighborhood: 'Other', area }), 201)).study;
    const blocker = await db.connect();
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM walk_audit_studies WHERE id=$1 FOR UPDATE', [study.id]);
      assert.equal((await call(`/studies/${study.id}`, 'PATCH', 'organizer', { expectedVersion: 1, neighborhood: 'Blocked' })).status, 409);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    assert.equal((await expect(await call(`/studies/${study.id}`), 200)).study.version, 1);
    const png = Buffer.from(await (await call(`/studies/${study.id}/thumbnail`)).arrayBuffer());
    const data = { type: 'intersection', worksheetId: 1, featureId: 'node/2', locationGps: { longitude: 0.005, latitude: 0.005 }, locationDescription: 'Crossing', answers: { 'crossing-comfort': 'comfortable' } };
    const draft = (await expect(await call(`/studies/${study.id}/drafts`, 'POST', 'contributor', {}), 201)).draft;
    await expect(await call(`/drafts/${draft.id}`, 'PATCH', 'contributor', { expectedVersion: 1, ...data }), 200);
    const submissions = await Promise.all([call(`/drafts/${draft.id}/submit`, 'POST', 'contributor', { expectedVersion: 2 }), call(`/drafts/${draft.id}/submit`, 'POST', 'contributor', { expectedVersion: 2 })]);
    assert.deepEqual(submissions.map(response => response.status).sort(), [201, 404]);
    const audit = (await submissions.find(response => response.status === 201)!.json()).audit;
    const edited = (await expect(await call(`/audits/${audit.id}`, 'PATCH', 'contributor', { expectedVersion: 1, locationDescription: 'Updated' }), 200)).audit;
    const report = (await expect(await call(`/studies/${study.id}/reports`, 'POST', 'organizer', { description: 'Saved narrative' }), 201)).report;
    await expect(await call(`/reports/${report.id}`, 'PATCH', 'organizer', { expectedVersion: 1, title: 'Edited title' }), 200);
    await stop(); await start();
    assert.equal((await expect(await call(`/studies/${study.id}`), 200)).study.neighborhood, 'First');
    assert.equal((await expect(await call(`/audits/${audit.id}`), 200)).audit.locationDescription, 'Updated');
    assert.equal((await expect(await call(`/reports/${report.id}`), 200)).report.description, 'Saved narrative');
    assert.deepEqual(Buffer.from(await (await call(`/studies/${study.id}/thumbnail`)).arrayBuffer()), png);
    const edits = await Promise.all([call(`/audits/${audit.id}`, 'PATCH', 'contributor', { expectedVersion: edited.version, locationDescription: 'Writer one' }), call(`/audits/${audit.id}`, 'PATCH', 'contributor', { expectedVersion: edited.version, locationDescription: 'Writer two' })]);
    assert.deepEqual(edits.map(response => response.status).sort(), [200, 409]);
    const snapshot = (await expect(await call(`/reports/${report.id}`), 200)).report;
    assert.equal(snapshot.capturedData.audits[0].locationDescription, 'Updated');
    const privateDraft = (await expect(await call(`/studies/${study.id}/drafts`, 'POST', 'contributor', {}), 201)).draft;
    const results = await Promise.all([call(`/studies/${study.id}?confirmPermanentDelete=true`, 'DELETE', 'organizer'), call(`/studies/${study.id}/drafts`, 'POST', 'contributor', {})]);
    assert.equal(results[0].status, 204); assert.ok([201, 404].includes(results[1].status));
    for (const table of ['walk_audit_audits', 'walk_audit_drafts', 'walk_audit_reports']) assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE study_id=$1`, [study.id])).rows[0].count, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM walk_audit_studies WHERE id=$1', [study.id])).rows[0].count, 0);
    assert.equal((await db.query('SELECT content FROM unrelated WHERE id=1')).rows[0].content, 'keep');
    assert.equal((await call(`/studies/${other.id}`)).status, 200);
    await stop(); await start();
    for (const path of [`/studies/${study.id}`, `/studies/${study.id}/thumbnail`, `/audits/${audit.id}`, `/reports/${report.id}`]) assert.equal((await call(path)).status, 404);
    assert.equal((await call(`/drafts/${privateDraft.id}`, 'GET', 'contributor')).status, 404);
    // Build a bounded but collectively large valid selection to exercise the 16 MiB capture limit.
    const largeWorksheet = (await db.query(`INSERT INTO walk_audit_worksheets(slug,version,title,description,source_url,recommend_for,prompts)
      SELECT 'large-selection',1,'Large selection','','https://example.org',ARRAY['intersection'],
        jsonb_agg(jsonb_build_object('id','p'||n,'type','text','label','Question','required',false,'maxLength',10000))
      FROM generate_series(1,10) n RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO walk_audit_audits(study_id,created_by,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers)
      SELECT $1,2,$2,'intersection','node/2','{"longitude":0.005,"latitude":0.005}','',
        (SELECT intersections->'features'->0 FROM walk_audit_studies WHERE id=$1),
        (SELECT jsonb_object_agg('p'||n,repeat('x',9000)) FROM generate_series(1,10) n)
      FROM generate_series(1,200)`, [other.id, largeWorksheet]);
    assert.equal((await call(`/studies/${other.id}/reports`, 'POST', 'contributor', {})).status, 413);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM walk_audit_reports WHERE study_id=$1', [other.id])).rows[0].count, 0);
  } finally {
    await stop(); await db.end();
    if (!/^wa_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Refusing unsafe schema cleanup.');
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

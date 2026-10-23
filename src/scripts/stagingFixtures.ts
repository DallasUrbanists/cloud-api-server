/**
 * Targeted synthetic staging fixtures across application stores. Report mode has no
 * clients or cloud calls; apply mode never reads or modifies shared Auth accounts.
 * @module
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { deploymentConfig, type DeploymentEnv } from '../config/deployment.js';

/** Reserved fixture keys; reset touches only these records and their fixture descendants. */
export const fixtureManifest = {
  marker: 'cloud-api-staging-fixtures-v1', suggestion: '910000001', sqlId: -910000001,
  contactName: 'STAGING FIXTURE NEIGHBOR', eventUid: 'staging-fixture-walk@example.invalid',
  object: 'staging-fixtures/v1/bus-stop.svg',
} as const;

/** Refuses any environment outside the exact staging resource contract before I/O. */
export function fixturePlan(action: string, env: DeploymentEnv = process.env) {
  const config = deploymentConfig(env);
  if (!config.staging || !['seed', 'reset'].includes(action)) throw new Error('Use seed/reset with a complete staging configuration.');
  return { action, environment: config.environment, database: config.database, bucket: config.bucket, sqlDatabase: env.DB_NAME, fixtures: fixtureManifest };
}

/** Seeds or resets the manifest after validation; cross-store operations are safely retryable, not atomic. */
export async function runFixtures(args: string[]) {
  if (args.length < 1 || args.slice(1).some(arg => arg !== '--apply')) throw new Error('Usage: stagingFixtures seed|reset [--apply]');
  const plan = fixturePlan(args[0]);
  console.log(JSON.stringify({ ...plan, apply: args.includes('--apply') }, null, 2));
  if (!args.includes('--apply')) return;
  const [{ getPublicImprovementsDb }, { getStorage }, { pool }] = await Promise.all([
    import('../config/firestore.js'), import('../config/storage.js'), import('../config/db.js'),
  ]);
  const db = getPublicImprovementsDb();
  const ref = db.collection('suggestion').doc(fixtureManifest.suggestion);
  const file = getStorage().bucket(plan.bucket).file(fixtureManifest.object);
  const client = await pool.connect();
  try {
    const identity = (await client.query('SELECT current_database() AS db, current_user AS role')).rows[0];
    if (identity.db !== 'urbanists_staging' || identity.role !== 'urbanists_staging') throw new Error('Unexpected SQL fixture identity.');
    await client.query('BEGIN');
    const contacts = await client.query('SELECT name, emails, firebase_uid FROM contacts WHERE id=$1 FOR UPDATE', [fixtureManifest.sqlId]);
    const events = await client.query('SELECT uid FROM events WHERE id=$1 FOR UPDATE', [fixtureManifest.sqlId]);
    if (contacts.rows.some(row => row.name !== fixtureManifest.contactName || row.firebase_uid !== null || JSON.stringify(row.emails) !== JSON.stringify(['neighbor@example.invalid']))
      || events.rows.some(row => row.uid !== fixtureManifest.eventUid)) throw new Error('SQL fixture ID collision; nothing replaced.');
    const existing = await ref.get();
    if (existing.exists && existing.get('_fixture') !== fixtureManifest.marker) throw new Error('Firestore fixture ID collision; nothing replaced.');
    const [exists] = await file.exists();
    let generation: number | undefined;
    if (exists) {
      const [metadata] = await file.getMetadata();
      if (metadata.metadata?.fixture !== fixtureManifest.marker) throw new Error('Storage fixture collision; nothing replaced.');
      generation = Number(metadata.generation);
    }
    if (plan.action === 'seed') {
      // The exported foundation uses GENERATED ALWAYS IDs; reserve fixtures without advancing sequences.
      if (!contacts.rows.length) await client.query('INSERT INTO contacts (id,name,emails) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3)', [fixtureManifest.sqlId, fixtureManifest.contactName, ['neighbor@example.invalid']]);
      if (!events.rows.length) await client.query('INSERT INTO events (id,uid,start_at,duration,title,ical_dtstamp) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$3)', [fixtureManifest.sqlId, fixtureManifest.eventUid, '2030-01-15T18:00:00Z', 'PT1H', 'Staging neighborhood walk']);
      if (!exists) await file.save('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#83bfa2"/><text x="12" y="55">Staging bus stop</text></svg>', {
        contentType: 'image/svg+xml', metadata: { metadata: { fixture: fixtureManifest.marker } }, preconditionOpts: { ifGenerationMatch: 0 },
      });
      if (!existing.exists) await ref.create({
        _fixture: fixtureManifest.marker, id: Number(fixtureManifest.suggestion), status: 'new', boundaryIds: [],
        creationDate: '2030-01-01T00:00:00Z', modificationDate: '2030-01-01T00:00:00Z',
        author: { name: 'Staging Neighbor', email: 'neighbor@example.invalid' },
        content: { summary: 'Add shade to a bus stop', details: 'Synthetic staging fixture.', photos: [{ url: `https://storage.googleapis.com/${plan.bucket}/${fixtureManifest.object}`, caption: 'Synthetic bus stop', timestamp: '2030-01-01T00:00:00Z' }] },
        location: { latitude: 32.78, longitude: -96.8, description: 'Synthetic bus stop', address: '' },
      });
    } else {
      await client.query('DELETE FROM events WHERE id=$1 AND uid=$2', [fixtureManifest.sqlId, fixtureManifest.eventUid]);
      await client.query('DELETE FROM contacts WHERE id=$1 AND name=$2', [fixtureManifest.sqlId, fixtureManifest.contactName]);
      if (existing.exists) await db.recursiveDelete(ref);
      if (exists) await file.delete({ ifGenerationMatch: generation });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
    await db.terminate();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFixtures(process.argv.slice(2)).catch(() => { console.error('Staging fixtures failed; check prerequisites and collisions. Cross-store partial progress may require a retry.'); process.exitCode = 1; });
}

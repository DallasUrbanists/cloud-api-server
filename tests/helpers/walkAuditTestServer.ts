/** Isolated HTTP fixture process for the opt-in real PostgreSQL acceptance test. */
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { WalkAuditStore } from '../../src/services/walkAuditStore.js';
import { WalkAuditGenerator } from '../../src/services/walkAuditGeospatial.js';
import { WalkAuditWorkflows } from '../../src/services/walkAuditWorkflows.js';
import type { RequestHandler } from 'express';

const connectionString = process.env.WALK_AUDIT_TEST_DATABASE_URL;
const schema = process.env.WALK_AUDIT_TEST_SCHEMA;
if (process.env.WALK_AUDIT_TEST_DESTRUCTIVE !== 'true' || !connectionString || !schema || !/^wa_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Explicit isolated PostgreSQL test configuration required.');
const db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const osm = { elements: [
  { type: 'node', id: 1, lon: 0, lat: 0.005 }, { type: 'node', id: 2, lon: 0.005, lat: 0.005 },
  { type: 'node', id: 3, lon: 0.01, lat: 0.005 }, { type: 'node', id: 4, lon: 0.005, lat: 0 },
  { type: 'node', id: 5, lon: 0.005, lat: 0.01 },
  { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'residential' } },
  { type: 'way', id: 20, nodes: [4, 2, 5], tags: { highway: 'service' } },
] };
const generator = new WalkAuditGenerator({ urls: ['https://overpass.example/api'], timeoutMs: 1000, concurrency: 2, intervalMs: 60000 }, async () => Response.json(osm));
const auth: RequestHandler = (req, res, next) => {
  const uid = req.header('X-Test-Identity');
  if (!uid || !['organizer', 'contributor'].includes(uid)) { res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Test identity required.' }); return; }
  req.user = { uid, emails: [], roles: [], token: { uid } as any }; next();
};
const app = createApp({ walkAuditService: new WalkAuditWorkflows(new WalkAuditStore(db), generator), walkAuditAuth: [auth] });
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`WALK_AUDIT_READY=${(server.address() as { port: number }).port}\n`));
process.on('message', message => {
  if (message !== 'stop') return;
  server.closeAllConnections(); server.close(() => { void db.end().finally(() => process.exit(0)); });
});

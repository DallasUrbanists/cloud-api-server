import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

let db: PGlite;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
const originalQuery = pool.query;
const originalFetch = globalThis.fetch;
const originalMapsKey = process.env.GOOGLE_MAPS_API_KEY;

function dateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function insertRepresentative(input: {
  entity?: string;
  body?: string;
  title?: string;
  name: string;
  start?: string;
  end?: string;
  district?: string;
  elections?: unknown[];
  bounds?: unknown;
}) {
  await db.query(
    `INSERT INTO representatives (entity, body, title, name, "start", "end", district, elections, district_bounds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      input.entity ?? 'City of Dallas',
      input.body ?? 'City Council',
      input.title ?? 'Council member',
      input.name,
      input.start ?? dateOffset(-10),
      input.end ?? null,
      input.district ?? 'District 1',
      JSON.stringify(input.elections ?? []),
      JSON.stringify(input.bounds ?? null),
    ],
  );
}

before(async () => {
  db = new PGlite();
  await db.exec(await readFile(new URL('../migrations/004_representatives.sql', import.meta.url), 'utf8'));
  (pool as any).query = (text: string, values?: unknown[]) => db.query(text, values);

  const election = [{
    label: 'General election',
    date: dateOffset(10),
    early_vote_start: dateOffset(2),
    early_vote_end: dateOffset(8),
    status: 'Upcoming',
  }];
  const polygon = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ],
  };
  await insertRepresentative({ name: 'Current Member', elections: election, bounds: polygon });
  await insertRepresentative({ name: 'Former Member', end: dateOffset(-2), district: 'District 2', bounds: polygon });
  await insertRepresentative({ name: 'Expired Earlier Today', end: `${dateOffset(0)}T00:00:00`, district: 'District 4', bounds: polygon });
  await insertRepresentative({ name: 'Future Member', start: dateOffset(1), district: 'District 3', bounds: polygon });
  await insertRepresentative({ name: 'Other Office', entity: 'Other Entity', body: 'Other Body', title: 'Other Title', bounds: polygon });
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  (pool as any).query = originalQuery;
  globalThis.fetch = originalFetch;
  if (originalMapsKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalMapsKey;
  await db.close();
});

async function get(path: string): Promise<Response> {
  return originalFetch(`${origin}${path}`);
}

test('representative searches are public and combine text and date filters', async () => {
  const response = await get('/api/representatives?entity=City%20of%20Dallas&body=City%20Council&title=Council%20member&district=District%201');
  assert.equal(response.status, 200);
  const filteredRepresentatives = await response.json();
  assert.deepEqual(filteredRepresentatives.map((row: { name: string }) => row.name), ['Current Member']);
  assert.equal('district_bounds' in filteredRepresentatives[0], false);

  const current = await get('/api/representatives');
  assert.deepEqual((await current.json()).map((row: { name: string }) => row.name), ['Current Member', 'Other Office']);

  const historical = await get(`/api/representatives?servingAsOf=${dateOffset(-5)}`);
  assert.deepEqual((await historical.json()).map((row: { name: string }) => row.name), ['Current Member', 'Former Member', 'Expired Earlier Today', 'Other Office']);

  const electionPeriod = await get(`/api/representatives?electionAsOf=${dateOffset(5)}`);
  assert.deepEqual((await electionPeriod.json()).map((row: { name: string }) => row.name), ['Current Member']);
  const outsideElectionPeriod = await get(`/api/representatives?electionAsOf=${dateOffset(1)}`);
  assert.deepEqual(await outsideElectionPeriod.json(), []);

  const intersected = await get(`/api/representatives?entity=City%20of%20Dallas&district=District%202&electionAsOf=${dateOffset(5)}`);
  assert.deepEqual(await intersected.json(), []);

  const invalidDate = await get('/api/representatives?servingAsOf=2026-02-30');
  assert.equal(invalidDate.status, 400);
});

test('coordinates use district polygons and address lookups are skipped when coordinates exist', async () => {
  const inside = await get('/api/representatives?lat=2&lon=2&district=District%201');
  assert.deepEqual((await inside.json()).map((row: { name: string }) => row.name), ['Current Member', 'Other Office']);

  const inHole = await get('/api/representatives?lat=5&lon=5&district=District%201');
  assert.deepEqual(await inHole.json(), []);

  const partialCoordinates = await get('/api/representatives?lat=2');
  assert.equal((await partialCoordinates.json()).length, 2);

  process.env.GOOGLE_MAPS_API_KEY = 'test-geocoding-key';
  let geocodeCalls = 0;
  globalThis.fetch = async (input) => {
    geocodeCalls++;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('address'), 'Dallas City Hall');
    assert.equal(url.searchParams.get('key'), 'test-geocoding-key');
    return Response.json({ status: 'OK', results: [{ geometry: { location: { lat: 2, lng: 2 } } }] });
  };
  const addressSearch = await get('/api/dallascitycouncil?address=Dallas%20City%20Hall&district=District%201');
  assert.equal(addressSearch.status, 200);
  const councilRepresentatives = await addressSearch.json();
  assert.deepEqual(councilRepresentatives.map((row: { name: string }) => row.name), ['Current Member']);
  assert.equal('district_bounds' in councilRepresentatives[0], false);

  const coordinatesOverrideAddress = await get('/api/dallascitycouncil?lat=2&lon=2&address=&district=District%201');
  assert.equal(coordinatesOverrideAddress.status, 200);
  assert.equal(geocodeCalls, 1);
});

test('Dallas City Council shortcut fixes office filters and address search reports missing configuration', async () => {
  const response = await get('/api/dallascitycouncil?entity=Other%20Entity&body=Other%20Body&title=Other%20Title');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map((row: { name: string }) => row.name), ['Current Member']);

  delete process.env.GOOGLE_MAPS_API_KEY;
  const unconfigured = await get('/api/representatives?address=Somewhere');
  assert.equal(unconfigured.status, 503);
});

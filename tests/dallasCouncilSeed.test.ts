import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const names = [
  'Chad West', 'Jesse Moreno', 'Zarin Gracey', 'Maxie Johnson', 'Jaime Resendez',
  'Laura Cadena', 'Adam Bazaldua', 'Lorie Blair', 'Paula Blackmon', 'Kathy Stewart',
  'Bill Roth', 'Cara Mendelsohn', 'Gay Donnell Willis', 'Paul E. Ridley',
];
const schema = await readFile(new URL('../migrations/004_representatives.sql', import.meta.url), 'utf8');
const seed = await readFile(new URL('../migrations/005_seed_dallas_city_council.sql', import.meta.url), 'utf8');
// Hashes are computed from the supplied district feature geometries, without simplification.
const geometryHashes: string[] = [
  "a6537f812545c380c52789941cc0d276410b6a0a088a0fdb7b847fe6ba4d2633",
  "f053d1d15dac60128332e0e1c7308dd18c0c38f1ef144f88d2344007ab735b58",
  "5611a8e0267d48ddf8fa613fdaef36f718d2ffd59760c8504d6681cdb6b3e1eb",
  "679ec830aee1ecff62e2ed8ce61b64b8dde470573e9fb93b06ae3501d2a4f091",
  "d23e44a2b65d35de1764f1d332c0e804e5fae2f2e3a4762dafb47983be66097e",
  "586806ac8db2c0bfc1d93037d97775352eb34098a18a9ffc8c108ad5f5a5190e",
  "b80e9b625e998afd3c9f1aef1b512aa467af7c05aeb1f64b65345ddf0ed56a14",
  "375633528aa0de54424eef07786c0abd2a8cb0ee57710a5df16b6b2f904b06d8",
  "e86bf1de11c279fb26ac55d16b138dc2f9caa37c7d8f43d78745dc37efcf5cd8",
  "d11cc1af30591ed1d94dedd20d29f1b3be1ff6d826dd7594a64b952569b61575",
  "4caa0f3b3272b488995f40e368cf8b0e7e7b4ce679b027250644a76a84db17b2",
  "957bd0443a552f998cfe04bf7f0ca000cf83f2fdbc1e19b7f3b6e118f0e89423",
  "95562d9c3ca960bee46a3aa9aecc1ccffa8436557d19bbcdc6700e9f69ae12ea",
  "e8fc3e9a8822a6b28c3ad1c165dfbef4037144e36b9a312ff5e659d988587264"
];

async function database() {
  const db = new PGlite();
  await db.exec(schema);
  return db;
}

test('seeds all 14 district members with valid contact, election, and exact boundary data', async () => {
  const db = await database();
  try {
    await db.exec(seed);
    const { rows } = await db.query<any>(`SELECT *, "start"::text AS tenure_start, "end"::text AS tenure_end
      FROM representatives ORDER BY substring(district FROM '[0-9]+')::integer`);
    assert.equal(rows.length, 14);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.name, names[index]);
      assert.equal(row.entity, 'City of Dallas');
      assert.equal(row.body, 'City Council');
      assert.equal(row.title, 'Council member');
      assert.equal(row.district, `District ${index + 1}`);
      assert.ok(row.bio.length > 50);
      assert.ok(row.district_description.length > 100);
      assert.equal(new URL(row.webpage_url).hostname, 'dallascityhall.com');
      assert.equal(new URL(row.photo_url).hostname, 'dallascityhall.com');
      assert.ok(row.emails.length > 0);
      assert.ok(row.phones.length > 0);
      for (const phone of row.phones) {
        assert.match(phone.phone, /^[0-9]{10}$/);
        assert.equal(phone.can_sms, false);
      }
      assert.ok(row.elections.length > 0);
      assert.ok(row.elections.some((election: any) => election.date.startsWith('2025-')));
      const earliestElectionDate = row.elections.map((election: any) => election.date).sort()[0];
      assert.equal(row.tenure_start, [4, 6, 8, 11].includes(index + 1)
        ? '2025-06-16 00:00:00'
        : `${earliestElectionDate} 00:00:00`);
      assert.equal(row.tenure_end, null);
      assert.equal(row.district_bounds.type, 'Polygon');
      const hash = createHash('sha256').update(JSON.stringify(row.district_bounds.coordinates)).digest('hex');
      assert.equal(hash, geometryHashes[index]);
    }
  } finally {
    await db.close();
  }
});

test('uses the earliest past election, excludes future dates, and keeps verified inaugurations', async () => {
  const db = await database();
  try {
    const dates = ['2999-05-01', '2023-05-06', '2019-05-04'];
    const elections = dates.map(date => ({
      label: 'Test election', date, early_vote_start: date, early_vote_end: date, status: 'Test',
    }));
    let replacements = 0;
    const scenario = seed.replace(/'(\[\{"label":[^\r\n]*"early_vote_start":[^\r\n]*\])'::jsonb/g, () => {
      replacements++;
      return `'${JSON.stringify(elections)}'::jsonb`;
    });
    assert.equal(replacements, 14);
    await db.exec(scenario);
    const { rows } = await db.query<{ district: string; start: string }>(
      'SELECT district, "start"::text AS start FROM representatives');
    for (const row of rows) {
      assert.equal(row.start, ['District 4', 'District 6', 'District 8', 'District 11'].includes(row.district)
        ? '2025-06-16 00:00:00'
        : '2019-05-04 00:00:00');
    }
  } finally {
    await db.close();
  }
});

test('leaves unverified start NULL when elections are only today/future or absent', async () => {
  const db = await database();
  try {
    const { rows: [today] } = await db.query<{ date: string }>('SELECT CURRENT_DATE::text AS date');
    const elections = [today.date, '2999-05-01'].map(date => ({
      label: 'Test election', date, early_vote_start: date, early_vote_end: date, status: 'Test',
    }));
    let replacements = 0;
    const scenario = seed.replace(/'(\[\{"label":[^\r\n]*"early_vote_start":[^\r\n]*\])'::jsonb/g, () => {
      replacements++;
      return `'${JSON.stringify(replacements % 2 ? elections : [])}'::jsonb`;
    });
    assert.equal(replacements, 14);
    await db.exec(scenario);
    const { rows } = await db.query<{ district: string; start: string | null; end: string | null }>(
      'SELECT district, "start"::text AS start, "end"::text AS end FROM representatives');
    for (const row of rows) {
      assert.equal(row.start, ['District 4', 'District 6', 'District 8', 'District 11'].includes(row.district)
        ? '2025-06-16 00:00:00'
        : null);
      assert.equal(row.end, null);
    }
  } finally {
    await db.close();
  }
});

test('rerunning preserves IDs and existing edits without duplicating council members', async () => {
  const db = await database();
  try {
    await db.exec(seed);
    const before = await db.query<{ id: number }>('SELECT id FROM representatives ORDER BY id');
    await db.exec("UPDATE representatives SET bio = 'Locally maintained biography' WHERE district = 'District 1'");
    await db.exec(seed);
    const after = await db.query<{ id: number }>('SELECT id FROM representatives ORDER BY id');
    assert.deepEqual(after.rows, before.rows);
    const { rows } = await db.query<{ bio: string }>("SELECT bio FROM representatives WHERE district = 'District 1'");
    assert.equal(rows[0].bio, 'Locally maintained biography');
  } finally {
    await db.close();
  }
});

test('rolls back the whole seed if an insert fails', async () => {
  const db = await database();
  try {
    await db.exec("SELECT setval(pg_get_serial_sequence('representatives', 'id'), 2147483646)");
    await assert.rejects(db.exec(seed));
    await db.exec('ROLLBACK');
    const { rows } = await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM representatives');
    assert.equal(rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test('preserves other representatives and accepts an already-present sitting member', async () => {
  const db = await database();
  try {
    await db.exec(`INSERT INTO representatives (entity, body, title, name, district, bio) VALUES
      ('Another city', 'City Council', 'Council member', 'Unrelated member', 'District 1', 'Keep unrelated'),
      ('City of Dallas', 'City Council', 'Council member', 'Former member', 'District 1', 'Keep historical'),
      ('City of Dallas', 'City Council', 'Council member', 'Chad West', 'District 1', 'Keep existing')`);
    await db.exec(seed);
    const { rows } = await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM representatives');
    assert.equal(rows[0].count, 16);
    const current = await db.query<{ bio: string }>("SELECT bio FROM representatives WHERE name = 'Chad West'");
    assert.deepEqual(current.rows, [{ bio: 'Keep existing' }]);
  } finally {
    await db.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

const keys = ['K_SERVICE', 'CLOUD_RUN_JOB', 'CLOUD_RUN_WORKER_POOL', 'INSTANCE_CONNECTION_NAME', 'DB_HOST', 'DB_PORT'] as const;
for (const mode of ['K_SERVICE', 'CLOUD_RUN_JOB', 'CLOUD_RUN_WORKER_POOL', 'local'] as const) {
  test(`boundary worker database configuration supports ${mode}`, async () => {
    const original = new Map(keys.map(key => [key, process.env[key]]));
    let database: any;
    try {
      for (const key of keys) delete process.env[key];
      process.env.INSTANCE_CONNECTION_NAME = 'fixture-project:us-central1:fixture-db';
      process.env.DB_HOST = '127.0.0.1'; process.env.DB_PORT = '6543';
      if (mode !== 'local') process.env[mode] = 'fixture-runtime';
      const url = new URL('../src/config/db.js', import.meta.url); url.search = `mode=${mode}`;
      database = (await import(url.href)).pool;
      assert.equal(database.options.host, mode === 'local' ? '127.0.0.1' : '/cloudsql/fixture-project:us-central1:fixture-db');
      if (mode === 'local') assert.equal(database.options.port, 6543);
      assert.equal(database.options.max, 10);
    } finally {
      if (database) await database.end();
      for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
}

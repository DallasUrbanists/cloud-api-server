/** PostgreSQL transaction boundary for walk-audit services. @module */
import { pool } from '../config/db.js';
import type { Pool, PoolClient } from 'pg';

/** One queryable session; transactions always use a separately acquired client. */
export type WalkAuditConnection = Pick<PoolClient, 'query'>;

/** Uses the existing pool in production and permits an isolated pool in tests. */
export class WalkAuditStore {
  constructor(public readonly db: Pool = pool) {}

  /** Commit all work together or roll it back, releasing the client in either case. */
  async transaction<T>(work: (client: WalkAuditConnection) => Promise<T>, isolation: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED'): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}

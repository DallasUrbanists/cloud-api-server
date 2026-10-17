/**
 * Durable PostgreSQL refresh scheduling, distributed budgets, leases, and fenced persistence.
 *
 * @remarks
 * One boundary scope admits one active job. Shape and research progress commit
 * separately; a later research failure does not roll back a successful shape update.
 * The worker executes research outside HTTP request lifetimes.
 * @module
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { BoundaryError, boundaryFromRow, dallasDate, type BoundaryRow, type ServiceDescriptor } from '../models/boundary.js';
import { BoundaryService } from './boundaryService.js';
import { RepresentativesService } from './representativesService.js';
import { ensureProvider, runResearch, runShape } from './boundaryAdapters.js';
import type { ResearchResult } from './research/types.js';

/** Storage-facing durable task; the lease token fences writes and bigint identity remains text. */
export interface SyncJob {
  id: string;
  scope_id: number;
  target_type: 'boundary' | 'representative';
  target_id: number;
  shape_requested: boolean;
  research_requested: boolean;
  force_sync: boolean;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  lease_token: string | null;
  attempts: number;
  error_code: string | null;
}
/** Reads a bounded positive integer setting, rejecting invalid configuration as an expected service failure. */
export function syncLimit(name: string, fallback: number, maximum = 10000): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new BoundaryError(503, 'SYNC_CONFIGURATION_INVALID', 'Sync limits are not configured correctly.');
  return value;
}
/**
 * Checks successful-refresh age in days while respecting retry backoff.
 * @remarks Attempt timestamps do not extend freshness; TTL expiry is inclusive.
 * @example
 * Let's imagine a noticeboard is checked regularly for new information. A failed
 * visit does not make its old information fresh again; it still needs another check.
 */
export function isDue(row: BoundaryRow, kind: 'shape' | 'research', now = Date.now()): boolean {
  const retry = row[`${kind}_retry_after`];
  if (retry && new Date(retry).getTime() > now) return false;
  const last = row[`last_${kind}_success`];
  return !last || new Date(last).getTime() + row[`${kind}_sync_ttl`] * 86400000 <= now;
}
/** SQL equivalent of success-based freshness and retry gating for trusted table aliases. */
const due = (alias: string, kind: 'shape' | 'research') =>
  `(${alias}.last_${kind}_success IS NULL OR CURRENT_TIMESTAMP - ${alias}.last_${kind}_success >= ${alias}.${kind}_sync_ttl * INTERVAL '1 day')
   AND (${alias}.${kind}_retry_after IS NULL OR ${alias}.${kind}_retry_after <= CURRENT_TIMESTAMP)`;
/** Runs a short SQL transaction with lock/statement deadlines and always releases its connection. */
async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
/** Atomically consumes a distributed fixed-window allowance; a rejected transaction rolls its increment back. */
async function consumeBucket(client: PoolClient, bucket: string, window: string, limit: number) {
  const { rows } = await client.query(
    `INSERT INTO boundary_sync_budgets(bucket, window_start, requests) VALUES ($1, date_trunc($2, CURRENT_TIMESTAMP), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       window_start = EXCLUDED.window_start,
       requests = CASE WHEN boundary_sync_budgets.window_start = EXCLUDED.window_start THEN boundary_sync_budgets.requests + 1 ELSE 1 END
     WHERE boundary_sync_budgets.window_start <> EXCLUDED.window_start OR boundary_sync_budgets.requests < $3 RETURNING bucket`, [bucket, window, limit],
  );
  if (!rows.length) throw new BoundaryError(429, 'SYNC_RATE_LIMITED', 'The sync request budget has been exhausted.');
}
/** Locks and verifies the running lease before publishing changes, rejecting stale workers. */
async function fenced(client: PoolClient, job: SyncJob) {
  const { rows } = await client.query(
    `SELECT id FROM boundary_sync_jobs WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_until > clock_timestamp() FOR UPDATE`, [job.id, job.lease_token],
  );
  if (!rows.length) throw new BoundaryError(409, 'SYNC_LEASE_LOST', 'The sync job lease is no longer valid.');
}
/**
 * Applies verified people and evidence inside the caller's fenced transaction.
 * @remarks
 * Only authoritative, complete, nonempty rosters can retire absent incumbents.
 * Undefined fields preserve stored values. Targeted research reports whether the
 * requested person was updated or validly retired; unresolved proposals retain evidence for review.
 */
async function saveResearch(client: PoolClient, job: SyncJob, result: ResearchResult, descriptor: ServiceDescriptor) {
  const target = job.target_type === 'representative'
    ? (await client.query('SELECT r.*, (r."start" IS NULL OR r."start" <= CURRENT_TIMESTAMP) AS has_started FROM representatives r WHERE r.id = $1 FOR UPDATE', [job.target_id])).rows[0]
    : undefined;
  const seen: number[] = [];
  let targetSeen = false;
  for (const person of result.people) {
    if (!person.sourceKey || !person.name?.trim() || person.name.length > 200 || !person.title?.trim()) throw new BoundaryError(502, 'RESEARCH_INVALID', 'Research person data is invalid.');
    const matchesTarget = !!target && (target.source_key === person.sourceKey || target.name?.trim().toLowerCase() === person.name.trim().toLowerCase());
    if (target && !matchesTarget && !result.completeRoster) continue;
    const existing = await client.query(
      `SELECT id FROM representatives WHERE boundary_id = $1 AND "end" IS NULL
       AND (source_key = $2 OR lower(name) = lower($3)) ORDER BY (source_key = $2) DESC NULLS LAST, id LIMIT 1 FOR UPDATE`, [job.scope_id, person.sourceKey, person.name],
    );
    const researchService = person.researchService ?? descriptor;
    let id = matchesTarget ? target.id : existing.rows[0]?.id;
    if (id === undefined) {
      if (descriptor.params.expectedMembers === 1 && !result.completeRoster) {
        const current = await client.query('SELECT id FROM representatives WHERE boundary_id = $1 AND "end" IS NULL AND lower(title) = lower($2) LIMIT 1', [job.scope_id, person.title]);
        if (current.rows.length) continue;
      }
      const inserted = await client.query(
        'INSERT INTO representatives(boundary_id, source_key, name, title, research_service) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id',
        [job.scope_id, person.sourceKey, person.name, person.title, JSON.stringify(researchService)],
      );
      id = inserted.rows[0].id;
    }
    const values: unknown[] = [id, person.sourceKey, person.name, person.title, JSON.stringify(researchService)];
    const updates = ['source_key = $2', 'name = $3', 'title = $4', 'research_service = $5::jsonb', 'last_research_sync = CURRENT_TIMESTAMP', 'last_research_success = CURRENT_TIMESTAMP', 'research_retry_after = NULL'];
    for (const field of ['webpage_url', 'photo_url', 'bio', 'emails', 'phones', 'start', 'end'] as const) {
      if (person[field] === undefined) continue;
      values.push(['emails', 'phones'].includes(field) ? JSON.stringify(person[field]) : person[field]);
      updates.push(`"${field}" = $${values.length}${['emails', 'phones'].includes(field) ? '::jsonb' : ''}`);
    }
    await client.query(`UPDATE representatives SET ${updates.join(', ')} WHERE id = $1`, values);
    seen.push(id);
    if (matchesTarget) targetSeen = true;
  }
  if (result.authoritative && result.completeRoster && seen.length) {
    await client.query(
      'UPDATE representatives SET "end" = CURRENT_TIMESTAMP WHERE boundary_id = $1 AND "end" IS NULL AND NOT (id = ANY($2::integer[])) AND ("start" IS NULL OR "start" <= CURRENT_TIMESTAMP)', [job.scope_id, seen],
    );
  }
  const retired = !!target && !targetSeen && seen.length > 0 && result.authoritative && result.completeRoster
    && target.has_started === true;
  if (retired) {
    await client.query('UPDATE representatives SET "end" = COALESCE("end", CURRENT_TIMESTAMP), last_research_success = CURRENT_TIMESTAMP, research_retry_after = NULL WHERE id = $1', [target.id]);
  }
  const unresolved = !!result.proposals && (result.proposals as any).people?.length !== seen.length;
  await client.query(
    `INSERT INTO boundary_research_evidence(boundary_id, representative_id, job_id, source_urls, outcome, proposal)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)`,
    [job.scope_id, target?.id ?? null, job.id, JSON.stringify(result.sourceUrls), unresolved || (!seen.length && !retired) ? 'review_required' : 'applied', JSON.stringify(result.proposals ?? result.people)],
  );
  if (job.target_type === 'boundary') {
    await client.query(
      `UPDATE boundaries SET last_research_success = CURRENT_TIMESTAMP, research_retry_after = NULL,
       description = COALESCE($2, description), when_to_contact = COALESCE($3, when_to_contact) WHERE id = $1`, [job.scope_id, result.description ?? null, result.whenToContact ?? null],
    );
  }
  return !target || targetSeen || retired;
}
/** Coordinates due-work selection and durable execution independently of a particular HTTP caller. */
export class BoundarySyncService {
  /**
   * Applies client budgets and selects/reuses one boundary-scoped task when work is due.
   * @remarks
   * Client-budget consumption commits separately from selection. Explicit IDs can
   * target historical records; forced requests bypass freshness but not active-job exclusion.
   * @returns A queued/existing job, or null when no requested adapter is due.
   * @throws BoundaryError for disabled sync, missing targets, conflicts, configuration, or budgets.
   * @example
   * Let's imagine a resident asks whether the district map needs an update. This
   * adds the work to a shared to-do list instead of starting the same task repeatedly.
   */
  static async enqueue(options: { target: 'boundary' | 'representative'; id?: number; kind?: 'shape' | 'research'; force?: boolean; clientAddress: string }): Promise<SyncJob | null> {
    if (process.env.BOUNDARY_SYNC_ENABLED !== 'true') throw new BoundaryError(503, 'SYNC_DISABLED', 'Boundary synchronization is not enabled.');
    await transaction(async client => {
      const ip = createHash('sha256').update(options.clientAddress).digest('hex');
      await consumeBucket(client, `client:${ip}`, 'minute', syncLimit('BOUNDARY_SYNC_CLIENT_PER_MINUTE', 30));
      await client.query("DELETE FROM boundary_sync_budgets WHERE window_start < CURRENT_TIMESTAMP - INTERVAL '2 days'");
    });
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(734210)');
      const boundaryTarget = options.target === 'boundary';
      const values: unknown[] = [dallasDate()];
      const conditions = ['(b.effective_date IS NULL OR b.effective_date <= $1::date)', '(b.expiration_date IS NULL OR b.expiration_date > $1::date)'];
      if (options.id !== undefined) {
        values.splice(0, values.length, options.id);
        // Explicit IDs can be inspected/synchronized outside their effective window.
        conditions.splice(0, conditions.length, `${boundaryTarget ? 'b' : 'r'}.id = $1`);
      } else {
        conditions.push("NOT EXISTS (SELECT 1 FROM boundary_sync_jobs j WHERE j.scope_id = b.id AND j.status IN ('queued', 'running'))");
        if (boundaryTarget) {
          const kind = options.kind ?? 'research';
          conditions.push(`b.${kind}_service IS NOT NULL AND ${due('b', kind)}`);
        } else {
          conditions.push(`COALESCE(r.research_service, b.research_service) IS NOT NULL AND ${due('r', 'research')}`);
          conditions.push('(r."start" IS NULL OR r."start" <= CURRENT_TIMESTAMP) AND (r."end" IS NULL OR r."end" > CURRENT_TIMESTAMP)');
        }
      }
      const select = boundaryTarget ? 'b.*' : 'r.*, row_to_json(b) AS boundary';
      const from = boundaryTarget ? 'boundaries b' : 'representatives r JOIN boundaries b ON b.id = r.boundary_id';
      const locking = options.id === undefined ? `FOR UPDATE OF ${boundaryTarget ? 'b' : 'r'} SKIP LOCKED` : '';
      const { rows } = await client.query(`SELECT ${select} FROM ${from} WHERE ${conditions.join(' AND ')} ORDER BY ${boundaryTarget ? 'b' : 'r'}.id LIMIT 1 ${locking}`, values);
      const row = rows[0];
      if (!row) {
        if (options.id !== undefined) throw new BoundaryError(404, 'NOT_FOUND', 'Sync target not found.');
        return null;
      }
      const boundary = boundaryTarget ? row : row.boundary;
      const active = await client.query("SELECT * FROM boundary_sync_jobs WHERE scope_id = $1 AND status IN ('queued', 'running')", [boundary.id]);
      if (active.rows[0]) {
        if (options.force) throw new BoundaryError(409, 'SYNC_IN_PROGRESS', 'A sync is already queued or running for this boundary. Retry after it completes.');
        return active.rows[0];
      }
      const shape = boundaryTarget && options.kind !== 'research' && !!row.shape_service && (options.force || isDue(row, 'shape'));
      const researchDescriptor = boundaryTarget ? row.research_service : row.research_service ?? boundary.research_service;
      const research = options.kind !== 'shape' && !!researchDescriptor && (options.force || isDue(row, 'research'));
      if (!shape && !research) return null;
      if (shape) ensureProvider(row.shape_service, 'shape');
      if (research) ensureProvider(researchDescriptor, 'research');
      const { rows: queued } = await client.query(
        `INSERT INTO boundary_sync_jobs(scope_id, target_type, target_id, shape_requested, research_requested, force_sync)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [boundary.id, options.target, row.id, shape, research, !!options.force],
      );
      return queued[0];
    });
  }
  /**
   * Leases the next eligible task, reclaiming expired work under global concurrency/budget limits.
   * @remarks Expired jobs exhausting crash attempts fail with backoff; lease identity changes on every claim.
   * @returns A leased job or null when none is eligible or concurrency is full.
   */
  static async claim(id?: string): Promise<SyncJob | null> {
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(734211)');
      const exhausted = await client.query(
        `UPDATE boundary_sync_jobs SET status = 'failed', error_code = 'SYNC_ATTEMPTS_EXHAUSTED', completed_at = CURRENT_TIMESTAMP,
         lease_token = NULL, lease_until = NULL WHERE status = 'running' AND lease_until <= CURRENT_TIMESTAMP AND attempts >= 3 RETURNING *`,
      );
      for (const job of exhausted.rows) {
        for (const kind of ['shape', 'research'] as const) {
          if (!job[`${kind}_requested`]) continue;
          await client.query(`UPDATE ${job.target_type === 'representative' ? 'representatives' : 'boundaries'} SET ${kind}_retry_after = CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE id = $1`, [job.target_id]);
        }
      }
      const running = await client.query("SELECT count(*)::integer AS count FROM boundary_sync_jobs WHERE status = 'running' AND lease_until > CURRENT_TIMESTAMP");
      if (running.rows[0].count >= syncLimit('BOUNDARY_SYNC_CONCURRENCY', 2, 20)) return null;
      const values: unknown[] = [];
      const specific = id === undefined ? '' : 'AND id = $1';
      if (id !== undefined) values.push(id);
      const { rows } = await client.query(
        `SELECT * FROM boundary_sync_jobs WHERE ((status = 'queued' AND available_at <= CURRENT_TIMESTAMP)
         OR (status = 'running' AND lease_until <= CURRENT_TIMESTAMP)) ${specific} ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, values,
      );
      if (!rows[0]) return null;
      await consumeBucket(client, 'global-minute', 'minute', syncLimit('BOUNDARY_SYNC_GLOBAL_PER_MINUTE', 10));
      await consumeBucket(client, 'global-day', 'day', syncLimit('BOUNDARY_SYNC_GLOBAL_PER_DAY', 100));
      const claimed = await client.query(
        `UPDATE boundary_sync_jobs SET status = 'running', lease_token = $2, lease_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes', attempts = attempts + 1 WHERE id = $1 RETURNING *`, [rows[0].id, randomUUID()],
      );
      return claimed.rows[0];
    });
  }
  /**
   * Executes allowlisted adapters under a deadline, persisting progress only while the lease is valid.
   * @remarks
   * Short HTTP deadlines requeue without charging a crash attempt. Other failures
   * record a safe code and retry backoff, retaining previously good data. Database
   * errors during failure recording can still reject instead of returning an outcome.
   * @returns Execution outcome; shape and research are not one atomic publication.
   * @example
   * Let's imagine a helper works through an update list: redraw the district map,
   * then check who represents it. Each completed part can be saved as the helper goes.
   */
  static async execute(job: SyncJob, milliseconds = 180000): Promise<'succeeded' | 'queued' | 'failed'> {
    const signal = AbortSignal.timeout(milliseconds);
    let kind: 'shape' | 'research' = job.shape_requested ? 'shape' : 'research';
    try {
      let row = await BoundaryService.getRow(job.scope_id);
      if (job.shape_requested && row.shape_service && (job.force_sync || isDue(row, 'shape'))) {
        await transaction(async client => {
          await fenced(client, job);
          await client.query('UPDATE boundaries SET last_shape_sync = CURRENT_TIMESTAMP WHERE id = $1', [job.scope_id]);
        });
        const shape = await runShape(row.shape_service, signal);
        signal.throwIfAborted();
        await transaction(async client => {
          await fenced(client, job);
          await client.query('UPDATE boundaries SET shape = $2::jsonb, shape_pending = false, last_shape_success = CURRENT_TIMESTAMP, shape_retry_after = NULL WHERE id = $1', [job.scope_id, JSON.stringify(shape)]);
          await client.query('UPDATE boundary_sync_jobs SET shape_requested = false WHERE id = $1', [job.id]);
          signal.throwIfAborted();
          await fenced(client, job);
        });
        job.shape_requested = false;
      }
      kind = 'research';
      if (job.research_requested) {
        row = await BoundaryService.getRow(job.scope_id);
        const representative = job.target_type === 'representative' ? await RepresentativesService.findById(job.target_id) : undefined;
        const descriptor = representative?.researchService ?? row.research_service;
        const targetRow = representative ? (await pool.query('SELECT * FROM representatives WHERE id = $1', [job.target_id])).rows[0] : row;
        if (descriptor && (job.force_sync || isDue(targetRow, 'research'))) {
          await transaction(async client => {
            await fenced(client, job);
            await client.query(`UPDATE ${representative ? 'representatives' : 'boundaries'} SET last_research_sync = CURRENT_TIMESTAMP WHERE id = $1`, [representative?.id ?? row.id]);
          });
          const result = await runResearch(descriptor, { boundary: boundaryFromRow(row), representative, signal });
          if (!result.authoritative || !result.sourceUrls.length) throw new BoundaryError(502, 'RESEARCH_NO_EVIDENCE', 'Research did not provide authoritative sources.');
          signal.throwIfAborted();
          const applied = await transaction(async client => {
            await fenced(client, job);
            const applied = await saveResearch(client, job, result, descriptor);
            if (applied) await client.query('UPDATE boundary_sync_jobs SET research_requested = false WHERE id = $1', [job.id]);
            signal.throwIfAborted();
            await fenced(client, job);
            return applied;
          });
          if (!applied) throw new BoundaryError(502, 'RESEARCH_NO_EVIDENCE', 'Representative research requires review before updates can be applied.');
          job.research_requested = false;
        }
      }
      await transaction(async client => {
        await fenced(client, job);
        await client.query("UPDATE boundary_sync_jobs SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP, lease_token = NULL, lease_until = NULL WHERE id = $1", [job.id]);
      });
      return 'succeeded';
    } catch (error) {
      if (signal.aborted && milliseconds < 180000) {
        await pool.query("UPDATE boundary_sync_jobs SET status = 'queued', lease_token = NULL, lease_until = NULL, attempts = GREATEST(attempts - 1, 0) WHERE id = $1 AND lease_token = $2 AND status = 'running'", [job.id, job.lease_token]);
        return 'queued';
      }
      const code = error instanceof BoundaryError ? error.code : signal.aborted ? 'SYNC_TIMEOUT' : 'SYNC_FAILED';
      await transaction(async client => {
        const current = await client.query("SELECT id FROM boundary_sync_jobs WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_until > CURRENT_TIMESTAMP FOR UPDATE", [job.id, job.lease_token]);
        if (!current.rows.length) return;
        await client.query("UPDATE boundary_sync_jobs SET status = 'failed', error_code = $2, completed_at = CURRENT_TIMESTAMP, lease_token = NULL, lease_until = NULL WHERE id = $1", [job.id, code]);
        await client.query(`UPDATE ${job.target_type === 'representative' ? 'representatives' : 'boundaries'} SET ${kind}_retry_after = CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE id = $1`, [job.target_id]);
      });
      console.warn(JSON.stringify({ event: 'boundary_sync_failed', jobId: String(job.id), code }));
      return 'failed';
    }
  }
  /** Reads public job progress and sanitized failure code; missing jobs throw NOT_FOUND. */
  static async status(id: string) {
    const { rows } = await pool.query('SELECT id, target_type, target_id, status, created_at, completed_at, error_code FROM boundary_sync_jobs WHERE id = $1', [id]);
    if (!rows[0]) throw new BoundaryError(404, 'NOT_FOUND', 'Sync job not found.');
    const row = rows[0];
    return { jobId: String(row.id), targetType: row.target_type, targetId: row.target_id, status: row.status, createdAt: row.created_at, completedAt: row.completed_at, errorCode: row.error_code };
  }
}

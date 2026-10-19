/**
 * Distributed request reservations, publication receipts, and generation budgets.
 * A publishing reservation is never automatically taken over: the external create
 * may have succeeded even if this process did not receive its response.
 * @module
 */
import { createHash, randomUUID } from 'node:crypto';
import { getFirestoreDb } from '../config/firestore.js';
import { StreetmixError, type StreetmixResult } from '../models/streetmix.js';

/** Evidence and generated data saved before making the external create request. */
export type StreetmixDraft = Omit<StreetmixResult, 'streetmixId' | 'streetmixUrl'>;
/** State transitions belong to one reservation attempt, preventing late writes after expiry. */
export interface StreetmixRecord {
  fingerprint: string;
  attempt: string;
  state: 'reserved' | 'publishing' | 'published' | 'completed' | 'failed';
  expiresAtMs: number;
  leaseUntilMs?: number;
  draft?: StreetmixDraft;
  publication?: { id: string; namespacedId: number };
  result?: StreetmixResult;
}
/** Persistence boundary supports deterministic tests without cloud credentials. */
export interface StreetmixStore {
  reserve(id: string, fingerprint: string, application: string, signal: AbortSignal): Promise<StreetmixRecord>;
  update(id: string, attempt: string, patch: Partial<StreetmixRecord>, signal: AbortSignal): Promise<void>;
  publicationBudget(signal: AbortSignal): Promise<void>;
}

/** Hashes application/key identities; raw credentials never enter persisted documents. */
export const streetmixHash = (value: string): string => createHash('sha256').update(value).digest('hex');

function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new StreetmixError(503, 'STREETMIX_UNAVAILABLE', `Configure ${name} as a positive integer.`);
  return Number(raw);
}

/** Bounds database waits; late commits can reserve quota but cannot trigger publication. */
async function stored<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (signal.aborted) throw new StreetmixError(504, 'GENERATION_TIMEOUT', 'Street generation exceeded its deadline.');
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new StreetmixError(504, 'GENERATION_TIMEOUT', 'Street generation exceeded its deadline.'));
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => reject(new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Street generation storage is unavailable. Retry with the same request key.')), 5000);
    })]);
  } catch (error) {
    if (error instanceof StreetmixError) throw error;
    throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Street generation storage is unavailable. Retry with the same request key.');
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Uses the existing database with logical expiry; Firestore TTL is optional cleanup. */
export class FirestoreStreetmixStore implements StreetmixStore {
  private db() { return getFirestoreDb(); }

  /** Atomically reserves a request and its application minute quota. Completed requests replay. */
  async reserve(id: string, fingerprint: string, application: string, signal: AbortSignal): Promise<StreetmixRecord> {
    const db = this.db(), now = Date.now(), window = Math.floor(now / 60000);
    const request = db.collection('streetmix-requests').doc(id);
    const quota = db.collection('streetmix-quotas').doc(`application-${application}`);
    const maximum = limit('STREETMIX_APP_REQUESTS_PER_MINUTE', 10);
    return stored(db.runTransaction(async transaction => {
      const [snapshot, quotaSnapshot] = await transaction.getAll(request, quota);
      const existing = snapshot.data() as StreetmixRecord | undefined;
      if (existing && (!Number.isSafeInteger(existing.expiresAtMs) || typeof existing.attempt !== 'string'
        || typeof existing.fingerprint !== 'string' || !['reserved', 'publishing', 'published', 'completed', 'failed'].includes(existing.state)
        || existing.state === 'completed' && !existing.result
        || existing.state === 'published' && (!existing.publication || !existing.draft))) {
        throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'The saved request is incomplete. Publication will not be repeated.');
      }
      if (existing && (existing.expiresAtMs > now || ['publishing', 'published'].includes(existing.state))) {
        if (existing.fingerprint !== fingerprint) throw new StreetmixError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used with different coordinates.');
        if (existing.state === 'completed' || existing.state === 'published') return existing;
        if (existing.state === 'publishing') throw new StreetmixError(502, 'PUBLICATION_UNCERTAIN', 'Streetmix publication may have succeeded. This request key will not create another street.');
        if (existing.state !== 'failed' && (existing.leaseUntilMs ?? existing.expiresAtMs) > now) throw new StreetmixError(409, 'REQUEST_IN_PROGRESS', 'This request is already running. Retry with the same key shortly.');
      }
      const data = quotaSnapshot.data();
      const count = data?.window === window ? data.count : 0;
      if (!Number.isSafeInteger(count) || count < 0) throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Street generation quota storage is unavailable.');
      if (count >= maximum) throw new StreetmixError(429, 'STREETMIX_RATE_LIMITED', 'Application generation limit reached. Retry next minute.', 60 - Math.floor(now / 1000) % 60);
      const record: StreetmixRecord = { fingerprint, attempt: randomUUID(), state: 'reserved', expiresAtMs: now + 86400000, leaseUntilMs: now + 90000 };
      transaction.set(request, { ...record, expiresAt: new Date(record.expiresAtMs) });
      transaction.set(quota, { window, count: count + 1, expiresAt: new Date(now + 86400000) });
      return record;
    }, { maxAttempts: 3 }), signal);
  }

  /** Applies a transition only to its owning attempt, protecting against delayed commits. */
  async update(id: string, attempt: string, patch: Partial<StreetmixRecord>, signal: AbortSignal): Promise<void> {
    const db = this.db(), ref = db.collection('streetmix-requests').doc(id);
    await stored(db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.data()?.attempt !== attempt) throw new StreetmixError(409, 'RESERVATION_EXPIRED', 'The request reservation expired.');
      transaction.update(ref, patch);
    }, { maxAttempts: 3 }), signal);
  }

  /** Reserves a UTC-day publication slot before dispatch, including uncertain/failed dispatches. */
  async publicationBudget(signal: AbortSignal): Promise<void> {
    const db = this.db(), now = Date.now(), window = Math.floor(now / 86400000);
    const ref = db.collection('streetmix-quotas').doc('global-publications');
    const maximum = limit('STREETMIX_GLOBAL_PUBLICATIONS_PER_DAY', 100);
    await stored(db.runTransaction(async transaction => {
      const data = (await transaction.get(ref)).data();
      const count = data?.window === window ? data.count : 0;
      if (!Number.isSafeInteger(count) || count < 0) throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Street generation quota storage is unavailable.');
      if (count >= maximum) throw new StreetmixError(429, 'STREETMIX_DAILY_LIMIT', 'Daily Streetmix publication limit reached.', Math.ceil(((window + 1) * 86400000 - now) / 1000));
      transaction.set(ref, { window, count: count + 1, expiresAt: new Date(now + 172800000) });
    }, { maxAttempts: 3 }), signal);
  }
}

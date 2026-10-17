/**
 * Firestore next-step actions and append-only suggestion activity with PostgreSQL contact checks.
 *
 * @remarks
 * Child writes transactionally check parent deletion state. Status changes and their
 * activity entry commit together; expiration affects listing, not persisted status.
 * @module
 */
import { FieldPath, Timestamp } from '@google-cloud/firestore';
import { pool } from '../config/db.js';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { ActionInput, LoggedAction, RecommendedAction, RecommendedActionStatus } from '../models/recommendedAction.js';

const actionsPath = (suggestionId: number) => `suggestion/${suggestionId}/recommendedActions`;
const logPath = (suggestionId: number) => `suggestion/${suggestionId}/log`;
const iso = (value: any): string => value instanceof Timestamp || value?.toDate ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const actionFrom = (data: any, id: string): RecommendedAction => ({ id, summary: data.summary, instructions: data.instructions, representativeId: data.representativeId ?? null, reason: data.reason, expirationDate: data.expirationDate ?? null, status: data.status, creationDate: iso(data.creationDate), modificationDate: iso(data.modificationDate), ...(data.recommendableId ? { recommendableId: data.recommendableId } : {}), ...(typeof data.matchProbability === 'number' ? { matchProbability: data.matchProbability } : {}) });
const logFrom = (data: any, id: string): LoggedAction => ({ id, summary: data.summary, description: data.description, actor: data.actor, timestamp: iso(data.timestamp) });
/** Tests inclusive expiration at an instant without changing lifecycle state; null means no expiry. */
export function isActionExpired(action: Pick<RecommendedAction, 'expirationDate'>, now = Date.now()): boolean {
  return action.expirationDate !== null && Date.parse(action.expirationDate) <= now;
}

/** Coordinates action persistence and history; HTTP authorization and input validation belong to callers. */
export class RecommendedActionService {
  /** Resolves the shared suggestion parent for transactional child-write checks. */
  private static parentRef(id: number) { return getPublicImprovementsDb().collection('suggestion').doc(String(id)); }
  /** Checks an optional PostgreSQL reference before the separate Firestore transaction, not a cross-store lock. */
  private static async assertRepresentative(id: number | null | undefined): Promise<void> {
    if (id == null) return;
    const { rows } = await pool.query('SELECT id FROM representatives WHERE id = $1 LIMIT 1', [id]);
    if (!rows.length) throw Object.assign(new Error('Representative not found.'), { status: 404 });
  }
  /** Rejects absent/deleting parents for reads; mutation transactions recheck the parent independently. */
  private static async assertParent(id: number): Promise<void> {
    const doc = await this.parentRef(id).get();
    if (!doc.exists) throw Object.assign(new Error('Suggestion not found.'), { status: 404 });
    if (doc.get('_deleting') === true) throw Object.assign(new Error('Suggestion is being deleted.'), { status: 409 });
  }
  /** Lists parent actions by document identity, applying status and default expiry hiding in memory. */
  static async list(suggestionId: number, options: { status?: RecommendedActionStatus; includeExpired?: boolean } = {}): Promise<RecommendedAction[]> {
    await this.assertParent(suggestionId);
    const snapshot = await getPublicImprovementsDb().collection(actionsPath(suggestionId)).orderBy(FieldPath.documentId()).get();
    const now = Date.now();
    return snapshot.docs.map((doc) => actionFrom(doc.data(), doc.id)).filter((item) => (!options.status || item.status === options.status) && (options.includeExpired || !isActionExpired(item, now)));
  }
  /** Returns one action even if expired; absent actions return null, while absent parents throw. */
  static async get(suggestionId: number, actionId: string): Promise<RecommendedAction | null> {
    await this.assertParent(suggestionId);
    const doc = await getPublicImprovementsDb().collection(actionsPath(suggestionId)).doc(actionId).get();
    return doc.exists ? actionFrom(doc.data(), doc.id) : null;
  }
  /**
   * Applies defaults and transactionally creates a child, returning an existing supplied identity unchanged.
   * @example
   * Let's imagine adding "Ask about a safer crossing" to a neighborhood suggestion's
   * to-do list. This saves that next step alongside the original idea.
   */
  static async create(suggestionId: number, input: ActionInput, actionId?: string): Promise<RecommendedAction> {
    await this.assertRepresentative(input.representativeId);
    const db = getPublicImprovementsDb(); const parent = this.parentRef(suggestionId); const actionCollection = db.collection(actionsPath(suggestionId)); const ref = actionId ? actionCollection.doc(actionId) : actionCollection.doc();
    const now = new Date().toISOString();
    const data = { summary: input.summary, instructions: input.instructions, representativeId: input.representativeId ?? null, reason: input.reason, expirationDate: input.expirationDate ?? null, status: input.status ?? 'open', creationDate: now, modificationDate: now, ...(input.recommendableId ? { recommendableId: input.recommendableId } : {}), ...(typeof input.matchProbability === 'number' ? { matchProbability: input.matchProbability } : {}) };
    let result: any = data;
    await db.runTransaction(async (tx) => {
      const p = await tx.get(parent); if (!p.exists) throw Object.assign(new Error('Suggestion not found.'), { status: 404 }); if (p.get('_deleting')) throw Object.assign(new Error('Suggestion is being deleted.'), { status: 409 });
      const existing = await tx.get(ref);
      if (existing.exists) { result = existing.data()!; return; }
      tx.create(ref, data);
    });
    return actionFrom(result, ref.id);
  }
  /**
   * Updates a child and appends status-transition activity in the same Firestore transaction.
   * @remarks Repeating status omits that change/log and sets noOp, but other supplied
   * fields can still update. Missing actions return null; parent deletion is a conflict.
   * @example
   * Let's imagine a neighbor starts working on a crossing idea. Marking its next
   * step as started also adds a note to the suggestion's story of progress.
   */
  static async update(suggestionId: number, actionId: string, input: Partial<ActionInput>, actor: { name: string; email: string }): Promise<{ action: RecommendedAction; noOp: boolean } | null> {
    await this.assertRepresentative(input.representativeId);
    const db = getPublicImprovementsDb(); const parent = this.parentRef(suggestionId); const ref = db.collection(actionsPath(suggestionId)).doc(actionId); let result: any = null; let noOp = false;
    await db.runTransaction(async (tx) => {
      const p = await tx.get(parent); if (!p.exists) throw Object.assign(new Error('Suggestion not found.'), { status: 404 }); if (p.get('_deleting')) throw Object.assign(new Error('Suggestion is being deleted.'), { status: 409 });
      const existing = await tx.get(ref); if (!existing.exists) return;
      const old = existing.data()!;
      const statusIsNoOp = input.status !== undefined && input.status === old.status;
      const updates = { ...input };
      if (statusIsNoOp) { delete updates.status; noOp = true; }
      if (Object.keys(updates).length === 0) { result = actionFrom(old, actionId); return; }
      const data = { ...updates, modificationDate: new Date().toISOString() }; tx.update(ref, data);
      if (input.status !== undefined && !statusIsNoOp) {
        const logRef = db.collection(logPath(suggestionId)).doc(); const summary = `Marked '${old.summary}' as ${input.status} (was ${old.status}).`;
        tx.create(logRef, { summary, description: summary, actor, timestamp: new Date().toISOString() });
      }
      result = actionFrom({ ...old, ...data }, actionId);
    });
    return result ? { action: result, noOp } : null;
  }
  /** Removes a child under a parent transaction without deleting historical activity; returns whether it existed. */
  static async delete(suggestionId: number, actionId: string): Promise<boolean> {
    const db = getPublicImprovementsDb(); const parent = this.parentRef(suggestionId); const ref = db.collection(actionsPath(suggestionId)).doc(actionId); let deleted = false;
    await db.runTransaction(async (tx) => { const p = await tx.get(parent); if (!p.exists) throw Object.assign(new Error('Suggestion not found.'), { status: 404 }); if (p.get('_deleting')) throw Object.assign(new Error('Suggestion is being deleted.'), { status: 409 }); const action = await tx.get(ref); if (action.exists) { tx.delete(ref); deleted = true; } });
    return deleted;
  }
  /** Appends server-attributed text after a transactional parent check, with no edit/delete counterpart. */
  static async appendLog(suggestionId: number, entry: { summary: string; description: string }, actor: { name: string; email: string }): Promise<LoggedAction> {
    const db = getPublicImprovementsDb(); const parent = this.parentRef(suggestionId); const ref = db.collection(logPath(suggestionId)).doc(); const at = new Date().toISOString();
    await db.runTransaction(async (tx) => { const p = await tx.get(parent); if (!p.exists) throw Object.assign(new Error('Suggestion not found.'), { status: 404 }); if (p.get('_deleting')) throw Object.assign(new Error('Suggestion is being deleted.'), { status: 409 }); tx.create(ref, { ...entry, actor, timestamp: at }); });
    return { id: ref.id, ...entry, actor, timestamp: at };
  }
  /**
   * Reads newest-first activity using timestamp plus document identity as a stable tie-breaker.
   * @remarks A cursor is a canonical base64url document identity resolved to an existing
   * snapshot. Reads one extra record to determine hasMore; malformed/stale cursors reject.
   */
  static async getLog(suggestionId: number, limit = 50, cursor?: string): Promise<{ data: LoggedAction[]; nextCursor: string | null; hasMore: boolean }> {
    await this.assertParent(suggestionId); const db = getPublicImprovementsDb(); let query: FirebaseFirestore.Query = db.collection(logPath(suggestionId)).orderBy('timestamp', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      if (!decoded || Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw Object.assign(new Error('Invalid log cursor.'), { status: 400 });
      const cursorDoc = await db.collection(logPath(suggestionId)).doc(decoded).get();
      if (!cursorDoc.exists) throw Object.assign(new Error('Invalid log cursor.'), { status: 400 });
      query = query.startAfter(cursorDoc);
    }
    const docs = (await query.limit(limit + 1).get()).docs; const hasMore = docs.length > limit; const page = docs.slice(0, limit);
    return { data: page.map((doc) => logFrom(doc.data(), doc.id)), nextCursor: hasMore && page.length ? Buffer.from(page[page.length - 1].id, 'utf8').toString('base64url') : null, hasMore };
  }
}

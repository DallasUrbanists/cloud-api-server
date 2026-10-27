/**
 * Coordinates idea-owned Streetmix requests with transactional leases and saves.
 * Provider publication remains owned by Streetmix's durable shared cache. This layer
 * protects idea revisions, selection, permissions, and recovery after disconnects.
 * @module
 */
import { randomUUID } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from '@google-cloud/firestore';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { ideaDocumentPath } from '../config/ideas.js';
import type { IdeasContract } from '../routes/ideaRoutes.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { StreetmixError, streetmixPoint, type StreetmixResult } from '../models/streetmix.js';
import { ideaStreetmixETag, ideaStreetmixSummary, type IdeaStreetmix, type IdeaStreetmixRequest as Workflow } from '../models/ideaStreetmix.js';
import { generateStreetmix } from './streetmixService.js';
import { requireTexas } from './streetmixSources.js';
import { streetmixHash } from './streetmixStore.js';

/** Inputs are server-authenticated; coordinates are always loaded from the idea. */
export interface IdeaStreetmixCommand {
  id: string;
  application: string;
  key: string;
  mode: 'initial' | 'regenerate' | 'selection';
  requestId?: string;
  osmWayId?: number;
  ifMatch?: string;
  user?: AuthenticatedUser;
}

/** HTTP-neutral outcome with a public recovery URL and optional revision validator. */
export interface IdeaStreetmixResponse { status: number; etag?: string; body: Record<string, unknown> }

function authorize(data: any, user?: AuthenticatedUser): void {
  if (!user) throw new StreetmixError(401, 'USER_AUTH_REQUIRED', 'Sign in as the idea author or staff to replace its design.');
  if (!user.roles.includes('staff') && !user.emails.some(email => email.toLowerCase() === String(data.author?.email || '').toLowerCase())) throw new StreetmixError(403, 'FORBIDDEN', 'Only the idea author or staff may replace its design.');
}

function available(data: any): void {
  if (!data) throw new StreetmixError(404, 'IDEA_NOT_FOUND', 'Idea not found.');
  if (data._deleting) throw new StreetmixError(409, 'IDEA_DELETING', 'Idea deletion is in progress.');
}

/** Injectable database/provider boundaries support contention and crash-recovery tests. */
export class IdeaStreetmixService {
  constructor(
    private readonly db: Firestore = getPublicImprovementsDb(),
    private readonly generate: typeof generateStreetmix = generateStreetmix,
    private readonly texas: typeof requireTexas = requireTexas,
    private readonly contract: IdeasContract = 'ideas',
  ) {}

  private parent(id: string) {
    const [collection, document] = ideaDocumentPath(id).split('/');
    return this.db.collection(collection).doc(document);
  }

  private async transaction<T>(signal: AbortSignal, work: (tx: Transaction) => Promise<T>): Promise<T> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    let abort: () => void = () => {};
    try {
      deadline.throwIfAborted();
      return await Promise.race([this.db.runTransaction(async tx => {
        deadline.throwIfAborted();
        const fenced = new Proxy(tx, { get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (['set', 'update', 'delete', 'create'].includes(String(property))) deadline.throwIfAborted();
            return value.apply(target, args);
          };
        } });
        return work(fenced);
      }, { maxAttempts: 3 }), new Promise<never>((_, reject) => {
        abort = () => reject(new StreetmixError(signal.aborted ? 504 : 503, signal.aborted ? 'GENERATION_TIMEOUT' : 'STORAGE_UNAVAILABLE', 'Idea workflow storage is unavailable. Retry the same request.'));
        deadline.addEventListener('abort', abort, { once: true });
        if (deadline.aborted) abort();
      })]);
    } finally { deadline.removeEventListener('abort', abort); }
  }

  private response(id: string, request: Workflow, status?: number): IdeaStreetmixResponse {
    const awaiting = request.status === 'awaiting_selection';
    const prefix = this.contract === 'ideas' ? '/api/ideas' : '/api/suggestions';
    return { status: status ?? (awaiting ? 409 : request.status === 'completed' ? 200 : 202),
      ...(request.streetmix ? { etag: ideaStreetmixETag(id, request.streetmix.revision) } : {}),
      body: { requestId: request.requestId, status: request.status, statusUrl: `${prefix}/${id}/streetmix/requests/${request.requestId}`,
        ...(awaiting ? { error: 'STREET_SELECTION_REQUIRED', message: 'Confirm the intended street before publishing.', coordinate: request.coordinate, candidates: request.candidates, selectionExpiresAt: request.selectionExpiresAt } : {}),
        ...(request.result ? { result: request.result } : {}), ...(request.streetmix ? { streetmix: request.streetmix } : {}),
        ...(request.error ? { error: request.error, message: request.message } : {}) } };
  }

  /** Reads the permanent attachment independently of transient receipt lifetime. */
  async read(id: string, signal: AbortSignal): Promise<IdeaStreetmixResponse> {
    return this.transaction(signal, async tx => {
      const parent = this.parent(id), data = (await tx.get(parent)).data();
      available(data);
      const current = (await tx.get(parent.collection('streetmix').doc('current'))).data();
      const active = data!._streetmixActive ? (await tx.get(parent.collection('streetmixRequests').doc(data!._streetmixActive))).data() as Workflow | undefined : undefined;
      return { status: 200, etag: ideaStreetmixETag(id, data!.streetmix?.revision || 0), body: {
        streetmix: ideaStreetmixSummary(data!.streetmix, data!.location), result: current?.result ?? null,
        activeRequest: active ? this.response(id, this.withExpiry(active)).body : null,
      } };
    });
  }

  /** Public recovery reads never trigger provider calls or publication. */
  async readRequest(id: string, requestId: string, signal: AbortSignal): Promise<IdeaStreetmixResponse> {
    return this.transaction(signal, async tx => {
      const parent = this.parent(id), data = (await tx.get(parent)).data();
      available(data);
      const workflow = (await tx.get(parent.collection('streetmixRequests').doc(requestId))).data() as Workflow | undefined;
      if (!workflow || workflow.expiresAtMs && workflow.expiresAtMs <= Date.now()) throw new StreetmixError(404, 'REQUEST_NOT_FOUND', 'Request not found or receipt expired. Read the current attachment.');
      return this.response(id, { ...this.withExpiry(workflow), ...(workflow.streetmix ? { streetmix: ideaStreetmixSummary(workflow.streetmix, data!.location)! } : {}) }, 200);
    });
  }

  private withExpiry(workflow: Workflow): Workflow {
    return workflow.status === 'awaiting_selection' && Date.parse(workflow.selectionExpiresAt!) <= Date.now()
      ? { ...workflow, status: 'expired', error: 'SELECTION_EXPIRED', message: 'Road selection expired. Start a new request.' } : workflow;
  }

  private validate(data: any, workflow: Workflow, user?: AuthenticatedUser): void {
    available(data);
    if (data.location?.latitude !== workflow.coordinate.latitude || data.location?.longitude !== workflow.coordinate.longitude || (data.streetmix?.revision || 0) !== workflow.expectedRevision) throw new StreetmixError(409, 'IDEA_CHANGED', 'Idea location or attachment changed. Start again from the current idea.');
    if (workflow.mode === 'regenerate') authorize(data, user);
  }

  /** Claims one workflow or joins existing work; only its fenced owner invokes providers. */
  async run(command: IdeaStreetmixCommand, signal: AbortSignal): Promise<IdeaStreetmixResponse> {
    const parent = this.parent(command.id), application = streetmixHash(command.application);
    const phase = command.mode === 'selection' ? `selection:${command.requestId}` : command.mode;
    const keyRef = parent.collection('streetmixRequestKeys').doc(streetmixHash(`${application}:${phase}:${command.key}`));
    const fingerprint = streetmixHash(JSON.stringify({ phase, osmWayId: command.osmWayId ?? null, ifMatch: command.ifMatch ?? null }));
    const claim = await this.transaction<{ owner: boolean; workflow?: Workflow; existing?: boolean }>(signal, async tx => {
      const data = (await tx.get(parent)).data(); available(data);
      const mapping = (await tx.get(keyRef)).data();
      const replay = mapping && (!mapping.expiresAtMs || mapping.expiresAtMs > Date.now());
      if (replay && mapping.fingerprint !== fingerprint) throw new StreetmixError(409, 'IDEMPOTENCY_CONFLICT', 'This key was used for a different operation.');
      const requestId = replay ? mapping.requestId : command.requestId || data!._streetmixActive;
      let workflow = requestId ? (await tx.get(parent.collection('streetmixRequests').doc(requestId))).data() as Workflow | undefined : undefined;
      if (replay && (!workflow || workflow.expiresAtMs && workflow.expiresAtMs <= Date.now())) throw new StreetmixError(409, 'REQUEST_EXPIRED', 'Request receipt expired. Read the attachment before starting again.');
      const join = () => {
        tx.set(keyRef, { requestId: workflow!.requestId, fingerprint });
        return { owner: false, workflow };
      };
      if (command.mode === 'regenerate') {
        authorize(data, command.user);
        if (!data!.streetmix) throw new StreetmixError(409, 'ATTACHMENT_REQUIRED', 'Generate the first attachment before regenerating.');
        if (!command.ifMatch) throw new StreetmixError(428, 'PRECONDITION_REQUIRED', 'Supply the current attachment ETag in If-Match.');
        // A completed same-key retry replays its receipt even though its old ETag was consumed.
        if (!(replay && workflow?.status === 'completed') && command.ifMatch !== ideaStreetmixETag(command.id, data!.streetmix.revision)) throw new StreetmixError(412, 'PRECONDITION_FAILED', 'Attachment revision changed. Read it again.');
      }
      if (command.mode === 'selection') {
        if (!workflow || workflow.requestId !== command.requestId) throw new StreetmixError(404, 'REQUEST_NOT_FOUND', 'Request not found.');
        if (workflow.mode === 'regenerate') authorize(data, command.user);
      }
      if (replay && workflow?.status === 'completed') return { owner: false, workflow };
      if (command.mode === 'initial' && data!.streetmix) return { owner: false, existing: true };
      if (workflow) workflow = this.withExpiry(workflow);
      // New callers join the active workflow; an expired selection may be replaced.
      if (!replay && command.mode !== 'selection' && workflow && !['expired', 'failed'].includes(workflow.status)) return join();
      if (command.mode === 'selection') {
        if (workflow!.osmWayId !== undefined && workflow!.osmWayId !== command.osmWayId) throw new StreetmixError(409, 'SELECTION_CONFLICT', 'This request already confirmed another street.');
        if (workflow!.status === 'expired') throw new StreetmixError(409, 'SELECTION_EXPIRED', 'Road selection expired. Start a new request.');
        if (!workflow!.candidates?.some(candidate => candidate.osmWayId === command.osmWayId)) throw new StreetmixError(422, 'INVALID_STREET_SELECTION', 'Choose a candidate offered by this request.');
      }
      if (workflow && (replay || command.mode === 'selection')) {
        this.validate(data, workflow, command.user);
        if (data!._streetmixActive && data!._streetmixActive !== workflow.requestId) throw new StreetmixError(409, 'REQUEST_SUPERSEDED', 'Another workflow is active.');
        if (workflow.status === 'expired') throw new StreetmixError(409, 'SELECTION_EXPIRED', 'Road selection expired. Start a new request.');
        if (workflow.status === 'awaiting_selection' && command.mode !== 'selection') return join();
        if (workflow.leaseUntil > Date.now() && ['generating', 'publishing', 'publication_uncertain', 'save_pending'].includes(workflow.status)) return join();
      } else {
        const coordinate = streetmixPoint({ latitude: data!.location?.latitude, longitude: data!.location?.longitude });
        workflow = { requestId: randomUUID(), application, providerNamespace: 'idea', mode: command.mode === 'regenerate' ? 'regenerate' : 'initial', status: 'generating', coordinate, expectedRevision: data!.streetmix?.revision || 0, createdAt: new Date().toISOString(), attempt: '', leaseUntil: 0,
          ...(command.mode === 'regenerate' ? { refreshScope: randomUUID() } : {}) };
      }
      // A replay retains its original provider identity, scope, and confirmed way.
      workflow = { ...workflow!, status: workflow!.result ? 'save_pending' : ['publishing', 'publication_uncertain'].includes(workflow!.status) ? 'publication_uncertain' : 'generating', attempt: randomUUID(), leaseUntil: Date.now() + 90000,
        ...(command.mode === 'selection' ? { osmWayId: command.osmWayId } : {}) };
      delete workflow.error;
      delete workflow.message;
      delete workflow.expiresAtMs;
      delete workflow.expiresAt;
      signal.throwIfAborted();
      tx.set(parent.collection('streetmixRequests').doc(workflow.requestId), workflow);
      tx.set(keyRef, { requestId: workflow.requestId, fingerprint });
      tx.update(parent, { _streetmixActive: workflow.requestId });
      return { owner: true, workflow };
    });
    if (claim.existing) {
      const saved = await this.read(command.id, signal);
      return { ...saved, body: { ...saved.body, requestId: (saved.body.streetmix as IdeaStreetmix).requestId, status: 'completed' } };
    }
    let workflow = claim.workflow!;
    if (!claim.owner) return this.response(command.id, workflow);
    const ref = parent.collection('streetmixRequests').doc(workflow.requestId);
    const patch = async (changes: Partial<Workflow>, check = false) => this.transaction(AbortSignal.timeout(5000), async tx => {
      const current = (await tx.get(ref)).data() as Workflow | undefined;
      const data = (await tx.get(parent)).data();
      if (!current || current.attempt !== workflow.attempt || data?._streetmixActive !== workflow.requestId) throw new StreetmixError(409, 'RESERVATION_EXPIRED', 'Another execution owns this workflow.');
      if (check) { signal.throwIfAborted(); this.validate(data, workflow, command.user); }
      tx.update(ref, changes);
      if (changes.status === 'failed') tx.update(parent, { _streetmixActive: FieldValue.delete() });
      workflow = { ...workflow, ...changes };
    });
    try {
      if (!workflow.result) {
        await this.texas(workflow.coordinate, signal);
        const result = await this.generate({ ...workflow.coordinate, ...(workflow.osmWayId ? { osmWayId: workflow.osmWayId } : {}) },
          `${workflow.providerNamespace ?? 'suggestion'}-${workflow.requestId}-${workflow.osmWayId || 'auto'}`, workflow.application, signal, undefined,
          { refreshScope: workflow.refreshScope, beforePublish: () => patch({ status: 'publishing' }, true) });
        // Keep the verified result before the attachment transaction, even after disconnect.
        await patch({ status: 'save_pending', result, leaseUntil: 0 });
      }
      await this.transaction(AbortSignal.timeout(5000), async tx => {
        const data = (await tx.get(parent)).data();
        const current = (await tx.get(ref)).data() as Workflow | undefined;
        this.validate(data, workflow, command.user);
        if (current?.attempt !== workflow.attempt || data!._streetmixActive !== workflow.requestId) throw new StreetmixError(409, 'RESERVATION_EXPIRED', 'Another execution owns this workflow.');
        const result = workflow.result!, savedAt = new Date().toISOString();
        const streetmix: IdeaStreetmix = { streetmixId: result.streetmixId, streetmixUrl: result.streetmixUrl, selectedStreet: result.selectedStreet, coordinate: workflow.coordinate, snappedCoordinate: result.snappedCoordinate,
          ...(result.dividedRoad ? { dividedRoad: result.dividedRoad } : {}), generatedAt: result.generatedAt, savedAt, requestId: workflow.requestId, revision: workflow.expectedRevision + 1, stale: false };
        tx.set(parent.collection('streetmix').doc('current'), { result });
        tx.update(parent, { streetmix, _streetmixActive: FieldValue.delete() });
        const expiresAtMs = Date.now() + 86400000;
        tx.update(ref, { status: 'completed', streetmix, expiresAtMs, expiresAt: new Date(expiresAtMs), leaseUntil: 0 });
        tx.set(keyRef, { requestId: workflow.requestId, fingerprint, expiresAtMs, expiresAt: new Date(expiresAtMs) });
        workflow = { ...workflow, status: 'completed', streetmix };
      });
      return this.response(command.id, workflow, workflow.mode === 'initial' ? 201 : 200);
    } catch (error) {
      const safe = error instanceof StreetmixError ? error : new StreetmixError(signal.aborted ? 504 : 503, signal.aborted ? 'GENERATION_TIMEOUT' : 'STORAGE_UNAVAILABLE', 'Generation could not finish. Retry the same request.');
      if (safe.code === 'STREET_SELECTION_REQUIRED' && safe.details) {
        await patch({ status: 'awaiting_selection', candidates: safe.details.candidates, selectionExpiresAt: new Date(Date.now() + 900000).toISOString(), leaseUntil: 0 });
        return this.response(command.id, workflow);
      }
      const uncertain = workflow.status === 'publishing' || workflow.status === 'publication_uncertain' || safe.code === 'PUBLICATION_UNCERTAIN';
      const invalidated = ['IDEA_CHANGED', 'IDEA_DELETING', 'IDEA_NOT_FOUND', 'FORBIDDEN', 'RESERVATION_EXPIRED'].includes(safe.code);
      const status = workflow.result ? invalidated ? 'failed' : 'save_pending' : uncertain ? 'publication_uncertain' : 'failed';
      const expiresAtMs = Date.now() + 86400000;
      await patch({ status, error: safe.code, message: safe.message, leaseUntil: 0, ...(status === 'failed' ? { expiresAtMs, expiresAt: new Date(expiresAtMs) } : {}) }).catch(() => {});
      if (workflow.result && !invalidated) return this.response(command.id, workflow);
      throw Object.assign(safe, { workflowResponse: this.response(command.id, workflow).body });
    }
  }
}

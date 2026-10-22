/** Durable protocol v1 lifecycle and state operations for TV presentations. */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { SuggestionService } from './suggestionService.js';
import {
  effectiveCaptionVisible, initialPresentationState, normalizeCode, normalizeStateForIdea,
  PresentationError, PRESENTATION_PROTOCOL_VERSION, publicPresentationIdea, validateUuid,
  validateWritableState, type PresentationIdea, type PresentationRole, type PresentationState,
} from '../models/presentation.js';
import { presentationPaths, type PresentationStore, type StoredDocument } from './presentationStore.js';
import type { Suggestion } from '../models/suggestion.js';

const TEN_MINUTES = 10 * 60_000;
const FOUR_HOURS = 4 * 60 * 60_000;
const PRESENCE_WRITE_INTERVAL = 15_000;
const PRESENCE_CONNECTED_WINDOW = 45_000;
const CONTENT_REFRESH_INTERVAL = 5_000;

export interface EnrollmentRequest {
  protocolVersion: number;
  participantId: string;
  participantToken: string;
  code?: string;
}
export interface PresentationParticipantContext {
  sessionId: string;
  participantId: string;
  role: PresentationRole;
  session: Record<string, any>;
  participant: Record<string, any>;
}
export interface PresentationServiceOptions {
  now?: () => number;
  uuid?: () => string;
  code?: () => string;
  getSuggestion?: (id: number) => Promise<Suggestion | null>;
  getSuggestionPage?: (afterId: string | null, limit: number) => Promise<{ items: Suggestion[]; nextCursor: string | null }>;
}
export interface PresenceReport {
  localView?: 'map' | 'photo' | 'description';
  appliedRevision?: number;
  viewport?: { width: number; height: number };
  renderStatus?: 'loading' | 'ready' | 'error';
  renderError?: string | null;
}
export interface SyncRequest {
  protocolVersion: number;
  lastRevision: number;
  lastContentVersion: string | null;
  presence?: PresenceReport;
}
export interface PresentationWatchSnapshot { session: Record<string, any> | undefined; participants: StoredDocument[]; }
export interface PresentationWatchCallbacks {
  change(snapshot: PresentationWatchSnapshot): void;
  error(error: unknown): void;
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function tokenDigest(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').length !== 32) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
  return sha(value);
}
function equalDigest(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || !/^[a-f0-9]{64}$/.test(left)) return false;
  const a = Buffer.from(left, 'hex'), b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function formatCode(code: string): string { return code; }
function codeHash(purpose: 'presenter' | 'audience', code: string): string { return sha(`${purpose}:${code}`); }
function stateOnly(session: Record<string, any>): PresentationState { return structuredClone(session.state) as PresentationState; }
function iso(ms: number): string { return new Date(ms).toISOString(); }
function fingerprint(operation: string, participantId: string, digest: string, payload: unknown): string {
  return sha(JSON.stringify({ operation, participantId, digest, payload }));
}
function normalizedSuggestionId(id: unknown): string | null { return typeof id === 'string' && /^[1-9]\d*$/.test(id) ? id : null; }

export class PresentationService {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly code: () => string;
  private readonly getSuggestion: (id: number) => Promise<Suggestion | null>;
  private readonly getSuggestionPage: (afterId: string | null, limit: number) => Promise<{ items: Suggestion[]; nextCursor: string | null }>;

  constructor(private readonly store: PresentationStore, options: PresentationServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.code = options.code ?? (() => String(randomInt(0, 100_000)).padStart(5, '0'));
    this.getSuggestion = options.getSuggestion ?? (id => SuggestionService.getForPresentation(id));
    this.getSuggestionPage = options.getSuggestionPage ?? ((afterId, limit) => SuggestionService.getPresentationPage(afterId, limit));
  }

  /** Enforces a durable fixed-window admission limit shared by all Cloud Run instances. */
  async enforceAdmissionLimit(scope: 'create' | 'pair' | 'audience', identity: string): Promise<void> {
    const max = scope === 'create' ? 5 : 10;
    const now = this.now(), bucket = Math.floor(now / 60_000), hash = sha(identity || 'unknown');
    const path = presentationPaths.rateLimit(scope, hash, bucket);
    await this.store.runTransaction(async tx => {
      const doc = await tx.get(path);
      const count = Number(doc?.count ?? 0);
      if (count >= max) throw new PresentationError(429, 'RATE_LIMITED', 'Too many presentation requests. Wait and try again.', undefined, Math.max(1, Math.ceil(((bucket + 1) * 60_000 - now) / 1000)));
      const expiresAtMs = (bucket + 2) * 60_000;
      tx.set(path, { count: count + 1, expiresAtMs, expiresAt: new Date(expiresAtMs) });
    });
  }

  private validateEnrollment(body: EnrollmentRequest, operation: string): { participantId: string; digest: string; key: string; keyHash: string; fingerprint: string } {
    if (!body || body.protocolVersion !== PRESENTATION_PROTOCOL_VERSION) throw new PresentationError(426, 'PROTOCOL_UNSUPPORTED', 'This presentation protocol version is not supported.');
    const participantId = validateUuid(body.participantId, 'participantId');
    const digest = tokenDigest(body.participantToken);
    const key = validateUuid((body as any).idempotencyKey, 'Idempotency-Key');
    const keyHash = sha(key);
    const payload = operation === 'pair' || operation === 'audience' ? normalizeCode(body.code) : null;
    return { participantId, digest, key, keyHash, fingerprint: fingerprint(operation, participantId, digest, payload) };
  }

  private enrollmentBody(body: EnrollmentRequest, keyHeader: string | undefined, operation: string): EnrollmentRequest {
    return { ...body, idempotencyKey: keyHeader } as EnrollmentRequest;
  }

  private sessionStatus(session: Record<string, any>, now = this.now()): 'waiting' | 'active' | 'ended' | 'expired' {
    if (session.status === 'ended') return 'ended';
    if (session.status === 'expired' || session.expiresAtMs <= now) return 'expired';
    return session.pairedAtMs ? 'active' : 'waiting';
  }

  private checkSession(session: Record<string, any>, now = this.now()): void {
    const status = this.sessionStatus(session, now);
    if (status === 'ended') throw new PresentationError(410, 'SESSION_ENDED', 'This presentation has ended.');
    if (status === 'expired') throw new PresentationError(410, 'SESSION_EXPIRED', 'This presentation has expired.');
  }

  private async readSession(sessionId: string): Promise<Record<string, any>> {
    const session = await this.store.get(presentationPaths.session(sessionId));
    if (!session) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
    if (session.expiresAtMs <= this.now() && session.status !== 'ended' && session.status !== 'expired') {
      await this.store.runTransaction(async tx => {
        const current = await tx.get(presentationPaths.session(sessionId));
        if (current && current.expiresAtMs <= this.now() && current.status !== 'ended') tx.update(presentationPaths.session(sessionId), { status: 'expired', expiredAtMs: this.now() });
      });
      session.status = 'expired';
    }
    this.checkSession(session);
    return session;
  }

  async createSession(body: EnrollmentRequest, idempotencyKey: string | undefined, ip: string): Promise<{ status: number; body: Record<string, any> }> {
    await this.enforceAdmissionLimit('create', ip);
    const validated = this.validateEnrollment(this.enrollmentBody(body, idempotencyKey, 'create'), 'create');
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = this.now(), sessionId = validateUuid(this.uuid(), 'sessionId');
      const presenterCode = this.code(), audienceCode = this.code();
      if (presenterCode === audienceCode) continue;
      const presenterHash = codeHash('presenter', presenterCode), audienceHash = codeHash('audience', audienceCode);
      const expiresAtMs = now + TEN_MINUTES;
      const participantPath = presentationPaths.participant(sessionId, validated.participantId);
      const sessionPath = presentationPaths.session(sessionId);
      const presenterLookupPath = presentationPaths.codeLookup('presenter', presenterHash);
      const audienceLookupPath = presentationPaths.codeLookup('audience', audienceHash);
      const receiptPath = presentationPaths.bootstrapReceipt(validated.keyHash);
      const response = {
        protocolVersion: 1, sessionId, participantId: validated.participantId, role: 'receiver',
        expiresAt: iso(expiresAtMs), state: initialPresentationState(), presenterCode: formatCode(presenterCode),
        presenterCodeExpiresAt: iso(expiresAtMs), audienceCode: formatCode(audienceCode),
      };
      try {
        const result = await this.store.runTransaction(async tx => {
          const existingReceipt = await tx.get(receiptPath);
          if (existingReceipt) {
            if (existingReceipt.operation !== 'create' || existingReceipt.fingerprint !== validated.fingerprint) throw new PresentationError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
            const existingSession = await tx.get(presentationPaths.session(existingReceipt.sessionId));
            if (!existingSession || existingSession.expiresAtMs <= now || existingSession.status === 'expired') throw new PresentationError(410, 'SESSION_EXPIRED', 'This presentation has expired.');
            if (existingSession.status === 'ended') throw new PresentationError(410, 'SESSION_ENDED', 'This presentation has ended.');
            if (existingReceipt.revoked) throw new PresentationError(410, 'PAIRING_EXPIRED', 'This presenter pairing code has expired.');
            return { status: 200, body: existingReceipt.response };
          }
          const [existingSession, presenterLookup, audienceLookup] = await Promise.all([
            tx.get(sessionPath), tx.get(presenterLookupPath), tx.get(audienceLookupPath),
          ]);
          if (existingSession || presenterLookup || audienceLookup) throw new Error('PRESENTATION_CODE_COLLISION');
          tx.set(sessionPath, {
            id: sessionId, status: 'waiting', createdAtMs: now, expiresAtMs, expiresAt: new Date(expiresAtMs), revision: 0,
            state: initialPresentationState(), contentSnapshot: null, contentVersion: null,
            presenterCode, presenterCodeExpiresAtMs: expiresAtMs, audienceCode,
            controllerId: null, receiverId: validated.participantId, pairedAtMs: null, terminalUntilMs: expiresAtMs, createReceiptPath: receiptPath,
            receiverStatus: null, contentLastCheckedAtMs: 0, contentRefreshUntilMs: 0,
          });
          tx.set(participantPath, { id: validated.participantId, role: 'receiver', tokenDigest: validated.digest, revoked: false, createdAtMs: now, lastSeenAtMs: now, displayName: null, expiresAtMs, expiresAt: new Date(expiresAtMs) });
          tx.set(presenterLookupPath, { sessionId, purpose: 'presenter', status: 'open', expiresAtMs, expiresAt: new Date(expiresAtMs) });
          tx.set(audienceLookupPath, { sessionId, purpose: 'audience', status: 'open', expiresAtMs, expiresAt: new Date(expiresAtMs) });
          tx.set(receiptPath, { operation: 'create', fingerprint: validated.fingerprint, sessionId, participantId: validated.participantId, response, createdAtMs: now, expiresAtMs, expiresAt: new Date(expiresAtMs) });
          return { status: 201, body: response };
        });
        return result;
      } catch (error) { if (error instanceof Error && error.message === 'PRESENTATION_CODE_COLLISION') continue; throw error; }
    }
    throw new PresentationError(503, 'PRESENTATION_UNAVAILABLE', 'Presentation sessions are temporarily unavailable.');
  }

  async pair(body: EnrollmentRequest, idempotencyKey: string | undefined, ip: string): Promise<{ status: number; body: Record<string, any> }> {
    await this.enforceAdmissionLimit('pair', ip);
    const normalized = normalizeCode(body?.code);
    const validated = this.validateEnrollment(this.enrollmentBody({ ...body, code: normalized }, idempotencyKey, 'pair'), 'pair');
    const lookupPath = presentationPaths.codeLookup('presenter', codeHash('presenter', normalized));
    const receiptPath = presentationPaths.bootstrapReceipt(validated.keyHash);
    const now = this.now();
    const result = await this.store.runTransaction(async tx => {
      const existingReceipt = await tx.get(receiptPath);
      if (existingReceipt) {
        if (existingReceipt.operation !== 'pair' || existingReceipt.fingerprint !== validated.fingerprint) throw new PresentationError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
        const session = await tx.get(presentationPaths.session(existingReceipt.sessionId));
        if (!session || session.expiresAtMs <= now || session.status === 'expired') throw new PresentationError(410, 'SESSION_EXPIRED', 'This presentation has expired.');
        if (session.status === 'ended') throw new PresentationError(410, 'SESSION_ENDED', 'This presentation has ended.');
        if (existingReceipt.revoked) throw new PresentationError(410, 'PAIRING_EXPIRED', 'This presenter pairing code has expired.');
        return { status: 200, body: existingReceipt.response };
      }
      const lookup = await tx.get(lookupPath);
      if (!lookup || lookup.expiresAtMs <= now) throw new PresentationError(410, 'PAIRING_EXPIRED', 'This presenter pairing code has expired.');
      if (lookup.status === 'revoked') throw new PresentationError(410, 'PAIRING_EXPIRED', 'This presenter pairing code has expired.');
      if (lookup.status !== 'open') throw new PresentationError(409, 'PAIRING_CLAIMED', 'Someone else has already claimed presenter control.');
      const sessionPath = presentationPaths.session(lookup.sessionId);
      const participantPath = presentationPaths.participant(lookup.sessionId, validated.participantId);
      const [session, existingParticipant] = await Promise.all([tx.get(sessionPath), tx.get(participantPath)]);
        if (!session || session.expiresAtMs <= now || session.status === 'expired') throw new PresentationError(410, 'SESSION_EXPIRED', 'This presentation has expired.');
      if (session.status === 'ended') throw new PresentationError(410, 'SESSION_ENDED', 'This presentation has ended.');
      if (session.controllerId) throw new PresentationError(409, 'PAIRING_CLAIMED', 'Someone else has already claimed presenter control.');
      if (existingParticipant) throw new PresentationError(409, 'IDEMPOTENCY_CONFLICT', 'This participant is already enrolled in the presentation.');
      const firstPairing = !session.pairedAtMs;
      const expiresAtMs = firstPairing ? now + FOUR_HOURS : session.expiresAtMs;
      const [receiver, createReceipt] = await Promise.all([
        firstPairing && session.receiverId ? tx.get(presentationPaths.participant(lookup.sessionId, session.receiverId)) : Promise.resolve(undefined),
        firstPairing && session.createReceiptPath ? tx.get(session.createReceiptPath) : Promise.resolve(undefined),
      ]);
      const content = session.contentSnapshot as PresentationIdea | null;
      const response: Record<string, any> = {
        protocolVersion: 1, sessionId: lookup.sessionId, participantId: validated.participantId,
        role: 'controller', expiresAt: iso(expiresAtMs), state: stateOnly(session),
        audienceCode: formatCode(session.audienceCode), content,
      };
      tx.update(sessionPath, { status: 'active', pairedAtMs: session.pairedAtMs ?? now, expiresAtMs, expiresAt: new Date(expiresAtMs), terminalUntilMs: expiresAtMs, controllerId: validated.participantId, pairingReceiptPath: receiptPath });
      tx.update(lookupPath, { status: 'claimed', claimedAtMs: now, claimedBy: validated.participantId });
      tx.set(participantPath, { id: validated.participantId, role: 'controller', tokenDigest: validated.digest, revoked: false, createdAtMs: now, lastSeenAtMs: now, displayName: 'Presenter', enrollmentReceiptPath: receiptPath, expiresAtMs, expiresAt: new Date(expiresAtMs) });
      if (receiver) tx.update(presentationPaths.participant(lookup.sessionId, session.receiverId), { expiresAtMs, expiresAt: new Date(expiresAtMs) });
      if (createReceipt) tx.update(session.createReceiptPath, { expiresAtMs, expiresAt: new Date(expiresAtMs) });
      tx.set(receiptPath, { operation: 'pair', fingerprint: validated.fingerprint, sessionId: lookup.sessionId, participantId: validated.participantId, response, createdAtMs: now, expiresAtMs, expiresAt: new Date(expiresAtMs) });
      return { status: 200, body: response };
    });
    return result;
  }

  async joinAudience(body: EnrollmentRequest, idempotencyKey: string | undefined, ip: string): Promise<{ status: number; body: Record<string, any> }> {
    await this.enforceAdmissionLimit('audience', ip);
    const normalized = normalizeCode(body?.code);
    const validated = this.validateEnrollment(this.enrollmentBody({ ...body, code: normalized }, idempotencyKey, 'audience'), 'audience');
    const lookupPath = presentationPaths.codeLookup('audience', codeHash('audience', normalized));
    const receiptPath = presentationPaths.bootstrapReceipt(validated.keyHash);
    const now = this.now();
    const result = await this.store.runTransaction(async tx => {
      const existingReceipt = await tx.get(receiptPath);
      if (existingReceipt) {
        if (existingReceipt.operation !== 'audience' || existingReceipt.fingerprint !== validated.fingerprint) throw new PresentationError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
        const session = await tx.get(presentationPaths.session(existingReceipt.sessionId));
        if (!session || session.expiresAtMs <= now || session.status === 'expired') throw new PresentationError(410, 'SESSION_EXPIRED', 'This presentation has expired.');
        if (session.status === 'ended') throw new PresentationError(410, 'SESSION_ENDED', 'This presentation has ended.');
        if (existingReceipt.revoked) throw new PresentationError(410, 'SESSION_ENDED', 'This audience enrollment has ended.');
        return { status: 200, body: existingReceipt.response };
      }
      const lookup = await tx.get(lookupPath);
      if (!lookup || lookup.status !== 'open' || lookup.expiresAtMs <= now) throw new PresentationError(410, 'SESSION_EXPIRED', 'This audience link has expired.');
      const sessionPath = presentationPaths.session(lookup.sessionId), participantPath = presentationPaths.participant(lookup.sessionId, validated.participantId);
      const [session, existingParticipant] = await Promise.all([tx.get(sessionPath), tx.get(participantPath)]);
      if (!session || session.expiresAtMs <= now || session.status === 'expired') throw new PresentationError(410, 'SESSION_EXPIRED', 'This presentation has expired.');
      if (session.status === 'ended') throw new PresentationError(410, 'SESSION_ENDED', 'This presentation has ended.');
      if (existingParticipant) throw new PresentationError(409, 'IDEMPOTENCY_CONFLICT', 'This participant is already enrolled in the presentation.');
      const suffix = this.code().slice(0, 4);
      const displayName = `Viewer ${suffix}`;
      const response = {
        protocolVersion: 1, sessionId: lookup.sessionId, participantId: validated.participantId,
        role: 'audience', displayName, expiresAt: iso(session.expiresAtMs), state: stateOnly(session), content: session.contentSnapshot ?? null,
      };
      tx.set(participantPath, { id: validated.participantId, role: 'audience', tokenDigest: validated.digest, revoked: false, createdAtMs: now, lastSeenAtMs: now, displayName, localView: null, enrollmentReceiptPath: receiptPath, expiresAtMs: session.expiresAtMs, expiresAt: new Date(session.expiresAtMs) });
      tx.set(receiptPath, { operation: 'audience', fingerprint: validated.fingerprint, sessionId: lookup.sessionId, participantId: validated.participantId, response, createdAtMs: now, expiresAtMs: session.expiresAtMs, expiresAt: new Date(session.expiresAtMs) });
      return { status: 200, body: response };
    });
    return result;
  }

  async authorize(sessionId: string, participantIdInput: string | undefined, tokenInput: string | undefined): Promise<PresentationParticipantContext> {
    const participantId = validateUuid(participantIdInput, 'X-Presentation-Participant');
    if (!tokenInput) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'A presentation participant token is required.');
    const digest = tokenDigest(tokenInput);
    const [session, participant] = await Promise.all([
      this.store.get(presentationPaths.session(sessionId)),
      this.store.get(presentationPaths.participant(sessionId, participantId)),
    ]);
    if (!session || !participant || participant.revoked || !equalDigest(participant.tokenDigest, digest)) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
    this.checkSession(session);
    if (participant.role === 'controller' && session.controllerId !== participantId) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
    return { sessionId, participantId, role: participant.role, session, participant };
  }

  /** Watches one session and its participant collection; callers should share this per session. */
  watchSessionSources(sessionId: string, callbacks: PresentationWatchCallbacks): () => void {
    if (!this.store.watchDocument || !this.store.watchCollection) throw new Error('Presentation store does not support durable watches.');
    let active = true, started = false, sessionReady = false, participantsReady = false;
    let session: Record<string, any> | undefined;
    let participants: StoredDocument[] = [];
    let stopSession: (() => void) | undefined, stopParticipants: (() => void) | undefined;
    const emit = () => {
      if (active && started && sessionReady && participantsReady) callbacks.change({ session, participants });
    };
    const fail = (error: unknown) => {
      if (!active) return;
      active = false;
      stopSession?.(); stopParticipants?.();
      callbacks.error(error);
    };
    const install = (watch: () => () => void, assign: (stop: () => void) => void) => {
      const stop = watch();
      if (active) assign(stop); else stop();
    };
    install(() => this.store.watchDocument!(presentationPaths.session(sessionId), value => {
      session = value; sessionReady = true; emit();
    }, fail), stop => { stopSession = stop; });
    install(() => this.store.watchCollection!(presentationPaths.participantCollection(sessionId), value => {
      participants = value; participantsReady = true; emit();
    }, fail), stop => { stopParticipants = stop; });
    started = true;
    emit();
    return () => {
      if (!active) return;
      active = false;
      stopSession?.(); stopParticipants?.();
    };
  }

  /** Produces a full socket envelope after fresh capability authorization and existing content maintenance. */
  async socketSnapshot(sessionId: string, participantId: string, participantToken: string): Promise<Record<string, any>> {
    await this.authorize(sessionId, participantId, participantToken);
    await this.maybeRefreshContent(sessionId);
    const context = await this.authorize(sessionId, participantId, participantToken);
    const roster = context.role === 'controller' ? await this.store.list(presentationPaths.participantCollection(sessionId)) : [];
    const envelope = this.envelopeFromRecord(context.session, context.role, roster, this.now());
    if (context.session.state?.selectedIdeaId == null) envelope.content = null;
    return envelope;
  }

  /** Runs the same five-second selected-content refresh and an idle absolute-expiry check used by REST traffic. */
  async maintainSocketSession(sessionId: string): Promise<void> {
    await this.expireSocketSession(sessionId);
    await this.refreshSocketContent(sessionId);
  }

  /** Expires a room only when its absolute deadline has arrived; it never extends the deadline. */
  async expireSocketSession(sessionId: string): Promise<void> {
    const now = this.now();
    await this.store.runTransaction(async tx => {
      const path = presentationPaths.session(sessionId), session = await tx.get(path);
      if (session && session.expiresAtMs <= now && session.status !== 'ended' && session.status !== 'expired') {
        tx.update(path, { status: 'expired', expiredAtMs: now });
      }
    });
  }

  /** Refreshes selected public content through the existing cross-instance lease. */
  async refreshSocketContent(sessionId: string): Promise<void> {
    await this.maybeRefreshContent(sessionId);
  }

  /** Uses the service's injected wall clock so timer scheduling remains testable. */
  millisecondsUntilExpiry(expiresAtMs: number): number { return Math.max(0, expiresAtMs - this.now()); }

  /** Reauthorizes each presence write; a socket close is deliberately not a membership change. */
  async recordSocketPresence(sessionId: string, participantId: string, participantToken: string, presence: PresenceReport): Promise<void> {
    const context = await this.authorize(sessionId, participantId, participantToken);
    await this.recordPresence(context, presence);
  }

  private assertRole(context: PresentationParticipantContext, roles: PresentationRole[]): void {
    if (!roles.includes(context.role)) throw new PresentationError(403, 'ROLE_FORBIDDEN', 'Your presentation role cannot perform this action.');
  }

  private async ideaById(id: string, sessionId = '{sessionId}'): Promise<PresentationIdea> {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
    const suggestion = await this.getSuggestion(Number(id));
    if (!suggestion) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
    return publicPresentationIdea(suggestion, sessionId);
  }

  private async maybeRefreshContent(sessionId: string): Promise<void> {
    const now = this.now(), leaseId = this.uuid();
    const acquired = await this.store.runTransaction(async tx => {
      const path = presentationPaths.session(sessionId), session = await tx.get(path);
      if (!session || session.expiresAtMs <= now || session.status === 'ended' || session.status === 'expired') return null;
      if (!session.state?.selectedIdeaId || now - Number(session.contentLastCheckedAtMs ?? 0) < CONTENT_REFRESH_INTERVAL || Number(session.contentRefreshUntilMs ?? 0) > now) return null;
      tx.update(path, { contentLastCheckedAtMs: now, contentRefreshUntilMs: now + 10_000, contentRefreshLeaseId: leaseId });
      return { ideaId: session.state.selectedIdeaId as string, current: session.contentSnapshot as PresentationIdea | null };
    });
    if (!acquired) return;
    let refreshed: PresentationIdea | null = null;
    try { refreshed = await this.ideaById(acquired.ideaId, sessionId); }
    catch (error) { if (!(error instanceof PresentationError) || error.code !== 'IDEA_UNAVAILABLE') { await this.releaseRefreshLease(sessionId, leaseId); return; } }
    await this.store.runTransaction(async tx => {
      const path = presentationPaths.session(sessionId), session = await tx.get(path);
      if (!session || session.contentRefreshLeaseId !== leaseId || session.state?.selectedIdeaId !== acquired.ideaId || session.expiresAtMs <= this.now() || session.status === 'ended') return;
      const previous = session.contentSnapshot as PresentationIdea | null;
      if (refreshed && previous?.contentVersion === refreshed.contentVersion) {
        tx.update(path, { contentRefreshUntilMs: 0, contentRefreshLeaseId: null });
        return;
      }
      const state = stateOnly(session);
      if (!refreshed) {
        state.selectedIdeaId = null; state.mode = 'map'; state.albumItemId = null; state.descriptionPage = 0;
        state.photoFrame = { scale: 1, centerX: 0.5, centerY: 0.5 };
        state.ideaEpoch++;
      } else {
        const selectedItemValid = state.albumItemId === null || refreshed.album.some(item => item.id === state.albumItemId);
        if (!selectedItemValid) {
          state.albumItemId = refreshed.album[0]?.id ?? null;
          state.photoFrame = { scale: 1, centerX: 0.5, centerY: 0.5 };
        }
        state.descriptionPage = Math.min(state.descriptionPage, refreshed.descriptionPages.length);
        const selected = refreshed.album.find(item => item.id === state.albumItemId);
        if (selected?.kind === 'streetmix') state.photoFrame = { scale: 1, centerX: 0.5, centerY: 0.5 };
      }
      state.revision++;
      tx.update(path, { state, contentSnapshot: refreshed, contentVersion: refreshed?.contentVersion ?? null, revision: state.revision, contentRefreshUntilMs: 0, contentRefreshLeaseId: null });
    });
  }

  private async releaseRefreshLease(sessionId: string, leaseId: string): Promise<void> {
    await this.store.runTransaction(async tx => {
      const path = presentationPaths.session(sessionId), session = await tx.get(path);
      if (session?.contentRefreshLeaseId === leaseId) tx.update(path, { contentRefreshUntilMs: 0, contentRefreshLeaseId: null });
    }).catch(() => undefined);
  }

  private async recordPresence(context: PresentationParticipantContext, presence?: PresenceReport): Promise<void> {
    const now = this.now(), path = presentationPaths.participant(context.sessionId, context.participantId), sessionPath = presentationPaths.session(context.sessionId);
    await this.store.runTransaction(async tx => {
      const participant = await tx.get(path), session = await tx.get(sessionPath);
      if (!participant || participant.revoked || !session || session.status === 'ended' || session.status === 'expired'
        || session.expiresAtMs <= now || participant.role !== context.role
        || !equalDigest(participant.tokenDigest, String(context.participant.tokenDigest))
        || (context.role === 'controller' && session.controllerId !== context.participantId)) return;
      const update: Record<string, any> = {};
      if (now - Number(participant.lastSeenAtMs ?? 0) >= PRESENCE_WRITE_INTERVAL) update.lastSeenAtMs = now;
      if (context.role === 'audience' && presence?.localView !== undefined && participant.localView !== presence.localView) update.localView = presence.localView;
      if (context.role === 'receiver' && presence) {
        const observed = {
          appliedRevision: presence.appliedRevision ?? null,
          viewport: presence.viewport ?? null,
          renderStatus: presence.renderStatus ?? null,
          renderError: presence.renderError ?? null,
        };
        const previous = session.receiverStatus ?? {};
        if (!session.receiverStatus || JSON.stringify(observed) !== JSON.stringify({
          appliedRevision: previous.appliedRevision ?? null, viewport: previous.viewport ?? null,
          renderStatus: previous.renderStatus ?? null, renderError: previous.renderError ?? null,
        }) || now - Number(previous.lastSeenAtMs ?? 0) >= PRESENCE_WRITE_INTERVAL) {
          tx.update(sessionPath, { receiverStatus: { ...observed, lastSeenAtMs: now } });
        }
      }
      if (Object.keys(update).length) tx.update(path, update);
    });
  }

  private async envelope(context: PresentationParticipantContext, lastRevision: number, lastContentVersion: string | null): Promise<Record<string, any>> {
    const session = await this.readSession(context.sessionId);
    const changed = lastRevision !== session.state.revision;
    const result: Record<string, any> = {
      protocolVersion: 1, serverTime: iso(this.now()),
      session: { id: session.id, status: this.sessionStatus(session), expiresAt: iso(session.expiresAtMs), revision: session.state.revision },
      changed, state: changed ? stateOnly(session) : null,
      content: lastContentVersion !== (session.contentVersion ?? null) ? session.contentSnapshot ?? null : null,
      participants: null, receiver: context.role === 'receiver' ? session.receiverStatus ? {
        appliedRevision: session.receiverStatus.appliedRevision, viewport: session.receiverStatus.viewport,
        renderStatus: session.receiverStatus.renderStatus, renderError: session.receiverStatus.renderError,
      } : null : null,
    };
    if (context.role === 'controller') {
      const participants = await this.store.list(presentationPaths.participantCollection(context.sessionId));
      result.participants = participants.filter(item => item.data.role === 'audience' && !item.data.revoked).map(item => ({
        id: item.id, displayName: item.data.displayName,
        connected: this.now() - Number(item.data.lastSeenAtMs ?? 0) <= PRESENCE_CONNECTED_WINDOW,
        localView: item.data.localView ?? null, lastSeenAt: iso(Number(item.data.lastSeenAtMs ?? item.data.createdAtMs ?? this.now())),
      }));
      result.audienceCode = formatCode(session.audienceCode);
    }
    return result;
  }

  async sync(context: PresentationParticipantContext, request: SyncRequest): Promise<Record<string, any>> {
    if (!request || request.protocolVersion !== 1) throw new PresentationError(426, 'PROTOCOL_UNSUPPORTED', 'This presentation protocol version is not supported.');
    if (!Number.isSafeInteger(request.lastRevision) || request.lastRevision < -1) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'lastRevision must be -1 or a nonnegative integer.');
    if (request.lastContentVersion !== null && typeof request.lastContentVersion !== 'string') throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'lastContentVersion must be a string or null.');
    await this.maybeRefreshContent(context.sessionId);
    await this.recordPresence(context, request.presence);
    const freshContext = { ...context, session: await this.readSession(context.sessionId) };
    return this.envelope(freshContext, request.lastRevision, request.lastContentVersion);
  }

  async catalog(context: PresentationParticipantContext, limit: number, cursor: string | undefined): Promise<Record<string, any>> {
    this.assertRole(context, ['controller']);
    const afterId = this.decodeCursor(cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'limit must be an integer from 1 through 100.');
    const page = await this.getSuggestionPage(afterId, limit);
    return { protocolVersion: 1, items: page.items.map(item => publicPresentationIdea(item, context.sessionId)), nextCursor: page.nextCursor === null ? null : this.encodeCursor(page.nextCursor) };
  }

  private decodeCursor(cursor: string | undefined): string | null {
    if (cursor === undefined) return null;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Catalog cursor is invalid.');
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      if (!/^[1-9]\d*$/.test(decoded) || !Number.isSafeInteger(Number(decoded))) throw new Error();
      return decoded;
    } catch { throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Catalog cursor is invalid.'); }
  }
  private encodeCursor(id: string): string { return Buffer.from(id).toString('base64url'); }

  async getIdea(context: PresentationParticipantContext, ideaId: string): Promise<Record<string, any>> {
    const normalized = normalizedSuggestionId(ideaId);
    if (!normalized) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
    await this.maybeRefreshContent(context.sessionId);
    const session = await this.readSession(context.sessionId);
    if (context.role !== 'controller' && session.state.selectedIdeaId !== normalized) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
    if (session.state.selectedIdeaId === normalized && session.contentSnapshot) return { protocolVersion: 1, idea: session.contentSnapshot };
    return { protocolVersion: 1, idea: await this.ideaById(normalized, context.sessionId) };
  }

  async selectedStreetmixId(context: PresentationParticipantContext, ideaId: string): Promise<string> {
    const normalized = normalizedSuggestionId(ideaId);
    if (!normalized) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
    await this.maybeRefreshContent(context.sessionId);
    const session = await this.readSession(context.sessionId);
    if (context.role !== 'controller' && session.state.selectedIdeaId !== normalized) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
    const idea = session.state.selectedIdeaId === normalized && session.contentSnapshot
      ? session.contentSnapshot as PresentationIdea
      : await this.ideaById(normalized, context.sessionId);
    const item = idea.album.find(entry => entry.kind === 'streetmix');
    if (!item || item.kind !== 'streetmix') throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea has no assigned Streetmix preview.');
    return item.streetmixId;
  }

  /** Returns the effective caption setting, keeping the ordinary-photo preference stored in canonical state. */
  effectiveCaption(session: Record<string, any>): boolean {
    return effectiveCaptionVisible(stateOnly(session), session.contentSnapshot ?? null);
  }

  /** Applies one full controller snapshot with optimistic concurrency and durable idempotency receipts. */
  async updateState(context: PresentationParticipantContext, request: { protocolVersion: number; baseRevision: number; state: unknown }, idempotencyKey: string | undefined): Promise<Record<string, any>> {
    this.assertRole(context, ['controller']);
    if (!request || request.protocolVersion !== 1) throw new PresentationError(426, 'PROTOCOL_UNSUPPORTED', 'This presentation protocol version is not supported.');
    if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'baseRevision must be a nonnegative integer.');
    const requested = validateWritableState(request.state, context.session.state.iconStyle);
    const key = validateUuid(idempotencyKey, 'Idempotency-Key'), keyHash = sha(key);
    const writeFingerprint = fingerprint('state', context.participantId, String(context.participant.tokenDigest), { baseRevision: request.baseRevision, state: requested });
    const targetIdea = requested.selectedIdeaId === null
      ? null
      : requested.selectedIdeaId === context.session.state.selectedIdeaId
        ? (context.session.contentSnapshot as PresentationIdea | null) ?? await this.ideaById(requested.selectedIdeaId, context.sessionId)
        : await this.ideaById(requested.selectedIdeaId, context.sessionId);
    const roster = context.role === 'controller' ? await this.store.list(presentationPaths.participantCollection(context.sessionId)) : [];
    const receiptPath = presentationPaths.stateReceipt(context.sessionId, keyHash), sessionPath = presentationPaths.session(context.sessionId), participantPath = presentationPaths.participant(context.sessionId, context.participantId);
    const result = await this.store.runTransaction(async tx => {
      const [receipt, session, participant] = await Promise.all([tx.get(receiptPath), tx.get(sessionPath), tx.get(participantPath)]);
      if (!session || !participant || !equalDigest(participant.tokenDigest, String(context.participant.tokenDigest)) || participant.revoked) {
        throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
      }
      if (session.status === 'ended') throw new PresentationError(410, 'SESSION_ENDED', 'This presentation has ended.');
      if (session.status === 'expired' || session.expiresAtMs <= this.now()) throw new PresentationError(410, 'SESSION_EXPIRED', 'This presentation has expired.');
      if (session.controllerId !== context.participantId || participant.role !== 'controller') throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
      if (receipt) {
        if (receipt.fingerprint !== writeFingerprint) throw new PresentationError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
        return { session, response: receipt.response };
      }
      if (session.state.revision !== request.baseRevision) return { conflict: true, session };
      const current = stateOnly(session);
      const nextFields = normalizeStateForIdea(requested, current, targetIdea);
      const changedIdea = current.selectedIdeaId !== nextFields.selectedIdeaId;
      const nextState: PresentationState = {
        ...nextFields,
        revision: current.revision + 1,
        ideaEpoch: current.ideaEpoch + (changedIdea ? 1 : 0),
      };
      const snapshot = nextState.selectedIdeaId === null ? null : targetIdea;
      const updatedSession = {
        ...session, state: nextState, revision: nextState.revision,
        contentSnapshot: snapshot, contentVersion: snapshot?.contentVersion ?? null,
      };
      const response = this.envelopeFromRecord(updatedSession, 'controller', roster, this.now());
      tx.update(sessionPath, {
        state: nextState, revision: nextState.revision, contentSnapshot: snapshot, contentVersion: snapshot?.contentVersion ?? null,
        contentLastCheckedAtMs: this.now(),
      });
      tx.set(receiptPath, { operation: 'state', fingerprint: writeFingerprint, participantId: context.participantId, response, createdAtMs: this.now(), expiresAtMs: session.expiresAtMs, expiresAt: new Date(session.expiresAtMs) });
      return { session: updatedSession, response };
    });
    if ('conflict' in result && result.conflict) {
      const fresh = { ...context, session: result.session };
      throw new PresentationError(409, 'REVISION_CONFLICT', 'Presentation state changed. Sync and rebase your changes.', await this.envelope(fresh, -1, null));
    }
    return result.response;
  }

  private envelopeFromRecord(session: Record<string, any>, role: PresentationRole, roster: Array<{ id: string; data: Record<string, any> }> = [], now = this.now()): Record<string, any> {
    const response: Record<string, any> = {
      protocolVersion: 1, serverTime: iso(now),
      session: { id: session.id, status: this.sessionStatus(session, now), expiresAt: iso(session.expiresAtMs), revision: session.state.revision },
      changed: true, state: stateOnly(session), content: session.contentSnapshot ?? null,
      participants: null,
      receiver: role === 'receiver' && session.receiverStatus ? {
        appliedRevision: session.receiverStatus.appliedRevision, viewport: session.receiverStatus.viewport,
        renderStatus: session.receiverStatus.renderStatus, renderError: session.receiverStatus.renderError,
      } : null,
    };
    if (role === 'controller') {
      response.participants = roster.filter(item => item.data.role === 'audience' && !item.data.revoked).map(item => ({
        id: item.id, displayName: item.data.displayName,
        connected: now - Number(item.data.lastSeenAtMs ?? 0) <= PRESENCE_CONNECTED_WINDOW,
        localView: item.data.localView ?? null, lastSeenAt: iso(Number(item.data.lastSeenAtMs ?? item.data.createdAtMs ?? now)),
      }));
      response.audienceCode = formatCode(session.audienceCode);
    }
    return response;
  }

  /** Rotates receiver pairing authority and invalidates the previous controller and outstanding receipt. */
  async rotatePairing(context: PresentationParticipantContext, protocolVersion: number, idempotencyKey: string | undefined): Promise<Record<string, any>> {
    this.assertRole(context, ['receiver']);
    if (protocolVersion !== 1) throw new PresentationError(426, 'PROTOCOL_UNSUPPORTED', 'This presentation protocol version is not supported.');
    const key = validateUuid(idempotencyKey, 'Idempotency-Key'), keyHash = sha(key);
    const requestFingerprint = fingerprint('rotate-pairing', context.participantId, String(context.participant.tokenDigest), { protocolVersion: 1 });
    const sessionPath = presentationPaths.session(context.sessionId), receiverPath = presentationPaths.participant(context.sessionId, context.participantId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = this.code(), hash = codeHash('presenter', code), lookupPath = presentationPaths.codeLookup('presenter', hash);
      try {
        const response = await this.store.runTransaction(async tx => {
          const receiptPath = presentationPaths.stateReceipt(context.sessionId, keyHash);
          const [receipt, session, receiver] = await Promise.all([tx.get(receiptPath), tx.get(sessionPath), tx.get(receiverPath)]);
          if (!session || !receiver || receiver.role !== 'receiver' || receiver.revoked || !equalDigest(receiver.tokenDigest, String(context.participant.tokenDigest))) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
          this.checkSession(session);
          if (receipt) {
            if (receipt.fingerprint !== requestFingerprint) throw new PresentationError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
            return receipt.response;
          }
          const oldReceiptPath = session.pairingReceiptPath as string | undefined;
          const oldCodeLookupPath = session.presenterCode ? presentationPaths.codeLookup('presenter', codeHash('presenter', session.presenterCode)) : undefined;
          const [collision, oldController, oldLookup, oldReceipt] = await Promise.all([
            tx.get(lookupPath),
            session.controllerId ? tx.get(presentationPaths.participant(context.sessionId, session.controllerId)) : Promise.resolve(undefined),
            oldCodeLookupPath ? tx.get(oldCodeLookupPath) : Promise.resolve(undefined),
            oldReceiptPath ? tx.get(oldReceiptPath) : Promise.resolve(undefined),
          ]);
          if (collision) throw new Error('PRESENTATION_CODE_COLLISION');
          const codeExpiry = Math.min(session.expiresAtMs, this.now() + TEN_MINUTES);
          const safe = { protocolVersion: 1, presenterCode: formatCode(code), presenterCodeExpiresAt: iso(codeExpiry) };
          if (oldController) tx.update(presentationPaths.participant(context.sessionId, session.controllerId), { revoked: true, revokedAtMs: this.now() });
          if (oldReceiptPath && oldReceipt) tx.update(oldReceiptPath, { revoked: true });
          if (oldLookup && oldCodeLookupPath) tx.update(oldCodeLookupPath, { status: 'revoked' });
          tx.set(lookupPath, { sessionId: context.sessionId, purpose: 'presenter', status: 'open', expiresAtMs: codeExpiry, expiresAt: new Date(codeExpiry) });
          tx.update(sessionPath, { presenterCode: code, presenterCodeExpiresAtMs: codeExpiry, controllerId: null, pairingReceiptPath: null });
          tx.set(receiptPath, { operation: 'rotate-pairing', fingerprint: requestFingerprint, response: safe, participantId: context.participantId, createdAtMs: this.now(), expiresAtMs: session.expiresAtMs, expiresAt: new Date(session.expiresAtMs) });
          return safe;
        });
        return response;
      } catch (error) { if (error instanceof Error && error.message === 'PRESENTATION_CODE_COLLISION') continue; throw error; }
    }
    throw new PresentationError(503, 'PRESENTATION_UNAVAILABLE', 'A new presenter pairing code could not be created.');
  }

  /** Audience participants leave themselves; presenters relinquish authority without ending the room. */
  async leave(context: PresentationParticipantContext, tokenInput: string): Promise<void> {
    const sessionPath = presentationPaths.session(context.sessionId), participantPath = presentationPaths.participant(context.sessionId, context.participantId);
    const digest = tokenDigest(tokenInput);
    await this.store.runTransaction(async tx => {
      const [session, participant] = await Promise.all([tx.get(sessionPath), tx.get(participantPath)]);
      if (!session || !participant || !equalDigest(participant.tokenDigest, digest)) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
      this.checkSession(session);
      if (participant.role === 'receiver') throw new PresentationError(403, 'ROLE_FORBIDDEN', 'The receiver cannot leave the presentation.');
      if (participant.revoked) return;
      if (participant.role === 'controller' && session.controllerId !== context.participantId) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
      const enrollmentReceipt = participant.enrollmentReceiptPath ? await tx.get(participant.enrollmentReceiptPath) : undefined;
      tx.update(participantPath, { revoked: true, revokedAtMs: this.now() });
      if (participant.role === 'controller') tx.update(sessionPath, { controllerId: null });
      if (participant.enrollmentReceiptPath && enrollmentReceipt) tx.update(participant.enrollmentReceiptPath, { revoked: true });
    });
  }

  /** Ends a room once, while allowing an already-authorized receiver/controller retry to receive 204. */
  async endSession(sessionId: string, participantIdInput: string | undefined, tokenInput: string | undefined): Promise<void> {
    const participantId = validateUuid(participantIdInput, 'X-Presentation-Participant');
    if (!tokenInput) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'A presentation participant token is required.');
    const digest = tokenDigest(tokenInput), sessionPath = presentationPaths.session(sessionId), participantPath = presentationPaths.participant(sessionId, participantId);
    await this.store.runTransaction(async tx => {
      const [session, participant] = await Promise.all([tx.get(sessionPath), tx.get(participantPath)]);
      if (!session || !participant || !equalDigest(participant.tokenDigest, digest)) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
      if (!['receiver', 'controller'].includes(participant.role)) throw new PresentationError(403, 'ROLE_FORBIDDEN', 'Your presentation role cannot end this room.');
      if (participant.role === 'controller' && session.status !== 'ended' && session.status !== 'expired'
          && (participant.revoked || session.controllerId !== participantId)) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
      if (session.status === 'ended' || session.status === 'expired' || session.expiresAtMs <= this.now()) {
        if (session.status !== 'ended' && session.status !== 'expired') tx.update(sessionPath, { status: 'expired', expiredAtMs: this.now() });
        return;
      }
      const presenterLookupPath = presentationPaths.codeLookup('presenter', codeHash('presenter', session.presenterCode));
      const audienceLookupPath = presentationPaths.codeLookup('audience', codeHash('audience', session.audienceCode));
      const [presenterLookup, audienceLookup, pairingReceipt] = await Promise.all([
        tx.get(presenterLookupPath), tx.get(audienceLookupPath), session.pairingReceiptPath ? tx.get(session.pairingReceiptPath) : Promise.resolve(undefined),
      ]);
      tx.update(sessionPath, { status: 'ended', endedAtMs: this.now(), terminalUntilMs: session.expiresAtMs, controllerId: null });
      if (presenterLookup) tx.update(presenterLookupPath, { status: 'revoked' });
      if (audienceLookup) tx.update(audienceLookupPath, { status: 'revoked' });
      if (pairingReceipt) tx.update(session.pairingReceiptPath, { revoked: true });
    });
  }
}


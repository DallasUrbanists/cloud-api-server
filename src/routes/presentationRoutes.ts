/** Accountless bootstrap and capability-authenticated presentation protocol routes. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { StreetmixError } from '../models/streetmix.js';
import { PresentationError, validateUuid } from '../models/presentation.js';
import { PresentationService, type EnrollmentRequest, type PresenceReport, type PresentationParticipantContext, type SyncRequest } from '../services/presentationService.js';
import { readStreetmixThumbnail } from '../services/streetmixThumbnail.js';

const RENDER_ERRORS = new Set(['TILE_UNAVAILABLE', 'IMAGE_UNAVAILABLE', 'RENDER_FAILED', 'NETWORK_ERROR', 'TIMEOUT', 'UNKNOWN']);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function objectBody(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Send a JSON object.');
  return value as Record<string, any>;
}
function exactKeys(value: Record<string, any>, required: string[], optional: string[] = []): void {
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Request contains missing or unsupported fields.');
  }
}
function protocol(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new PresentationError(426, 'PROTOCOL_UNSUPPORTED', 'This presentation protocol version is not supported.');
  return value;
}
function idempotencyKey(req: Request): string | undefined { return req.header('Idempotency-Key'); }
function clientIp(req: Request): string { return req.ip || req.socket.remoteAddress || 'unknown'; }
function pathParam(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? '' : value ?? ''; }

function validatePresence(input: unknown, role: PresentationParticipantContext['role']): PresenceReport | undefined {
  if (input === undefined) return undefined;
  const presence = objectBody(input);
  const permitted = role === 'audience' ? ['localView'] : role === 'receiver' ? ['appliedRevision', 'viewport', 'renderStatus', 'renderError'] : [];
  if (Object.keys(presence).some(key => !permitted.includes(key))) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Presence contains fields that are not available to this role.');
  if (role === 'audience' && presence.localView !== undefined && !['map', 'photo', 'description'].includes(presence.localView)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'localView is invalid.');
  if (role !== 'receiver' || !permitted.length) return presence as PresenceReport;
  if (presence.appliedRevision !== undefined && (!Number.isSafeInteger(presence.appliedRevision) || presence.appliedRevision < 0)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'appliedRevision must be a nonnegative integer.');
  if (presence.viewport !== undefined) {
    const viewport = objectBody(presence.viewport);
    exactKeys(viewport, ['width', 'height']);
    if (![viewport.width, viewport.height].every((v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 16384)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Viewport dimensions must be finite positive values no greater than 16384.');
  }
  if (presence.renderStatus !== undefined && !['loading', 'ready', 'error'].includes(presence.renderStatus)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'renderStatus is invalid.');
  if (presence.renderError !== undefined && presence.renderError !== null && (typeof presence.renderError !== 'string' || !RENDER_ERRORS.has(presence.renderError))) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'renderError is not an allowed code.');
  return presence as PresenceReport;
}

function bearer(req: Request): string | undefined {
  const value = req.header('Authorization');
  const match = value && /^Bearer ([A-Za-z0-9_-]+)$/.exec(value);
  return match?.[1];
}

export function createPresentationRouter(service: PresentationService): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use((req, res, next) => {
    if (process.env.PRESENTATION_ENABLED !== 'true') {
      res.status(404).json({ error: 'PRESENTATION_DISABLED', message: 'Presentation sessions are not enabled on this server.' });
      return;
    }
    next();
  });

  const run = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    try { await handler(req, res); }
    catch (error) {
      if (res.headersSent) return;
      if (error instanceof PresentationError) {
        if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
        res.status(error.status).json(error.toPayload());
        return;
      }
      if (error instanceof StreetmixError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      res.status(503).json({ error: 'PRESENTATION_UNAVAILABLE', message: 'Presentation sessions are temporarily unavailable.' });
    }
  };

  const enroll = (role: 'pair' | 'audience' | 'create') => run(async (req, res) => {
    const body = objectBody(req.body);
    const fields = ['protocolVersion', 'participantId', 'participantToken', ...(role === 'create' ? [] : ['code'])];
    exactKeys(body, fields);
    protocol(body.protocolVersion);
    if (typeof body.participantId !== 'string' || typeof body.participantToken !== 'string') throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'participantId and participantToken are required.');
    const result = role === 'create'
      ? await service.createSession(body as unknown as EnrollmentRequest, idempotencyKey(req), clientIp(req))
      : role === 'pair'
        ? await service.pair(body as unknown as EnrollmentRequest, idempotencyKey(req), clientIp(req))
        : await service.joinAudience(body as unknown as EnrollmentRequest, idempotencyKey(req), clientIp(req));
    res.status(result.status).json(result.body);
  });

  router.post('/sessions', enroll('create'));
  router.post('/pair', enroll('pair'));
  router.post('/audience/join', enroll('audience'));

  const authorized = (handler: (req: Request, res: Response, context: PresentationParticipantContext) => Promise<void>) => run(async (req, res) => {
    const sessionId = validateUuid(pathParam(req.params.sessionId), 'sessionId');
    const participantId = req.header('X-Presentation-Participant');
    const context = await service.authorize(sessionId, participantId, bearer(req));
    await handler(req, res, context);
  });

  router.post('/sessions/:sessionId/sync', authorized(async (req, res, context) => {
    const body = objectBody(req.body);
    exactKeys(body, ['protocolVersion', 'lastRevision', 'lastContentVersion'], ['presence']);
    protocol(body.protocolVersion);
    const presence = validatePresence(body.presence, context.role);
    const result = await service.sync(context, { ...body, presence } as SyncRequest);
    res.status(200).json(result);
  }));

  router.put('/sessions/:sessionId/state', authorized(async (req, res, context) => {
    const body = objectBody(req.body);
    exactKeys(body, ['protocolVersion', 'baseRevision', 'state']);
    protocol(body.protocolVersion);
    res.status(200).json(await service.updateState(context, body as { protocolVersion: number; baseRevision: number; state: unknown }, idempotencyKey(req)));
  }));

  router.get('/sessions/:sessionId/ideas', authorized(async (req, res, context) => {
    if (Object.keys(req.query).some(key => !['limit', 'cursor'].includes(key))) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Unsupported catalog query parameter.');
    const rawLimit = req.query.limit === undefined ? '100' : req.query.limit;
    const limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    const cursor = req.query.cursor;
    if (cursor !== undefined && typeof cursor !== 'string') throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Catalog cursor is invalid.');
    res.status(200).json(await service.catalog(context, limit, cursor as string | undefined));
  }));

  router.get('/sessions/:sessionId/ideas/:ideaId/streetmix-thumbnail', authorized(async (req, res, context) => {
    const streetmixId = await service.selectedStreetmixId(context, pathParam(req.params.ideaId));
    const image = await readStreetmixThumbnail(streetmixId, AbortSignal.timeout(16_000));
    res.set('Cache-Control', 'no-store').type('image/png').send(image);
  }));

  router.get('/sessions/:sessionId/ideas/:ideaId', authorized(async (req, res, context) => {
    res.status(200).json(await service.getIdea(context, pathParam(req.params.ideaId)));
  }));

  router.post('/sessions/:sessionId/pairing', authorized(async (req, res, context) => {
    const body = objectBody(req.body);
    exactKeys(body, ['protocolVersion']);
    protocol(body.protocolVersion);
    res.status(200).json(await service.rotatePairing(context, body.protocolVersion as number, idempotencyKey(req)));
  }));

  router.delete('/sessions/:sessionId/participants/me', authorized(async (req, res, context) => {
    const token = bearer(req);
    if (!token) throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'A presentation participant token is required.');
    await service.leave(context, token);
    res.status(204).end();
  }));

  router.delete('/sessions/:sessionId', run(async (req, res) => {
    const sessionId = validateUuid(pathParam(req.params.sessionId), 'sessionId');
    await service.endSession(sessionId, req.header('X-Presentation-Participant'), bearer(req));
    res.status(204).end();
  }));

  return router;
}

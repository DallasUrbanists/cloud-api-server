/** Capability-authenticated presentation sockets. The suggestion dispatcher owns HTTP upgrade routing. */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { PresentationError } from './models/presentation.js';
import type { PresentationRole } from './models/presentation.js';
import type { PresentationService, PresentationWatchSnapshot } from './services/presentationService.js';
import {
  createHeartbeat, createSocketError, parseAuthentication, parsePresence, PRESENTATION_SOCKET_PATH,
  type PresentationAuthentication,
} from './services/presentationSocketProtocol.js';

export interface PresentationWebSocketOptions {
  enabled?: () => boolean;
  now?: () => number;
  uuid?: () => string;
  authTimeoutMs?: number;
  readyTimeoutMs?: number;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  projectionIntervalMs?: number;
  maintenanceIntervalMs?: number;
  maxPending?: number;
  maxAuthenticated?: number;
  maxPerParticipant?: number;
  maxPerSession?: number;
  maxBufferedAmount?: number;
  closeTimeoutMs?: number;
}

export interface PresentationUpgradeHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): Promise<void>;
}

type Phase = 'pending' | 'verifying' | 'initializing' | 'ready' | 'closing';
interface Connection {
  ws: WebSocket;
  phase: Phase;
  authTimer?: NodeJS.Timeout;
  readyTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  projectionTimer?: NodeJS.Timeout;
  terminationTimer?: NodeJS.Timeout;
  auth?: PresentationAuthentication;
  role?: PresentationRole;
  hub?: SessionHub;
  sequence: number;
  lastRevision: number;
  staleRetries: number;
  lastProjection?: string;
  projecting: boolean;
  dirty: boolean;
  nextHeartbeatAt: number;
  outstanding: Array<{ id: string; issuedAt: number }>;
  heartbeatNumber: number;
  authGeneration: number;
  authorizationGeneration: number;
  tokens: number;
  tokenUpdatedAt: number;
}
interface PendingPresence { connection: Connection; presence: Record<string, unknown>; }
interface PresenceQueue { pending?: PendingPresence; running: boolean; task?: Promise<void>; }
interface SessionHub {
  sessionId: string;
  connections: Set<Connection>;
  stopWatching?: () => void;
  stopMaintenance?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  expiryDeadline?: number;
  rosterTimer?: NodeJS.Timeout;
  snapshot?: PresentationWatchSnapshot;
  initialized: boolean;
  closed: boolean;
  maintenanceInFlight: boolean;
  generation: number;
}

const MAX_FRAME_BYTES = 32 * 1024;
const DEFAULT_MAX_BUFFERED = 1024 * 1024;
const TERMINAL_CODES = new Set(['SESSION_ENDED', 'SESSION_EXPIRED', 'INVALID_SESSION_CREDENTIAL', 'ROLE_FORBIDDEN']);

/** Owns only presentation WebSocket sessions; an HTTP upgrade dispatcher calls handleUpgrade. */
export class PresentationWebSocketServer implements PresentationUpgradeHandler {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly hubs = new Map<string, SessionHub>();
  private readonly presenceQueues = new Map<string, PresenceQueue>();
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly enabled: () => boolean;
  private shuttingDown = false;
  private shutdown?: Promise<void>;

  constructor(private readonly service: PresentationService, private readonly options: PresentationWebSocketOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.uuid = options.uuid ?? randomUUID;
    this.enabled = options.enabled ?? (() => process.env.PRESENTATION_ENABLED === 'true' && process.env.PRESENTATION_WEBSOCKET_ENABLED === 'true');
    this.wss.on('connection', ws => this.accept(ws));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.enabled()) { rejectUpgrade(socket, 404, 'Not Found'); return; }
    if (this.shuttingDown || this.countPending() >= (this.options.maxPending ?? 50)
      || this.countAuthenticated() >= (this.options.maxAuthenticated ?? 500)) {
      rejectUpgrade(socket, 503, 'Service Unavailable', 5); return;
    }
    try { this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws)); }
    catch { socket.destroy(); }
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.shuttingDown = true;
    for (const connection of this.connections.values()) this.closeConnection(connection, 1001, 'SERVER_SHUTDOWN', 'Presentation updates are shutting down.');
    for (const hub of [...this.hubs.values()]) this.stopHub(hub);
    const presenceDrains = [...this.presenceQueues.values()].map(queue => queue.task).filter((task): task is Promise<void> => Boolean(task));
    this.shutdown = new Promise<void>(resolve => this.wss.close(() => resolve())).then(async () => {
      await Promise.all(presenceDrains.map(task => task.catch(() => undefined)));
    });
    return this.shutdown;
  }

  private accept(ws: WebSocket): void {
    const connection: Connection = {
      ws, phase: 'pending', sequence: 0, lastRevision: -1, staleRetries: 0, projecting: false, dirty: false,
      nextHeartbeatAt: 0, outstanding: [], heartbeatNumber: 0, authGeneration: 0,
      authorizationGeneration: 0, tokens: 20, tokenUpdatedAt: this.now(),
    };
    this.connections.set(ws, connection);
    connection.authTimer = this.timer(() => this.closeConnection(connection, 4000, 'AUTHENTICATION_TIMEOUT', 'Presentation authentication timed out.'), this.options.authTimeoutMs ?? 5000);
    ws.on('error', () => this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation updates are temporarily unavailable.', 5000));
    ws.on('close', () => this.cleanup(connection));
    ws.on('message', (data, binary) => { void this.receive(connection, rawDataBuffer(data), binary); });
  }

  private async receive(connection: Connection, data: Buffer, binary: boolean): Promise<void> {
    if (connection.phase === 'closing') return;
    if (binary) {
      this.closeConnection(connection, 1008, 'INVALID_SOCKET_FRAME', 'Binary frames are not supported.');
      return;
    }
    if (data.byteLength > MAX_FRAME_BYTES) {
      this.closeConnection(connection, 1009, 'FRAME_TOO_LARGE', 'Presentation socket frame is too large.');
      return;
    }
    if (!this.consumeToken(connection)) {
      this.closeConnection(connection, 1008, 'MESSAGE_RATE_LIMITED', 'Presentation socket messages are arriving too quickly.');
      return;
    }
    let value: unknown;
    try { value = JSON.parse(data.toString('utf8')); }
    catch { this.closeConnection(connection, 1008, 'INVALID_SOCKET_FRAME', 'Presentation socket frame is invalid.'); return; }

    if (connection.phase === 'pending') {
      connection.phase = 'verifying';
      const generation = ++connection.authGeneration;
      let auth: PresentationAuthentication;
      try { auth = parseAuthentication(value); }
      catch (error) { this.failFromError(connection, error); return; }
      try {
        const context = await this.service.authorize(auth.sessionId, auth.participantId, auth.participantToken);
        if (connection.phase !== 'verifying' || connection.authGeneration !== generation || connection.ws.readyState !== WebSocket.OPEN) return;
        if (this.shuttingDown || this.countAuthenticated() >= (this.options.maxAuthenticated ?? 500)) {
          this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation capacity is temporarily full.', 5000); return;
        }
        const participantKey = `${auth.sessionId}:${auth.participantId}`;
        if (this.countParticipant(participantKey) >= (this.options.maxPerParticipant ?? 4)) {
          this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'This participant already has the maximum number of connections.', 5000); return;
        }
        const hub = this.getOrCreateHub(auth.sessionId);
        if (hub.closed) throw new Error('Presentation listener is unavailable.');
        if (hub.connections.size >= (this.options.maxPerSession ?? 500)) {
          this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'This presentation has reached its connection limit.', 5000); return;
        }
        connection.auth = auth;
        connection.role = context.role;
        connection.hub = hub;
        connection.phase = 'initializing';
        clearTimeout(connection.authTimer);
        connection.readyTimer = this.timer(() => this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation updates are temporarily unavailable.', 5000), this.options.readyTimeoutMs ?? 15_000);
        hub.connections.add(connection);
        if (hub.initialized) this.scheduleProjection(connection);
        return;
      } catch (error) {
        if (connection.phase === 'verifying' && connection.authGeneration === generation) this.failFromError(connection, error);
        return;
      }
    }

    if (connection.phase !== 'ready' || !connection.auth || !connection.role) {
      this.closeConnection(connection, 1008, 'INVALID_SOCKET_FRAME', 'Only one authentication frame is accepted.'); return;
    }
    let parsed: ReturnType<typeof parsePresence>;
    try { parsed = parsePresence(value, connection.role); }
    catch (error) { this.failFromError(connection, error); return; }
    if (parsed.heartbeatId !== null) this.acknowledge(connection, parsed.heartbeatId);
    this.queuePresence(connection, parsed.presence);
  }

  private getOrCreateHub(sessionId: string): SessionHub {
    const existing = this.hubs.get(sessionId);
    if (existing && !existing.closed) return existing;
    const hub: SessionHub = { sessionId, connections: new Set(), initialized: false, closed: false, maintenanceInFlight: false, generation: 0 };
    this.hubs.set(sessionId, hub);
    const stop = this.service.watchSessionSources(sessionId, {
      change: snapshot => this.hubChanged(hub, snapshot),
      error: () => this.failHub(hub),
    });
    if (hub.closed) stop(); else hub.stopWatching = stop;
    if (!hub.closed) {
      hub.stopMaintenance = this.interval(() => {
        if (hub.closed || !hub.connections.size || hub.maintenanceInFlight) return;
        hub.maintenanceInFlight = true;
        void this.service.refreshSocketContent(sessionId)
          .catch(() => this.failHub(hub))
          .finally(() => { hub.maintenanceInFlight = false; });
      }, this.options.maintenanceIntervalMs ?? 5000);
    }
    return hub;
  }

  private hubChanged(hub: SessionHub, snapshot: PresentationWatchSnapshot): void {
    if (hub.closed) return;
    hub.snapshot = snapshot;
    hub.initialized = true;
    hub.generation++;
    this.scheduleExpiry(hub);
    this.scheduleRosterAging(hub);
    for (const connection of hub.connections) {
      void this.recheckAuthorization(connection, hub.generation);
      this.scheduleProjection(connection);
    }
  }

  private async recheckAuthorization(connection: Connection, generation: number): Promise<void> {
    if (!connection.auth || connection.phase === 'closing') return;
    const check = ++connection.authorizationGeneration;
    try {
      await this.service.authorize(connection.auth.sessionId, connection.auth.participantId, connection.auth.participantToken);
    } catch (error) {
      if (!this.isClosing(connection) && connection.hub?.generation === generation && connection.authorizationGeneration === check) this.failFromError(connection, error);
    }
  }

  private scheduleProjection(connection: Connection): void {
    if (connection.phase !== 'initializing' && connection.phase !== 'ready') return;
    connection.dirty = true;
    if (connection.projecting || connection.projectionTimer || !connection.hub?.initialized) return;
    connection.projectionTimer = this.timer(() => {
      connection.projectionTimer = undefined;
      void this.project(connection);
    }, this.options.projectionIntervalMs ?? 100);
  }

  private scheduleExpiry(hub: SessionHub): void {
    const session = hub.snapshot?.session;
    const deadline = session?.expiresAtMs;
    if (!session || session.status === 'ended' || session.status === 'expired' || typeof deadline !== 'number' || !Number.isFinite(deadline)) {
      clearTimeout(hub.expiryTimer);
      hub.expiryTimer = undefined; hub.expiryDeadline = undefined;
      return;
    }
    if (hub.expiryDeadline === deadline && hub.expiryTimer) return;
    clearTimeout(hub.expiryTimer);
    hub.expiryDeadline = deadline;
    hub.expiryTimer = this.timer(() => {
      hub.expiryTimer = undefined;
      if (hub.closed || !hub.connections.size) return;
      void this.service.expireSocketSession(hub.sessionId).catch(() => this.failHub(hub));
    }, this.service.millisecondsUntilExpiry(deadline), true);
  }

  private scheduleRosterAging(hub: SessionHub): void {
    clearTimeout(hub.rosterTimer);
    hub.rosterTimer = undefined;
    if (!hub.initialized || ![...hub.connections].some(connection => connection.role === 'controller')) return;
    const audience = hub.snapshot?.participants.filter(item => item.data.role === 'audience' && !item.data.revoked) ?? [];
    const delays = audience.map(item => this.service.millisecondsUntilExpiry(Number(item.data.lastSeenAtMs ?? item.data.createdAtMs ?? 0) + 45_000)).filter(value => value > 0);
    if (!delays.length) return;
    hub.rosterTimer = this.timer(() => {
      hub.rosterTimer = undefined;
      if (hub.closed) return;
      for (const connection of hub.connections) if (connection.role === 'controller') this.scheduleProjection(connection);
      this.scheduleRosterAging(hub);
    }, Math.min(...delays) + 1, true);
  }

  private async project(connection: Connection): Promise<void> {
    if (connection.projecting || !connection.auth) return;
    connection.projecting = true;
    try {
      while (connection.dirty && (connection.phase === 'initializing' || connection.phase === 'ready')) {
        connection.dirty = false;
        const auth: PresentationAuthentication = connection.auth!;
        const envelope = await this.service.socketSnapshot(auth.sessionId, auth.participantId, auth.participantToken);
        if (this.isClosing(connection) || connection.auth !== auth) return;
        const revision = envelope.session?.revision;
        if (!Number.isSafeInteger(revision) || envelope.state?.revision !== revision || !envelope.changed
          || (envelope.state?.selectedIdeaId == null ? envelope.content !== null : !envelope.content || envelope.content.id !== envelope.state.selectedIdeaId)) {
          throw new Error('Current presentation snapshot is malformed.');
        }
        if (connection.phase === 'ready' && revision < connection.lastRevision) {
          if (++connection.staleRetries > 3) throw new Error('Presentation snapshot remained behind the last delivered revision.');
          connection.dirty = true;
          break;
        }
        connection.staleRetries = 0;
        const fingerprint = JSON.stringify({ ...envelope, serverTime: undefined });
        if (connection.phase === 'initializing') {
          connection.phase = 'ready';
          clearTimeout(connection.readyTimer);
          connection.sequence = 1;
          connection.lastRevision = revision;
          connection.lastProjection = fingerprint;
          if (!this.send(connection, { type: 'ready', socketProtocolVersion: 1, sequence: 1, envelope })) return;
          this.startHeartbeat(connection);
          continue;
        }
        if (fingerprint === connection.lastProjection) continue;
        connection.sequence++;
        connection.lastRevision = revision;
        connection.lastProjection = fingerprint;
        if (!this.send(connection, { type: 'snapshot', socketProtocolVersion: 1, sequence: connection.sequence, envelope })) return;
      }
    } catch (error) {
      this.failFromError(connection, error);
    } finally {
      connection.projecting = false;
      if (connection.dirty && !connection.projectionTimer && (connection.phase === 'initializing' || connection.phase === 'ready')) this.scheduleProjection(connection);
    }
  }

  private startHeartbeat(connection: Connection): void {
    connection.nextHeartbeatAt = this.now();
    this.scheduleHeartbeat(connection);
  }

  private scheduleHeartbeat(connection: Connection): void {
    clearTimeout(connection.heartbeatTimer);
    if (connection.phase !== 'ready') return;
    const now = this.now();
    const nextIssue = connection.nextHeartbeatAt + (this.options.heartbeatMs ?? 15_000);
    const oldestDeadline = connection.outstanding.length
      ? connection.outstanding[0].issuedAt + (this.options.heartbeatTimeoutMs ?? 30_000)
      : Number.POSITIVE_INFINITY;
    const nextCheck = connection.outstanding.length >= 2 ? oldestDeadline : Math.min(nextIssue, oldestDeadline);
    connection.heartbeatTimer = this.timer(() => {
      if (connection.phase !== 'ready') return;
      const current = this.now();
      if (connection.outstanding.length && current - connection.outstanding[0].issuedAt >= (this.options.heartbeatTimeoutMs ?? 30_000)) {
        this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation heartbeat timed out.', 5000); return;
      }
      const interval = this.options.heartbeatMs ?? 15_000;
      if (current >= connection.nextHeartbeatAt + interval && connection.outstanding.length < 2) {
        connection.nextHeartbeatAt += interval;
        const id = `${++connection.heartbeatNumber}-${this.uuid()}`;
        connection.outstanding.push({ id, issuedAt: current });
        if (!this.send(connection, createHeartbeat(id, Date.now()))) return;
      }
      this.scheduleHeartbeat(connection);
    }, Math.max(0, nextCheck - now));
  }

  private acknowledge(connection: Connection, id: string): void {
    const index = connection.outstanding.findIndex(item => item.id === id);
    if (index < 0) return;
    connection.outstanding.splice(0, index + 1);
    this.scheduleHeartbeat(connection);
  }

  private queuePresence(connection: Connection, presence: Record<string, unknown>): void {
    if (!connection.auth) return;
    const key = `${connection.auth.sessionId}:${connection.auth.participantId}`;
    let queue = this.presenceQueues.get(key);
    if (!queue) this.presenceQueues.set(key, queue = { running: false });
    queue.pending = { connection, presence };
    if (queue.running) return;
    queue.running = true;
    queue.task = this.drainPresenceQueue(key, queue);
  }

  private async drainPresenceQueue(key: string, queue: PresenceQueue): Promise<void> {
    while (queue.pending) {
      const pending = queue.pending;
      queue.pending = undefined;
      const auth = pending.connection.auth;
      if (!auth || pending.connection.phase !== 'ready') continue;
      try {
        await this.service.recordSocketPresence(auth.sessionId, auth.participantId, auth.participantToken, pending.presence as any);
      } catch (error) {
        if (!this.isClosing(pending.connection)) this.failFromError(pending.connection, error);
      }
    }
    queue.running = false;
    if (this.presenceQueues.get(key) === queue) this.presenceQueues.delete(key);
  }

  private failHub(hub: SessionHub): void {
    if (hub.closed) return;
    for (const connection of [...hub.connections]) this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation updates are temporarily unavailable.', 5000);
    this.stopHub(hub);
  }

  private failFromError(connection: Connection, error: unknown): void {
    if (connection.phase === 'closing') return;
    if (error instanceof PresentationError) {
      const retryAfterMs = error.retryAfter === undefined ? undefined : error.retryAfter * 1000;
      if (TERMINAL_CODES.has(error.code)) {
        const closeCode = error.code === 'SESSION_ENDED' || error.code === 'SESSION_EXPIRED' ? 4003 : 4001;
        this.closeConnection(connection, closeCode, error.code, error.message, retryAfterMs, error.code);
        return;
      }
      if (error.code === 'SOCKET_PROTOCOL_UNSUPPORTED' || error.code === 'PROTOCOL_UNSUPPORTED') {
        this.closeConnection(connection, 4004, error.code, error.message, undefined, error.code); return;
      }
      if (error.code === 'INVALID_SOCKET_FRAME' || error.status === 422) {
        this.closeConnection(connection, 1008, error.code === 'INVALID_SOCKET_FRAME' ? error.code : 'INVALID_PRESENCE', error.message, undefined, error.code); return;
      }
    }
    this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation updates are temporarily unavailable.', 5000);
  }

  private closeConnection(connection: Connection, closeCode: number, error: string, message: string, retryAfterMs?: number, errorOverride?: string): void {
    if (connection.phase === 'closing') return;
    if (connection.ws.readyState === WebSocket.OPEN) this.sendControl(connection, createSocketError(errorOverride ?? error, message, retryAfterMs));
    connection.phase = 'closing';
    this.cleanupTimers(connection);
    if (connection.hub) {
      const hub = connection.hub;
      hub.connections.delete(connection);
      connection.hub = undefined;
      if (!hub.connections.size) this.stopHub(hub);
    }
    try { connection.ws.close(closeCode, message.slice(0, 120)); }
    catch { connection.ws.terminate(); }
    connection.terminationTimer = this.timer(() => connection.ws.terminate(), this.options.closeTimeoutMs ?? 1000, true);
  }

  private cleanup(connection: Connection): void {
    if (connection.phase !== 'closing') {
      connection.phase = 'closing';
      this.cleanupTimers(connection);
      if (connection.hub) {
        const hub = connection.hub;
        hub.connections.delete(connection);
        connection.hub = undefined;
        if (!hub.connections.size) this.stopHub(hub);
      }
    }
    clearTimeout(connection.terminationTimer);
    this.connections.delete(connection.ws);
  }

  private cleanupTimers(connection: Connection): void {
    clearTimeout(connection.authTimer); clearTimeout(connection.readyTimer);
    clearTimeout(connection.heartbeatTimer); clearTimeout(connection.projectionTimer);
    connection.authTimer = undefined; connection.readyTimer = undefined;
    connection.heartbeatTimer = undefined; connection.projectionTimer = undefined;
  }

  private stopHub(hub: SessionHub): void {
    if (hub.closed) return;
    hub.closed = true;
    clearInterval(hub.stopMaintenance);
    hub.stopMaintenance = undefined;
    clearTimeout(hub.expiryTimer); hub.expiryTimer = undefined;
    clearTimeout(hub.rosterTimer); hub.rosterTimer = undefined;
    hub.stopWatching?.(); hub.stopWatching = undefined;
    if (this.hubs.get(hub.sessionId) === hub) this.hubs.delete(hub.sessionId);
  }

  private send(connection: Connection, value: unknown): boolean {
    if (connection.phase === 'closing' || connection.ws.readyState !== WebSocket.OPEN) return false;
    let frame: string;
    try { frame = JSON.stringify(value); }
    catch {
      this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation updates are temporarily unavailable.', 5000);
      return false;
    }
    if (connection.ws.bufferedAmount + Buffer.byteLength(frame) > (this.options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED)) {
      this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation client is not keeping up.', 5000);
      return false;
    }
    try {
      connection.ws.send(frame, error => {
        if (error && connection.phase !== 'closing') this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation updates are temporarily unavailable.', 5000);
      });
      return true;
    } catch {
      this.closeConnection(connection, 1013, 'PRESENTATION_UNAVAILABLE', 'Presentation updates are temporarily unavailable.', 5000);
      return false;
    }
  }

  private sendControl(connection: Connection, value: unknown): void {
    if (connection.ws.readyState !== WebSocket.OPEN || connection.ws.bufferedAmount > (this.options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED)) return;
    try { connection.ws.send(JSON.stringify(value)); } catch { /* Closing remains authoritative. */ }
  }

  private countPending(): number { return [...this.connections.values()].filter(item => item.phase === 'pending' || item.phase === 'verifying').length; }
  private countAuthenticated(): number { return [...this.connections.values()].filter(item => item.phase === 'initializing' || item.phase === 'ready').length; }
  private countParticipant(key: string): number {
    return [...this.connections.values()].filter(item => item.phase !== 'closing' && item.auth && `${item.auth.sessionId}:${item.auth.participantId}` === key).length;
  }

  private consumeToken(connection: Connection): boolean {
    const now = this.now();
    connection.tokens = Math.min(20, connection.tokens + Math.max(0, now - connection.tokenUpdatedAt) * 10 / 1000);
    connection.tokenUpdatedAt = now;
    if (connection.tokens < 1) return false;
    connection.tokens -= 1;
    return true;
  }

  private isClosing(connection: Connection): boolean { return connection.phase === 'closing'; }

  private timer(callback: () => void, delay: number, unref = false): NodeJS.Timeout {
    const timer = setTimeout(callback, Math.max(0, delay));
    if (unref) timer.unref();
    return timer;
  }

  private interval(callback: () => void, delay: number): NodeJS.Timeout {
    const timer = setInterval(callback, Math.max(1, delay));
    timer.unref();
    return timer;
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

export function presentationSocketsEnabled(): boolean {
  return process.env.PRESENTATION_ENABLED === 'true' && process.env.PRESENTATION_WEBSOCKET_ENABLED === 'true';
}

export function presentationUpgradePath(): string { return PRESENTATION_SOCKET_PATH; }

export function rejectPresentationUpgrade(socket: Duplex, status: number, reason: string, retryAfter?: number): void {
  rejectUpgrade(socket, status, reason, retryAfter);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string, retryAfter?: number): void {
  if (socket.destroyed) return;
  const retry = retryAfter === undefined ? '' : `Retry-After: ${retryAfter}\r\n`;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${retry}\r\n`);
}

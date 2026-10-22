/** Runtime wire contract for presentation WebSocket protocol v1. */
import { randomUUID } from 'node:crypto';
import { PresentationError, PRESENTATION_PROTOCOL_VERSION, validateUuid } from '../models/presentation.js';
import type { PresentationRole } from '../models/presentation.js';
import { validatePresentationPresence } from './presentationPresence.js';

export const PRESENTATION_SOCKET_PROTOCOL_VERSION = 1 as const;
export const PRESENTATION_SOCKET_PATH = '/api/public-improvements/presentation/ws';

export interface PresentationAuthentication {
  sessionId: string;
  participantId: string;
  participantToken: string;
}
export interface PresentationHeartbeatFrame {
  type: 'heartbeat';
  socketProtocolVersion: 1;
  id: string;
  serverTime: string;
}
export interface PresentationPresenceFrame {
  type: 'presence';
  socketProtocolVersion: 1;
  heartbeatId: string | null;
  presence: Record<string, unknown>;
}
export interface PresentationErrorFrame {
  type: 'error';
  socketProtocolVersion: 1;
  error: string;
  message: string;
  retryAfterMs?: number;
}

export function parseAuthentication(value: unknown): PresentationAuthentication {
  const frame = object(value);
  exactKeys(frame, ['type', 'socketProtocolVersion', 'protocolVersion', 'sessionId', 'participantId', 'participantToken']);
  if (frame.type !== 'authenticate') throw socketFault('Only an authentication frame is accepted before authorization.');
  if (frame.socketProtocolVersion !== PRESENTATION_SOCKET_PROTOCOL_VERSION) {
    throw new PresentationError(426, 'SOCKET_PROTOCOL_UNSUPPORTED', 'This presentation socket protocol version is not supported.');
  }
  if (frame.protocolVersion !== PRESENTATION_PROTOCOL_VERSION) {
    throw new PresentationError(426, 'PROTOCOL_UNSUPPORTED', 'This presentation protocol version is not supported.');
  }
  const sessionId = validateUuid(frame.sessionId, 'sessionId');
  const participantId = validateUuid(frame.participantId, 'participantId');
  if (typeof frame.participantToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(frame.participantToken)
    || Buffer.from(frame.participantToken, 'base64url').length !== 32) {
    throw new PresentationError(401, 'INVALID_SESSION_CREDENTIAL', 'This presentation link is no longer valid.');
  }
  return { sessionId, participantId, participantToken: frame.participantToken };
}

export function parsePresence(value: unknown, role: PresentationRole): { heartbeatId: string | null; presence: Record<string, unknown> } {
  const frame = object(value);
  exactKeys(frame, ['type', 'socketProtocolVersion', 'heartbeatId', 'presence']);
  if (frame.type !== 'presence' || frame.socketProtocolVersion !== PRESENTATION_SOCKET_PROTOCOL_VERSION) throw socketFault('Invalid presentation socket frame.');
  if (frame.heartbeatId !== null && (typeof frame.heartbeatId !== 'string' || frame.heartbeatId.length < 1 || frame.heartbeatId.length > 64)) throw socketFault('heartbeatId must be null or a bounded heartbeat identifier.');
  const presence = validatePresentationPresence(frame.presence, role);
  if (!presence) throw socketFault('Presence must be an object.');
  return { heartbeatId: frame.heartbeatId as string | null, presence: presence as Record<string, unknown> };
}

export function createHeartbeat(id: string = randomUUID(), now = Date.now()): PresentationHeartbeatFrame {
  return { type: 'heartbeat', socketProtocolVersion: 1, id, serverTime: new Date(now).toISOString() };
}

export function createSocketError(error: string, message: string, retryAfterMs?: number): PresentationErrorFrame {
  const frame: PresentationErrorFrame = { type: 'error', socketProtocolVersion: 1, error, message };
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) frame.retryAfterMs = Math.min(60_000, Math.max(0, retryAfterMs));
  return frame;
}

export function socketFault(message = 'Invalid presentation socket frame.'): PresentationError {
  return new PresentationError(400, 'INVALID_SOCKET_FRAME', message);
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw socketFault();
  return value as Record<string, any>;
}

function exactKeys(value: Record<string, any>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw socketFault('Socket frame contains missing or unsupported fields.');
}

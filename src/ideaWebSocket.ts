/** Authenticated, read-only idea WebSockets attached to the existing HTTP server. */
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { isOriginAllowed } from './middleware/cors.js';
import { verifyApplicationAccess } from './middleware/auth.js';
import { ideasMaintenanceEnabled } from './config/ideas.js';
import { IdeaNoticeService } from './services/ideaNoticeService.js';
import type { PresentationUpgradeHandler } from './presentationWebSocket.js';
import { rejectPresentationUpgrade } from './presentationWebSocket.js';
import { PRESENTATION_SOCKET_PATH } from './services/presentationSocketProtocol.js';

export interface IdeaSocketOptions {
  notices?: IdeaNoticeService;
  presentation?: PresentationUpgradeHandler;
  /** Enables both canonical and compatibility idea sockets. */
  ideasEnabled?: boolean;
  /** @deprecated Use ideasEnabled. */
  suggestionsEnabled?: boolean;
  verify?: typeof verifyApplicationAccess;
  authTimeoutMs?: number;
  readyTimeoutMs?: number;
  heartbeatMs?: number;
  sessionMs?: number;
  maxPending?: number;
  maxAuthenticated?: number;
}

interface Connection {
  contract: 'ideas' | 'suggestions';
  phase: 'pending' | 'verifying' | 'authenticated' | 'closing';
  alive: boolean;
  ready: boolean;
  timer?: NodeJS.Timeout;
  session?: NodeJS.Timeout;
  termination?: NodeJS.Timeout;
  unsubscribe?: () => void;
}

/** Returns an idempotent shutdown function; createApp remains a REST-only application factory. */
export function attachIdeaWebSocket(server: Server, options: IdeaSocketOptions = {}): () => Promise<void> {
  const notices = options.notices ?? new IdeaNoticeService();
  const verify = options.verify ?? verifyApplicationAccess;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const connections = new Map<WebSocket, Connection>();
  const contracts = new WeakMap<WebSocket, 'ideas' | 'suggestions'>();
  const ideasEnabled = options.ideasEnabled ?? options.suggestionsEnabled ?? true;
  let shuttingDown = false;
  let shutdown: Promise<void> | undefined;
  const count = (authenticated: boolean) => [...connections.values()].filter(c =>
    authenticated ? c.phase === 'authenticated' : c.phase === 'pending' || c.phase === 'verifying').length;
  const log = (event: string) => console.info(JSON.stringify({ event, pending: count(false), authenticated: count(true) }));
  const close = (ws: WebSocket, c: Connection, code: number, reason: string) => {
    if (c.phase === 'closing') return;
    c.phase = 'closing';
    clearTimeout(c.timer);
    clearTimeout(c.session);
    c.unsubscribe?.();
    c.unsubscribe = undefined;
    ws.close(code, reason);
    c.termination = setTimeout(() => ws.terminate(), 1000);
    c.termination.unref();
  };
  const send = (ws: WebSocket, c: Connection, value: unknown) => {
    if (c.phase !== 'authenticated' || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) {
      log('idea_socket_slow_client');
      close(ws, c, 1013, 'Client too slow; reconnect and refresh.');
      return;
    }
    ws.send(JSON.stringify(value), error => {
      if (error) close(ws, c, 1013, 'Send failed; reconnect and refresh.');
    });
  };
  const reject = (socket: Duplex, status: number, reason: string) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${status === 503 ? 'Retry-After: 5\r\n' : ''}\r\n`);
  };
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { reject(socket, 400, 'Bad Request'); return; }
    const contract = ['/api/suggestions/ws', '/api/public-improvements/suggestions/ws'].includes(url.pathname) ? 'suggestions' : 'ideas';
    const ideaPath = ['/api/ideas/ws', '/api/public-improvements/ideas/ws', '/api/suggestions/ws', '/api/public-improvements/suggestions/ws'].includes(url.pathname);
    const presentationPath = url.pathname === PRESENTATION_SOCKET_PATH;
    if (!ideaPath && !presentationPath) {
      reject(socket, 404, 'Not Found'); return;
    }
    if (url.search) { reject(socket, 400, 'Bad Request'); return; }
    if (!isOriginAllowed(req.headers.origin)) { reject(socket, 403, 'Forbidden'); return; }
    if (ideaPath && !ideasEnabled) { reject(socket, 404, 'Not Found'); return; }
    if (ideasMaintenanceEnabled()) { reject(socket, 503, 'Service Unavailable'); return; }
    if (presentationPath) {
      if (!options.presentation) { rejectPresentationUpgrade(socket, 404, 'Not Found'); return; }
      options.presentation.handleUpgrade(req, socket, head);
      return;
    }
    if (shuttingDown || count(false) >= (options.maxPending ?? 50) || count(true) >= (options.maxAuthenticated ?? 500)) {
      reject(socket, 503, 'Service Unavailable'); return;
    }
    try { wss.handleUpgrade(req, socket, head, ws => { contracts.set(ws, contract); wss.emit('connection', ws); }); }
    catch { socket.destroy(); }
  };
  server.on('upgrade', upgrade);
  wss.on('connection', (ws: WebSocket) => {
    const contract = contracts.get(ws) ?? 'ideas';
    const c: Connection = { contract, phase: 'pending', alive: true, ready: false };
    connections.set(ws, c);
    if (contract === 'suggestions') console.info(JSON.stringify({ event: 'ideas_legacy_socket_connected' }));
    c.timer = setTimeout(() => {
      log('idea_socket_authentication_timeout');
      close(ws, c, 4000, 'Authentication timed out.');
    }, options.authTimeoutMs ?? 5000);
    c.timer.unref();
    log('idea_socket_connected');
    ws.on('error', () => close(ws, c, 1013, 'Connection failed.'));
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => {
      clearTimeout(c.timer);
      clearTimeout(c.session);
      clearTimeout(c.termination);
      c.unsubscribe?.();
      c.phase = 'closing';
      connections.delete(ws);
      log('idea_socket_disconnected');
    });
    ws.on('message', async (data, binary) => {
      if (c.phase !== 'pending') {
        close(ws, c, 1008, 'Only the initial authentication message is supported.'); return;
      }
      let frame: { type?: unknown; apiKey?: unknown; appCheckToken?: unknown };
      try {
        const value: unknown = binary ? null : JSON.parse(data.toString());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        frame = value;
        if (frame.type !== 'authenticate' || typeof frame.apiKey !== 'string' || !frame.apiKey
          || (frame.appCheckToken !== undefined && typeof frame.appCheckToken !== 'string')) throw new Error();
      } catch { close(ws, c, 1008, 'Invalid authentication message.'); return; }
      c.phase = 'verifying';
      try {
        await verify({ apiKey: frame.apiKey as string, appCheckToken: frame.appCheckToken as string | undefined });
      } catch {
        log('idea_socket_authentication_failed');
        close(ws, c, 4001, 'Application verification failed.'); return;
      }
      if (c.phase !== 'verifying' || ws.readyState !== WebSocket.OPEN) return;
      clearTimeout(c.timer);
      if (shuttingDown || count(true) >= (options.maxAuthenticated ?? 500)) {
        close(ws, c, 1013, 'Server busy; retry later.'); return;
      }
      c.phase = 'authenticated';
      log('idea_socket_authenticated');
      c.timer = setTimeout(() => close(ws, c, 1013, 'Listener unavailable; retry later.'), options.readyTimeoutMs ?? 15000);
      c.timer.unref();
      c.session = setTimeout(() => close(ws, c, 4002, 'Renew application authentication.'), options.sessionMs ?? 30 * 60 * 1000);
      c.session.unref();
      const unsubscribe = notices.subscribe({
        ready: () => {
          if (c.phase !== 'authenticated') return;
          clearTimeout(c.timer);
          c.ready = true;
          send(ws, c, { type: 'ready', protocolVersion: contract === 'ideas' ? 2 : 1 });
        },
        notice: notice => {
          if (!c.ready) return;
          if (contract === 'ideas') { send(ws, c, notice); return; }
          send(ws, c, { type: notice.type.replace(/^idea\./, 'suggestion.'), suggestionId: notice.ideaId });
        },
        failed: () => close(ws, c, 1013, 'Listener failed; reconnect and refresh.'),
      });
      if (ws.readyState !== WebSocket.OPEN) unsubscribe();
      else c.unsubscribe = unsubscribe;
    });
  });
  const maintenance = setInterval(() => {
    if (!ideasMaintenanceEnabled()) return;
    options.presentation?.maintenance?.();
    for (const [ws, c] of connections) close(ws, c, 1013, 'Ideas are migrating; reconnect and refresh.');
  }, 1000);
  maintenance.unref();
  const heartbeat = setInterval(() => {
    for (const [ws, c] of connections) {
      if (c.phase === 'closing') continue;
      if (ideasMaintenanceEnabled()) { close(ws, c, 1013, 'Ideas are migrating; reconnect and refresh.'); continue; }
      if (!c.alive) { ws.terminate(); continue; }
      c.alive = false;
      ws.ping();
    }
  }, options.heartbeatMs ?? 30000);
  heartbeat.unref();

  return () => {
    if (shutdown) return shutdown;
    shuttingDown = true;
    clearInterval(maintenance);
    clearInterval(heartbeat);
    for (const [ws, c] of connections) close(ws, c, 1001, 'Server shutting down.');
    notices.stop();
    const presentationShutdown = options.presentation?.close() ?? Promise.resolve();
    shutdown = Promise.all([new Promise<void>(resolve => wss.close(() => resolve())), presentationShutdown]).then(() => {
      server.off('upgrade', upgrade);
    });
    return shutdown;
  };
}

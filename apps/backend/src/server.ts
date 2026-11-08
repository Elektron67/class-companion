// apps/backend/src/server.ts
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Database } from './db.ts';
import { SessionService } from './services/session.service.ts';
import { RosterService } from './services/roster.service.ts';
import { CheckService } from './services/check.service.ts';
import type {
  UpstreamMessage,
  DownstreamMessage,
  CheckSummary
} from '../../packages/shared-types/src/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_DIR = path.resolve(__dirname, '../../web-dashboard/public');
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../data/app.db');

export class AppServer {
  public server: http.Server;
  public wss: WebSocketServer;
  public db: Database;
  public sessionService: SessionService;
  public rosterService: RosterService;
  public checkService: CheckService;

  // Active WebSocket connections
  private instructorSockets: Map<string, Set<WebSocket>> = new Map(); // sessionId -> Set<WebSocket>
  private studentSockets: Map<string, WebSocket> = new Map(); // guestToken -> WebSocket
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(inMemoryDb = false) {
    this.db = new Database(inMemoryDb ? ':memory:' : DB_PATH);
    this.sessionService = new SessionService(this.db);
    this.rosterService = new RosterService(this.db);
    this.checkService = new CheckService(this.db, this.rosterService);

    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.setupWebSockets();
    this.startHeartbeatSweep();
  }

  private startHeartbeatSweep() {
    this.heartbeatInterval = setInterval(() => {
      for (const [sessionId, sockets] of this.instructorSockets.entries()) {
        if (sockets.size > 0) {
          const roster = this.rosterService.sweepStaleHeartbeats(sessionId, 15000);
          this.broadcastToInstructors(sessionId, {
            event: 'roster:update',
            payload: { students: roster }
          });
        }
      }
    }, 5000);
  }

  public close(): Promise<void> {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.server.close(() => resolve());
      });
    });
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';

    // CORS headers for local extension and dashboard development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      this.handleApi(req, res, url, method);
      return;
    }

    // Serve static dashboard files
    this.serveStatic(req, res, url);
  }

  private async handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    method: string
  ) {
    const sendJson = (status: number, data: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      // 1. Create Session: POST /api/v1/sessions
      if (method === 'POST' && url.pathname === '/api/v1/sessions') {
        const body = await this.readJsonBody(req);
        if (!body.title || !body.meetingUrl) {
          return sendJson(400, { error: 'TITLE_AND_MEETING_URL_REQUIRED' });
        }
        const session = this.sessionService.createSession(
          body.instructorId || 'demo_instructor',
          body.title,
          body.meetingUrl
        );
        return sendJson(201, session);
      }

      // 2. Join Session: POST /api/v1/sessions/join
      if (method === 'POST' && url.pathname === '/api/v1/sessions/join') {
        const body = await this.readJsonBody(req);
        if (!body.meetingCode || !body.studentName) {
          return sendJson(400, { error: 'MEETING_CODE_AND_NAME_REQUIRED' });
        }

        const normalizedInputMeet = this.sessionService.normalizeMeetingCode(body.meetingCode);
        let session = null;

        // Path A: Reconnection with existing guestToken
        if (body.guestToken) {
          const existingGuest = this.rosterService.getGuestByToken(body.guestToken);
          if (existingGuest) {
            const guestSession = this.sessionService.getSessionById(existingGuest.sessionId);
            if (guestSession && guestSession.status === 'ACTIVE') {
              if (guestSession.meetingCode === normalizedInputMeet) {
                session = guestSession;
              }
            }
          }
        }

        // Path B: New Join or fallback via joinCode
        if (!session) {
          if (!body.joinCode) {
            return sendJson(400, { error: 'JOIN_CODE_REQUIRED' });
          }
          session = this.sessionService.getSessionByJoinCode(body.joinCode);
          if (!session) {
            return sendJson(404, { code: 'INVALID_JOIN_CODE', message: 'Join code is invalid or session has ended.' });
          }

          if (normalizedInputMeet !== session.meetingCode) {
            return sendJson(403, {
              code: 'MEETING_MISMATCH',
              message: `This join code is registered for Google Meet (${session.meetingCode}), not (${normalizedInputMeet}).`
            });
          }
        }

        const { guest, isReconnection } = this.rosterService.joinOrReconnect(
          session.id,
          body.studentName,
          body.guestToken
        );

        // Notify instructor
        const updatedRoster = this.rosterService.getRosterForSession(session.id);
        this.broadcastToInstructors(session.id, {
          event: 'roster:update',
          payload: { students: updatedRoster }
        });

        return sendJson(200, {
          session: {
            id: session.id,
            title: session.title,
            meetingCode: session.meetingCode,
            joinCode: session.joinCode
          },
          guest,
          isReconnection
        });
      }

      // 3. Get Session Details & Roster: GET /api/v1/sessions/:id
      const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (method === 'GET' && sessionMatch) {
        const sessionId = sessionMatch[1];
        const session = this.sessionService.getSessionById(sessionId);
        if (!session) return sendJson(404, { error: 'SESSION_NOT_FOUND' });

        const roster = this.rosterService.getRosterForSession(sessionId);
        const activeCheck = this.checkService.getActiveCheck(sessionId);
        const checkSummary = activeCheck ? this.checkService.getCheckSummary(activeCheck.id, true) : null;

        return sendJson(200, {
          session,
          roster,
          activeCheck: checkSummary
        });
      }

      // 4. Trigger Participation Check: POST /api/v1/sessions/:id/checks
      const checkMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/checks$/);
      if (method === 'POST' && checkMatch) {
        const sessionId = checkMatch[1];
        const body = await this.readJsonBody(req);
        if (!body.targetPhrase) {
          return sendJson(400, { error: 'TARGET_PHRASE_REQUIRED' });
        }

        const { check, summary } = this.checkService.startCheck(
          sessionId,
          body.targetPhrase,
          (finalizedSummary) => {
            // Broadcast finalization to instructor and students
            this.broadcastToInstructors(sessionId, {
              event: 'check:finalized',
              payload: finalizedSummary
            });
            this.broadcastToStudents(sessionId, {
              event: 'check:ack',
              payload: {
                checkId: check.id,
                status: 'EXPIRED',
                message: 'Check window has closed.'
              }
            });
          }
        );

        // Broadcast check:started to all students in this session
        this.broadcastToStudents(sessionId, {
          event: 'check:started',
          payload: {
            checkId: check.id,
            targetPhrase: check.targetPhrase,
            startedAt: check.startedAt,
            deadlineAt: check.deadlineAt,
            durationSeconds: 20
          }
        });

        // Broadcast to instructors
        this.broadcastToInstructors(sessionId, {
          event: 'check:progress',
          payload: {
            checkId: check.id,
            snapshotTotal: summary.snapshotTotal,
            eligibleTotal: summary.eligibleTotal,
            respondedCount: 0,
            didNotRespondCount: 0,
            excusedCount: summary.excusedCount,
            pendingCount: summary.pendingCount,
            remainingMs: 20000
          }
        });

        return sendJson(201, { check, summary });
      }

      // 5. Submit Check via HTTP (Fallback): POST /api/v1/sessions/:id/checks/:checkId/submit
      const submitMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/checks\/([^/]+)\/submit$/);
      if (method === 'POST' && submitMatch) {
        const sessionId = submitMatch[1];
        const checkId = submitMatch[2];
        const body = await this.readJsonBody(req);
        if (!body.guestToken || !body.inputPhrase) {
          return sendJson(400, { error: 'GUEST_TOKEN_AND_INPUT_PHRASE_REQUIRED' });
        }

        const resOutcome = this.checkService.submitResponse(checkId, body.guestToken, body.inputPhrase);
        if (resOutcome.status === 'SUCCESS' && resOutcome.summary) {
          this.broadcastToInstructors(sessionId, {
            event: 'check:progress',
            payload: {
              checkId,
              snapshotTotal: resOutcome.summary.snapshotTotal,
              eligibleTotal: resOutcome.summary.eligibleTotal,
              respondedCount: resOutcome.summary.respondedCount,
              didNotRespondCount: resOutcome.summary.didNotRespondCount,
              excusedCount: resOutcome.summary.excusedCount,
              pendingCount: resOutcome.summary.pendingCount,
              remainingMs: Math.max(0, resOutcome.summary.deadlineAt - Date.now())
            }
          });
        }
        return sendJson(200, resOutcome);
      }

      // 6. End Session: POST /api/v1/sessions/:id/end
      const endMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/end$/);
      if (method === 'POST' && endMatch) {
        const sessionId = endMatch[1];
        const body = await this.readJsonBody(req);
        const session = this.sessionService.endSession(sessionId, body.instructorId || 'demo_instructor');

        this.broadcastToInstructors(sessionId, {
          event: 'session:ended',
          payload: { message: 'Session has ended.' }
        });
        this.broadcastToStudents(sessionId, {
          event: 'session:ended',
          payload: { message: 'Class session has ended. Your notes remain saved.' }
        });

        return sendJson(200, session);
      }

      // 7. Eject Guest: POST /api/v1/sessions/:id/roster/:guestId/eject
      const ejectMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/roster\/([^/]+)\/eject$/);
      if (method === 'POST' && ejectMatch) {
        const sessionId = ejectMatch[1];
        const guestId = ejectMatch[2];
        const guest = this.rosterService.getGuestById(guestId);

        if (guest) {
          const ws = this.studentSockets.get(guest.guestToken);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              event: 'session:ejected',
              payload: { message: 'You have been removed from this class session by the instructor.' }
            }));
            ws.close(4003, 'EJECTED_BY_INSTRUCTOR');
          }
          this.studentSockets.delete(guest.guestToken);
        }

        const success = this.rosterService.ejectGuest(sessionId, guestId);
        const updatedRoster = this.rosterService.getRosterForSession(sessionId);
        this.broadcastToInstructors(sessionId, {
          event: 'roster:update',
          payload: { students: updatedRoster }
        });

        return sendJson(200, { success });
      }

      // Not found
      return sendJson(404, { error: 'NOT_FOUND' });
    } catch (err: any) {
      return sendJson(500, { error: err.message || 'INTERNAL_ERROR' });
    }
  }

  private setupWebSockets() {
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleWsConnection(ws, url);
      });
    });
  }

  private handleWsConnection(ws: WebSocket, url: URL) {
    const role = url.searchParams.get('role'); // 'instructor' | 'student'
    const sessionId = url.searchParams.get('sessionId');
    const guestToken = url.searchParams.get('guestToken');

    if (role === 'instructor' && sessionId) {
      if (!this.instructorSockets.has(sessionId)) {
        this.instructorSockets.set(sessionId, new Set());
      }
      this.instructorSockets.get(sessionId)!.add(ws);

      // Send initial roster snapshot to instructor
      const roster = this.rosterService.getRosterForSession(sessionId);
      ws.send(JSON.stringify({ event: 'roster:update', payload: { students: roster } }));

      ws.on('close', () => {
        const set = this.instructorSockets.get(sessionId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) this.instructorSockets.delete(sessionId);
        }
      });
      return;
    }

    if (role === 'student' && guestToken) {
      const guest = this.rosterService.getGuestByToken(guestToken);
      if (!guest) {
        ws.close(4001, 'INVALID_GUEST_TOKEN');
        return;
      }

      this.studentSockets.set(guestToken, ws);
      this.rosterService.setConnectionStatus(guestToken, 'CONNECTED');

      // Broadcast connected state
      this.broadcastToInstructors(guest.sessionId, {
        event: 'roster:update',
        payload: { students: this.rosterService.getRosterForSession(guest.sessionId) }
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as UpstreamMessage;
          this.handleStudentMessage(ws, guestToken, guest.sessionId, msg);
        } catch (e) {
          // Ignore invalid JSON frames
        }
      });

      ws.on('close', () => {
        this.studentSockets.delete(guestToken);
        this.rosterService.setConnectionStatus(guestToken, 'DISCONNECTED');
        this.broadcastToInstructors(guest.sessionId, {
          event: 'roster:update',
          payload: { students: this.rosterService.getRosterForSession(guest.sessionId) }
        });
      });
      return;
    }

    // Invalid connection params
    ws.close(4000, 'UNAUTHORIZED_PARAMS');
  }

  private handleStudentMessage(
    ws: WebSocket,
    guestToken: string,
    sessionId: string,
    msg: UpstreamMessage
  ) {
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ event: 'pong' }));
      return;
    }

    if (msg.type === 'telemetry:update') {
      const updated = this.rosterService.updateTelemetry(guestToken, msg.payload.focusState);
      if (updated) {
        this.broadcastToInstructors(sessionId, {
          event: 'roster:update',
          payload: { students: this.rosterService.getRosterForSession(sessionId) }
        });
      }
      return;
    }

    if (msg.type === 'afk:request') {
      const activeCheck = this.checkService.getActiveCheck(sessionId);
      if (msg.payload.action === 'START') {
        const res = this.rosterService.requestAFK(guestToken, Boolean(activeCheck));
        if (res.success && res.guest) {
          ws.send(JSON.stringify({
            event: 'afk:ack',
            payload: {
              success: true,
              isActive: true,
              afkUsesConsumed: res.guest.afkUsesConsumed,
              afkExpiresAt: res.guest.afkExpiresAt,
              message: 'AFK period started. You have 5 minutes.'
            }
          }));
          this.broadcastToInstructors(sessionId, {
            event: 'roster:update',
            payload: { students: this.rosterService.getRosterForSession(sessionId) }
          });
        } else {
          ws.send(JSON.stringify({
            event: 'afk:ack',
            payload: {
              success: false,
              isActive: false,
              afkUsesConsumed: 0,
              message: res.error === 'CHECK_IN_PROGRESS'
                ? 'Cannot declare AFK while a participation check is active.'
                : res.error === 'LIMIT_REACHED'
                ? 'You have reached the maximum of 3 AFK breaks for this class.'
                : 'Unable to start AFK.'
            }
          }));
        }
      } else if (msg.payload.action === 'END') {
        const res = this.rosterService.endAFKEarly(guestToken);
        if (res.success && res.guest) {
          ws.send(JSON.stringify({
            event: 'afk:ack',
            payload: {
              success: true,
              isActive: false,
              afkUsesConsumed: res.guest.afkUsesConsumed,
              afkExpiresAt: null,
              message: 'Returned from AFK early.'
            }
          }));
          this.broadcastToInstructors(sessionId, {
            event: 'roster:update',
            payload: { students: this.rosterService.getRosterForSession(sessionId) }
          });
        }
      }
      return;
    }

    if (msg.type === 'check:submit') {
      const resOutcome = this.checkService.submitResponse(
        msg.payload.checkId,
        guestToken,
        msg.payload.inputPhrase
      );

      ws.send(JSON.stringify({
        event: 'check:ack',
        payload: {
          checkId: msg.payload.checkId,
          status: resOutcome.status,
          message: resOutcome.message,
          attempts: resOutcome.attempts
        }
      }));

      if (resOutcome.status === 'SUCCESS' && resOutcome.summary) {
        this.broadcastToInstructors(sessionId, {
          event: 'check:progress',
          payload: {
            checkId: msg.payload.checkId,
            snapshotTotal: resOutcome.summary.snapshotTotal,
            eligibleTotal: resOutcome.summary.eligibleTotal,
            respondedCount: resOutcome.summary.respondedCount,
            didNotRespondCount: resOutcome.summary.didNotRespondCount,
            excusedCount: resOutcome.summary.excusedCount,
            pendingCount: resOutcome.summary.pendingCount,
            remainingMs: Math.max(0, resOutcome.summary.deadlineAt - Date.now())
          }
        });
      }
    }
  }

  private broadcastToInstructors(sessionId: string, message: DownstreamMessage) {
    const sockets = this.instructorSockets.get(sessionId);
    if (!sockets) return;
    const str = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(str);
      }
    }
  }

  private broadcastToStudents(sessionId: string, message: DownstreamMessage) {
    const roster = this.rosterService.getRosterForSession(sessionId);
    const str = JSON.stringify(message);
    for (const guest of roster) {
      const ws = this.studentSockets.get(guest.guestToken);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(str);
      }
    }
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    let filePath = path.join(DASHBOARD_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(DASHBOARD_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  private readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => {
        if (!data.trim()) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('INVALID_JSON'));
        }
      });
      req.on('error', reject);
    });
  }
}

// Self-starting when executed directly
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
  const app = new AppServer();
  app.server.listen(port, () => {
    console.log(`[MeetMonitor API & WebSocket Gateway] Running on http://localhost:${port}`);
    console.log(`[Instructor Dashboard] Accessible on http://localhost:${port}`);
  });
}


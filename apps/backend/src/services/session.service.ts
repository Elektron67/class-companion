// apps/backend/src/services/session.service.ts
import { randomUUID } from 'node:crypto';
import type { Database } from '../db.ts';
import type { ClassSession } from '../../../../packages/shared-types/src/types.ts';

// Alphanumeric alphabet excluding ambiguous characters (0, O, 1, I)
const JOIN_CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export class SessionService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  generateJoinCode(): string {
    let code = '';
    for (let i = 0; i < 6; i++) {
      const idx = Math.floor(Math.random() * JOIN_CODE_CHARS.length);
      code += JOIN_CODE_CHARS[idx];
    }
    return code;
  }

  normalizeMeetingCode(urlOrCode: string): string {
    const cleaned = urlOrCode.trim().toLowerCase();
    const match = cleaned.match(/(?:^|\/)([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|\?)/);
    if (!match) {
      throw new Error('INVALID_MEETING_CODE: Format must be xxx-yyyy-zzz');
    }
    return match[1];
  }

  createSession(instructorId: string, title: string, meetingUrlOrCode: string): ClassSession {
    const meetingCode = this.normalizeMeetingCode(meetingUrlOrCode);
    const id = randomUUID();
    let joinCode = this.generateJoinCode();

    // Ensure join code uniqueness among active sessions
    let attempts = 0;
    while (attempts < 5) {
      const existing = this.db.raw
        .prepare('SELECT id FROM sessions WHERE join_code = ? AND status = ?')
        .get(joinCode, 'ACTIVE');
      if (!existing) break;
      joinCode = this.generateJoinCode();
      attempts++;
    }

    const startedAt = Date.now();
    this.db.raw.prepare(`
      INSERT INTO sessions (id, instructor_id, meeting_code, title, join_code, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
    `).run(id, instructorId, meetingCode, title.trim(), joinCode, startedAt);

    return {
      id,
      instructorId,
      meetingCode,
      title: title.trim(),
      joinCode,
      status: 'ACTIVE',
      startedAt
    };
  }

  getSessionById(sessionId: string): ClassSession | null {
    const row = this.db.raw.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id,
      instructorId: row.instructor_id,
      meetingCode: row.meeting_code,
      title: row.title,
      joinCode: row.join_code,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at || undefined
    };
  }

  getSessionByJoinCode(joinCode: string): ClassSession | null {
    const cleanCode = joinCode.trim().toUpperCase();
    const row = this.db.raw.prepare('SELECT * FROM sessions WHERE join_code = ? AND status = ?').get(cleanCode, 'ACTIVE') as any;
    if (!row) return null;
    return {
      id: row.id,
      instructorId: row.instructor_id,
      meetingCode: row.meeting_code,
      title: row.title,
      joinCode: row.join_code,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at || undefined
    };
  }

  endSession(sessionId: string, instructorId: string): ClassSession {
    const session = this.getSessionById(sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    if (session.instructorId !== instructorId) throw new Error('UNAUTHORIZED');

    const endedAt = Date.now();
    this.db.raw.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?').run('ENDED', endedAt, sessionId);
    session.status = 'ENDED';
    session.endedAt = endedAt;
    return session;
  }
}

// apps/backend/src/services/check.service.ts
import { randomUUID } from 'node:crypto';
import type { Database } from '../db.ts';
import type { RosterService } from './roster.service.ts';
import type {
  ParticipationCheck,
  CheckSummary,
  CheckSnapshotRecord
} from '../../../../packages/shared-types/src/types.ts';
import { normalizePhrase, phrasesMatch } from '../../../../packages/string-normalizer/src/index.ts';

const CHECK_DURATION_MS = 20 * 1000; // Exactly 20.000 seconds
const NETWORK_GRACE_WINDOW_MS = 500; // 500ms network transit tolerance

export class CheckService {
  private activeTimers: Map<string, NodeJS.Timeout> = new Map();
  private db: Database;
  private rosterService: RosterService;

  constructor(
    db: Database,
    rosterService: RosterService
  ) {
    this.db = db;
    this.rosterService = rosterService;
  }

  getActiveCheck(sessionId: string): ParticipationCheck | null {
    const row = this.db.raw.prepare(`
      SELECT * FROM participation_checks
      WHERE session_id = ? AND status = 'OPEN'
    `).get(sessionId) as any;

    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      targetPhrase: row.target_phrase,
      targetPhraseNormalized: row.target_phrase_normalized,
      startedAt: row.started_at,
      deadlineAt: row.deadline_at,
      status: row.status
    };
  }

  startCheck(
    sessionId: string,
    targetPhrase: string,
    onFinalized?: (summary: CheckSummary) => void
  ): { check: ParticipationCheck; summary: CheckSummary } {
    const cleanPhrase = targetPhrase.trim();
    if (!cleanPhrase) throw new Error('TARGET_PHRASE_REQUIRED');

    // Rule: Only one active check per session for MVP
    const existing = this.getActiveCheck(sessionId);
    if (existing) {
      throw new Error('CHECK_ALREADY_ACTIVE');
    }

    const checkId = randomUUID();
    const startedAt = Date.now();
    const deadlineAt = startedAt + CHECK_DURATION_MS;
    const normalized = normalizePhrase(cleanPhrase);

    this.db.raw.prepare(`
      INSERT INTO participation_checks (
        id, session_id, target_phrase, target_phrase_normalized, started_at, deadline_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN')
    `).run(checkId, sessionId, cleanPhrase, normalized, startedAt, deadlineAt);

    // Freeze Snapshot at T_start
    const roster = this.rosterService.getRosterForSession(sessionId);
    let excusedCount = 0;
    let pendingCount = 0;

    for (const student of roster) {
      const isAFK = student.afkExpiresAt && student.afkExpiresAt > startedAt;
      const result = isAFK ? 'EXCUSED_AFK' : 'PENDING';
      if (isAFK) excusedCount++;
      else pendingCount++;

      this.db.raw.prepare(`
        INSERT INTO check_snapshots (
          id, check_id, roster_guest_id, student_name, result, total_attempts
        ) VALUES (?, ?, ?, ?, ?, 0)
      `).run(randomUUID(), checkId, student.id, student.displayName, result);
    }

    const snapshotTotal = roster.length;
    const eligibleTotal = snapshotTotal - excusedCount;

    const check: ParticipationCheck = {
      id: checkId,
      sessionId,
      targetPhrase: cleanPhrase,
      targetPhraseNormalized: normalized,
      startedAt,
      deadlineAt,
      status: 'OPEN'
    };

    const summary: CheckSummary = {
      checkId,
      targetPhrase: cleanPhrase,
      startedAt,
      deadlineAt,
      status: 'OPEN',
      snapshotTotal,
      eligibleTotal,
      respondedCount: 0,
      didNotRespondCount: 0,
      excusedCount,
      pendingCount
    };

    // Schedule authoritative server-side deadline
    const timeout = setTimeout(() => {
      this.finalizeCheck(checkId);
      if (onFinalized) {
        const finalSummary = this.getCheckSummary(checkId, true);
        if (finalSummary) onFinalized(finalSummary);
      }
    }, CHECK_DURATION_MS + NETWORK_GRACE_WINDOW_MS);

    this.activeTimers.set(checkId, timeout);

    return { check, summary };
  }

  submitResponse(
    checkId: string,
    guestToken: string,
    rawInput: string
  ): {
    status: 'SUCCESS' | 'INCORRECT' | 'EXPIRED' | 'DUPLICATE' | 'INELIGIBLE';
    message: string;
    attempts: number;
    summary?: CheckSummary;
  } {
    const check = this.db.raw.prepare(`
      SELECT * FROM participation_checks WHERE id = ?
    `).get(checkId) as any;

    if (!check) throw new Error('CHECK_NOT_FOUND');

    const guest = this.rosterService.getGuestByToken(guestToken);
    if (!guest) throw new Error('GUEST_NOT_FOUND');

    // Find snapshot record
    const snapshot = this.db.raw.prepare(`
      SELECT * FROM check_snapshots
      WHERE check_id = ? AND roster_guest_id = ?
    `).get(checkId, guest.id) as any;

    // Late joiners not in snapshot
    if (!snapshot) {
      return { status: 'INELIGIBLE', message: 'You joined after this check started.', attempts: 0 };
    }

    // Already excused because of AFK
    if (snapshot.result === 'EXCUSED_AFK') {
      return { status: 'INELIGIBLE', message: 'You were excused from this check due to AFK.', attempts: 0 };
    }

    const now = Date.now();
    // Authoritative deadline check
    if (now > check.deadline_at + NETWORK_GRACE_WINDOW_MS || check.status !== 'OPEN') {
      return { status: 'EXPIRED', message: 'Time expired. Response cannot be accepted.', attempts: snapshot.total_attempts };
    }

    // Reject duplicate correct submission
    if (snapshot.result === 'RESPONDED') {
      return { status: 'DUPLICATE', message: 'Your response was already recorded.', attempts: snapshot.total_attempts };
    }

    const isMatch = phrasesMatch(rawInput, check.target_phrase);
    const newAttempts = snapshot.total_attempts + 1;

    // Record submission attempt
    this.db.raw.prepare(`
      INSERT INTO check_submissions (id, snapshot_id, raw_input, is_match, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), snapshot.id, rawInput.slice(0, 255), isMatch ? 1 : 0, now);

    if (isMatch) {
      this.db.raw.prepare(`
        UPDATE check_snapshots
        SET result = 'RESPONDED', total_attempts = ?, final_submitted_at = ?
        WHERE id = ?
      `).run(newAttempts, now, snapshot.id);

      const summary = this.getCheckSummary(checkId, false)!;
      return { status: 'SUCCESS', message: 'Correct response recorded.', attempts: newAttempts, summary };
    } else {
      this.db.raw.prepare(`
        UPDATE check_snapshots
        SET total_attempts = ?
        WHERE id = ?
      `).run(newAttempts, snapshot.id);

      return {
        status: 'INCORRECT',
        message: 'Incorrect phrase. Check spelling and retry before time expires.',
        attempts: newAttempts
      };
    }
  }

  finalizeCheck(checkId: string): CheckSummary | null {
    const timer = this.activeTimers.get(checkId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(checkId);
    }

    // Transition all remaining PENDING records in snapshot to DID_NOT_RESPOND
    this.db.raw.prepare(`
      UPDATE check_snapshots
      SET result = 'DID_NOT_RESPOND'
      WHERE check_id = ? AND result = 'PENDING'
    `).run(checkId);

    this.db.raw.prepare(`
      UPDATE participation_checks SET status = 'FINALIZED' WHERE id = ?
    `).run(checkId);

    return this.getCheckSummary(checkId, true);
  }

  getCheckSummary(checkId: string, includeNonResponders: boolean = false): CheckSummary | null {
    const check = this.db.raw.prepare(`
      SELECT * FROM participation_checks WHERE id = ?
    `).get(checkId) as any;

    if (!check) return null;

    const snapshots = this.db.raw.prepare(`
      SELECT * FROM check_snapshots WHERE check_id = ?
    `).all(checkId) as any[];

    let respondedCount = 0;
    let didNotRespondCount = 0;
    let excusedCount = 0;
    let pendingCount = 0;
    const nonResponders: string[] = [];

    for (const s of snapshots) {
      if (s.result === 'RESPONDED') respondedCount++;
      else if (s.result === 'DID_NOT_RESPOND') {
        didNotRespondCount++;
        nonResponders.push(s.student_name);
      } else if (s.result === 'EXCUSED_AFK') excusedCount++;
      else if (s.result === 'PENDING') pendingCount++;
    }

    const snapshotTotal = snapshots.length;
    const eligibleTotal = snapshotTotal - excusedCount;

    return {
      checkId: check.id,
      targetPhrase: check.target_phrase,
      startedAt: check.started_at,
      deadlineAt: check.deadline_at,
      status: check.status,
      snapshotTotal,
      eligibleTotal,
      respondedCount,
      didNotRespondCount,
      excusedCount,
      pendingCount,
      nonResponders: includeNonResponders ? nonResponders : undefined
    };
  }

  getSnapshotsForCheck(checkId: string): CheckSnapshotRecord[] {
    const rows = this.db.raw.prepare(`
      SELECT * FROM check_snapshots WHERE check_id = ?
    `).all(checkId) as any[];

    return rows.map(r => ({
      id: r.id,
      checkId: r.check_id,
      rosterGuestId: r.roster_guest_id,
      studentName: r.student_name,
      result: r.result,
      totalAttempts: r.total_attempts,
      finalSubmittedAt: r.final_submitted_at
    }));
  }
}

// apps/backend/tests/services.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db.ts';
import { SessionService } from '../src/services/session.service.ts';
import { RosterService } from '../src/services/roster.service.ts';
import { CheckService } from '../src/services/check.service.ts';

describe('Backend Services & Participation Engine', () => {
  let db: Database;
  let sessionService: SessionService;
  let rosterService: RosterService;
  let checkService: CheckService;

  beforeEach(() => {
    db = new Database(':memory:');
    sessionService = new SessionService(db);
    rosterService = new RosterService(db);
    checkService = new CheckService(db, rosterService);
  });

  describe('Session Lifecycle & Code Validation', () => {
    it('creates a session with valid meeting code format', () => {
      const session = sessionService.createSession('inst_1', 'Biology 101', 'https://meet.google.com/abc-defg-hij');
      assert.equal(session.meetingCode, 'abc-defg-hij');
      assert.equal(session.title, 'Biology 101');
      assert.equal(session.status, 'ACTIVE');
      assert.equal(session.joinCode.length, 6);
    });

    it('rejects invalid meeting code format', () => {
      assert.throws(() => {
        sessionService.createSession('inst_1', 'Math', 'https://google.com/search?q=test');
      }, /INVALID_MEETING_CODE/);
    });

    it('retrieves active session by join code and rejects after session ends', () => {
      const session = sessionService.createSession('inst_1', 'Physics', 'abc-defg-hij');
      const found = sessionService.getSessionByJoinCode(session.joinCode);
      assert.ok(found);
      assert.equal(found.id, session.id);

      sessionService.endSession(session.id, 'inst_1');
      const afterEnd = sessionService.getSessionByJoinCode(session.joinCode);
      assert.equal(afterEnd, null); // Expired join code
    });
  });

  describe('Roster Management, Guest Tokens & Reconnection', () => {
    it('generates a guestToken and creates a single roster entry', () => {
      const session = sessionService.createSession('inst_1', 'History', 'abc-defg-hij');
      const { guest, isReconnection } = rosterService.joinOrReconnect(session.id, 'Alex Rivera');
      assert.equal(isReconnection, false);
      assert.equal(guest.displayName, 'Alex Rivera');
      assert.ok(guest.guestToken);

      const roster = rosterService.getRosterForSession(session.id);
      assert.equal(roster.length, 1);
    });

    it('reconnects with existing guestToken without creating duplicate roster entry', () => {
      const session = sessionService.createSession('inst_1', 'History', 'abc-defg-hij');
      const { guest: firstJoin } = rosterService.joinOrReconnect(session.id, 'Alex Rivera');

      // Reconnect with same token
      const { guest: reconnect, isReconnection } = rosterService.joinOrReconnect(
        session.id,
        'Alex Rivera',
        firstJoin.guestToken
      );

      assert.equal(isReconnection, true);
      assert.equal(reconnect.id, firstJoin.id);
      assert.equal(reconnect.guestToken, firstJoin.guestToken);

      const roster = rosterService.getRosterForSession(session.id);
      assert.equal(roster.length, 1);
    });

    it('flags duplicate display names and disambiguates with suffix', () => {
      const session = sessionService.createSession('inst_1', 'History', 'abc-defg-hij');
      const { guest: first } = rosterService.joinOrReconnect(session.id, 'Alex Rivera');
      const { guest: second } = rosterService.joinOrReconnect(session.id, 'Alex Rivera');

      assert.equal(first.displayName, 'Alex Rivera');
      assert.equal(second.displayName, 'Alex Rivera #2');
      assert.equal(second.isDuplicateName, true);

      const roster = rosterService.getRosterForSession(session.id);
      assert.equal(roster.length, 2);
    });

    it('updates focus telemetry and sweeps stale heartbeats to UNKNOWN', () => {
      const session = sessionService.createSession('inst_1', 'History', 'abc-defg-hij');
      const { guest } = rosterService.joinOrReconnect(session.id, 'Alex Rivera');

      rosterService.updateTelemetry(guest.guestToken, 'UNFOCUSED');
      let current = rosterService.getGuestByToken(guest.guestToken);
      assert.equal(current?.focusState, 'UNFOCUSED');

      // Simulate stale heartbeat by backdating last_heartbeat_at
      db.raw.prepare('UPDATE roster_guests SET last_heartbeat_at = ? WHERE id = ?').run(Date.now() - 20000, guest.id);
      rosterService.sweepStaleHeartbeats(session.id, 15000);

      current = rosterService.getGuestByToken(guest.guestToken);
      assert.equal(current?.connectionStatus, 'UNKNOWN');
    });
  });

  describe('AFK State Machine & Quota Enforcement', () => {
    it('allows declaring AFK up to 3 times and rejects 4th attempt', () => {
      const session = sessionService.createSession('inst_1', 'Bio', 'abc-defg-hij');
      const { guest } = rosterService.joinOrReconnect(session.id, 'Casey Jordan');

      for (let i = 1; i <= 3; i++) {
        const res = rosterService.requestAFK(guest.guestToken, false);
        assert.equal(res.success, true);
        assert.equal(res.guest?.afkUsesConsumed, i);
        assert.ok(res.guest?.afkExpiresAt);

        // Student clicks "I'm back" early
        const returnRes = rosterService.endAFKEarly(guest.guestToken);
        assert.equal(returnRes.success, true);
        assert.equal(returnRes.guest?.afkExpiresAt, null);
        assert.equal(returnRes.guest?.afkUsesConsumed, i);
      }

      // 4th attempt must be rejected
      const fourth = rosterService.requestAFK(guest.guestToken, false);
      assert.equal(fourth.success, false);
      assert.equal(fourth.error, 'LIMIT_REACHED');
    });

    it('rejects AFK declaration if check is already in progress', () => {
      const session = sessionService.createSession('inst_1', 'Bio', 'abc-defg-hij');
      const { guest } = rosterService.joinOrReconnect(session.id, 'Casey Jordan');

      const res = rosterService.requestAFK(guest.guestToken, true); // checkInProgress = true
      assert.equal(res.success, false);
      assert.equal(res.error, 'CHECK_IN_PROGRESS');
    });
  });

  describe('Participation Check 20s Engine & Reconciliation', () => {
    it('reconciles snapshot counts and correctly excuses AFK students', () => {
      const session = sessionService.createSession('inst_1', 'Bio', 'abc-defg-hij');
      const { guest: student1 } = rosterService.joinOrReconnect(session.id, 'Student 1');
      const { guest: student2 } = rosterService.joinOrReconnect(session.id, 'Student 2');
      const { guest: student3 } = rosterService.joinOrReconnect(session.id, 'Student 3');

      // Student 1 declares AFK before check starts
      rosterService.requestAFK(student1.guestToken, false);

      const { check, summary } = checkService.startCheck(session.id, 'Photosynthesis in Plants');
      assert.equal(summary.snapshotTotal, 3);
      assert.equal(summary.excusedCount, 1);
      assert.equal(summary.eligibleTotal, 2);
      assert.equal(summary.pendingCount, 2);

      // Student 2 submits correct answer with varied spacing and casing
      const sub2 = checkService.submitResponse(
        check.id,
        student2.guestToken,
        '  photosynthesis   in   plants  '
      );
      assert.equal(sub2.status, 'SUCCESS');

      // Student 3 submits wrong answer first, gets retry feedback, then does not submit
      const wrong = checkService.submitResponse(
        check.id,
        student3.guestToken,
        'cellular respiration'
      );
      assert.equal(wrong.status, 'INCORRECT');
      assert.equal(wrong.attempts, 1);

      // Student 1 (AFK) attempts to submit: must be ineligible
      const afkSub = checkService.submitResponse(
        check.id,
        student1.guestToken,
        'Photosynthesis in Plants'
      );
      assert.equal(afkSub.status, 'INELIGIBLE');

      // Finalize check (simulates 20s deadline elapsed)
      const finalized = checkService.finalizeCheck(check.id);
      assert.ok(finalized);
      assert.equal(finalized.snapshotTotal, 3);
      assert.equal(finalized.respondedCount, 1); // Student 2
      assert.equal(finalized.didNotRespondCount, 1); // Student 3
      assert.equal(finalized.excusedCount, 1); // Student 1
      assert.equal(finalized.pendingCount, 0);

      // Mathematical Reconciliation: Snapshot Total === Responded + Did Not Respond + Excused
      assert.equal(
        finalized.snapshotTotal,
        finalized.respondedCount + finalized.didNotRespondCount + finalized.excusedCount
      );

      // Verify non-responders list
      assert.deepEqual(finalized.nonResponders, ['Student 3']);
    });

    it('rejects duplicate correct submissions and submissions after deadline', () => {
      const session = sessionService.createSession('inst_1', 'Bio', 'abc-defg-hij');
      const { guest } = rosterService.joinOrReconnect(session.id, 'Student Fast');

      const { check } = checkService.startCheck(session.id, 'DNA Helicase');

      // Valid response
      const res1 = checkService.submitResponse(check.id, guest.guestToken, 'dna helicase');
      assert.equal(res1.status, 'SUCCESS');

      // Duplicate submission
      const res2 = checkService.submitResponse(check.id, guest.guestToken, 'dna helicase');
      assert.equal(res2.status, 'DUPLICATE');

      // Check finalized
      checkService.finalizeCheck(check.id);
      const res3 = checkService.submitResponse(check.id, guest.guestToken, 'dna helicase');
      assert.equal(res3.status, 'EXPIRED');
    });
  });
});

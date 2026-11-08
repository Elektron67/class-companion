// apps/backend/tests/e2e-vertical-slice.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { AppServer } from '../src/server.ts';

describe('E2E Vertical Slice: Instructor Dashboard to Student Extension', () => {
  let app: AppServer;
  let port: number;
  let baseUrl: string;
  let wsUrl: string;

  before(async () => {
    app = new AppServer(true); // In-memory database
    await new Promise<void>((resolve) => {
      app.server.listen(0, () => {
        const addr = app.server.address() as any;
        port = addr.port;
        baseUrl = `http://localhost:${port}`;
        wsUrl = `ws://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await app.close();
  });

  it('executes full E2E lifecycle with checks, telemetry, AFK, and reconnection', async () => {
    // 1. Instructor creates class session
    const createRes = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Cellular Biology - Lecture 1',
        meetingUrl: 'https://meet.google.com/abc-defg-hij'
      })
    });
    assert.equal(createRes.status, 201);
    const session = await createRes.json();
    assert.equal(session.meetingCode, 'abc-defg-hij');
    assert.equal(session.joinCode.length, 6);

    // 2. Instructor connects to WebSocket
    const instructorWs = new WebSocket(`${wsUrl}/ws?role=instructor&sessionId=${session.id}`);
    const instructorMessages: any[] = [];
    instructorWs.on('message', (data) => {
      instructorMessages.push(JSON.parse(data.toString()));
    });
    await new Promise((r) => instructorWs.on('open', r));

    // 3. Reject student joining with mismatched meeting code
    const rejectRes = await fetch(`${baseUrl}/api/v1/sessions/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        joinCode: session.joinCode,
        meetingCode: 'zzz-yyyy-xxx', // Mismatched meet!
        studentName: 'Jordan Lee'
      })
    });
    assert.equal(rejectRes.status, 403);
    const rejectData = await rejectRes.json();
    assert.equal(rejectData.code, 'MEETING_MISMATCH');

    // 4. Student 1 and Student 2 join with matching meeting code
    const joinRes1 = await fetch(`${baseUrl}/api/v1/sessions/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        joinCode: session.joinCode,
        meetingCode: 'abc-defg-hij',
        studentName: 'Alice Walker'
      })
    });
    assert.equal(joinRes1.status, 200);
    const student1Data = await joinRes1.json();

    const joinRes2 = await fetch(`${baseUrl}/api/v1/sessions/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        joinCode: session.joinCode,
        meetingCode: 'abc-defg-hij',
        studentName: 'Bob Dylan'
      })
    });
    assert.equal(joinRes2.status, 200);
    const student2Data = await joinRes2.json();

    // 5. Students connect to WebSocket
    const student1Ws = new WebSocket(`${wsUrl}/ws?role=student&guestToken=${student1Data.guest.guestToken}`);
    const student1Messages: any[] = [];
    student1Ws.on('message', (d) => student1Messages.push(JSON.parse(d.toString())));
    await new Promise((r) => student1Ws.on('open', r));

    const student2Ws = new WebSocket(`${wsUrl}/ws?role=student&guestToken=${student2Data.guest.guestToken}`);
    const student2Messages: any[] = [];
    student2Ws.on('message', (d) => student2Messages.push(JSON.parse(d.toString())));
    await new Promise((r) => student2Ws.on('open', r));

    // Wait 50ms for initial connection sync
    await new Promise((r) => setTimeout(r, 50));

    // 6. Student 2 sends telemetry update (Meet not focused)
    student2Ws.send(JSON.stringify({
      type: 'telemetry:update',
      payload: { focusState: 'UNFOCUSED', inCall: true, clientTimestamp: Date.now() }
    }));
    await new Promise((r) => setTimeout(r, 50));

    const latestRosterMsg = instructorMessages.filter(m => m.event === 'roster:update').pop();
    assert.ok(latestRosterMsg);
    const bobRoster = latestRosterMsg.payload.students.find((s: any) => s.displayName === 'Bob Dylan');
    assert.equal(bobRoster.focusState, 'UNFOCUSED');

    // 7. Student 1 declares AFK
    student1Ws.send(JSON.stringify({
      type: 'afk:request',
      payload: { action: 'START' }
    }));
    await new Promise((r) => setTimeout(r, 50));
    const afkAck = student1Messages.find(m => m.event === 'afk:ack');
    assert.ok(afkAck);
    assert.equal(afkAck.payload.success, true);
    assert.equal(afkAck.payload.isActive, true);

    // 8. Instructor triggers 20-second participation check
    const checkRes = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPhrase: 'Cellular Mitosis' })
    });
    assert.equal(checkRes.status, 201);
    const { check, summary } = await checkRes.json();
    assert.equal(summary.snapshotTotal, 2);
    assert.equal(summary.excusedCount, 1); // Alice is AFK
    assert.equal(summary.eligibleTotal, 1); // Only Bob is eligible

    // 9. Student 2 receives check:started event over WebSocket
    await new Promise((r) => setTimeout(r, 50));
    const checkStartMsg = student2Messages.find(m => m.event === 'check:started');
    assert.ok(checkStartMsg);
    assert.equal(checkStartMsg.payload.targetPhrase, 'Cellular Mitosis');

    // 10. Student 2 submits response with extra spaces and mixed casing
    student2Ws.send(JSON.stringify({
      type: 'check:submit',
      payload: {
        checkId: check.id,
        inputPhrase: '   cellular   mitosis  ',
        submissionId: 'sub_1'
      }
    }));
    await new Promise((r) => setTimeout(r, 50));

    const checkAck = student2Messages.find(m => m.event === 'check:ack');
    assert.ok(checkAck);
    assert.equal(checkAck.payload.status, 'SUCCESS');

    // 11. Finalize check and verify reconciliation
    const finalSummary = app.checkService.finalizeCheck(check.id);
    assert.ok(finalSummary);
    assert.equal(finalSummary.snapshotTotal, 2);
    assert.equal(finalSummary.respondedCount, 1); // Bob
    assert.equal(finalSummary.excusedCount, 1); // Alice (AFK)
    assert.equal(finalSummary.didNotRespondCount, 0);
    // Mathematical reconciliation: Snapshot Total === Responded + Did Not Respond + Excused
    assert.equal(
      finalSummary.snapshotTotal,
      finalSummary.respondedCount + finalSummary.didNotRespondCount + finalSummary.excusedCount
    );

    // 12. Student 2 refreshes/reconnects with guestToken
    const reconnectRes = await fetch(`${baseUrl}/api/v1/sessions/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        joinCode: session.joinCode,
        meetingCode: 'abc-defg-hij',
        studentName: 'Bob Dylan',
        guestToken: student2Data.guest.guestToken
      })
    });
    assert.equal(reconnectRes.status, 200);
    const reconnectData = await reconnectRes.json();
    assert.equal(reconnectData.isReconnection, true);
    assert.equal(reconnectData.guest.id, student2Data.guest.id);

    // Verify roster size is still exactly 2 (no duplicate entry created)
    const roster = app.rosterService.getRosterForSession(session.id);
    assert.equal(roster.length, 2);

    // 13. Clean up sockets
    student1Ws.close();
    student2Ws.close();
    instructorWs.close();
  });
});

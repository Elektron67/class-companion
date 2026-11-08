// apps/web-dashboard/public/dashboard.js

(function () {
  let activeSession = null;
  let socket = null;
  let activeCountdownTimer = null;
  let nonRespondersRevealed = false;

  // DOM Elements
  const createSessionView = document.getElementById('createSessionView');
  const activeDashboardView = document.getElementById('activeDashboardView');
  const sessionEndedView = document.getElementById('sessionEndedView');
  const sessionStatusHeader = document.getElementById('sessionStatusHeader');

  const createSessionForm = document.getElementById('createSessionForm');
  const inputTitle = document.getElementById('inputTitle');
  const inputMeet = document.getElementById('inputMeet');

  const displayClassTitle = document.getElementById('displayClassTitle');
  const displayMeetLink = document.getElementById('displayMeetLink');
  const displayStartTime = document.getElementById('displayStartTime');
  const displayJoinCode = document.getElementById('displayJoinCode');
  const emptyJoinCode = document.getElementById('emptyJoinCode');
  const btnCopyCode = document.getElementById('btnCopyCode');

  const triggerCheckForm = document.getElementById('triggerCheckForm');
  const inputTargetPhrase = document.getElementById('inputTargetPhrase');
  const btnTriggerCheck = document.getElementById('btnTriggerCheck');

  const checkProgressBanner = document.getElementById('checkProgressBanner');
  const displayActivePhrase = document.getElementById('displayActivePhrase');
  const checkTimerCountdown = document.getElementById('checkTimerCountdown');
  const checkTimerStatus = document.getElementById('checkTimerStatus');

  const statResponded = document.getElementById('statResponded');
  const statPending = document.getElementById('statPending');
  const statExcused = document.getElementById('statExcused');
  const statDidNotRespond = document.getElementById('statDidNotRespond');
  const statSnapshotTotal = document.getElementById('statSnapshotTotal');

  const mathSnap = document.getElementById('mathSnap');
  const mathResp = document.getElementById('mathResp');
  const mathMiss = document.getElementById('mathMiss');
  const mathExc = document.getElementById('mathExc');

  const btnToggleNonResponders = document.getElementById('btnToggleNonResponders');
  const nonRespondersPanel = document.getElementById('nonRespondersPanel');
  const nonRespondersList = document.getElementById('nonRespondersList');

  const rosterTableBody = document.getElementById('rosterTableBody');
  const rosterCount = document.getElementById('rosterCount');
  const btnEndSession = document.getElementById('btnEndSession');
  const btnNewSession = document.getElementById('btnNewSession');

  // 1. Create Session
  createSessionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = inputTitle.value.trim();
    const meetingUrl = inputMeet.value.trim();
    if (!title || !meetingUrl) return;

    try {
      const res = await fetch('/api/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, meetingUrl })
      });

      if (!res.ok) {
        const err = await res.json();
        alert('Error creating session: ' + (err.error || 'Failed'));
        return;
      }

      activeSession = await res.json();
      setupActiveSession(activeSession);
    } catch (err) {
      alert('Network error connecting to API: ' + err.message);
    }
  });

  function setupActiveSession(session) {
    createSessionView.classList.add('hidden');
    sessionEndedView.classList.add('hidden');
    activeDashboardView.classList.remove('hidden');
    sessionStatusHeader.classList.remove('hidden');

    displayClassTitle.textContent = session.title;
    displayMeetLink.textContent = `meet.google.com/${session.meetingCode}`;
    displayMeetLink.href = `https://meet.google.com/${session.meetingCode}`;
    displayStartTime.textContent = new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    displayJoinCode.textContent = session.joinCode;
    emptyJoinCode.textContent = session.joinCode;

    connectWebSocket(session.id);
  }

  // Copy Join Code Button
  btnCopyCode.addEventListener('click', () => {
    if (!activeSession) return;
    navigator.clipboard.writeText(activeSession.joinCode);
    btnCopyCode.textContent = '✅';
    setTimeout(() => btnCopyCode.textContent = '📋', 1500);
  });

  // 2. Real-Time WebSocket Connection
  function connectWebSocket(sessionId) {
    if (socket) socket.close();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?role=instructor&sessionId=${sessionId}`;
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[Dashboard] WebSocket connected.');
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.event === 'roster:update') {
          renderRoster(msg.payload.students);
        } else if (msg.event === 'check:progress') {
          updateCheckProgress(msg.payload);
        } else if (msg.event === 'check:finalized') {
          finalizeCheckUI(msg.payload);
        } else if (msg.event === 'session:ended') {
          showSessionEnded();
        }
      } catch (err) {
        console.error('WebSocket parse error:', err);
      }
    };

    socket.onclose = () => {
      console.warn('[Dashboard] WebSocket disconnected. Reconnecting in 3s...');
      setTimeout(() => {
        if (activeSession && activeSession.status !== 'ENDED') {
          connectWebSocket(sessionId);
        }
      }, 3000);
    };
  }

  // 3. Render Roster
  function renderRoster(students) {
    rosterCount.textContent = students.length;
    if (students.length === 0) {
      rosterTableBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">Waiting for students to join with code <strong>${activeSession.joinCode}</strong> on Google Meet...</td>
        </tr>`;
      return;
    }

    rosterTableBody.innerHTML = '';
    students.forEach((s) => {
      const tr = document.createElement('tr');

      // Focus State formatting
      let focusBadge = '';
      if (s.connectionStatus !== 'CONNECTED') {
        focusBadge = `<span class="badge-telemetry unknown"><span class="dot disconnected">◌</span> No telemetry</span>`;
      } else if (s.focusState === 'FOCUSED') {
        focusBadge = `<span class="badge-telemetry focused"><span class="dot focused">●</span> Meet focused</span>`;
      } else if (s.focusState === 'UNFOCUSED') {
        focusBadge = `<span class="badge-telemetry unfocused"><span class="dot unfocused">◐</span> Meet not focused</span>`;
      } else {
        focusBadge = `<span class="badge-telemetry hidden"><span class="dot hidden-state">○</span> Meet hidden</span>`;
      }

      // AFK Status formatting
      let afkLabel = `Active (${3 - s.afkUsesConsumed} breaks left)`;
      if (s.afkExpiresAt && s.afkExpiresAt > Date.now()) {
        const secRem = Math.max(0, Math.round((s.afkExpiresAt - Date.now()) / 1000));
        const mm = String(Math.floor(secRem / 60)).padStart(2, '0');
        const ss = String(secRem % 60).padStart(2, '0');
        afkLabel = `⏸️ AFK (${mm}:${ss} rem)`;
      }

      const duplicateBadge = s.isDuplicateName ? `<span class="badge-duplicate">Duplicate</span>` : '';

      tr.innerHTML = `
        <td><strong>${escapeHtml(s.displayName)}</strong>${duplicateBadge}</td>
        <td><span class="status-pill ${s.connectionStatus.toLowerCase()}">${s.connectionStatus}</span></td>
        <td>${focusBadge}</td>
        <td>${afkLabel}</td>
        <td>${new Date(s.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td>
          <button class="btn btn-xs btn-secondary btn-rename" data-id="${s.id}" data-name="${escapeHtml(s.displayName)}" style="margin-right:6px;">Rename</button>
          <button class="btn btn-xs btn-danger-outline btn-eject" data-id="${s.id}">Eject</button>
        </td>
      `;
      rosterTableBody.appendChild(tr);
    });

    // Attach rename actions
    document.querySelectorAll('.btn-rename').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const studentId = e.target.getAttribute('data-id');
        const oldName = e.target.getAttribute('data-name');
        if (!activeSession) return;
        const newName = prompt('Enter corrected name for student:', oldName);
        if (!newName || newName.trim() === oldName) return;

        try {
          const res = await fetch(`/api/v1/sessions/${activeSession.id}/roster/${studentId}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName: newName.trim() })
          });
          if (!res.ok) {
            const err = await res.json();
            alert('Error renaming: ' + (err.error || 'Failed'));
          }
        } catch (err) {
          alert('Network error renaming student: ' + err.message);
        }
      });
    });

    // Attach eject actions
    document.querySelectorAll('.btn-eject').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const studentId = e.target.getAttribute('data-id');
        if (!activeSession) return;
        if (confirm('Eject this student from the active class session?')) {
          try {
            const res = await fetch(`/api/v1/sessions/${activeSession.id}/roster/${studentId}/eject`, {
              method: 'POST'
            });
            if (!res.ok) {
              const err = await res.json();
              alert('Error ejecting: ' + (err.error || 'Failed'));
            }
          } catch (err) {
            alert('Network error ejecting student: ' + err.message);
          }
        }
      });
    });
  }

  // 4. Trigger 20-Second Participation Check
  triggerCheckForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phrase = inputTargetPhrase.value.trim();
    if (!phrase || !activeSession) return;

    btnTriggerCheck.disabled = true;
    btnTriggerCheck.textContent = 'Triggering...';

    try {
      const res = await fetch(`/api/v1/sessions/${activeSession.id}/checks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPhrase: phrase })
      });

      if (!res.ok) {
        const err = await res.json();
        alert('Check trigger failed: ' + (err.error || 'Server rejected check.'));
        btnTriggerCheck.disabled = false;
        btnTriggerCheck.textContent = 'Trigger 20s Check';
        return;
      }

      const data = await res.json();
      startCheckClientCountdown(data.check.targetPhrase, data.check.deadlineAt);
      inputTargetPhrase.value = '';
    } catch (err) {
      alert('Error triggering check: ' + err.message);
      btnTriggerCheck.disabled = false;
      btnTriggerCheck.textContent = 'Trigger 20s Check';
    }
  });

  function startCheckClientCountdown(targetPhrase, deadlineAt) {
    checkProgressBanner.classList.remove('hidden');
    displayActivePhrase.textContent = `"${targetPhrase}"`;
    checkTimerStatus.textContent = 'WINDOW OPEN (20s)';
    checkTimerStatus.style.background = 'var(--warning)';

    if (activeCountdownTimer) clearInterval(activeCountdownTimer);

    function tick() {
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      const sec = (remainingMs / 1000).toFixed(1);
      checkTimerCountdown.textContent = `${sec}s`;

      if (remainingMs <= 0) {
        clearInterval(activeCountdownTimer);
        checkTimerStatus.textContent = 'WINDOW CLOSED';
        checkTimerStatus.style.background = 'var(--border)';
        btnTriggerCheck.disabled = false;
        btnTriggerCheck.textContent = 'Trigger 20s Check';
      }
    }
    tick();
    activeCountdownTimer = setInterval(tick, 100);
  }

  function updateCheckProgress(payload) {
    statResponded.textContent = payload.respondedCount;
    statPending.textContent = payload.pendingCount;
    statExcused.textContent = payload.excusedCount;
    statDidNotRespond.textContent = payload.didNotRespondCount;
    statSnapshotTotal.textContent = payload.snapshotTotal;

    mathSnap.textContent = payload.snapshotTotal;
    mathResp.textContent = payload.respondedCount;
    mathMiss.textContent = payload.didNotRespondCount;
    mathExc.textContent = payload.excusedCount;
  }

  function finalizeCheckUI(summary) {
    if (activeCountdownTimer) clearInterval(activeCountdownTimer);
    checkTimerCountdown.textContent = '0.0s';
    checkTimerStatus.textContent = 'FINALIZED';
    btnTriggerCheck.disabled = false;
    btnTriggerCheck.textContent = 'Trigger 20s Check';

    updateCheckProgress(summary);

    // Populate non-responders list
    if (summary.nonResponders && summary.nonResponders.length > 0) {
      nonRespondersList.innerHTML = summary.nonResponders
        .map(name => `<li>${escapeHtml(name)}</li>`)
        .join('');
    } else {
      nonRespondersList.innerHTML = '<li>All eligible students responded! 🎉</li>';
    }
  }

  // Toggle non-responders list
  btnToggleNonResponders.addEventListener('click', () => {
    nonRespondersRevealed = !nonRespondersRevealed;
    if (nonRespondersRevealed) {
      nonRespondersPanel.classList.remove('hidden');
      btnToggleNonResponders.textContent = 'Hide Non-Responders';
    } else {
      nonRespondersPanel.classList.add('hidden');
      btnToggleNonResponders.textContent = 'Reveal Non-Responders';
    }
  });

  // 5. CSV Export & End Session
  function triggerCsvDownload() {
    if (!activeSession) return;
    window.location.href = `/api/v1/sessions/${activeSession.id}/export`;
  }

  const btnExportCsvNav = document.getElementById('btnExportCsvNav');
  if (btnExportCsvNav) btnExportCsvNav.addEventListener('click', triggerCsvDownload);

  const btnExportCsvSummary = document.getElementById('btnExportCsvSummary');
  if (btnExportCsvSummary) btnExportCsvSummary.addEventListener('click', triggerCsvDownload);

  btnEndSession.addEventListener('click', async () => {
    if (!confirm('End this class session? Student monitoring will immediately stop.')) return;
    try {
      await fetch(`/api/v1/sessions/${activeSession.id}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      showSessionEnded();
    } catch (err) {
      alert('Error ending session: ' + err.message);
    }
  });

  function showSessionEnded() {
    activeDashboardView.classList.add('hidden');
    sessionStatusHeader.classList.add('hidden');
    sessionEndedView.classList.remove('hidden');

    const summaryTotalStudents = document.getElementById('summaryTotalStudents');
    if (summaryTotalStudents) summaryTotalStudents.textContent = rosterCount.textContent;
  }

  btnNewSession.addEventListener('click', () => {
    activeSession = null;
    sessionEndedView.classList.add('hidden');
    createSessionView.classList.remove('hidden');
    inputTitle.value = '';
    inputMeet.value = '';
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m];
    });
  }
})();


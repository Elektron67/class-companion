// apps/chrome-extension/src/content/content.js

(function () {
  console.log('[MeetMonitor] Content script initialized on Google Meet.');

  const API_BASE = 'http://localhost:4000';
  const WS_BASE = 'ws://localhost:4000';

  // 1. Extract and validate Google Meet meeting code (xxx-yyyy-zzz)
  function getMeetingCode() {
    const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : null;
  }

  const meetingCode = getMeetingCode();
  if (!meetingCode) {
    console.log('[MeetMonitor] Not in a recognized Google Meet room. Standing by.');
    return;
  }

  // 2. State
  let currentSession = null;
  let currentGuest = null;
  let socket = null;
  let heartbeatTimer = null;
  let activeCheck = null;
  let checkCountdownInterval = null;
  let notesAutoSaveTimeout = null;

  // 3. Mount Shadow DOM container for complete style isolation
  const hostElement = document.createElement('div');
  hostElement.id = 'meetmonitor-root';
  document.body.appendChild(hostElement);
  const shadow = hostElement.attachShadow({ mode: 'open' });

  // Injected CSS into Shadow DOM
  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    
    /* Floating Dock Button */
    .dock-pill {
      position: fixed;
      bottom: 24px;
      left: 24px;
      z-index: 999999;
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid #3b82f6;
      border-radius: 24px;
      padding: 10px 18px;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.4);
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: transform 0.2s ease;
    }
    .dock-pill:hover { transform: scale(1.04); background: #2563eb; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }
    .status-dot.active { background: #10b981; box-shadow: 0 0 6px #10b981; }

    /* Modal Backdrop */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(3px);
      z-index: 1000000;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .modal-card {
      background: #0f172a;
      color: #f8fafc;
      border: 1px solid #334155;
      border-radius: 12px;
      width: 440px;
      max-width: 90vw;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
    }

    .modal-header h3 { margin: 0 0 8px 0; font-size: 18px; }
    .modal-header p { margin: 0 0 20px 0; font-size: 13px; color: #94a3b8; }

    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .form-group input {
      width: 100%;
      padding: 10px 14px;
      background: #1e293b;
      border: 1px solid #475569;
      border-radius: 6px;
      color: white;
      font-size: 14px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      width: 100%;
    }
    .btn-primary { background: #3b82f6; color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-warning { background: #f59e0b; color: #000; }
    .btn-secondary { background: #334155; color: white; margin-top: 8px; }
    .btn-danger { background: #ef4444; color: white; }

    .error-banner {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid #ef4444;
      color: #fca5a5;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      margin-bottom: 16px;
    }

    /* Participation Check Overlay Modal */
    .check-modal {
      border: 2px solid #f59e0b;
      background: #0f172a;
      text-align: center;
      animation: popIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    @keyframes popIn {
      from { transform: scale(0.9); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .check-target-banner {
      background: rgba(245, 158, 11, 0.15);
      border: 1px dashed #f59e0b;
      padding: 14px;
      border-radius: 8px;
      margin: 16px 0;
    }
    .check-target-phrase { font-size: 22px; font-weight: 800; color: #fbbf24; }

    .countdown-timer-large {
      font-size: 32px;
      font-weight: 900;
      color: #f59e0b;
      margin-bottom: 8px;
    }

    .input-check {
      font-size: 18px !important;
      text-align: center;
      letter-spacing: 0.05em;
    }

    .shake {
      animation: shake 0.4s ease-in-out;
    }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-8px); }
      40%, 80% { transform: translateX(8px); }
    }

    /* Side Notes Drawer */
    .notes-drawer {
      position: fixed;
      top: 60px;
      right: 20px;
      width: 320px;
      height: 480px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      z-index: 999998;
      display: flex;
      flex-direction: column;
      color: white;
    }

    .notes-header {
      padding: 12px 16px;
      border-bottom: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      font-weight: 600;
    }

    .notes-textarea {
      flex: 1;
      background: #0f172a;
      color: white;
      border: none;
      padding: 12px;
      font-size: 13px;
      line-height: 1.5;
      resize: none;
      outline: none;
    }

    .notes-footer {
      padding: 10px 14px;
      border-top: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: #94a3b8;
    }

    .hidden { display: none !important; }
  `;
  shadow.appendChild(style);

  // 4. Create UI Markup
  const uiContainer = document.createElement('div');
  uiContainer.innerHTML = `
    <!-- Dock Pill -->
    <div id="dockPill" class="dock-pill">
      <span id="dockDot" class="status-dot"></span>
      <span id="dockLabel">Join Class Session</span>
    </div>

    <!-- Join Session Modal -->
    <div id="joinModal" class="modal-backdrop hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3>Join Monitored Class Session</h3>
          <p>Meeting: <strong>${meetingCode}</strong></p>
        </div>
        <div id="joinError" class="error-banner hidden"></div>
        <form id="joinForm">
          <div class="form-group">
            <label>6-Character Join Code</label>
            <input type="text" id="inputJoinCode" placeholder="e.g. C8M3K9" maxlength="6" style="text-transform:uppercase" required />
          </div>
          <div class="form-group">
            <label>Your Full Name</label>
            <input type="text" id="inputStudentName" placeholder="e.g. Jordan Lee" required />
          </div>
          <button type="submit" id="btnSubmitJoin" class="btn btn-primary">Join Class</button>
          <button type="button" id="btnCancelJoin" class="btn btn-secondary">Close</button>
        </form>
      </div>
    </div>

    <!-- Participation Check Modal Overlay -->
    <div id="checkModal" class="modal-backdrop hidden">
      <div class="modal-card check-modal" id="checkCard">
        <div class="countdown-timer-large" id="checkTimer">20.0s</div>
        <h3>⚡ Participation Check</h3>
        <p style="font-size:12px; color:#94a3b8; margin:4px 0 12px 0;">Type the exact target phrase below to confirm your presence.</p>
        
        <div class="check-target-banner">
          <div style="font-size:11px; color:#f59e0b; text-transform:uppercase; font-weight:700;">Target Phrase</div>
          <div class="check-target-phrase" id="checkTargetPhrase">---</div>
        </div>

        <div id="checkErrorBanner" class="error-banner hidden"></div>

        <form id="checkForm">
          <div class="form-group">
            <input type="text" id="inputCheckAnswer" class="input-check" placeholder="Type target phrase here..." autocomplete="off" required />
          </div>
          <button type="submit" id="btnSubmitAnswer" class="btn btn-warning">Submit Response (Enter)</button>
        </form>
      </div>
    </div>

    <!-- Notes & AFK Slide Drawer -->
    <div id="notesDrawer" class="notes-drawer hidden">
      <div class="notes-header">
        <span id="notesTitle">Class Notes</span>
        <button id="btnCloseNotes" style="background:none; border:none; color:#94a3b8; cursor:pointer;">✕</button>
      </div>
      <textarea id="notesArea" class="notes-textarea" placeholder="Take private class notes here. Notes autosave and can be exported as a PDF after class..."></textarea>
      <div class="notes-footer">
        <span id="notesSaveStatus">Saved locally ●</span>
        <button id="btnExportPdf" style="background:#3b82f6; border:none; color:white; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px;">Export PDF</button>
      </div>
      <div style="padding:10px 14px; background:#0f172a; border-top:1px solid #334155; display:flex; justify-content:space-between; align-items:center;">
        <span id="afkLabel" style="font-size:11px; color:#94a3b8;">AFK: 3 breaks left</span>
        <button id="btnToggleAfk" style="background:#f59e0b; border:none; color:#000; font-weight:600; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px;">Take AFK Break</button>
      </div>
    </div>
  `;
  shadow.appendChild(uiContainer);

  // Elements inside shadow DOM
  const dockPill = shadow.getElementById('dockPill');
  const dockDot = shadow.getElementById('dockDot');
  const dockLabel = shadow.getElementById('dockLabel');
  const joinModal = shadow.getElementById('joinModal');
  const joinForm = shadow.getElementById('joinForm');
  const inputJoinCode = shadow.getElementById('inputJoinCode');
  const inputStudentName = shadow.getElementById('inputStudentName');
  const btnCancelJoin = shadow.getElementById('btnCancelJoin');
  const joinError = shadow.getElementById('joinError');

  const checkModal = shadow.getElementById('checkModal');
  const checkCard = shadow.getElementById('checkCard');
  const checkTimer = shadow.getElementById('checkTimer');
  const checkTargetPhrase = shadow.getElementById('checkTargetPhrase');
  const checkErrorBanner = shadow.getElementById('checkErrorBanner');
  const checkForm = shadow.getElementById('checkForm');
  const inputCheckAnswer = shadow.getElementById('inputCheckAnswer');
  const btnSubmitAnswer = shadow.getElementById('btnSubmitAnswer');

  const notesDrawer = shadow.getElementById('notesDrawer');
  const btnCloseNotes = shadow.getElementById('btnCloseNotes');
  const notesArea = shadow.getElementById('notesArea');
  const notesSaveStatus = shadow.getElementById('notesSaveStatus');
  const btnExportPdf = shadow.getElementById('btnExportPdf');
  const afkLabel = shadow.getElementById('afkLabel');
  const btnToggleAfk = shadow.getElementById('btnToggleAfk');

  // 5. Audio Synthesizer (Chime for participation check)
  function playAlertChime() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15); // A5
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.4);
    } catch (e) {
      // Audio autoplay may be constrained; fail gracefully
    }
  }

  // 6. Join Modal Controls
  dockPill.addEventListener('click', () => {
    if (currentSession) {
      notesDrawer.classList.toggle('hidden');
    } else {
      joinModal.classList.remove('hidden');
    }
  });

  btnCancelJoin.addEventListener('click', () => {
    joinModal.classList.add('hidden');
  });

  btnCloseNotes.addEventListener('click', () => {
    notesDrawer.classList.add('hidden');
  });

  // 7. Join Form Submission
  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    joinError.classList.add('hidden');

    const joinCode = inputJoinCode.value.trim().toUpperCase();
    const studentName = inputStudentName.value.trim();
    if (!joinCode || !studentName) return;

    try {
      const res = await fetch(`${API_BASE}/api/v1/sessions/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          joinCode,
          meetingCode,
          studentName
        })
      });

      const data = await res.json();
      if (!res.ok) {
        joinError.textContent = data.message || data.error || 'Failed to join.';
        joinError.classList.remove('hidden');
        return;
      }

      // Successful join
      joinModal.classList.add('hidden');
      onJoinedSession(data.session, data.guest);
    } catch (err) {
      joinError.textContent = 'Connection error: ' + err.message;
      joinError.classList.remove('hidden');
    }
  });

  // Check for existing session token in chrome.storage.local
  chrome.storage.local.get(['currentGuestSession', 'classNotes'], (result) => {
    if (result.currentGuestSession && result.currentGuestSession.meetingCode === meetingCode) {
      console.log('[MeetMonitor] Found saved session token, attempting seamless reconnect...');
      fetch(`${API_BASE}/api/v1/sessions/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          joinCode: result.currentGuestSession.joinCode || '',
          meetingCode,
          studentName: result.currentGuestSession.studentName,
          guestToken: result.currentGuestSession.guestToken
        })
      })
      .then(res => res.json())
      .then(data => {
        if (data.guest) {
          onJoinedSession(data.session, data.guest);
        }
      })
      .catch(() => {});
    }
  });

  function onJoinedSession(session, guest) {
    currentSession = session;
    currentGuest = guest;

    // Save to chrome.storage.local
    chrome.storage.local.set({
      currentGuestSession: {
        sessionId: session.id,
        joinCode: session.joinCode,
        guestToken: guest.guestToken,
        meetingCode,
        studentName: guest.displayName,
        joinedAt: Date.now()
      }
    });

    dockDot.classList.add('active');
    dockLabel.textContent = `${session.title} (Connected)`;

    loadSavedNotes(session.id);
    initWebSocket(guest.guestToken);
    initTelemetry();
  }

  // 8. WebSocket Connection with Service Worker CSP-Immunity Fallback
  let swPort = null;

  function initWebSocket(guestToken) {
    const wsUrl = `${WS_BASE}/ws?role=student&guestToken=${guestToken}`;

    function handleIncomingMessage(rawText) {
      try {
        const msg = JSON.parse(rawText);
        if (msg.event === 'check:started') {
          handleCheckStarted(msg.payload);
        } else if (msg.event === 'check:ack') {
          handleCheckAck(msg.payload);
        } else if (msg.event === 'afk:ack') {
          handleAfkAck(msg.payload);
        } else if (msg.event === 'session:ended') {
          dockLabel.textContent = 'Class Session Ended';
          dockDot.classList.remove('active');
          closeActiveConnection();
        } else if (msg.event === 'session:ejected') {
          dockLabel.textContent = 'Removed by Instructor';
          dockDot.classList.remove('active');
          alert('You have been removed from this class session by the instructor.');
          closeActiveConnection();
        }
      } catch (err) {
        console.error('Error parsing WS message:', err);
      }
    }

    function closeActiveConnection() {
      if (socket) {
        try { socket.close(); } catch (e) {}
        socket = null;
      }
      if (swPort) {
        try { swPort.postMessage({ action: 'CLOSE_WS' }); } catch (e) {}
        swPort.disconnect();
        swPort = null;
      }
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }

    // Try direct WebSocket first, fallback to Service Worker port on CSP error
    try {
      if (socket) socket.close();
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        console.log('[MeetMonitor] Direct WebSocket connected.');
        onSocketConnected();
      };

      socket.onmessage = (event) => {
        handleIncomingMessage(event.data);
      };

      socket.onerror = () => {
        console.warn('[MeetMonitor] Direct WebSocket blocked (likely page CSP). Switching to Service Worker bridge...');
        connectViaServiceWorker(wsUrl);
      };

      socket.onclose = () => {
        dockDot.classList.remove('active');
        dockLabel.textContent = `${currentSession?.title || 'Class'} (Reconnecting...)`;
      };
    } catch (e) {
      connectViaServiceWorker(wsUrl);
    }

    function connectViaServiceWorker(url) {
      if (swPort) {
        try { swPort.disconnect(); } catch (e) {}
      }

      swPort = chrome.runtime.connect({ name: 'meetmonitor-stream' });
      swPort.postMessage({ action: 'CONNECT_WS', wsUrl: url });

      swPort.onMessage.addListener((msg) => {
        if (msg.type === 'WS_OPEN') {
          console.log('[MeetMonitor] Bridge WebSocket connected via Service Worker.');
          onSocketConnected();
        } else if (msg.type === 'WS_MESSAGE') {
          handleIncomingMessage(msg.data);
        } else if (msg.type === 'WS_CLOSE') {
          dockDot.classList.remove('active');
          dockLabel.textContent = `${currentSession?.title || 'Class'} (Reconnecting...)`;
        }
      });
    }

    function onSocketConnected() {
      dockDot.classList.add('active');
      dockLabel.textContent = `${currentSession?.title || 'Class'} (Connected)`;
      sendTelemetry();

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        sendWsMessage({ type: 'ping' });
      }, 5000);
    }
  }

  function sendWsMessage(obj) {
    const raw = JSON.stringify(obj);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(raw);
    } else if (swPort) {
      swPort.postMessage({ action: 'SEND_WS', data: raw });
    }
  }

  // 9. Telemetry & Focus Monitoring
  function initTelemetry() {
    document.addEventListener('visibilitychange', () => sendTelemetry());
    window.addEventListener('focus', () => sendTelemetry());
    window.addEventListener('blur', () => sendTelemetry());
  }

  function sendTelemetry() {
    let focusState = 'FOCUSED';
    if (document.visibilityState === 'hidden') {
      focusState = 'HIDDEN';
    } else if (!document.hasFocus()) {
      focusState = 'UNFOCUSED';
    }

    sendWsMessage({
      type: 'telemetry:update',
      payload: {
        focusState,
        inCall: true,
        clientTimestamp: Date.now()
      }
    });
  }

  // 10. Participation Check Execution
  function handleCheckStarted(payload) {
    activeCheck = payload;
    checkTargetPhrase.textContent = payload.targetPhrase;
    inputCheckAnswer.value = '';
    inputCheckAnswer.disabled = false;
    btnSubmitAnswer.disabled = false;
    btnSubmitAnswer.textContent = 'Submit Response (Enter)';
    checkErrorBanner.classList.add('hidden');
    checkModal.classList.remove('hidden');

    playAlertChime();

    // If student is on another tab/window, trigger background desktop notification
    if (document.visibilityState === 'hidden' || !document.hasFocus()) {
      chrome.runtime.sendMessage({
        action: 'TRIGGER_CHECK_NOTIFICATION',
        targetPhrase: payload.targetPhrase
      });
    }

    inputCheckAnswer.focus();

    if (checkCountdownInterval) clearInterval(checkCountdownInterval);
    function updateCountdown() {
      const remainingMs = Math.max(0, payload.deadlineAt - Date.now());
      checkTimer.textContent = (remainingMs / 1000).toFixed(1) + 's';

      if (remainingMs <= 0) {
        clearInterval(checkCountdownInterval);
        checkTimer.textContent = '0.0s';
        inputCheckAnswer.disabled = true;
        btnSubmitAnswer.disabled = true;
        btnSubmitAnswer.textContent = 'Time Expired';
      }
    }
    updateCountdown();
    checkCountdownInterval = setInterval(updateCountdown, 100);
  }

  checkForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!activeCheck) return;

    const answer = inputCheckAnswer.value;
    sendWsMessage({
      type: 'check:submit',
      payload: {
        checkId: activeCheck.checkId,
        inputPhrase: answer,
        submissionId: String(Date.now())
      }
    });
  });

  function handleCheckAck(payload) {
    if (payload.status === 'SUCCESS') {
      if (checkCountdownInterval) clearInterval(checkCountdownInterval);
      btnSubmitAnswer.textContent = '✅ Responded Successfully';
      btnSubmitAnswer.style.background = '#10b981';
      inputCheckAnswer.disabled = true;
      btnSubmitAnswer.disabled = true;
      checkErrorBanner.classList.add('hidden');
      setTimeout(() => {
        checkModal.classList.add('hidden');
      }, 1500);
    } else if (payload.status === 'INCORRECT') {
      checkErrorBanner.textContent = payload.message || 'Incorrect match. Check spelling and retry.';
      checkErrorBanner.classList.remove('hidden');
      checkCard.classList.remove('shake');
      void checkCard.offsetWidth; // Trigger reflow
      checkCard.classList.add('shake');
      inputCheckAnswer.select();
    } else if (payload.status === 'EXPIRED') {
      checkErrorBanner.textContent = 'Time has expired. Response was not recorded.';
      checkErrorBanner.classList.remove('hidden');
      inputCheckAnswer.disabled = true;
      btnSubmitAnswer.disabled = true;
    }
  }

  // 11. AFK Break Handling
  btnToggleAfk.addEventListener('click', () => {
    if (!currentGuest) return;
    const isCurrentlyAfk = btnToggleAfk.textContent === "I'm Back";

    sendWsMessage({
      type: 'afk:request',
      payload: { action: isCurrentlyAfk ? 'END' : 'START' }
    });
  });

  function handleAfkAck(payload) {
    if (payload.success) {
      if (payload.isActive) {
        btnToggleAfk.textContent = "I'm Back";
        btnToggleAfk.style.background = '#10b981';
        afkLabel.textContent = 'AFK Active (5m max)';
      } else {
        btnToggleAfk.textContent = 'Take AFK Break';
        btnToggleAfk.style.background = '#f59e0b';
        afkLabel.textContent = `AFK: ${3 - payload.afkUsesConsumed} breaks left`;
      }
    } else {
      alert(payload.message || 'AFK action could not be completed.');
    }
  }

  // 12. Student Notes & Local PDF Export
  function loadSavedNotes(sessionId) {
    chrome.storage.local.get(['classNotes'], (res) => {
      if (res.classNotes && res.classNotes[sessionId]) {
        notesArea.value = res.classNotes[sessionId].markdownContent || '';
      }
    });
  }

  notesArea.addEventListener('input', () => {
    notesSaveStatus.textContent = 'Saving...';
    if (notesAutoSaveTimeout) clearTimeout(notesAutoSaveTimeout);

    notesAutoSaveTimeout = setTimeout(() => {
      if (!currentSession) return;
      chrome.storage.local.get(['classNotes'], (res) => {
        const notes = res.classNotes || {};
        notes[currentSession.id] = {
          sessionId: currentSession.id,
          classTitle: currentSession.title,
          meetingCode,
          sessionDate: new Date().toISOString(),
          markdownContent: notesArea.value,
          lastSavedAt: Date.now()
        };
        chrome.storage.local.set({ classNotes: notes }, () => {
          notesSaveStatus.textContent = 'Saved locally ●';
        });
      });
    }, 300);
  });

  // Client-Side Multi-Page PDF Generation without external dependencies
  btnExportPdf.addEventListener('click', () => {
    const content = notesArea.value;
    if (!content.trim()) {
      alert('Your notes are currently empty.');
      return;
    }

    const title = currentSession ? currentSession.title : 'Google Meet Class Notes';
    const dateStr = new Date().toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    // Create printable clean document
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Popups blocked. Please allow popups to export PDF.');
      return;
    }

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title} - Notes</title>
        <style>
          @page { size: A4; margin: 20mm; }
          body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; line-height: 1.6; }
          header { border-bottom: 2px solid #3b82f6; padding-bottom: 12px; margin-bottom: 24px; }
          h1 { margin: 0 0 6px 0; font-size: 22px; color: #1e3a8a; }
          .meta { font-size: 12px; color: #64748b; }
          .content { font-size: 14px; white-space: pre-wrap; word-wrap: break-word; }
          footer { position: fixed; bottom: 0; width: 100%; text-align: center; font-size: 10px; color: #94a3b8; }
        </style>
      </head>
      <body>
        <header>
          <h1>${title}</h1>
          <div class="meta">Date: ${dateStr} | Meeting: meet.google.com/${meetingCode}</div>
        </header>
        <div class="content">${escapeHtml(content)}</div>
        <script>
          window.onload = function() {
            window.print();
          };
        <\/script>
      </body>
      </html>
    `);
    printWindow.document.close();
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m];
    });
  }
})();


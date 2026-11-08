// apps/chrome-extension/src/popup/popup.js

document.addEventListener('DOMContentLoaded', () => {
  const sessionStatus = document.getElementById('sessionStatus');
  const guestNameRow = document.getElementById('guestNameRow');
  const guestName = document.getElementById('guestName');
  const notesList = document.getElementById('notesList');

  chrome.storage.local.get(['currentGuestSession', 'classNotes'], (data) => {
    if (data.currentGuestSession) {
      sessionStatus.textContent = `Connected (${data.currentGuestSession.meetingCode})`;
      sessionStatus.style.color = '#34d399';
      guestName.textContent = data.currentGuestSession.studentName;
      guestNameRow.style.display = 'block';
    } else {
      sessionStatus.textContent = 'Not currently in an active class session';
    }

    const notes = data.classNotes || {};
    const noteKeys = Object.keys(notes);

    if (noteKeys.length > 0) {
      notesList.innerHTML = '';
      noteKeys.forEach((k) => {
        const item = notes[k];
        const div = document.createElement('div');
        div.className = 'note-item';
        div.innerHTML = `
          <div>
            <strong>${escapeHtml(item.classTitle || 'Class Session')}</strong>
            <div style="font-size:10px; color:#94a3b8;">${new Date(item.lastSavedAt).toLocaleDateString()}</div>
          </div>
          <button class="btn btn-export" data-id="${k}">Export</button>
        `;
        notesList.appendChild(div);
      });

      document.querySelectorAll('.btn-export').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.target.getAttribute('data-id');
          const note = notes[id];
          if (!note) return;

          const printWindow = window.open('', '_blank');
          if (printWindow) {
            printWindow.document.write(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>${escapeHtml(note.classTitle)} - Notes</title>
                <style>
                  @page { size: A4; margin: 20mm; }
                  body { font-family: sans-serif; line-height: 1.6; color: #111; }
                  h1 { color: #1e3a8a; }
                  .meta { font-size: 12px; color: #64748b; margin-bottom: 20px; }
                  .content { white-space: pre-wrap; word-wrap: break-word; }
                </style>
              </head>
              <body>
                <h1>${escapeHtml(note.classTitle)}</h1>
                <div class="meta">Date: ${new Date(note.lastSavedAt).toLocaleDateString()} | Meeting: ${note.meetingCode}</div>
                <div class="content">${escapeHtml(note.markdownContent)}</div>
                <script>window.onload = function() { window.print(); };<\/script>
              </body>
              </html>
            `);
            printWindow.document.close();
          }
        });
      });
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m];
    });
  }
});

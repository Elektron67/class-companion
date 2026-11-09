// apps/chrome-extension/src/popup/popup.js

const extAPI = (typeof chrome !== 'undefined' && chrome.runtime)
  ? chrome
  : (typeof browser !== 'undefined' ? browser : null);

document.addEventListener('DOMContentLoaded', () => {
  const sessionStatus = document.getElementById('sessionStatus');
  const guestNameRow = document.getElementById('guestNameRow');
  const guestName = document.getElementById('guestName');
  const notesList = document.getElementById('notesList');

  extAPI.storage.local.get(['currentGuestSession', 'classNotes'], (data) => {
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
      notesList.textContent = '';
      noteKeys.forEach((k) => {
        const item = notes[k];
        const div = document.createElement('div');
        div.className = 'note-item';

        const textWrapper = document.createElement('div');
        const titleStrong = document.createElement('strong');
        titleStrong.textContent = item.classTitle || 'Class Session';
        const dateSub = document.createElement('div');
        dateSub.style.fontSize = '10px';
        dateSub.style.color = '#94a3b8';
        dateSub.textContent = new Date(item.lastSavedAt).toLocaleDateString();

        textWrapper.appendChild(titleStrong);
        textWrapper.appendChild(dateSub);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'btn btn-export';
        exportBtn.setAttribute('data-id', k);
        exportBtn.textContent = 'Export';

        div.appendChild(textWrapper);
        div.appendChild(exportBtn);
        notesList.appendChild(div);
      });

      document.querySelectorAll('.btn-export').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.target.getAttribute('data-id');
          const note = notes[id];
          if (!note) return;

          const printWindow = window.open('', '_blank');
          if (printWindow) {
            const doc = printWindow.document;
            doc.title = `${note.classTitle || 'Class Session'} - Notes`;

            const style = doc.createElement('style');
            style.textContent = `
              @page { size: A4; margin: 20mm; }
              body { font-family: sans-serif; line-height: 1.6; color: #111; }
              h1 { color: #1e3a8a; }
              .meta { font-size: 12px; color: #64748b; margin-bottom: 20px; }
              .content { white-space: pre-wrap; word-wrap: break-word; }
            `;
            doc.head.appendChild(style);

            const h1 = doc.createElement('h1');
            h1.textContent = note.classTitle || 'Class Session';

            const meta = doc.createElement('div');
            meta.className = 'meta';
            meta.textContent = `Date: ${new Date(note.lastSavedAt).toLocaleDateString()} | Meeting: ${note.meetingCode}`;

            const contentDiv = doc.createElement('div');
            contentDiv.className = 'content';
            contentDiv.textContent = note.markdownContent || '';

            doc.body.appendChild(h1);
            doc.body.appendChild(meta);
            doc.body.appendChild(contentDiv);

            setTimeout(() => {
              printWindow.print();
            }, 300);
          }
        });
      });
    }
    // Server Settings configuration
    const inputServerUrl = document.getElementById('inputServerUrl');
    const btnSaveServerUrl = document.getElementById('btnSaveServerUrl');
    const serverUrlSaveMsg = document.getElementById('serverUrlSaveMsg');

    if (inputServerUrl && btnSaveServerUrl) {
      const defaultUrl = (typeof window.MEETMONITOR_CONFIG !== 'undefined' && window.MEETMONITOR_CONFIG.SERVER_URL)
        ? window.MEETMONITOR_CONFIG.SERVER_URL
        : 'http://localhost:4000';

      extAPI.storage.local.get(['customServerUrl'], (res) => {
        inputServerUrl.value = res.customServerUrl || defaultUrl;
      });

      btnSaveServerUrl.addEventListener('click', () => {
        const val = inputServerUrl.value.trim().replace(/\/+$/, '');
        if (!val) return;
        extAPI.storage.local.set({ customServerUrl: val }, () => {
          if (serverUrlSaveMsg) {
            serverUrlSaveMsg.style.display = 'block';
            setTimeout(() => { serverUrlSaveMsg.style.display = 'none'; }, 2000);
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


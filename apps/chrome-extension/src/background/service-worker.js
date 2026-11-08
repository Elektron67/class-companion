// apps/chrome-extension/src/background/service-worker.js

// Cross-browser WebExtensions API polyfill (Firefox, Brave, Chrome, Edge)
const extAPI = (typeof chrome !== 'undefined' && chrome.runtime)
  ? chrome
  : (typeof browser !== 'undefined' ? browser : null);

let lastCheckTabId = null;
let activeSocket = null;
let activePort = null;

// 1. Desktop Notification Handling with Static PNG Icon
extAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'TRIGGER_CHECK_NOTIFICATION') {
    if (sender.tab && sender.tab.id) {
      lastCheckTabId = sender.tab.id;
    }

    extAPI.notifications.create('meetmonitor_check_alert', {
      type: 'basic',
      iconUrl: extAPI.runtime.getURL('icons/icon48.png'),
      title: 'Class Participation Check Active!',
      message: `Type phrase "${message.targetPhrase}" now. You have 20 seconds remaining!`,
      priority: 2,
      requireInteraction: true
    });

    sendResponse({ delivered: true });
    return true;
  }
});

extAPI.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'meetmonitor_check_alert' && lastCheckTabId) {
    extAPI.tabs.update(lastCheckTabId, { active: true }, (tab) => {
      if (tab && tab.windowId) {
        extAPI.windows.update(tab.windowId, { focused: true });
      }
    });
    extAPI.notifications.clear(notificationId);
  }
});

// 2. CSP-Immune WebSocket Bridge for Google Meet
// Content scripts on meet.google.com can be subject to page-level CSP (connect-src).
// This bridge allows the content script to route WebSocket traffic through the service worker.
extAPI.runtime.onConnect.addListener((port) => {
  if (port.name !== 'meetmonitor-stream') return;
  activePort = port;

  port.onMessage.addListener((msg) => {
    if (msg.action === 'CONNECT_WS') {
      const wsUrl = msg.wsUrl;
      if (activeSocket) {
        try { activeSocket.close(); } catch (e) {}
      }

      try {
        activeSocket = new WebSocket(wsUrl);

        activeSocket.onopen = () => {
          port.postMessage({ type: 'WS_OPEN' });
        };

        activeSocket.onmessage = (event) => {
          port.postMessage({ type: 'WS_MESSAGE', data: event.data });
        };

        activeSocket.onerror = (err) => {
          port.postMessage({ type: 'WS_ERROR', error: 'WebSocket connection failed' });
        };

        activeSocket.onclose = () => {
          port.postMessage({ type: 'WS_CLOSE' });
        };
      } catch (err) {
        port.postMessage({ type: 'WS_ERROR', error: err.message });
      }
    } else if (msg.action === 'SEND_WS') {
      if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(msg.data);
      }
    } else if (msg.action === 'CLOSE_WS') {
      if (activeSocket) {
        try { activeSocket.close(); } catch (e) {}
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (activePort === port) {
      activePort = null;
    }
  });
});

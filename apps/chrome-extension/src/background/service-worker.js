// apps/chrome-extension/src/background/service-worker.js

let lastCheckTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'TRIGGER_CHECK_NOTIFICATION') {
    if (sender.tab && sender.tab.id) {
      lastCheckTabId = sender.tab.id;
    }

    chrome.notifications.create('meetmonitor_check_alert', {
      type: 'basic',
      iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%22%23f59e0b%22/><text x="50" y="65" font-size="50" text-anchor="middle" fill="black">⚡</text></svg>',
      title: 'Class Participation Check Active!',
      message: `Type phrase "${message.targetPhrase}" now. You have 20 seconds remaining!`,
      priority: 2,
      requireInteraction: true
    });

    sendResponse({ delivered: true });
    return true;
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'meetmonitor_check_alert' && lastCheckTabId) {
    chrome.tabs.update(lastCheckTabId, { active: true }, (tab) => {
      if (tab && tab.windowId) {
        chrome.windows.update(tab.windowId, { focused: true });
      }
    });
    chrome.notifications.clear(notificationId);
  }
});


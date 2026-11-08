// apps/chrome-extension/src/content/meet-detector.js

/**
 * Resilient Google Meet In-Call State Detector
 * 
 * Inspects stable accessibility attributes (aria-labels) rather than obfuscated
 * class names to detect whether the user is:
 * - 'LOBBY': In the pre-join "green room"
 * - 'IN_CALL': Actively participating in the call
 * - 'LEFT_CALL': On the post-call exit screen
 * 
 * Graceful Degradation: If Google alters attributes, falls back to 'IN_CALL'
 * as long as the URL matches a meeting pattern so students are never blocked.
 */

export class MeetDetector {
  constructor(onStateChange) {
    this.onStateChange = onStateChange;
    this.currentState = 'UNKNOWN';
    this.pollInterval = null;
    this.observer = null;
  }

  start() {
    this.checkState();

    // Use MutationObserver for immediate reactivity on DOM changes
    this.observer = new MutationObserver(() => {
      this.checkState();
    });

    if (document.body) {
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    // Also poll every 2 seconds as a fallback
    this.pollInterval = setInterval(() => {
      this.checkState();
    }, 2000);
  }

  stop() {
    if (this.observer) this.observer.disconnect();
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  detect() {
    const textContent = document.body ? document.body.innerText || '' : '';

    // 1. Post-call exit screen heuristic
    if (
      textContent.includes('You left the meeting') ||
      textContent.includes('You were removed from the meeting') ||
      textContent.includes('Return to home screen')
    ) {
      return 'LEFT_CALL';
    }

    // 2. In-Call heuristic (Leave Call button or participant controls)
    const leaveButton = document.querySelector(
      'button[aria-label*="Leave call" i], button[data-tooltip*="Leave call" i], button[aria-label*="leave" i]'
    );
    if (leaveButton) {
      return 'IN_CALL';
    }

    // Check for active participant media elements
    const inCallVideos = document.querySelectorAll('video');
    if (inCallVideos.length > 1) {
      return 'IN_CALL';
    }

    // 3. Lobby / Pre-join heuristic
    const joinButton = document.querySelector(
      'button[aria-label*="Join now" i], button[aria-label*="Ask to join" i], button[data-tooltip*="Join now" i]'
    );
    if (joinButton || textContent.includes('Ready to join?')) {
      return 'LOBBY';
    }

    // 4. Graceful Fallback:
    // If URL matches standard Meet room, assume IN_CALL so participation checks remain active
    const isMeetUrl = /\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(window.location.pathname);
    return isMeetUrl ? 'IN_CALL' : 'UNKNOWN';
  }

  checkState() {
    const newState = this.detect();
    if (newState !== this.currentState) {
      this.currentState = newState;
      if (this.onStateChange) {
        this.onStateChange(newState);
      }
    }
  }
}

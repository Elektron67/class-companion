# Project Cephalon: Google Meet Participation & Class Engagement Monitoring System

A privacy-preserving, dual-interface application designed to help instructors monitor participation during online classes held in Google Meet.

---

## Architecture Overview

```
+---------------------------------------------------------------------------------------------------+
|                                        SYSTEM TOPOLOGY                                            |
|                                                                                                   |
|   +--------------------------+        WSS / HTTPS         +-----------------------------------+   |
|   | Student Chrome Extension | <=======================> |       Backend API & Real-Time      |   |
|   | (Content Script + Notes) |    (Guest Token Auth)     |     (Fastify / Node.js + SQLite)   |   |
|   +--------------------------+                           +-----------------------------------+   |
|                                                                            ^                      |
|                                                                            | WSS / HTTPS          |
|                                                                            | (Role: Instructor)   |
|                                                                            v                      |
|                                                          +-----------------------------------+   |
|                                                          |     Instructor Web Dashboard      |   |
|                                                          |   (Vanilla JS / Responsive SPA)   |   |
|                                                          +-----------------------------------+   |
+---------------------------------------------------------------------------------------------------+
```

### Core Components
1. **Student Chrome Extension (Manifest V3):**
   - Injected into `https://meet.google.com/[a-z]{3}-[a-z]{4}-[a-z]{3}`.
   - Isolated Shadow DOM to prevent style interference with Google Meet.
   - Real-time tab visibility & window focus telemetry (`document.visibilityState`, `window.onfocus/blur`).
   - 20-second participation check prompt with chime sound and background desktop notifications (`chrome.notifications`).
   - Server-enforced AFK breaks (up to 3 uses $\times$ 5 minutes max).
   - Local-only student notes with auto-save to `chrome.storage.local` and client-side printable PDF export.
2. **Instructor Web Dashboard:**
   - Session creation tied to a specific Google Meet meeting.
   - Ephemeral 6-character student join code.
   - Live roster telemetry with neutral labeling: `Meet focused`, `Meet not focused`, `Meet hidden`, `Disconnected`.
   - 20-second participation check trigger with live progress meters, snapshot reconciliation, and private non-responder reveal.
3. **Backend API & Real-Time Server:**
   - Server-authoritative session validity, join codes, and 20-second deadlines.
   - Case-insensitive, NFKC Unicode and internal whitespace-tolerant normalization engine.
   - Ephemeral guest tokens (`guestToken`) supporting seamless student reconnection without duplicate roster entries.

---

## Getting Started

### 1. Prerequisites
- **Node.js:** v22+ or v24+
- **Google Chrome:** v115+ (Manifest V3 support)

### 2. Start the Backend Server & Dashboard
```bash
# Start the HTTP API, WebSocket gateway, and Instructor Dashboard
npm run start:backend
```
- **Instructor Dashboard:** Open [http://localhost:4000](http://localhost:4000)
- **API Base:** `http://localhost:4000/api/v1`
- **WebSocket Gateway:** `ws://localhost:4000/ws`

### 3. Load the Student Chrome Extension
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** (top-right corner).
3. Click **Load unpacked**.
4. Select the folder: `c:\Users\Jerome\Documents\PROGRAMMING\Projects\Project Cephalon\apps\chrome-extension`.

---

## Running the Automated Test Suite

Project Cephalon includes unit tests, integration service tests, and end-to-end WebSocket lifecycle tests:

```bash
npm test
```

### Verified Test Matrix:
- **String Normalization:** NFKC Unicode compatibility, lowercase conversion, leading/trailing trim, internal space collapsing, and word boundary preservation.
- **Session Lifecycle:** Meeting code format validation (`[a-z]{3}-[a-z]{4}-[a-z]{3}`), temporary code expiration on session termination, and cross-meeting code rejection.
- **Roster & Telemetry:** Guest token reconnection, duplicate name detection with visual disambiguation (`Alice Smith #2`), and heartbeat timeout sweeping to `UNKNOWN`.
- **AFK Boundary Engine:** 3-break allocation limit, early return with use forfeiture, check-in-progress lock, and retroactive excuse protection.
- **Participation Engine:** Authoritative 20-second deadline enforcement, retry support for incorrect attempts, duplicate rejection, and strict mathematical reconciliation ($\text{Snapshot Total} = \text{Responded} + \text{Did Not Respond} + \text{Excused}$).


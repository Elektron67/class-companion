// packages/shared-types/src/types.ts

export type FocusState = 'FOCUSED' | 'UNFOCUSED' | 'HIDDEN';
export type ConnectionStatus = 'CONNECTED' | 'UNKNOWN' | 'DISCONNECTED';
export type CallState = 'LOBBY' | 'IN_CALL' | 'LEFT_CALL' | 'UNKNOWN';
export type SessionStatus = 'ACTIVE' | 'ENDED';
export type CheckStatus = 'OPEN' | 'FINALIZED';

export type CheckResult =
  | 'PENDING'
  | 'RESPONDED'
  | 'DID_NOT_RESPOND'
  | 'EXCUSED_AFK'
  | 'INELIGIBLE_LATE';

export interface ClassSession {
  id: string;
  instructorId: string;
  meetingCode: string; // e.g. "abc-defg-hij"
  title: string;
  joinCode: string; // e.g. "C8M3K9"
  status: SessionStatus;
  startedAt: number; // Unix timestamp ms
  endedAt?: number;
}

export interface StudentRosterEntry {
  id: string;
  sessionId: string;
  guestToken: string;
  displayName: string;
  isDuplicateName?: boolean;
  connectionStatus: ConnectionStatus;
  focusState: FocusState;
  callState?: CallState;
  afkUsesConsumed: number; // Max 3
  afkExpiresAt?: number | null; // Unix timestamp ms
  lastHeartbeatAt: number;
  joinedAt: number;
}

export interface ParticipationCheck {
  id: string;
  sessionId: string;
  targetPhrase: string;
  targetPhraseNormalized: string;
  startedAt: number; // Server timestamp ms
  deadlineAt: number; // Server timestamp ms = startedAt + 20000
  status: CheckStatus;
}

export interface CheckSnapshotRecord {
  id: string;
  checkId: string;
  rosterGuestId: string;
  studentName: string;
  result: CheckResult;
  totalAttempts: number;
  finalSubmittedAt?: number | null;
}

export interface CheckSummary {
  checkId: string;
  targetPhrase: string;
  startedAt: number;
  deadlineAt: number;
  status: CheckStatus;
  snapshotTotal: number;
  eligibleTotal: number;
  respondedCount: number;
  didNotRespondCount: number;
  excusedCount: number;
  pendingCount: number;
  nonResponders?: string[]; // Revealed only when requested
}

export interface AttendanceExportRecord {
  displayName: string;
  isDuplicateName: boolean;
  joinedAt: string;
  totalChecks: number;
  responded: number;
  didNotRespond: number;
  excusedAFK: number;
  participationRatePercent: number;
  afkUsesConsumed: number;
  finalConnectionStatus: string;
  finalFocusState: string;
}

// Client-to-Server WebSocket payloads
export type UpstreamMessage =
  | {
      type: 'telemetry:update';
      payload: {
        focusState: FocusState;
        callState?: CallState;
        inCall: boolean;
        clientTimestamp: number;
      };
    }
  | {
      type: 'afk:request';
      payload: {
        action: 'START' | 'END'; // START = take 5min break, END = I'm back
      };
    }
  | {
      type: 'check:submit';
      payload: {
        checkId: string;
        inputPhrase: string;
        submissionId: string;
      };
    }
  | {
      type: 'ping';
    };

// Server-to-Client WebSocket payloads
export type DownstreamMessage =
  | {
      event: 'check:started';
      payload: {
        checkId: string;
        targetPhrase: string;
        startedAt: number;
        deadlineAt: number;
        durationSeconds: number;
      };
    }
  | {
      event: 'check:ack';
      payload: {
        checkId: string;
        status: 'SUCCESS' | 'INCORRECT' | 'EXPIRED' | 'DUPLICATE' | 'RETRY_ALLOWED';
        message: string;
        attempts?: number;
      };
    }
  | {
      event: 'check:progress';
      payload: {
        checkId: string;
        snapshotTotal: number;
        eligibleTotal: number;
        respondedCount: number;
        didNotRespondCount: number;
        excusedCount: number;
        pendingCount: number;
        remainingMs: number;
      };
    }
  | {
      event: 'check:finalized';
      payload: CheckSummary;
    }
  | {
      event: 'roster:update';
      payload: {
        students: StudentRosterEntry[];
      };
    }
  | {
      event: 'afk:ack';
      payload: {
        success: boolean;
        isActive: boolean;
        afkUsesConsumed: number;
        afkExpiresAt?: number | null;
        message: string;
      };
    }
  | {
      event: 'session:ended';
      payload: {
        message: string;
      };
    }
  | {
      event: 'session:ejected';
      payload: {
        message: string;
      };
    }
  | {
      event: 'pong';
    };

// Student Private Notes (Stored locally on client)
export interface StudentClassNote {
  sessionId: string;
  meetingCode: string;
  classTitle: string;
  sessionDate: string; // ISO string
  markdownContent: string;
  lastSavedAt: number;
}

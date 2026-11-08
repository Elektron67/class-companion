// apps/backend/src/services/roster.service.ts
import { randomUUID } from 'node:crypto';
import type { Database } from '../db.ts';
import type { StudentRosterEntry, FocusState, ConnectionStatus } from '../../../../packages/shared-types/src/types.ts';
import { normalizePhrase } from '../../../../packages/string-normalizer/src/index.ts';

const MAX_AFK_USES = 3;
const AFK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export class RosterService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  joinOrReconnect(
    sessionId: string,
    studentName: string,
    clientGuestToken?: string
  ): { guest: StudentRosterEntry; isReconnection: boolean } {
    const trimmedName = studentName.trim();
    if (!trimmedName) throw new Error('NAME_REQUIRED');

    // 1. Reconnection path: if valid guestToken provided for this session
    if (clientGuestToken) {
      const existing = this.db.raw.prepare(`
        SELECT * FROM roster_guests WHERE guest_token = ? AND session_id = ?
      `).get(clientGuestToken, sessionId) as any;

      if (existing) {
        const now = Date.now();
        this.db.raw.prepare(`
          UPDATE roster_guests
          SET connection_status = 'CONNECTED', last_heartbeat_at = ?
          WHERE id = ?
        `).run(now, existing.id);

        return {
          guest: this.mapRowToEntry({ ...existing, connection_status: 'CONNECTED', last_heartbeat_at: now }),
          isReconnection: true
        };
      }
    }

    // 2. New Join path: check for duplicate names in this session
    const normalizedNewName = normalizePhrase(trimmedName);
    const existingGuests = this.db.raw.prepare(`
      SELECT * FROM roster_guests WHERE session_id = ?
    `).all(sessionId) as any[];

    let duplicateCount = 0;
    for (const g of existingGuests) {
      if (normalizePhrase(g.display_name).startsWith(normalizedNewName)) {
        duplicateCount++;
      }
    }

    const isDuplicate = duplicateCount > 0;
    const finalDisplayName = isDuplicate ? `${trimmedName} #${duplicateCount + 1}` : trimmedName;
    const id = randomUUID();
    const guestToken = randomUUID();
    const now = Date.now();

    this.db.raw.prepare(`
      INSERT INTO roster_guests (
        id, session_id, guest_token, display_name, is_duplicate_name,
        connection_status, focus_state, afk_uses_consumed, last_heartbeat_at, joined_at
      ) VALUES (?, ?, ?, ?, ?, 'CONNECTED', 'FOCUSED', 0, ?, ?)
    `).run(id, sessionId, guestToken, finalDisplayName, isDuplicate ? 1 : 0, now, now);

    return {
      guest: {
        id,
        sessionId,
        guestToken,
        displayName: finalDisplayName,
        isDuplicateName: isDuplicate,
        connectionStatus: 'CONNECTED',
        focusState: 'FOCUSED',
        afkUsesConsumed: 0,
        afkExpiresAt: null,
        lastHeartbeatAt: now,
        joinedAt: now
      },
      isReconnection: false
    };
  }

  getGuestByToken(guestToken: string): StudentRosterEntry | null {
    const row = this.db.raw.prepare(`SELECT * FROM roster_guests WHERE guest_token = ?`).get(guestToken) as any;
    if (!row) return null;
    return this.mapRowToEntry(row);
  }

  getGuestById(guestId: string): StudentRosterEntry | null {
    const row = this.db.raw.prepare(`SELECT * FROM roster_guests WHERE id = ?`).get(guestId) as any;
    if (!row) return null;
    return this.mapRowToEntry(row);
  }

  getRosterForSession(sessionId: string): StudentRosterEntry[] {
    const rows = this.db.raw.prepare(`
      SELECT * FROM roster_guests WHERE session_id = ? ORDER BY joined_at ASC
    `).all(sessionId) as any[];
    return rows.map(r => this.mapRowToEntry(r));
  }

  updateTelemetry(guestToken: string, focusState: FocusState): StudentRosterEntry | null {
    const now = Date.now();
    const result = this.db.raw.prepare(`
      UPDATE roster_guests
      SET focus_state = ?, connection_status = 'CONNECTED', last_heartbeat_at = ?
      WHERE guest_token = ?
    `).run(focusState, now, guestToken);

    if (result.changes === 0) return null;
    return this.getGuestByToken(guestToken);
  }

  setConnectionStatus(guestToken: string, status: ConnectionStatus): void {
    this.db.raw.prepare(`
      UPDATE roster_guests SET connection_status = ? WHERE guest_token = ?
    `).run(status, guestToken);
  }

  sweepStaleHeartbeats(sessionId: string, timeoutMs: number = 15000): StudentRosterEntry[] {
    const cutoff = Date.now() - timeoutMs;
    this.db.raw.prepare(`
      UPDATE roster_guests
      SET connection_status = 'UNKNOWN'
      WHERE session_id = ? AND connection_status = 'CONNECTED' AND last_heartbeat_at < ?
    `).run(sessionId, cutoff);

    return this.getRosterForSession(sessionId);
  }

  requestAFK(guestToken: string, isCheckInProgress: boolean): { success: boolean; guest?: StudentRosterEntry; error?: string } {
    const guest = this.getGuestByToken(guestToken);
    if (!guest) return { success: false, error: 'GUEST_NOT_FOUND' };

    // Rule: Cannot declare AFK if participation check is active
    if (isCheckInProgress) {
      return { success: false, error: 'CHECK_IN_PROGRESS' };
    }

    // Rule: Cannot declare if already in active AFK
    const now = Date.now();
    if (guest.afkExpiresAt && guest.afkExpiresAt > now) {
      return { success: false, error: 'ALREADY_AFK' };
    }

    // Rule: Max 3 AFK uses per session
    if (guest.afkUsesConsumed >= MAX_AFK_USES) {
      return { success: false, error: 'LIMIT_REACHED' };
    }

    const newConsumed = guest.afkUsesConsumed + 1;
    const expiresAt = now + AFK_DURATION_MS;

    this.db.raw.prepare(`
      UPDATE roster_guests
      SET afk_uses_consumed = ?, afk_expires_at = ?
      WHERE id = ?
    `).run(newConsumed, expiresAt, guest.id);

    return {
      success: true,
      guest: this.getGuestById(guest.id)!
    };
  }

  endAFKEarly(guestToken: string): { success: boolean; guest?: StudentRosterEntry; error?: string } {
    const guest = this.getGuestByToken(guestToken);
    if (!guest) return { success: false, error: 'GUEST_NOT_FOUND' };

    // Clear expiry but keep consumed count
    this.db.raw.prepare(`
      UPDATE roster_guests SET afk_expires_at = NULL WHERE id = ?
    `).run(guest.id);

    return {
      success: true,
      guest: this.getGuestById(guest.id)!
    };
  }

  renameGuest(sessionId: string, guestId: string, newName: string): StudentRosterEntry | null {
    const clean = newName.trim();
    if (!clean) return null;
    this.db.raw.prepare(`
      UPDATE roster_guests SET display_name = ? WHERE id = ? AND session_id = ?
    `).run(clean, guestId, sessionId);
    return this.getGuestById(guestId);
  }

  ejectGuest(sessionId: string, guestId: string): boolean {
    const result = this.db.raw.prepare(`
      DELETE FROM roster_guests WHERE id = ? AND session_id = ?
    `).run(guestId, sessionId);
    return result.changes > 0;
  }

  private mapRowToEntry(row: any): StudentRosterEntry {
    const now = Date.now();
    const afkActive = row.afk_expires_at && row.afk_expires_at > now;
    return {
      id: row.id,
      sessionId: row.session_id,
      guestToken: row.guest_token,
      displayName: row.display_name,
      isDuplicateName: Boolean(row.is_duplicate_name),
      connectionStatus: row.connection_status as ConnectionStatus,
      focusState: row.focus_state as FocusState,
      afkUsesConsumed: row.afk_uses_consumed,
      afkExpiresAt: afkActive ? row.afk_expires_at : null,
      lastHeartbeatAt: row.last_heartbeat_at,
      joinedAt: row.joined_at
    };
  }
}

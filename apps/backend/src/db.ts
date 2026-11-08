// apps/backend/src/db.ts
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export class Database {
  private db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        instructor_id TEXT NOT NULL,
        meeting_code TEXT NOT NULL,
        title TEXT NOT NULL,
        join_code TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS roster_guests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        guest_token TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        is_duplicate_name INTEGER NOT NULL DEFAULT 0,
        connection_status TEXT NOT NULL DEFAULT 'CONNECTED',
        focus_state TEXT NOT NULL DEFAULT 'FOCUSED',
        afk_uses_consumed INTEGER NOT NULL DEFAULT 0,
        afk_expires_at INTEGER,
        last_heartbeat_at INTEGER NOT NULL,
        joined_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS participation_checks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        target_phrase TEXT NOT NULL,
        target_phrase_normalized TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN'
      );

      CREATE TABLE IF NOT EXISTS check_snapshots (
        id TEXT PRIMARY KEY,
        check_id TEXT NOT NULL REFERENCES participation_checks(id) ON DELETE CASCADE,
        roster_guest_id TEXT NOT NULL REFERENCES roster_guests(id) ON DELETE CASCADE,
        student_name TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT 'PENDING',
        total_attempts INTEGER NOT NULL DEFAULT 0,
        final_submitted_at INTEGER,
        UNIQUE(check_id, roster_guest_id)
      );

      CREATE TABLE IF NOT EXISTS check_submissions (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES check_snapshots(id) ON DELETE CASCADE,
        raw_input TEXT NOT NULL,
        is_match INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      );
    `);
  }

  get raw(): DatabaseSync {
    return this.db;
  }
}


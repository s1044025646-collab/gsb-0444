import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ParseReport } from '../core/types.js';

export interface ReportRow {
  id: number;
  group_id: number;
  revision: number;
  valid: number;
  packet_size: number;
  parser_version: number;
  note: string | null;
  created_at: string;
  raw_hex: string;
  tree_json: string | null;
  report_json: string;
}

export class ReportStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        valid INTEGER NOT NULL,
        packet_size INTEGER NOT NULL,
        parser_version INTEGER NOT NULL,
        raw_hex TEXT NOT NULL,
        tree_json TEXT,
        report_json TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (group_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_reports_group ON reports(group_id, revision);
    `);
  }

  /** 保存报告；传入 group_id 则在该组生成新版本，否则新建组。错误包也可保存但 valid=0。 */
  saveReport(report: ParseReport, opts: { groupId?: number; note?: string } = {}): ReportRow {
    const groupId = opts.groupId ?? this.nextGroupId();
    const maxRev = this.db
      .prepare('SELECT COALESCE(MAX(revision), 0) AS r FROM reports WHERE group_id = ?')
      .get(groupId) as { r: number };
    const revision = maxRev.r + 1;
    const info = this.db
      .prepare(
        `INSERT INTO reports (group_id, revision, valid, packet_size, parser_version, raw_hex, tree_json, report_json, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        groupId,
        revision,
        report.valid ? 1 : 0,
        report.packetSize,
        report.parserVersion,
        report.hex,
        report.tree ? JSON.stringify(report.tree) : null,
        JSON.stringify(report),
        opts.note ?? null,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  private nextGroupId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(group_id), 0) + 1 AS g FROM reports').get() as { g: number };
    return row.g;
  }

  get(id: number): ReportRow | null {
    return (this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined) ?? null;
  }

  listReports(limit = 50): ReportRow[] {
    return this.db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT ?').all(limit) as unknown as ReportRow[];
  }

  listGroup(groupId: number): ReportRow[] {
    return this.db.prepare('SELECT * FROM reports WHERE group_id = ? ORDER BY revision').all(groupId) as unknown as ReportRow[];
  }

  close(): void {
    this.db.close();
  }
}

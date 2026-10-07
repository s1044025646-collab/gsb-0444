import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PARSER_VERSION } from "./osc/limits.js";

export interface SaveResult {
  packetId: number;
  version: number;
}

export class OscDb {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const dir = process.env.OSC_DATA_DIR ?? path.join(process.cwd(), "data");
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath ?? path.join(dir, "osc.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS packets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        packet_id INTEGER NOT NULL REFERENCES packets(id),
        version INTEGER NOT NULL,
        parser_version TEXT NOT NULL,
        raw BLOB NOT NULL,
        tree_json TEXT,
        diagnostics_json TEXT NOT NULL,
        ok INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(packet_id, version)
      );
    `);
  }

  /** 保存新算例（version=1）。错误包也保存原字节与诊断，但 ok=0。 */
  savePacket(name: string, raw: Buffer, tree: unknown, diagnostics: unknown, ok: boolean): SaveResult {
    const info = this.db.prepare("INSERT INTO packets (name) VALUES (?)").run(name);
    const packetId = Number(info.lastInsertRowid);
    this.insertVersion(packetId, 1, raw, tree, diagnostics, ok);
    return { packetId, version: 1 };
  }

  /** 修订：为已有算例追加一个新版本 */
  revisePacket(packetId: number, raw: Buffer, tree: unknown, diagnostics: unknown, ok: boolean): SaveResult {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM versions WHERE packet_id = ?").get(packetId) as
      | { v: number | null }
      | undefined;
    if (!row || row.v === null) {
      throw new Error(`算例 ${packetId} 不存在`);
    }
    const version = row.v + 1;
    this.insertVersion(packetId, version, raw, tree, diagnostics, ok);
    return { packetId, version };
  }

  private insertVersion(packetId: number, version: number, raw: Buffer, tree: unknown, diagnostics: unknown, ok: boolean): void {
    this.db
      .prepare(
        "INSERT INTO versions (packet_id, version, parser_version, raw, tree_json, diagnostics_json, ok) VALUES (?,?,?,?,?,?,?)",
      )
      .run(packetId, version, PARSER_VERSION, raw, tree == null ? null : JSON.stringify(tree), JSON.stringify(diagnostics), ok ? 1 : 0);
  }

  listPackets(): unknown[] {
    return this.db
      .prepare(
        `SELECT p.id, p.name, p.created_at, COUNT(v.id) AS versions, MAX(v.ok) AS ok
         FROM packets p LEFT JOIN versions v ON v.packet_id = p.id
         GROUP BY p.id ORDER BY p.id`,
      )
      .all();
  }

  getVersion(packetId: number, version?: number): Record<string, unknown> | null {
    const row = (
      version == null
        ? this.db.prepare("SELECT * FROM versions WHERE packet_id = ? ORDER BY version DESC LIMIT 1").get(packetId)
        : this.db.prepare("SELECT * FROM versions WHERE packet_id = ? AND version = ?").get(packetId, version)
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    const raw = Buffer.from(row.raw as Uint8Array);
    return {
      packet_id: row.packet_id,
      version: row.version,
      parser_version: row.parser_version,
      ok: row.ok === 1,
      hex: raw.toString("hex"),
      length: raw.length,
      tree: row.tree_json ? JSON.parse(row.tree_json as string) : null,
      diagnostics: JSON.parse(row.diagnostics_json as string),
      created_at: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}

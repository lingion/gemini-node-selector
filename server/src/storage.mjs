import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Persistent SQLite storage for probed node states, multi-source IP intelligence cache,
 * and subscription YAML snapshots (including last-known-good fallback).
 */
export class Storage {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        fingerprint TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        egress_ip TEXT,
        ip_family INTEGER DEFAULT 4,
        ip_consensus INTEGER DEFAULT 0,
        country_code TEXT DEFAULT 'XX',
        region TEXT DEFAULT 'Unknown',
        city TEXT DEFAULT 'Unknown',
        asn INTEGER DEFAULT 0,
        as_name TEXT DEFAULT 'Unknown',
        network_type TEXT DEFAULT 'unknown',
        is_datacenter INTEGER DEFAULT 0,
        facility_name TEXT DEFAULT 'Unknown',
        facility_confidence TEXT DEFAULT 'D',
        intel_sources_json TEXT DEFAULT '[]',
        gemini_status TEXT DEFAULT 'UNTESTED',
        gemini_details_json TEXT DEFAULT '{}',
        gemini_last_checked INTEGER DEFAULT 0,
        ip_last_checked INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS intel_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sub_cache (
        cache_key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        meta_json TEXT DEFAULT '{}',
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  getIntelCache(key) {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare('SELECT payload_json FROM intel_cache WHERE cache_key = ? AND expires_at > ?').get(key, now);
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  }

  setIntelCache(key, payload, ttlSeconds) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('INSERT OR REPLACE INTO intel_cache (cache_key, payload_json, expires_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(payload), now + ttlSeconds);
  }

  getSubCache(key, allowExpired = false) {
    const now = Math.floor(Date.now() / 1000);
    const row = allowExpired
      ? this.db.prepare('SELECT value, meta_json, expires_at, updated_at FROM sub_cache WHERE cache_key = ?').get(key)
      : this.db.prepare('SELECT value, meta_json, expires_at, updated_at FROM sub_cache WHERE cache_key = ? AND expires_at > ?').get(key, now);
    if (!row) return null;
    return {
      value: row.value,
      meta: JSON.parse(row.meta_json || '{}'),
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
      stale: row.expires_at <= now,
    };
  }

  setSubCache(key, value, meta, ttlSeconds) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('INSERT OR REPLACE INTO sub_cache (cache_key, value, meta_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(key, value, JSON.stringify(meta || {}), now + ttlSeconds, now);
  }

  getNode(fingerprint) {
    return this.db.prepare('SELECT * FROM nodes WHERE fingerprint = ?').get(fingerprint) || null;
  }

  upsertNode(record) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO nodes (
        fingerprint, source_id, original_name, normalized_name, protocol,
        egress_ip, ip_family, ip_consensus, country_code, region, city,
        asn, as_name, network_type, is_datacenter, facility_name, facility_confidence,
        intel_sources_json, gemini_status, gemini_details_json,
        gemini_last_checked, ip_last_checked, duration_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        source_id = excluded.source_id,
        original_name = excluded.original_name,
        normalized_name = excluded.normalized_name,
        protocol = excluded.protocol,
        egress_ip = excluded.egress_ip,
        ip_family = excluded.ip_family,
        ip_consensus = excluded.ip_consensus,
        country_code = excluded.country_code,
        region = excluded.region,
        city = excluded.city,
        asn = excluded.asn,
        as_name = excluded.as_name,
        network_type = excluded.network_type,
        is_datacenter = excluded.is_datacenter,
        facility_name = excluded.facility_name,
        facility_confidence = excluded.facility_confidence,
        intel_sources_json = excluded.intel_sources_json,
        gemini_status = excluded.gemini_status,
        gemini_details_json = excluded.gemini_details_json,
        gemini_last_checked = excluded.gemini_last_checked,
        ip_last_checked = excluded.ip_last_checked,
        duration_ms = excluded.duration_ms,
        updated_at = excluded.updated_at
    `).run(
      record.fingerprint,
      record.source_id,
      record.original_name,
      record.normalized_name,
      record.protocol,
      record.egress_ip || null,
      record.ip_family || 4,
      record.ip_consensus ? 1 : 0,
      record.country_code || 'XX',
      record.region || 'Unknown',
      record.city || 'Unknown',
      Number(record.asn) || 0,
      record.as_name || 'Unknown',
      record.network_type || 'unknown',
      record.is_datacenter ? 1 : 0,
      record.facility_name || 'Unknown',
      record.facility_confidence || 'D',
      JSON.stringify(record.intel_sources || []),
      record.gemini_status || 'FAIL',
      JSON.stringify(record.gemini_details || {}),
      record.gemini_last_checked || now,
      record.ip_last_checked || now,
      record.duration_ms || 0,
      now
    );
  }

  getAllNodes() {
    return this.db.prepare('SELECT * FROM nodes ORDER BY updated_at DESC').all();
  }
}

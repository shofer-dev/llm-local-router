/**
 * SQLite persistence layer for the metrics collector.
 *
 * Stores per-request entries and pre-aggregated 5-minute window data
 * using sql.js (SQLite compiled to WebAssembly). On startup, recent
 * windows are loaded back into the in-memory collector. On window
 * transitions, the closing window is flushed to disk.
 *
 * sql.js is pure TypeScript/WebAssembly — no native addons, so a
 * single VSIX works cross-platform (Linux, macOS, Windows).
 *
 * Schema:
 *   requests  — raw per-request entries (for detailed historical queries)
 *   windows   — pre-aggregated window data as JSON blobs (for fast retrieval)
 */

import initSqlJs, { Database as SqlJsDatabase, SqlValue } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import {
    MetricsRequestEntry,
    MetricsWindow,
    ModelWindowStats,
} from './types';

/** How many days of data to retain before pruning. */
const RETENTION_DAYS = 30;

export class MetricsStorage {
    private db: SqlJsDatabase;
    private dbPath: string;
    /** When false, saveToDisk() is a no-op — used inside transactions. */
    private autoSave = true;

    /** Private constructor — use MetricsStorage.create() instead. */
    private constructor(db: SqlJsDatabase, dbPath: string) {
        this.db = db;
        this.dbPath = dbPath;
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous = NORMAL');
        this.db.run('PRAGMA cache_size = -8000'); // 8MB cache
        this.initSchema();
    }

    /**
     * Create a MetricsStorage instance, loading existing data from disk
     * if a database file already exists at the given path.
     */
    static async create(dbPath: string): Promise<MetricsStorage> {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const SQL = await initSqlJs();

        let db: SqlJsDatabase;
        if (fs.existsSync(dbPath)) {
            const buffer = fs.readFileSync(dbPath);
            db = new SQL.Database(buffer);
        } else {
            db = new SQL.Database();
        }

        return new MetricsStorage(db, dbPath);
    }

    // ─── Persistence helpers ──────────────────────────────────────

    /** Write the in-memory database to disk. No-op inside transactions. */
    private saveToDisk(): void {
        if (!this.autoSave) return;
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
    }

    /**
     * Execute a write statement (INSERT / UPDATE / DELETE) with named
     * parameters and persist to disk.
     */
    private runWrite(sql: string, params: Record<string, SqlValue> = {}): void {
        this.db.run(sql, params);
        this.saveToDisk();
    }

    /** Query all rows matching the statement. */
    private queryAll<T>(sql: string, params: Record<string, SqlValue> = {}): T[] {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        const rows: T[] = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject() as unknown as T);
        }
        stmt.free();
        return rows;
    }

    /** Query a single row, or undefined if none. */
    private queryOne<T>(sql: string, params: Record<string, SqlValue> = {}): T | undefined {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        let row: T | undefined;
        if (stmt.step()) {
            row = stmt.getAsObject() as unknown as T;
        }
        stmt.free();
        return row;
    }

    // ─── Schema ────────────────────────────────────────────────────

    private initSchema(): void {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                model_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                is_composite INTEGER NOT NULL DEFAULT 0,
                composite_model_id TEXT,
                served_by_model TEXT NOT NULL,
                status TEXT NOT NULL,
                error_type TEXT,
                error_message TEXT,
                ttfb_ms INTEGER NOT NULL DEFAULT 0,
                ttlb_ms INTEGER NOT NULL DEFAULT 0,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0,
                failover_occurred INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 1
            );

            CREATE INDEX IF NOT EXISTS idx_requests_timestamp
                ON requests(timestamp);
            CREATE INDEX IF NOT EXISTS idx_requests_model_id
                ON requests(model_id);
            CREATE INDEX IF NOT EXISTS idx_requests_status
                ON requests(status);
            CREATE INDEX IF NOT EXISTS idx_requests_composite
                ON requests(composite_model_id)
                WHERE composite_model_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS windows (
                window_start TEXT NOT NULL,
                model_id TEXT NOT NULL,
                data_json TEXT NOT NULL,
                PRIMARY KEY (window_start, model_id)
            );

            CREATE INDEX IF NOT EXISTS idx_windows_start
                ON windows(window_start);
        `);
        this.saveToDisk();
    }

    // ─── Write ─────────────────────────────────────────────────────

    private INSERT_REQUEST_SQL = `
        INSERT INTO requests (
            timestamp, model_id, provider, is_composite,
            composite_model_id, served_by_model, status,
            error_type, error_message, ttfb_ms, ttlb_ms,
            prompt_tokens, completion_tokens, cached_tokens,
            cache_creation_tokens, cost_usd, failover_occurred, attempts
        ) VALUES (
            :timestamp, :model_id, :provider, :is_composite,
            :composite_model_id, :served_by_model, :status,
            :error_type, :error_message, :ttfb_ms, :ttlb_ms,
            :prompt_tokens, :completion_tokens, :cached_tokens,
            :cache_creation_tokens, :cost_usd, :failover_occurred, :attempts
        )
    `;

    /**
     * Insert a single request entry into the database.
     * Called after each window closes (batch insert) or on each request
     * if real-time persistence is desired.
     */
    insertRequest(entry: MetricsRequestEntry): void {
        this.runWrite(this.INSERT_REQUEST_SQL, {
            ':timestamp': entry.timestamp,
            ':model_id': entry.modelId,
            ':provider': entry.provider,
            ':is_composite': entry.isComposite ? 1 : 0,
            ':composite_model_id': entry.compositeModelId ?? null,
            ':served_by_model': entry.servedByModel,
            ':status': entry.status,
            ':error_type': entry.errorType ?? null,
            ':error_message': entry.errorMessage ?? null,
            ':ttfb_ms': entry.ttfbMs,
            ':ttlb_ms': entry.ttlbMs,
            ':prompt_tokens': entry.promptTokens,
            ':completion_tokens': entry.completionTokens,
            ':cached_tokens': entry.cachedTokens,
            ':cache_creation_tokens': entry.cacheCreationTokens,
            ':cost_usd': entry.costUsd,
            ':failover_occurred': entry.failoverOccurred ? 1 : 0,
            ':attempts': entry.attempts,
        });
    }

    /**
     * Batch-insert multiple request entries in a transaction.
     */
    insertRequests(entries: MetricsRequestEntry[]): void {
        this.autoSave = false;
        try {
            this.db.run('BEGIN');
            for (const entry of entries) {
                this.db.run(this.INSERT_REQUEST_SQL, {
                    ':timestamp': entry.timestamp,
                    ':model_id': entry.modelId,
                    ':provider': entry.provider,
                    ':is_composite': entry.isComposite ? 1 : 0,
                    ':composite_model_id': entry.compositeModelId ?? null,
                    ':served_by_model': entry.servedByModel,
                    ':status': entry.status,
                    ':error_type': entry.errorType ?? null,
                    ':error_message': entry.errorMessage ?? null,
                    ':ttfb_ms': entry.ttfbMs,
                    ':ttlb_ms': entry.ttlbMs,
                    ':prompt_tokens': entry.promptTokens,
                    ':completion_tokens': entry.completionTokens,
                    ':cached_tokens': entry.cachedTokens,
                    ':cache_creation_tokens': entry.cacheCreationTokens,
                    ':cost_usd': entry.costUsd,
                    ':failover_occurred': entry.failoverOccurred ? 1 : 0,
                    ':attempts': entry.attempts,
                });
            }
            this.db.run('COMMIT');
        } catch (err) {
            this.db.run('ROLLBACK');
            throw err;
        } finally {
            this.autoSave = true;
            this.saveToDisk();
        }
    }

    /**
     * Save a single model's window stats as a JSON blob.
     */
    upsertWindowStats(windowStart: string, modelId: string, stats: ModelWindowStats): void {
        this.runWrite(
            `INSERT INTO windows (window_start, model_id, data_json)
             VALUES (:window_start, :model_id, :data_json)
             ON CONFLICT(window_start, model_id) DO UPDATE SET
                 data_json = excluded.data_json`,
            {
                ':window_start': windowStart,
                ':model_id': modelId,
                ':data_json': JSON.stringify(stats),
            },
        );
    }

    /**
     * Save all model stats from a window in a transaction.
     */
    flushWindow(window: MetricsWindow): void {
        this.autoSave = false;
        try {
            this.db.run('BEGIN');
            for (const [modelId, stats] of Object.entries(window.models)) {
                this.db.run(
                    `INSERT INTO windows (window_start, model_id, data_json)
                     VALUES (:window_start, :model_id, :data_json)
                     ON CONFLICT(window_start, model_id) DO UPDATE SET
                         data_json = excluded.data_json`,
                    {
                        ':window_start': window.windowStart,
                        ':model_id': modelId,
                        ':data_json': JSON.stringify(stats),
                    },
                );
            }
            this.db.run('COMMIT');
        } catch (err) {
            this.db.run('ROLLBACK');
            throw err;
        } finally {
            this.autoSave = true;
            this.saveToDisk();
        }
    }

    // ─── Read ──────────────────────────────────────────────────────

    /**
     * Load windows starting from a given ISO timestamp.
     * Returns windows reconstructed from the per-model JSON blobs.
     */
    loadWindows(since: string): MetricsWindow[] {
        const rows = this.queryAll<{
            window_start: string;
            model_id: string;
            data_json: string;
        }>(
            `SELECT window_start, model_id, data_json
             FROM windows
             WHERE window_start >= :since
             ORDER BY window_start ASC`,
            { ':since': since },
        );

        // Group by window_start
        const windowMap = new Map<string, MetricsWindow>();
        for (const row of rows) {
            let win = windowMap.get(row.window_start);
            if (!win) {
                const startMs = new Date(row.window_start).getTime();
                win = {
                    windowStart: row.window_start,
                    windowEnd: new Date(startMs + 5 * 60 * 1000).toISOString(),
                    models: {},
                    compositeRouting: {},
                };
                windowMap.set(row.window_start, win);
            }
            try {
                win.models[row.model_id] = JSON.parse(row.data_json) as ModelWindowStats;
            } catch {
                // Corrupt JSON blob — skip
            }
        }

        return Array.from(windowMap.values())
            .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
    }

    /**
     * Query raw request entries for a model within a time range.
     */
    queryRequests(modelId: string, since: string, limit: number = 1000): MetricsRequestEntry[] {
        const rows = this.queryAll<Record<string, SqlValue>>(
            `SELECT * FROM requests
             WHERE model_id = :model_id
               AND timestamp >= :since
             ORDER BY timestamp DESC
             LIMIT :limit`,
            { ':model_id': modelId, ':since': since, ':limit': limit },
        );

        return rows.map(row => ({
            timestamp: row.timestamp as string,
            modelId: row.model_id as string,
            provider: row.provider as string,
            isComposite: !!(row.is_composite as number),
            compositeModelId: (row.composite_model_id as string) ?? undefined,
            servedByModel: row.served_by_model as string,
            status: row.status as MetricsRequestEntry['status'],
            errorType: (row.error_type as MetricsRequestEntry['errorType']) ?? undefined,
            errorMessage: (row.error_message as string) ?? undefined,
            ttfbMs: row.ttfb_ms as number,
            ttlbMs: row.ttlb_ms as number,
            promptTokens: row.prompt_tokens as number,
            completionTokens: row.completion_tokens as number,
            cachedTokens: row.cached_tokens as number,
            cacheCreationTokens: row.cache_creation_tokens as number,
            costUsd: row.cost_usd as number,
            failoverOccurred: !!(row.failover_occurred as number),
            attempts: row.attempts as number,
        }));
    }

    /**
     * Get the total cost across all stored requests for a model
     * within a time range.
     */
    getTotalCost(modelId: string, since: string): number {
        const row = this.queryOne<{ total: number }>(
            `SELECT COALESCE(SUM(cost_usd), 0) as total
             FROM requests
             WHERE model_id = :model_id AND timestamp >= :since`,
            { ':model_id': modelId, ':since': since },
        );
        return row?.total ?? 0;
    }

    /**
     * Get cost breakdown by model within a time range.
     */
    getCostBreakdown(since: string): Array<{ modelId: string; totalCost: number; requestCount: number }> {
        const rows = this.queryAll<{
            model_id: string;
            total_cost: number;
            request_count: number;
        }>(
            `SELECT
                 model_id,
                 COALESCE(SUM(cost_usd), 0) as total_cost,
                 COUNT(*) as request_count
             FROM requests
             WHERE timestamp >= :since
             GROUP BY model_id
             ORDER BY total_cost DESC`,
            { ':since': since },
        );

        return rows.map(r => ({
            modelId: r.model_id,
            totalCost: r.total_cost,
            requestCount: r.request_count,
        }));
    }

    // ─── Maintenance ───────────────────────────────────────────────

    /**
     * Prune data older than RETENTION_DAYS.
     * Returns the number of deleted rows.
     */
    prune(): { requestsDeleted: number; windowsDeleted: number } {
        const cutoff = new Date(
            Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString();

        this.autoSave = false;
        try {
            this.db.run('BEGIN');

            this.db.run(
                'DELETE FROM requests WHERE timestamp < :cutoff',
                { ':cutoff': cutoff },
            );
            const requestsDeleted = this.db.getRowsModified();

            this.db.run(
                'DELETE FROM windows WHERE window_start < :cutoff',
                { ':cutoff': cutoff },
            );
            const windowsDeleted = this.db.getRowsModified();

            this.db.run('COMMIT');
            return { requestsDeleted, windowsDeleted };
        } catch (err) {
            this.db.run('ROLLBACK');
            throw err;
        } finally {
            this.autoSave = true;
            this.saveToDisk();
        }
    }

    /** Number of distinct windows stored. */
    getWindowCount(): number {
        const row = this.queryOne<{ cnt: number }>(
            'SELECT COUNT(DISTINCT window_start) as cnt FROM windows',
        );
        return row?.cnt ?? 0;
    }

    /** Total number of raw request entries stored. */
    getRequestCount(): number {
        const row = this.queryOne<{ cnt: number }>(
            'SELECT COUNT(*) as cnt FROM requests',
        );
        return row?.cnt ?? 0;
    }

    /**
     * Vacuum the database to reclaim space after large deletions.
     */
    vacuum(): void {
        this.db.run('VACUUM');
        this.saveToDisk();
    }

    /** Close the database connection. */
    close(): void {
        this.db.close();
    }
}

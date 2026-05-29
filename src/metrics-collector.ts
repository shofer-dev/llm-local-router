/**
 * In-memory metrics collector with 5-minute windowed aggregation.
 *
 * Replaces the Prometheus metrics subsystem from llm-router (Go) with an
 * in-process collector suitable for a VS Code extension. Aggregates every
 * chat completion request into 5-minute aligned windows, tracking:
 *
 *   (a) Cost and token usage by model per 5m window
 *   (b) Reliability: latency (TTFB/TTLB percentiles), availability, error rates
 *   (c) Both primary and composite models
 *   (d) Composite load-balancing distribution (which underlying model served)
 *   (e) Additional KPIs: cache hit ratio, error type breakdown, throttle skips
 *
 * Query methods expose per-model and per-composite aggregated stats.
 * The Prometheus text-format export enables scraping by external monitoring.
 */

import {
    CompositeDistribution,
    ErrorType,
    MetricsRequestEntry,
    MetricsWindow,
    ModelSummary,
    ModelWindowStats,
    RequestStatus,
} from './types';
import { MetricsStorage } from './metrics-storage';

/** Duration of a single aggregation window. */
const WINDOW_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum windows retained (24 hours = 288 windows). */
const MAX_WINDOWS = 288;

/** Default SLO target: fraction of requests that must succeed. */
const DEFAULT_SLO_TARGET = 0.99;

/**
 * Compute a percentile from a sorted array of numbers.
 * Uses linear interpolation between adjacent values.
 */
function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Classify a JavaScript error into an ErrorType for metrics.
 */
export function classifyError(err: Error): { errorType: ErrorType; status: RequestStatus } {
    const msg = err.message || '';

    // AbortError → cancelled or timeout
    if (err.name === 'AbortError') {
        if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out')) {
            return { errorType: 'timeout', status: 'timeout' };
        }
        return { errorType: 'cancelled', status: 'cancelled' };
    }

    // LLMClientError or similar with HTTP status
    const httpMatch = msg.match(/HTTP\s+(\d{3})/i);
    if (httpMatch) {
        const code = parseInt(httpMatch[1], 10);
        if (code === 429) return { errorType: 'http_429', status: 'error' };
        if (code >= 500) return { errorType: 'http_5xx', status: 'error' };
        if (code >= 400) return { errorType: 'http_4xx', status: 'error' };
    }

    // Network errors
    if (
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('fetch failed') ||
        msg.includes('network')
    ) {
        return { errorType: 'network_error', status: 'error' };
    }

    // Timeout keywords
    if (
        msg.toLowerCase().includes('timeout') ||
        msg.toLowerCase().includes('timed out')
    ) {
        return { errorType: 'timeout', status: 'timeout' };
    }

    // Parse errors
    if (msg.includes('parse') || msg.includes('JSON')) {
        return { errorType: 'parse_error', status: 'error' };
    }

    return { errorType: 'unknown', status: 'error' };
}

export class MetricsCollector {
    private windows: MetricsWindow[] = [];

    /** Count of requests skipped due to throttling, keyed by modelId. */
    private throttleSkipCounts = new Map<string, number>();

    /** Optional SQLite persistence backend. */
    private _storage: MetricsStorage | undefined;

    /** Raw request entries for the current window (flushed on close). */
    private currentRawEntries: MetricsRequestEntry[] = [];

    // ─── Persistence ───────────────────────────────────────────────

    /**
     * Attach a SQLite storage backend for persistence.
     * Call loadFromStorage() after setting to restore historical data.
     */
    setStorage(storage: MetricsStorage): void {
        this._storage = storage;
    }

    /**
     * Load recent windows from SQLite into the in-memory collector.
     * Windows older than the in-memory retention (MAX_WINDOWS = 24h) are
     * still available via storage.queryRequests() for historical queries.
     */
    loadFromStorage(): void {
        if (!this._storage) return;

        const since = new Date(Date.now() - MAX_WINDOWS * WINDOW_DURATION_MS).toISOString();
        const stored = this._storage.loadWindows(since);

        // Merge stored windows into in-memory state, avoiding duplicates
        const existingStarts = new Set(this.windows.map(w => w.windowStart));
        for (const win of stored) {
            if (!existingStarts.has(win.windowStart)) {
                this.windows.push(win);
            }
        }

        // Keep sorted
        this.windows.sort((a, b) => a.windowStart.localeCompare(b.windowStart));

        // Evict if over limit
        while (this.windows.length > MAX_WINDOWS) {
            this.windows.shift();
        }
    }

    /**
     * Flush current window to storage and clear in-memory raw entries.
     * Called automatically on window transitions.
     */
    private flushCurrentWindow(): void {
        if (!this._storage || this.windows.length === 0) return;

        const win = this.windows[this.windows.length - 1];

        // Flush window stats
        this._storage.flushWindow(win);

        // Flush raw request entries
        if (this.currentRawEntries.length > 0) {
            this._storage.insertRequests(this.currentRawEntries);
            this.currentRawEntries = [];
        }

        // Periodically prune old data (every 100 windows)
        if (this.windows.length % 100 === 0) {
            try {
                this._storage.prune();
            } catch {
                // Pruning is best-effort
            }
        }
    }

    /**
     * Force flush current window to storage (for shutdown).
     */
    forceFlush(): void {
        if (!this._storage) return;
        this.ensureCurrentWindow();
        this.flushCurrentWindow();
    }

    /**
     * Get the storage backend for direct historical queries.
     */
    getStorage(): MetricsStorage | undefined {
        return this._storage;
    }

    // ─── Recording ─────────────────────────────────────────────────

    /**
     * Record a completed chat completion request (success or failure).
     */
    recordRequest(entry: MetricsRequestEntry): void {
        this.ensureCurrentWindow();
        const win = this.currentWindow();

        // Track raw entry for later batch insert
        this.currentRawEntries.push(entry);

        // Get or create per-model stats
        const modelKey = entry.modelId;
        if (!win.models[modelKey]) {
            win.models[modelKey] = this.emptyModelStats(
                modelKey,
                entry.provider,
                entry.isComposite,
            );
        }

        const stats = win.models[modelKey];
        this.updateModelStats(stats, entry);

        // Composite routing distribution
        if (entry.isComposite && entry.compositeModelId) {
            this.updateCompositeRouting(win, entry);
        }
    }

    /**
     * Record that a model was skipped due to throttling during composite
     * candidate selection.
     */
    recordThrottleSkip(modelId: string): void {
        const current = this.throttleSkipCounts.get(modelId) ?? 0;
        this.throttleSkipCounts.set(modelId, current + 1);
    }

    /**
     * Get throttle skip count for a model since last query (resets after read).
     */
    getThrottleSkipCount(modelId: string): number {
        return this.throttleSkipCounts.get(modelId) ?? 0;
    }

    /** Reset throttle skip counters. */
    resetThrottleSkipCounts(): void {
        this.throttleSkipCounts.clear();
    }

    // ─── Query API ──────────────────────────────────────────────────

    /** Get the current (in-progress) 5-minute window stats. */
    getCurrentWindow(): MetricsWindow {
        this.ensureCurrentWindow();
        return this.deepCloneWindow(this.currentWindow());
    }

    /** Get window history, newest first. */
    getWindowHistory(count?: number): MetricsWindow[] {
        const n = count ?? MAX_WINDOWS;
        return this.windows.slice(-n).reverse().map(w => this.deepCloneWindow(w));
    }

    /** Get per-model stats across the last N windows, newest window first. */
    getModelHistory(modelId: string, count?: number): ModelWindowStats[] {
        const n = count ?? MAX_WINDOWS;
        const result: ModelWindowStats[] = [];
        for (let i = this.windows.length - 1; i >= 0 && result.length < n; i--) {
            const stats = this.windows[i].models[modelId];
            if (stats) {
                result.push(this.deepCloneStats(stats));
            }
        }
        return result;
    }

    /** Get composite routing distribution for the current window. */
    getCompositeDistribution(compositeId: string): CompositeDistribution | undefined {
        this.ensureCurrentWindow();
        const dist = this.currentWindow().compositeRouting[compositeId];
        if (!dist) return undefined;
        return { ...dist, modelCounts: { ...dist.modelCounts } };
    }

    /** Get composite routing history across all windows. */
    getCompositeDistributionHistory(compositeId: string): CompositeDistribution[] {
        const result: CompositeDistribution[] = [];
        for (let i = this.windows.length - 1; i >= 0; i--) {
            const dist = this.windows[i].compositeRouting[compositeId];
            if (dist) {
                result.push({ ...dist, modelCounts: { ...dist.modelCounts } });
            }
        }
        return result;
    }

    /**
     * Get a cross-window summary for a single model.
     * Aggregates all available windows.
     */
    getModelSummary(modelId: string, windowCount?: number): ModelSummary | undefined {
        const history = this.getModelHistory(modelId, windowCount);
        if (history.length === 0) return undefined;

        const first = history[0];
        const summary: ModelSummary = {
            modelId: first.modelId,
            provider: first.provider,
            windowCount: history.length,
            totalRequests: 0,
            totalSuccess: 0,
            totalErrors: 0,
            totalTimeouts: 0,
            totalCancelled: 0,
            availability: 0,
            totalCostUsd: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            avgTtfbMs: 0,
            avgTtlbMs: 0,
            p90TtlbMs: 0,
            cacheHitRatio: 0,
        };

        const allTtfb: number[] = [];
        const allTtlb: number[] = [];

        for (const w of history) {
            summary.totalRequests += w.requestCount;
            summary.totalSuccess += w.successCount;
            summary.totalErrors += w.errorCount;
            summary.totalTimeouts += w.timeoutCount;
            summary.totalCancelled += w.cancelledCount;
            summary.totalCostUsd += w.totalCostUsd;
            summary.totalPromptTokens += w.totalPromptTokens;
            summary.totalCompletionTokens += w.totalCompletionTokens;
            allTtfb.push(...w.ttfbSamples);
            allTtlb.push(...w.ttlbSamples);
        }

        const completed = summary.totalSuccess + summary.totalErrors + summary.totalTimeouts;
        summary.availability = completed > 0
            ? summary.totalSuccess / completed
            : 1;

        if (allTtfb.length > 0) {
            summary.avgTtfbMs = allTtfb.reduce((a, b) => a + b, 0) / allTtfb.length;
        }
        if (allTtlb.length > 0) {
            summary.avgTtlbMs = allTtlb.reduce((a, b) => a + b, 0) / allTtlb.length;
            const sorted = [...allTtlb].sort((a, b) => a - b);
            summary.p90TtlbMs = percentile(sorted, 90);
        }

        const totalCacheable = summary.totalPromptTokens;
        const totalCached = history.reduce((s, w) => s + w.totalCachedTokens, 0);
        summary.cacheHitRatio = totalCacheable > 0 ? totalCached / totalCacheable : 0;

        return summary;
    }

    /**
     * Get a summary of all models in the current window.
     */
    getAllModelSummaries(windowCount?: number): ModelSummary[] {
        this.ensureCurrentWindow();
        const seen = new Set<string>();
        const summaries: ModelSummary[] = [];
        for (const modelId of Object.keys(this.currentWindow().models)) {
            if (seen.has(modelId)) continue;
            seen.add(modelId);
            const s = this.getModelSummary(modelId, windowCount);
            if (s) summaries.push(s);
        }
        return summaries.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
    }

    // ─── Export ─────────────────────────────────────────────────────

    /**
     * Export all metrics in Prometheus text format.
     * Suitable for scraping by an external Prometheus instance or
     * writing to a textfile for node_exporter.
     */
    toPrometheusText(): string {
        const lines: string[] = [];
        const now = this.currentWindow();

        // Per-model gauges (current window)
        for (const [modelId, stats] of Object.entries(now.models)) {
            const labels = `model="${modelId}",provider="${stats.provider}"`;

            lines.push(`# HELP shofer_router_requests_window Requests in current 5m window`);
            lines.push(`# TYPE shofer_router_requests_window gauge`);
            lines.push(`shofer_router_requests_window{${labels},status="success"} ${stats.successCount}`);
            lines.push(`shofer_router_requests_window{${labels},status="error"} ${stats.errorCount}`);
            lines.push(`shofer_router_requests_window{${labels},status="timeout"} ${stats.timeoutCount}`);
            lines.push(`shofer_router_requests_window{${labels},status="cancelled"} ${stats.cancelledCount}`);

            lines.push(`# HELP shofer_router_cost_usd_window Total cost in current 5m window`);
            lines.push(`# TYPE shofer_router_cost_usd_window gauge`);
            lines.push(`shofer_router_cost_usd_window{${labels}} ${stats.totalCostUsd.toFixed(8)}`);

            lines.push(`# HELP shofer_router_tokens_window Token usage in current 5m window`);
            lines.push(`# TYPE shofer_router_tokens_window gauge`);
            lines.push(`shofer_router_tokens_window{${labels},type="prompt"} ${stats.totalPromptTokens}`);
            lines.push(`shofer_router_tokens_window{${labels},type="completion"} ${stats.totalCompletionTokens}`);
            lines.push(`shofer_router_tokens_window{${labels},type="cached"} ${stats.totalCachedTokens}`);

            lines.push(`# HELP shofer_router_latency_seconds Latency percentiles in current window`);
            lines.push(`# TYPE shofer_router_latency_seconds gauge`);
            lines.push(`shofer_router_latency_seconds{${labels},quantile="0.5",phase="ttfb"} ${(stats.ttfbP50 / 1000).toFixed(3)}`);
            lines.push(`shofer_router_latency_seconds{${labels},quantile="0.9",phase="ttfb"} ${(stats.ttfbP90 / 1000).toFixed(3)}`);
            lines.push(`shofer_router_latency_seconds{${labels},quantile="0.99",phase="ttfb"} ${(stats.ttfbP99 / 1000).toFixed(3)}`);
            lines.push(`shofer_router_latency_seconds{${labels},quantile="0.5",phase="ttlb"} ${(stats.ttlbP50 / 1000).toFixed(3)}`);
            lines.push(`shofer_router_latency_seconds{${labels},quantile="0.9",phase="ttlb"} ${(stats.ttlbP90 / 1000).toFixed(3)}`);
            lines.push(`shofer_router_latency_seconds{${labels},quantile="0.99",phase="ttlb"} ${(stats.ttlbP99 / 1000).toFixed(3)}`);

            lines.push(`# HELP shofer_router_availability Availability ratio in current window`);
            lines.push(`# TYPE shofer_router_availability gauge`);
            lines.push(`shofer_router_availability{${labels}} ${stats.availability.toFixed(6)}`);

            lines.push(`# HELP shofer_router_cache_hit_ratio Cache hit ratio in current window`);
            lines.push(`# TYPE shofer_router_cache_hit_ratio gauge`);
            lines.push(`shofer_router_cache_hit_ratio{${labels}} ${stats.cacheHitRatio.toFixed(6)}`);
        }

        // Composite distribution
        for (const [compositeId, dist] of Object.entries(now.compositeRouting)) {
            for (const [underlyingId, count] of Object.entries(dist.modelCounts)) {
                lines.push(`# HELP shofer_router_composite_requests Requests routed by composite to underlying model`);
                lines.push(`# TYPE shofer_router_composite_requests gauge`);
                lines.push(`shofer_router_composite_requests{composite="${compositeId}",underlying="${underlyingId}"} ${count}`);
            }
            lines.push(`# HELP shofer_router_composite_failover_total Failover events per composite model`);
            lines.push(`# TYPE shofer_router_composite_failover_total gauge`);
            lines.push(`shofer_router_composite_failover_total{composite="${compositeId}"} ${dist.failoverCount}`);
        }

        // Throttle skips
        for (const [modelId, count] of this.throttleSkipCounts) {
            lines.push(`# HELP shofer_router_throttle_skips_total Requests skipped due to throttling`);
            lines.push(`# TYPE shofer_router_throttle_skips_total gauge`);
            lines.push(`shofer_router_throttle_skips_total{model="${modelId}"} ${count}`);
        }

        // Error breakdown
        for (const [modelId, stats] of Object.entries(now.models)) {
            for (const [errorType, count] of Object.entries(stats.errorTypes)) {
                if (count > 0) {
                    lines.push(`# HELP shofer_router_errors_window Errors by type in current window`);
                    lines.push(`# TYPE shofer_router_errors_window gauge`);
                    lines.push(`shofer_router_errors_window{model="${modelId}",error_type="${errorType}"} ${count}`);
                }
            }
        }

        return lines.join('\n') + '\n';
    }

    // ─── Admin ──────────────────────────────────────────────────────

    /** Drop all collected data. */
    clear(): void {
        this.windows = [];
        this.throttleSkipCounts.clear();
    }

    /** Number of windows currently stored. */
    getWindowCount(): number {
        return this.windows.length;
    }

    // ─── Internal helpers ───────────────────────────────────────────

    private ensureCurrentWindow(): void {
        const now = Date.now();
        const windowStart = Math.floor(now / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;

        // If we already have a window for this time slot, return
        if (this.windows.length > 0) {
            const last = this.windows[this.windows.length - 1];
            if (new Date(last.windowStart).getTime() === windowStart) return;

            // Window transition: flush the closing window to storage
            this.flushCurrentWindow();
        }

        // Create new window
        const win: MetricsWindow = {
            windowStart: new Date(windowStart).toISOString(),
            windowEnd: new Date(windowStart + WINDOW_DURATION_MS).toISOString(),
            models: {},
            compositeRouting: {},
        };
        this.windows.push(win);

        // Evict old windows
        while (this.windows.length > MAX_WINDOWS) {
            this.windows.shift();
        }
    }

    private currentWindow(): MetricsWindow {
        return this.windows[this.windows.length - 1];
    }

    private emptyModelStats(
        modelId: string,
        provider: string,
        isComposite: boolean,
    ): ModelWindowStats {
        return {
            modelId,
            provider,
            isComposite,
            requestCount: 0,
            successCount: 0,
            errorCount: 0,
            timeoutCount: 0,
            cancelledCount: 0,
            availability: 1,
            ttfbSamples: [],
            ttlbSamples: [],
            ttfbP50: 0,
            ttfbP90: 0,
            ttfbP99: 0,
            ttlbP50: 0,
            ttlbP90: 0,
            ttlbP99: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalCachedTokens: 0,
            totalCacheCreationTokens: 0,
            totalCostUsd: 0,
            cacheHitRatio: 0,
            errorTypes: {},
        };
    }

    private updateModelStats(stats: ModelWindowStats, entry: MetricsRequestEntry): void {
        stats.requestCount++;

        switch (entry.status) {
            case 'success':
                stats.successCount++;
                break;
            case 'error':
                stats.errorCount++;
                if (entry.errorType) {
                    stats.errorTypes[entry.errorType] = (stats.errorTypes[entry.errorType] ?? 0) + 1;
                }
                break;
            case 'timeout':
                stats.timeoutCount++;
                if (entry.errorType) {
                    stats.errorTypes[entry.errorType] = (stats.errorTypes[entry.errorType] ?? 0) + 1;
                }
                break;
            case 'cancelled':
                stats.cancelledCount++;
                break;
        }

        // Latency samples (only for successful or error-with-timing requests)
        if (entry.ttfbMs > 0) stats.ttfbSamples.push(entry.ttfbMs);
        if (entry.ttlbMs > 0) stats.ttlbSamples.push(entry.ttlbMs);

        // Token aggregates
        stats.totalPromptTokens += entry.promptTokens;
        stats.totalCompletionTokens += entry.completionTokens;
        stats.totalCachedTokens += entry.cachedTokens;
        stats.totalCacheCreationTokens += entry.cacheCreationTokens;

        // Cost
        stats.totalCostUsd += entry.costUsd;

        // Recompute derived fields
        this.recomputeDerivedStats(stats);
    }

    private recomputeDerivedStats(stats: ModelWindowStats): void {
        // Availability
        const completed = stats.successCount + stats.errorCount + stats.timeoutCount;
        stats.availability = completed > 0
            ? stats.successCount / completed
            : 1;

        // Latency percentiles
        if (stats.ttfbSamples.length > 0) {
            const sortedTtfb = [...stats.ttfbSamples].sort((a, b) => a - b);
            stats.ttfbP50 = Math.round(percentile(sortedTtfb, 50));
            stats.ttfbP90 = Math.round(percentile(sortedTtfb, 90));
            stats.ttfbP99 = Math.round(percentile(sortedTtfb, 99));
        }
        if (stats.ttlbSamples.length > 0) {
            const sortedTtlb = [...stats.ttlbSamples].sort((a, b) => a - b);
            stats.ttlbP50 = Math.round(percentile(sortedTtlb, 50));
            stats.ttlbP90 = Math.round(percentile(sortedTtlb, 90));
            stats.ttlbP99 = Math.round(percentile(sortedTtlb, 99));
        }

        // Cache hit ratio
        const totalPrompt = stats.totalPromptTokens;
        stats.cacheHitRatio = totalPrompt > 0
            ? stats.totalCachedTokens / totalPrompt
            : 0;
    }

    private updateCompositeRouting(win: MetricsWindow, entry: MetricsRequestEntry): void {
        const compositeId = entry.compositeModelId!;
        if (!win.compositeRouting[compositeId]) {
            win.compositeRouting[compositeId] = {
                compositeModelId: compositeId,
                modelCounts: {},
                failoverCount: 0,
                midstreamFailureCount: 0,
                totalAttempts: 0,
            };
        }

        const dist = win.compositeRouting[compositeId];
        dist.modelCounts[entry.servedByModel] = (dist.modelCounts[entry.servedByModel] ?? 0) + 1;
        dist.totalAttempts += entry.attempts;
        if (entry.failoverOccurred) dist.failoverCount++;
    }

    /** Record a mid-stream failure for a composite model. */
    recordMidstreamFailure(compositeModelId: string): void {
        this.ensureCurrentWindow();
        const win = this.currentWindow();
        if (win.compositeRouting[compositeModelId]) {
            win.compositeRouting[compositeModelId].midstreamFailureCount++;
        }
    }

    private deepCloneWindow(win: MetricsWindow): MetricsWindow {
        return {
            windowStart: win.windowStart,
            windowEnd: win.windowEnd,
            models: Object.fromEntries(
                Object.entries(win.models).map(([k, v]) => [k, this.deepCloneStats(v)]),
            ),
            compositeRouting: Object.fromEntries(
                Object.entries(win.compositeRouting).map(([k, v]) => [k, {
                    ...v,
                    modelCounts: { ...v.modelCounts },
                }]),
            ),
        };
    }

    private deepCloneStats(stats: ModelWindowStats): ModelWindowStats {
        return {
            ...stats,
            ttfbSamples: [...stats.ttfbSamples],
            ttlbSamples: [...stats.ttlbSamples],
            errorTypes: { ...stats.errorTypes },
        };
    }
}

/** Global singleton instance. */
let globalCollector: MetricsCollector | undefined;

export function initMetricsCollector(storage?: MetricsStorage): MetricsCollector {
    globalCollector = new MetricsCollector();
    if (storage) {
        globalCollector.setStorage(storage);
        globalCollector.loadFromStorage();
    }
    return globalCollector;
}

export function getMetricsCollector(): MetricsCollector {
    if (!globalCollector) {
        globalCollector = new MetricsCollector();
    }
    return globalCollector;
}

/**
 * Flush the global collector's current window and close the storage backend.
 * Call during extension deactivation.
 */
export function shutdownMetricsCollector(): void {
    if (globalCollector) {
        globalCollector.forceFlush();
        globalCollector.getStorage()?.close();
    }
}

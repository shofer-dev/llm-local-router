/**
 * Unit tests for the MetricsCollector.
 *
 * Covers: window creation, request recording, percentile computation,
 * composite distribution tracking, model summaries, Prometheus export,
 * error classification, throttle skip tracking, and edge cases.
 */

import { MetricsCollector, classifyError, getMetricsCollector } from '../metrics-collector';
import { MetricsRequestEntry, MetricsWindow } from '../types';

// Helper to create a minimal success entry
function makeEntry(overrides: Partial<MetricsRequestEntry> = {}): MetricsRequestEntry {
    return {
        timestamp: new Date().toISOString(),
        modelId: 'deepseek-v4-pro',
        provider: 'deepseek',
        isComposite: false,
        servedByModel: 'deepseek-v4-pro',
        status: 'success',
        ttfbMs: 200,
        ttlbMs: 1500,
        promptTokens: 1000,
        completionTokens: 500,
        cachedTokens: 300,
        cacheCreationTokens: 0,
        costUsd: 0.001,
        failoverOccurred: false,
        attempts: 1,
        ...overrides,
    };
}

// ─── classifyError tests ───────────────────────────────────────────

function testClassifyAbortError(): void {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = classifyError(err);
    if (result.status !== 'cancelled') throw new Error(`Expected cancelled, got ${result.status}`);
    if (result.errorType !== 'cancelled') throw new Error(`Expected cancelled, got ${result.errorType}`);
}

function testClassifyTimeout(): void {
    const err = new Error('Request timeout exceeded');
    err.name = 'AbortError';
    const result = classifyError(err);
    if (result.status !== 'timeout') throw new Error(`Expected timeout, got ${result.status}`);
    if (result.errorType !== 'timeout') throw new Error(`Expected timeout, got ${result.errorType}`);
}

function testClassifyHttp429(): void {
    const err = new Error('HTTP 429: Too Many Requests');
    const result = classifyError(err);
    if (result.errorType !== 'http_429') throw new Error(`Expected http_429, got ${result.errorType}`);
}

function testClassifyHttp5xx(): void {
    const err = new Error('HTTP 502: Bad Gateway');
    const result = classifyError(err);
    if (result.errorType !== 'http_5xx') throw new Error(`Expected http_5xx, got ${result.errorType}`);
}

function testClassifyNetworkError(): void {
    const err = new Error('fetch failed: ECONNREFUSED');
    const result = classifyError(err);
    if (result.errorType !== 'network_error') throw new Error(`Expected network_error, got ${result.errorType}`);
}

function testClassifyUnknown(): void {
    const err = new Error('Something weird happened');
    const result = classifyError(err);
    if (result.errorType !== 'unknown') throw new Error(`Expected unknown, got ${result.errorType}`);
}

function testClassifyHttp4xx(): void {
    const err = new Error('HTTP 400: Bad Request');
    const result = classifyError(err);
    if (result.errorType !== 'http_4xx') throw new Error(`Expected http_4xx, got ${result.errorType}`);
    if (result.status !== 'error') throw new Error(`Expected error status, got ${result.status}`);
}

function testClassifyParseError(): void {
    const err = new Error('Failed to parse JSON response');
    const result = classifyError(err);
    if (result.errorType !== 'parse_error') throw new Error(`Expected parse_error, got ${result.errorType}`);
    if (result.status !== 'error') throw new Error(`Expected error status, got ${result.status}`);
}

// ─── MetricsCollector tests ────────────────────────────────────────

function testRecordSuccess(): void {
    const c = new MetricsCollector();
    c.recordRequest(makeEntry({ modelId: 'gpt-5.5', provider: 'openai', ttfbMs: 150, ttlbMs: 2000 }));

    const win = c.getCurrentWindow();
    const stats = win.models['gpt-5.5'];
    if (!stats) throw new Error('Expected stats for gpt-5.5');
    if (stats.requestCount !== 1) throw new Error(`Expected 1 request, got ${stats.requestCount}`);
    if (stats.successCount !== 1) throw new Error(`Expected 1 success, got ${stats.successCount}`);
    if (stats.ttfbP50 !== 150) throw new Error(`Expected ttfbP50=150, got ${stats.ttfbP50}`);
    if (stats.ttlbP50 !== 2000) throw new Error(`Expected ttlbP50=2000, got ${stats.ttlbP50}`);
    if (stats.totalCostUsd !== 0.001) throw new Error(`Expected cost 0.001, got ${stats.totalCostUsd}`);
}

function testRecordError(): void {
    const c = new MetricsCollector();
    c.recordRequest(makeEntry({
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        status: 'error',
        errorType: 'http_5xx',
        errorMessage: 'HTTP 502: Bad Gateway',
        ttfbMs: 0,
        ttlbMs: 500,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
    }));

    const win = c.getCurrentWindow();
    const stats = win.models['claude-sonnet-4-6'];
    if (!stats) throw new Error('Expected stats for claude-sonnet-4-6');
    if (stats.errorCount !== 1) throw new Error(`Expected 1 error, got ${stats.errorCount}`);
    if (stats.availability !== 0) throw new Error(`Expected availability 0, got ${stats.availability}`);
    if ((stats.errorTypes['http_5xx'] ?? 0) !== 1) throw new Error('Expected http_5xx in errorTypes');
}

function testAvailability(): void {
    const c = new MetricsCollector();
    for (let i = 0; i < 95; i++) {
        c.recordRequest(makeEntry({ modelId: 'test-model', provider: 'test' }));
    }
    for (let i = 0; i < 5; i++) {
        c.recordRequest(makeEntry({
            modelId: 'test-model', provider: 'test',
            status: 'error', errorType: 'http_5xx',
            ttfbMs: 0, ttlbMs: 100, promptTokens: 0,
            completionTokens: 0, costUsd: 0,
        }));
    }

    const win = c.getCurrentWindow();
    const stats = win.models['test-model'];
    if (!stats) throw new Error('Expected stats');
    const expected = 95 / 100; // 0.95
    if (Math.abs(stats.availability - expected) > 0.001) {
        throw new Error(`Expected availability ${expected}, got ${stats.availability}`);
    }
}

function testPercentiles(): void {
    const c = new MetricsCollector();
    // Add 100 samples with ttfb = 100, 200, ..., 10000
    for (let i = 0; i < 100; i++) {
        c.recordRequest(makeEntry({
            modelId: `model-${i % 3}`, // 3 different models
            provider: 'test',
            ttfbMs: (i + 1) * 100,
            ttlbMs: (i + 1) * 200,
        }));
    }

    const win = c.getCurrentWindow();
    // Check one of the models has correct percentiles
    const model0 = win.models['model-0'];
    if (!model0) throw new Error('Expected model-0 stats');
    // model-0 gets indices 0,3,6,...,99 → 34 entries (ceil(100/3))
    // But the exact number depends on rounding. Just verify p50 < p90 < p99
    if (model0.ttfbSamples.length === 0) throw new Error('Expected samples');
    if (model0.ttfbP50 >= model0.ttfbP90 || model0.ttfbP90 >= model0.ttfbP99) {
        throw new Error('Expected p50 < p90 < p99');
    }
}

function testCompositeDistribution(): void {
    const c = new MetricsCollector();
    c.recordRequest(makeEntry({
        modelId: 'local/code',
        provider: 'deepseek',
        isComposite: true,
        compositeModelId: 'local/code',
        servedByModel: 'deepseek-v4-pro',
        failoverOccurred: false,
        attempts: 1,
    }));
    c.recordRequest(makeEntry({
        modelId: 'local/code',
        provider: 'anthropic',
        isComposite: true,
        compositeModelId: 'local/code',
        servedByModel: 'claude-sonnet-4-6',
        failoverOccurred: false,
        attempts: 1,
    }));
    c.recordRequest(makeEntry({
        modelId: 'local/code',
        provider: 'deepseek',
        isComposite: true,
        compositeModelId: 'local/code',
        servedByModel: 'deepseek-v4-pro',
        failoverOccurred: true,
        attempts: 2,
    }));

    const dist = c.getCompositeDistribution('local/code');
    if (!dist) throw new Error('Expected distribution for local/code');
    if (dist.modelCounts['deepseek-v4-pro'] !== 2) throw new Error(`Expected 2 for deepseek, got ${dist.modelCounts['deepseek-v4-pro']}`);
    if (dist.modelCounts['claude-sonnet-4-6'] !== 1) throw new Error(`Expected 1 for claude, got ${dist.modelCounts['claude-sonnet-4-6']}`);
    if (dist.failoverCount !== 1) throw new Error(`Expected 1 failover, got ${dist.failoverCount}`);
    if (dist.totalAttempts !== 4) throw new Error(`Expected 4 attempts, got ${dist.totalAttempts}`);
}

function testThrottleSkip(): void {
    const c = new MetricsCollector();
    c.recordThrottleSkip('deepseek-v4-pro');
    c.recordThrottleSkip('deepseek-v4-pro');
    c.recordThrottleSkip('claude-sonnet-4-6');

    if (c.getThrottleSkipCount('deepseek-v4-pro') !== 2) throw new Error('Expected 2 throttle skips');
    if (c.getThrottleSkipCount('claude-sonnet-4-6') !== 1) throw new Error('Expected 1 throttle skip');
    if (c.getThrottleSkipCount('unknown-model') !== 0) throw new Error('Expected 0 for unknown');

    c.resetThrottleSkipCounts();
    if (c.getThrottleSkipCount('deepseek-v4-pro') !== 0) throw new Error('Expected 0 after reset');
}

function testModelSummary(): void {
    const c = new MetricsCollector();
    for (let i = 0; i < 10; i++) {
        c.recordRequest(makeEntry({
            modelId: 'deepseek-v4-pro',
            provider: 'deepseek',
            ttfbMs: 100,
            ttlbMs: 1000,
            promptTokens: 100,
            completionTokens: 50,
            cachedTokens: 20,
            costUsd: 0.0001,
        }));
    }

    const summary = c.getModelSummary('deepseek-v4-pro');
    if (!summary) throw new Error('Expected summary');
    if (summary.totalRequests !== 10) throw new Error(`Expected 10 total, got ${summary.totalRequests}`);
    if (summary.totalSuccess !== 10) throw new Error(`Expected 10 success, got ${summary.totalSuccess}`);
    if (Math.abs(summary.totalCostUsd - 0.001) > 1e-10) throw new Error(`Expected cost ~0.001, got ${summary.totalCostUsd}`);
    if (summary.avgTtfbMs !== 100) throw new Error(`Expected avgTtfb 100, got ${summary.avgTtfbMs}`);
    if (summary.avgTtlbMs !== 1000) throw new Error(`Expected avgTtlb 1000, got ${summary.avgTtlbMs}`);
    if (summary.cacheHitRatio !== 0.2) throw new Error(`Expected cacheHitRatio 0.2, got ${summary.cacheHitRatio}`);
}

function testGetModelSummaryUnknown(): void {
    const c = new MetricsCollector();
    const summary = c.getModelSummary('nonexistent');
    if (summary !== undefined) throw new Error('Expected undefined for unknown model');
}

function testPrometheusExport(): void {
    const c = new MetricsCollector();
    c.recordRequest(makeEntry({ modelId: 'test-model', provider: 'test' }));
    const text = c.toPrometheusText();
    if (!text.includes('llm_local_router_requests_window')) throw new Error('Expected requests_window in export');
    if (!text.includes('test-model')) throw new Error('Expected model name in export');
    if (!text.includes('llm_local_router_cost_usd_window')) throw new Error('Expected cost in export');
    if (!text.includes('llm_local_router_latency_seconds')) throw new Error('Expected latency in export');
}

function testMidstreamFailure(): void {
    const c = new MetricsCollector();
    // First ensure routing is set up with a normal request
    c.recordRequest(makeEntry({
        modelId: 'local/code',
        provider: 'deepseek',
        isComposite: true,
        compositeModelId: 'local/code',
        servedByModel: 'deepseek-v4-pro',
    }));
    c.recordMidstreamFailure('local/code');

    const dist = c.getCompositeDistribution('local/code');
    if (!dist) throw new Error('Expected distribution');
    if (dist.midstreamFailureCount !== 1) throw new Error(`Expected 1 midstream failure, got ${dist.midstreamFailureCount}`);
}

function testMultipleWindows(): void {
    const c = new MetricsCollector();
    c.recordRequest(makeEntry({ modelId: 'm1', provider: 'test' }));
    // We can't easily simulate time passing, but we can verify window count
    if (c.getWindowCount() !== 1) throw new Error(`Expected 1 window, got ${c.getWindowCount()}`);
}

function testClear(): void {
    const c = new MetricsCollector();
    c.recordRequest(makeEntry());
    c.clear();
    if (c.getWindowCount() !== 0) throw new Error('Expected 0 windows after clear');
}

function testDeepCloneDoesNotMutate(): void {
    const c = new MetricsCollector();
    c.recordRequest(makeEntry({ modelId: 'test', provider: 'test' }));

    const win1 = c.getCurrentWindow();
    const stats1 = win1.models['test'];
    if (!stats1) throw new Error('Expected stats');

    // Mutate the clone — should not affect internal state
    stats1.requestCount = 999;

    const win2 = c.getCurrentWindow();
    const stats2 = win2.models['test'];
    if (!stats2) throw new Error('Expected stats');
    if (stats2.requestCount !== 1) throw new Error(`Expected 1 after clone mutation, got ${stats2.requestCount}`);
}

function testCacheHitRatio(): void {
    const c = new MetricsCollector();
    // All prompt tokens cached
    c.recordRequest(makeEntry({
        modelId: 'test', provider: 'test',
        promptTokens: 100, cachedTokens: 100, completionTokens: 50,
    }));
    const win = c.getCurrentWindow();
    const stats = win.models['test'];
    if (!stats) throw new Error('Expected stats');
    if (stats.cacheHitRatio !== 1) throw new Error(`Expected cacheHitRatio 1, got ${stats.cacheHitRatio}`);

    // No cached tokens
    c.recordRequest(makeEntry({
        modelId: 'test', provider: 'test',
        promptTokens: 100, cachedTokens: 0, completionTokens: 50,
    }));
    const win2 = c.getCurrentWindow();
    const stats2 = win2.models['test'];
    if (!stats2) throw new Error('Expected stats');
    // 200 total prompt, 100 cached → 0.5
    if (Math.abs(stats2.cacheHitRatio - 0.5) > 0.001) {
        throw new Error(`Expected cacheHitRatio 0.5, got ${stats2.cacheHitRatio}`);
    }
}

function testGetAllModelSummaries(): void {
    const c = new MetricsCollector();
    c.recordRequest(makeEntry({ modelId: 'expensive', provider: 'test', costUsd: 0.01 }));
    c.recordRequest(makeEntry({ modelId: 'cheap', provider: 'test', costUsd: 0.001 }));

    const summaries = c.getAllModelSummaries(1);
    if (summaries.length !== 2) throw new Error(`Expected 2 summaries, got ${summaries.length}`);
    // Should be sorted by cost desc
    if (summaries[0].modelId !== 'expensive') throw new Error('Expected expensive first');
    if (summaries[1].modelId !== 'cheap') throw new Error('Expected cheap second');
}

function testGlobalSingleton(): void {
    const c1 = getMetricsCollector();
    const c2 = getMetricsCollector();
    if (c1 !== c2) throw new Error('Expected same singleton instance');
}

// ─── Run ───────────────────────────────────────────────────────────

const tests: Array<{ name: string; fn: () => void }> = [
    { name: 'classifyAbortError', fn: testClassifyAbortError },
    { name: 'classifyTimeout', fn: testClassifyTimeout },
    { name: 'classifyHttp429', fn: testClassifyHttp429 },
    { name: 'classifyHttp5xx', fn: testClassifyHttp5xx },
    { name: 'classifyNetworkError', fn: testClassifyNetworkError },
    { name: 'classifyUnknown', fn: testClassifyUnknown },
    { name: 'classifyHttp4xx', fn: testClassifyHttp4xx },
    { name: 'classifyParseError', fn: testClassifyParseError },
    { name: 'recordSuccess', fn: testRecordSuccess },
    { name: 'recordError', fn: testRecordError },
    { name: 'availability', fn: testAvailability },
    { name: 'percentiles', fn: testPercentiles },
    { name: 'compositeDistribution', fn: testCompositeDistribution },
    { name: 'throttleSkip', fn: testThrottleSkip },
    { name: 'modelSummary', fn: testModelSummary },
    { name: 'getModelSummaryUnknown', fn: testGetModelSummaryUnknown },
    { name: 'prometheusExport', fn: testPrometheusExport },
    { name: 'midstreamFailure', fn: testMidstreamFailure },
    { name: 'multipleWindows', fn: testMultipleWindows },
    { name: 'clear', fn: testClear },
    { name: 'deepCloneDoesNotMutate', fn: testDeepCloneDoesNotMutate },
    { name: 'cacheHitRatio', fn: testCacheHitRatio },
    { name: 'getAllModelSummaries', fn: testGetAllModelSummaries },
    { name: 'globalSingleton', fn: testGlobalSingleton },
];

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
    try {
        fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`✗ ${name}: ${(err as Error).message}`);
    }
}

console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
if (failed > 0) process.exit(1);

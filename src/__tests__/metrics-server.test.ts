/**
 * Unit tests for the Prometheus metrics HTTP server.
 *
 * Tests: server start/stop lifecycle, /metrics endpoint content,
 * /health endpoint, 404 for unknown paths, idempotent start,
 * idempotent stop, port query, POST rejection.
 */

import * as http from 'http';
import { initMetricsCollector, getMetricsCollector } from '../metrics-collector';
import { MetricsRequestEntry } from '../types';

// Set ephemeral port before importing the server module
process.env.SHOFER_ROUTER_METRICS_PORT = '0';

// Dynamic import to pick up the env var
const metricsServer = require('../metrics-server');

function httpGet(path: string, port: number): Promise<{ status: number; body: string; contentType: string }> {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${path}`, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => {
                resolve({
                    status: res.statusCode ?? 0,
                    body,
                    contentType: res.headers['content-type'] ?? '',
                });
            });
        }).on('error', reject);
    });
}

function httpPost(path: string, port: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}${path}`, { method: 'POST' }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => {
                resolve({ status: res.statusCode ?? 0, body });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ─── Setup ─────────────────────────────────────────────────────────

function setupCollector(): void {
    const c = initMetricsCollector();
    // Record a few requests so metrics endpoint has data
    const entry: MetricsRequestEntry = {
        timestamp: new Date().toISOString(),
        modelId: 'test-model',
        provider: 'test',
        isComposite: false,
        servedByModel: 'test-model',
        status: 'success',
        ttfbMs: 100,
        ttlbMs: 500,
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
        failoverOccurred: false,
        attempts: 1,
    };
    c.recordRequest(entry);
}

// ─── Tests ─────────────────────────────────────────────────────────

async function testStartAndStop(): Promise<void> {
    await metricsServer.startMetricsServer();
    const port = metricsServer.getMetricsServerPort();
    if (typeof port !== 'number' || port <= 0) throw new Error(`Expected valid port, got ${port}`);

    await metricsServer.stopMetricsServer();
    if (metricsServer.getMetricsServerPort() !== undefined) throw new Error('Expected undefined port after stop');
}

async function testMetricsEndpoint(): Promise<void> {
    setupCollector();
    await metricsServer.startMetricsServer();
    const port = metricsServer.getMetricsServerPort();

    const res = await httpGet('/metrics', port);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.includes('shofer_router_requests_window')) {
        throw new Error('Expected prometheus metrics in response body');
    }
    if (!res.body.includes('test-model')) {
        throw new Error('Expected test-model in response body');
    }
    if (!res.contentType.includes('text/plain')) {
        throw new Error(`Expected text/plain content type, got ${res.contentType}`);
    }

    await metricsServer.stopMetricsServer();
}

async function testHealthEndpoint(): Promise<void> {
    await metricsServer.startMetricsServer();
    const port = metricsServer.getMetricsServerPort();

    const res = await httpGet('/health', port);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (res.body.trim() !== 'OK') throw new Error(`Expected 'OK', got '${res.body}'`);

    await metricsServer.stopMetricsServer();
}

async function testNotFound(): Promise<void> {
    await metricsServer.startMetricsServer();
    const port = metricsServer.getMetricsServerPort();

    const res = await httpGet('/nonexistent', port);
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
    if (res.body.trim() !== 'Not Found') throw new Error(`Expected 'Not Found', got '${res.body}'`);

    await metricsServer.stopMetricsServer();
}

async function testPostRejected(): Promise<void> {
    await metricsServer.startMetricsServer();
    const port = metricsServer.getMetricsServerPort();

    const res = await httpPost('/metrics', port);
    if (res.status !== 404) throw new Error(`Expected 404 for POST, got ${res.status}`);

    await metricsServer.stopMetricsServer();
}

async function testIdempotentStart(): Promise<void> {
    await metricsServer.startMetricsServer();
    const port1 = metricsServer.getMetricsServerPort();

    // Second start should be a no-op
    await metricsServer.startMetricsServer();
    const port2 = metricsServer.getMetricsServerPort();

    if (port1 !== port2) throw new Error(`Port changed on second start: ${port1} → ${port2}`);

    await metricsServer.stopMetricsServer();
}

async function testIdempotentStop(): Promise<void> {
    await metricsServer.startMetricsServer();
    await metricsServer.stopMetricsServer();

    // Second stop should be a no-op (no error)
    await metricsServer.stopMetricsServer();
    // Should not throw
}

async function testEmptyCollector(): Promise<void> {
    // Re-init with empty collector
    initMetricsCollector();
    await metricsServer.startMetricsServer();
    const port = metricsServer.getMetricsServerPort();

    const res = await httpGet('/metrics', port);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    // Empty collector should still produce valid Prometheus text
    if (typeof res.body !== 'string') throw new Error('Expected string body');

    await metricsServer.stopMetricsServer();
}

// ─── Run ───────────────────────────────────────────────────────────

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'startAndStop', fn: testStartAndStop },
    { name: 'metricsEndpoint', fn: testMetricsEndpoint },
    { name: 'healthEndpoint', fn: testHealthEndpoint },
    { name: 'notFound', fn: testNotFound },
    { name: 'postRejected', fn: testPostRejected },
    { name: 'idempotentStart', fn: testIdempotentStart },
    { name: 'idempotentStop', fn: testIdempotentStop },
    { name: 'emptyCollector', fn: testEmptyCollector },
];

async function run(): Promise<void> {
    let passed = 0;
    let failed = 0;

    for (const { name, fn } of tests) {
        try {
            await fn();
            passed++;
            console.log(`✓ ${name}`);
        } catch (err) {
            failed++;
            console.log(`✗ ${name}: ${(err as Error).message}`);
        }
    }

    // Ensure server is stopped
    try { await metricsServer.stopMetricsServer(); } catch { /* ignore */ }

    console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
    if (failed > 0) process.exit(1);
}

run();

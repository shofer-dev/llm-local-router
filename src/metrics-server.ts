/**
 * Prometheus metrics HTTP server for the LLM Local Router extension.
 *
 * Exposes the in-memory metrics collector's `toPrometheusText()` output
 * via a minimal HTTP server on `127.0.0.1:<LLM_LOCAL_ROUTER_METRICS_PORT>`
 * (default 30098). Gated behind the `llmLocalRouter.experimental.prometheusEndpoint`
 * configuration flag (default: false).
 *
 * Design mirrors `extensions/shofer/src/metrics/server.ts` but uses the
 * existing `MetricsCollector.toPrometheusText()` directly instead of
 * `prom-client`, keeping the dependency footprint minimal.
 *
 * ## Endpoints
 *
 * | Path      | Method | Description                       |
 * |-----------|--------|-----------------------------------|
 * | `/metrics` | GET   | Prometheus text format exposition |
 * | `/health`  | GET   | 200 OK when server is running     |
 *
 * Binds to `127.0.0.1` only — unreachable from remote hosts; no auth.
 */

import * as http from 'http';
import { getMetricsCollector } from './metrics-collector';
import { getLogger } from './logger';

/** Port the metrics server listens on. Configurable via env var. */
const METRICS_PORT = parseInt(process.env.LLM_LOCAL_ROUTER_METRICS_PORT ?? '30098', 10);

let _server: http.Server | undefined;
let _serverPort: number | undefined;

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'GET' || !req.url) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found\n');
        return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/metrics') {
        try {
            const body = getMetricsCollector().toPrometheusText();
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8; version=0.0.4',
            });
            res.end(body);
        } catch (err) {
            getLogger().errorWithError('[metrics-server] exposition failed', err as Error);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error\n');
        }
        return;
    }

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK\n');
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
}

/**
 * Start the metrics HTTP server.
 * Idempotent — second call is a no-op.
 */
export async function startMetricsServer(): Promise<void> {
    if (_server) {
        getLogger().info(`[metrics-server] Already running on port ${_serverPort}`);
        return;
    }

    return new Promise((resolve, reject) => {
        _server = http.createServer(handleRequest);

        _server.on('error', (err) => {
            getLogger().errorWithError('[metrics-server] Server error', err);
            if (!_serverPort) {
                // Failed before listen() succeeded — reject the start promise.
                _server = undefined;
                reject(err);
            } else {
                // Runtime error after a successful listen: tear the server down
                // and reset state so a subsequent startMetricsServer() recreates
                // it instead of short-circuiting on a wedged instance.
                const dead = _server;
                _server = undefined;
                _serverPort = undefined;
                dead?.close();
            }
        });

        _server.listen(METRICS_PORT, '127.0.0.1', () => {
            _serverPort = (_server!.address() as { port: number }).port;
            getLogger().info(`[metrics-server] Listening on 127.0.0.1:${_serverPort}`);
            resolve();
        });
    });
}

/** Stop the metrics server. */
export async function stopMetricsServer(): Promise<void> {
    return new Promise((resolve) => {
        if (!_server) {
            resolve();
            return;
        }
        const server = _server;
        // Reset module state up front so a concurrent start sees "not running".
        _server = undefined;
        _serverPort = undefined;
        server.close(() => {
            getLogger().info('[metrics-server] Stopped');
            resolve();
        });
        // Force-drain any in-flight scrape connections so close() can resolve
        // promptly (VS Code does not await async deactivate work).
        server.closeAllConnections?.();
    });
}

/** Current server port if running. */
export function getMetricsServerPort(): number | undefined {
    return _serverPort;
}

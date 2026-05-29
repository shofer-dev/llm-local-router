/**
 * Provider Health Checker — TCP keepalive-based connectivity monitoring.
 *
 * Maintains one raw TCP socket per configured provider with SO_KEEPALIVE
 * enabled. No data is ever sent — the OS kernel handles keepalive probes
 * transparently. When the OS detects the connection is dead, the socket
 * emits 'error' or 'close', and we mark the provider as unhealthy.
 *
 * This is zero-rate-limit: no HTTP requests, no API calls, no TLS handshakes.
 * Just TCP-level connectivity verification via the OS networking stack.
 *
 * Design decision: we do NOT use these sockets for actual LLM requests.
 * Node.js fetch() already pools connections with keepalive via its HTTP agent.
 * These are purely health indicators — lightweight, non-intrusive, OS-managed.
 */

import * as net from 'net';
import * as tls from 'tls';
import { getLogger, Logger } from './logger';
import type { ProviderType } from './types';

/** Per-provider health state exposed to the rest of the system. */
export interface ProviderHealthState {
  provider: string;
  healthy: boolean;
  lastChangeMs: number;
  error?: string;
}

/** Called when a provider's health state changes. */
export type HealthChangeCallback = (state: ProviderHealthState) => void;

/**
 * Default keepalive initial delay: start TCP keepalive probes after 30s of idle.
 * On Linux this sets TCP_KEEPIDLE. The kernel then sends probes at system-defined
 * intervals (typically every 75s) and marks the connection dead after ~9 failed probes.
 */
const KEEPALIVE_INITIAL_DELAY_MS = 30_000;

/**
 * Connection timeout: if we can't establish a TCP connection within 5s,
 * the provider is considered unreachable.
 */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Reconnect delay when a socket fails: wait this long before retrying.
 */
const RECONNECT_DELAY_MS = 10_000;

export class ProviderHealthChecker {
  private sockets = new Map<string, net.Socket>();
  private health = new Map<string, ProviderHealthState>();
  private callbacks: HealthChangeCallback[] = [];
  private logger: Logger;
  private shutdown = false;

  constructor() {
    this.logger = getLogger();
  }

  /**
   * Start monitoring a provider. Opens a TCP socket with keepalive.
   * Safe to call multiple times — reconnects if already connected.
   */
  connect(provider: string, endpointUrl: string): void {
    if (this.shutdown) return;

    // Close existing socket if any
    this.disconnect(provider);

    const { hostname, port } = this.parseEndpoint(endpointUrl);
    this.logger.debug(`Health check connecting to ${provider} at ${hostname}:${port}`);

    const socket = new net.Socket();
    this.sockets.set(provider, socket);

    socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);
    socket.setTimeout(0); // No data timeout — keepalive handles detection

    socket.on('connect', () => {
      this.logger.debug(`Health check connected to ${provider}`);
      this.setHealth(provider, true);
    });

    socket.on('error', (err: Error) => {
      this.logger.warning(`Health check error for ${provider}: ${err.message}`);
      this.setHealth(provider, false, err.message);
      this.scheduleReconnect(provider, endpointUrl);
    });

    socket.on('close', (hadError: boolean) => {
      if (hadError) return; // 'error' handler already fired
      this.logger.warning(`Health check connection closed for ${provider}`);
      this.setHealth(provider, false, 'Connection closed');
      this.scheduleReconnect(provider, endpointUrl);
    });

    // Set connect timeout
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy(new Error(`Connection timeout after ${CONNECT_TIMEOUT_MS}ms`));
    });

    socket.connect(port, hostname);
  }

  /**
   * Stop monitoring a provider and close its socket.
   */
  disconnect(provider: string): void {
    const socket = this.sockets.get(provider);
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      this.sockets.delete(provider);
    }
    this.health.delete(provider);
  }

  /** Get current health for a specific provider. */
  getHealth(provider: string): ProviderHealthState | undefined {
    return this.health.get(provider);
  }

  /** Get health for all monitored providers. */
  getAllHealth(): ProviderHealthState[] {
    return [...this.health.values()];
  }

  /** Register a callback for health state changes. */
  onChange(callback: HealthChangeCallback): void {
    this.callbacks.push(callback);
  }

  /** Shut down all sockets. */
  dispose(): void {
    this.shutdown = true;
    for (const [provider] of this.sockets) {
      this.disconnect(provider);
    }
    this.callbacks = [];
  }

  // ─── Internals ─────────────────────────────────────────────────

  private parseEndpoint(url: string): { hostname: string; port: number } {
    try {
      const u = new URL(url);
      return {
        hostname: u.hostname,
        port: u.port ? parseInt(u.port, 10) : 443,
      };
    } catch {
      return { hostname: 'localhost', port: 443 };
    }
  }

  private setHealth(provider: string, healthy: boolean, error?: string): void {
    const prev = this.health.get(provider);
    if (prev && prev.healthy === healthy) return; // No change

    const state: ProviderHealthState = {
      provider,
      healthy,
      lastChangeMs: Date.now(),
      error,
    };
    this.health.set(provider, state);

    this.logger.info(
      `Health ${provider}: ${healthy ? 'healthy' : 'unhealthy'}` +
      (error ? ` (${error})` : '')
    );

    for (const cb of this.callbacks) {
      try { cb(state); } catch { /* callback errors must not propagate */ }
    }
  }

  private scheduleReconnect(provider: string, endpointUrl: string): void {
    if (this.shutdown) return;
    setTimeout(() => {
      if (!this.shutdown && this.sockets.has(provider)) {
        this.logger.debug(`Health check reconnecting to ${provider}...`);
        this.connect(provider, endpointUrl);
      }
    }, RECONNECT_DELAY_MS);
  }
}

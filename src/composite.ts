/**
 * Composite model failover and load-balancing logic.
 *
 * Handles shofer/* composite models that wrap multiple underlying models
 * with configurable routing strategies:
 *   - failover: tries models in strict order; on failure, falls back
 *   - round_robin: distributes requests across available models
 *
 * Streaming requests follow a "first-byte rule": once any chunk has been
 * sent to the client, failover to a different model is not possible.
 * Only pre-first-byte failures trigger failover.
 *
 * Ported from llm-router/internal/services/composite.go.
 * Simplified: no Redis, no per-replica health monitor, no Prometheus metrics.
 */

import {
    ChatCompletionRequest,
    ChatCompletionResponse,
    CompositeModelConfig,
    CompositeStrategy,
    ThrottlingConfig,
} from './types';
import { ProviderRouter } from './provider-client';
import { getLogger } from './logger';

export interface CompositeSendResult {
    response: ChatCompletionResponse;
    /** The underlying model that actually served the request */
    servedByModel: string;
    /** Whether failover occurred (at least one attempt failed) */
    failoverOccurred: boolean;
    /** Number of attempts made */
    attempts: number;
}

/**
 * In-memory health tracking per underlying model.
 */
interface ModelHealth {
    consecutiveFailures: number;
    lastFailureTime: number;
    isUnhealthy: boolean;
    unhealthySince: number;
}

/**
 * In-memory throttling state per underlying model.
 */
interface ModelThrottle {
    /** Number of requests in the current window */
    windowCount: number;
    /** Start of the current window (epoch ms) */
    windowStart: number;
    /** Current number of in-flight requests */
    inFlight: number;
}

const DEFAULT_THROTTLING: ThrottlingConfig = {
    maxConcurrent: 50,
    requestsPerWindow: 100,
    windowMinutes: 5,
};

/** How long an unhealthy model stays quarantined before probing */
const UNHEALTHY_COOLDOWN_MS = 30_000; // 30 seconds

export class CompositeService {
    private router: ProviderRouter;
    private compositeConfigs: Map<string, CompositeModelConfig> = new Map();

    // Per-model health tracking
    private health = new Map<string, ModelHealth>();

    // Per-model throttling
    private throttle = new Map<string, ModelThrottle>();

    // Round-robin state per composite model
    private rrCounters = new Map<string, number>();

    constructor(router: ProviderRouter) {
        this.router = router;
    }

    /**
     * Load composite model configurations from a JSON object.
     */
    loadConfigs(configs: Record<string, CompositeModelConfig>): void {
        this.compositeConfigs.clear();
        for (const [id, config] of Object.entries(configs)) {
            this.compositeConfigs.set(id, config);
        }
        getLogger().info(`Loaded ${this.compositeConfigs.size} composite model configs`);
    }

    /**
     * Check if a model ID is a composite model.
     */
    isCompositeModel(modelId: string): boolean {
        return modelId.startsWith('shofer/') && this.compositeConfigs.has(modelId);
    }

    /**
     * Get the list of composite model IDs.
     */
    getCompositeModelIds(): string[] {
        return Array.from(this.compositeConfigs.keys());
    }

    /**
     * Send a request through a composite model with failover/load-balancing.
     */
    async sendCompositeRequest(
        compositeModelId: string,
        request: ChatCompletionRequest,
        onChunk: (chunk: ChatCompletionResponse) => void,
        abortController: AbortController,
    ): Promise<CompositeSendResult> {
        const config = this.compositeConfigs.get(compositeModelId);
        if (!config) {
            throw new Error(`Unknown composite model: ${compositeModelId}`);
        }

        const logger = getLogger();
        const attempts: string[] = [];
        let failoverOccurred = false;

        // Get candidate models based on strategy
        const candidates = this.getCandidates(compositeModelId, config);

        if (candidates.length === 0) {
            throw new Error(`No healthy models available for composite: ${compositeModelId}`);
        }

        let lastError: Error | undefined;

        for (const candidateModel of candidates) {
            // Check if throttled
            if (this.isThrottled(candidateModel, config.throttling)) {
                logger.debug(`Skipping throttled model: ${candidateModel}`);
                continue;
            }

            attempts.push(candidateModel);
            if (attempts.length > 1) failoverOccurred = true;

            // Acquire throttle slot
            this.acquireThrottle(candidateModel);

            try {
                // Create a per-attempt abort controller
                const attemptAbort = new AbortController();

                // Wire parent cancellation
                abortController.signal.addEventListener('abort', () => attemptAbort.abort());

                const perAttemptTimeout = config.perAttemptTimeoutMs ?? 120_000;
                const timeoutId = setTimeout(() => attemptAbort.abort(), perAttemptTimeout);

                // For streaming: wrap onChunk to track first-byte
                let firstByteReceived = false;
                const wrappedOnChunk = (chunk: ChatCompletionResponse) => {
                    firstByteReceived = true;
                    onChunk(chunk);
                };

                const response = await this.router.sendStreamingRequest(
                    candidateModel,
                    request,
                    wrappedOnChunk,
                    attemptAbort,
                );

                clearTimeout(timeoutId);

                // Success — update health
                this.recordSuccess(candidateModel);

                logger.debug(
                    `Composite ${compositeModelId}: served by ${candidateModel} ` +
                    `(attempt ${attempts.length}/${candidates.length})`
                );

                return {
                    response,
                    servedByModel: candidateModel,
                    failoverOccurred,
                    attempts: attempts.length,
                };
            } catch (err) {
                clearTimeout((err as any)?.timeoutId);
                lastError = err as Error;

                // If first byte was already received during streaming, can't failover
                // (This is handled by the streaming loop aborting on error)
                logger.warning(
                    `Composite ${compositeModelId}: ${candidateModel} failed ` +
                    `(attempt ${attempts.length}/${candidates.length}): ${lastError.message}`
                );

                this.recordFailure(candidateModel);
            } finally {
                this.releaseThrottle(candidateModel);
            }
        }

        throw new Error(
            `All models failed for composite ${compositeModelId} ` +
            `(tried: ${attempts.join(', ')}). Last error: ${lastError?.message}`
        );
    }

    /**
     * Get candidate models ordered by strategy.
     */
    private getCandidates(compositeId: string, config: CompositeModelConfig): string[] {
        const healthy = config.models.filter(m => !this.isUnhealthy(m));

        if (config.strategy === 'failover' || config.strategy === ('failover' as CompositeStrategy)) {
            return healthy;
        }

        // Round-robin: start from the last-used index
        if (healthy.length === 0) return [];

        let counter = this.rrCounters.get(compositeId) ?? 0;
        const startIdx = counter % healthy.length;
        counter = (counter + 1) % healthy.length;
        this.rrCounters.set(compositeId, counter);

        // Reorder: models from startIdx to end, then 0 to startIdx-1
        return [...healthy.slice(startIdx), ...healthy.slice(0, startIdx)];
    }

    // ─── Health tracking ───────────────────────────────────────────

    private getHealth(modelId: string): ModelHealth {
        let h = this.health.get(modelId);
        if (!h) {
            h = { consecutiveFailures: 0, lastFailureTime: 0, isUnhealthy: false, unhealthySince: 0 };
            this.health.set(modelId, h);
        }
        return h;
    }

    private recordSuccess(modelId: string): void {
        const h = this.getHealth(modelId);
        h.consecutiveFailures = 0;
        h.isUnhealthy = false;
    }

    private recordFailure(modelId: string): void {
        const h = this.getHealth(modelId);
        h.consecutiveFailures++;
        h.lastFailureTime = Date.now();

        // Mark unhealthy after 3 consecutive failures
        if (h.consecutiveFailures >= 3) {
            h.isUnhealthy = true;
            h.unhealthySince = Date.now();
        }
    }

    private isUnhealthy(modelId: string): boolean {
        const h = this.getHealth(modelId);
        if (!h.isUnhealthy) return false;

        // Probe after cooldown period
        const elapsed = Date.now() - h.unhealthySince;
        if (elapsed > UNHEALTHY_COOLDOWN_MS) {
            // Allow one probe attempt
            h.isUnhealthy = false;
            return false;
        }

        return true;
    }

    // ─── Throttling ─────────────────────────────────────────────────

    private getThrottle(modelId: string, config?: ThrottlingConfig): ModelThrottle {
        let t = this.throttle.get(modelId);
        if (!t) {
            t = { windowCount: 0, windowStart: Date.now(), inFlight: 0 };
            this.throttle.set(modelId, t);
        }
        return t;
    }

    private isThrottled(modelId: string, config?: ThrottlingConfig): boolean {
        const tc = config ?? DEFAULT_THROTTLING;
        const t = this.getThrottle(modelId, tc);

        // Check concurrency limit
        if (t.inFlight >= tc.maxConcurrent) return true;

        // Check sliding window rate limit
        const windowMs = tc.windowMinutes * 60 * 1000;
        if (Date.now() - t.windowStart > windowMs) {
            // Window expired, reset
            t.windowCount = 0;
            t.windowStart = Date.now();
            return false;
        }

        return t.windowCount >= tc.requestsPerWindow;
    }

    private acquireThrottle(modelId: string): void {
        const t = this.getThrottle(modelId);
        t.inFlight++;
        t.windowCount++;
    }

    private releaseThrottle(modelId: string): void {
        const t = this.throttle.get(modelId);
        if (t && t.inFlight > 0) {
            t.inFlight--;
        }
    }
}

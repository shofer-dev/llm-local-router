/**
 * Composite model failover and load-balancing logic.
 *
 * Handles shofer/* composite models that wrap multiple underlying models
 * with configurable routing strategies:
 *   - failover: tries models in strict order; on failure, falls back
 *   - round_robin: smooth weighted round-robin (nginx-style) across models
 *
 * Streaming requests follow a "first-byte rule": once any chunk has been
 * sent to the client, failover to a different model is not possible.
 * Only pre-first-byte failures trigger failover.
 *
 * Simplified: no Redis, no per-replica metrics.
 * Enhanced: smooth WRR, configurable health cooldown, degraded state.
 */

import {
    ChatCompletionRequest,
    ChatCompletionResponse,
    CompositeModelConfig,
    CompositeHealthConfig,
    ThrottlingConfig,
} from './types';
import { ProviderRouter } from './provider-client';
import { getLogger } from './logger';
import { getMetricsCollector } from './metrics-collector';

export interface CompositeSendResult {
    response: ChatCompletionResponse;
    /** The underlying model that actually served the request */
    servedByModel: string;
    /** Whether failover occurred (at least one attempt failed) */
    failoverOccurred: boolean;
    /** Number of attempts made */
    attempts: number;
}

/** Health state per underlying model. */
enum HealthState {
    Healthy = 'healthy',
    Degraded = 'degraded',
    Unhealthy = 'unhealthy',
}

/**
 * In-memory health tracking per underlying model.
 */
interface ModelHealth {
    state: HealthState;
    consecutiveFailures: number;
    lastFailureTime: number;
    lastStateChangeMs: number;
}

/**
 * In-memory throttling state per underlying model.
 */
interface ModelThrottle {
    windowCount: number;
    windowStart: number;
    inFlight: number;
}

/**
 * Resolved per-model configuration.
 */
interface ResolvedModelConfig {
    id: string;
    weight: number;
    throttling: ThrottlingConfig;
}

const DEFAULT_THROTTLING: ThrottlingConfig = {
    maxConcurrent: 50,
    requestsPerWindow: 100,
    windowMinutes: 5,
};

const DEFAULT_HEALTH: Required<CompositeHealthConfig> = {
    failureThreshold: 3,
    cooldownMs: 30_000,
    degradedThreshold: 1,
};

const DEFAULT_STREAMING_TIMEOUT_MS = 30_000;
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 120_000;

/**
 * Smooth weighted round-robin state (nginx-style).
 * Tracks current weight per model to avoid bursting.
 */
interface SWRRState {
    models: string[];
    weights: Map<string, number>;
    currentWeights: Map<string, number>;
}

export class CompositeService {
    private router: ProviderRouter;
    private compositeConfigs: Map<string, CompositeModelConfig> = new Map();

    // Per-model health tracking
    private health = new Map<string, ModelHealth>();

    // Per-model throttling
    private throttle = new Map<string, ModelThrottle>();

    // Smooth WRR state per composite model
    private swrrState = new Map<string, SWRRState>();

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
     * Get resolved per-model configs for a composite.
     */
    getResolvedModels(compositeModelId: string): ResolvedModelConfig[] {
        const config = this.compositeConfigs.get(compositeModelId);
        if (!config) return [];

        const compositeThrottle = config.throttling ?? DEFAULT_THROTTLING;
        const result: ResolvedModelConfig[] = [];

        for (const entry of config.models) {
            if (typeof entry === 'string') {
                result.push({ id: entry, weight: 1, throttling: compositeThrottle });
            } else {
                result.push({
                    id: entry.id,
                    weight: entry.weight ?? 1,
                    throttling: entry.throttling ?? compositeThrottle,
                });
            }
        }

        return result;
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
        const health = config.health ?? {};
        const resolvedModels = this.getResolvedModels(compositeModelId);
        const attempts: string[] = [];
        let failoverOccurred = false;

        // Get candidate model IDs based on strategy
        const candidateIds = this.getCandidates(compositeModelId, config, resolvedModels);
        if (candidateIds.length === 0) {
            throw new Error(`No healthy models available for composite: ${compositeModelId}`);
        }

        let lastError: Error | undefined;
        const totalStart = Date.now();
        const totalTimeout = config.totalTimeoutMs ?? 300_000;

        for (const candidateModel of candidateIds) {
            // Check total timeout
            if (Date.now() - totalStart > totalTimeout) {
                throw new Error(
                    `Total timeout exceeded for composite ${compositeModelId} ` +
                    `(${totalTimeout}ms). Tried: ${attempts.join(', ')}`
                );
            }

            // Find the resolved config for this model
            const resolvedModel = resolvedModels.find(m => m.id === candidateModel);
            const modelThrottle = resolvedModel?.throttling ?? DEFAULT_THROTTLING;

            // Check if throttled
            if (this.isThrottled(candidateModel, modelThrottle)) {
                logger.debug(`Skipping throttled model: ${candidateModel}`);
                getMetricsCollector().recordThrottleSkip(candidateModel);
                continue;
            }

            attempts.push(candidateModel);
            if (attempts.length > 1) failoverOccurred = true;

            // Acquire throttle slot
            this.acquireThrottle(candidateModel);

            let firstByteReceived = false;

            try {
                const attemptAbort = new AbortController();
                abortController.signal.addEventListener('abort', () => attemptAbort.abort());

                // Use streaming timeout if request is streaming, else per-attempt timeout
                const isStreaming = request.stream !== false;
                const timeoutMs = isStreaming
                    ? (config.streamingTimeoutMs ?? DEFAULT_STREAMING_TIMEOUT_MS)
                    : (config.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS);

                let lastChunkMs = Date.now();
                let timeoutId: ReturnType<typeof setTimeout> | undefined;

                const resetInactivityTimer = () => {
                    if (timeoutId) clearTimeout(timeoutId);
                    if (isStreaming) {
                        timeoutId = setTimeout(() => {
                            attemptAbort.abort();
                        }, timeoutMs);
                    } else {
                        // Non-streaming: one-shot timeout
                        timeoutId = setTimeout(() => attemptAbort.abort(), timeoutMs);
                    }
                };
                resetInactivityTimer();
                const wrappedOnChunk = (chunk: ChatCompletionResponse) => {
                    firstByteReceived = true;
                    lastChunkMs = Date.now();
                    // Reset inactivity timer on each chunk for streaming
                    if (isStreaming) resetInactivityTimer();
                    onChunk(chunk);
                };

                const response = await this.router.sendStreamingRequest(
                    candidateModel,
                    request,
                    wrappedOnChunk,
                    attemptAbort,
                );

                if (timeoutId) clearTimeout(timeoutId);

                this.recordSuccess(candidateModel, health);

                logger.debug(
                    `Composite ${compositeModelId}: served by ${candidateModel} ` +
                    `(attempt ${attempts.length}/${candidateIds.length})`
                );

                return {
                    response,
                    servedByModel: candidateModel,
                    failoverOccurred,
                    attempts: attempts.length,
                };
            } catch (err) {
                lastError = err as Error;

                // If first byte was received mid-stream, failover is blocked
                if (firstByteReceived) {
                    logger.warning(
                        `Composite ${compositeModelId}: ${candidateModel} failed mid-stream ` +
                        `— cannot failover (first-byte rule)`
                    );
                    getMetricsCollector().recordMidstreamFailure(compositeModelId);
                    throw err;
                }

                logger.warning(
                    `Composite ${compositeModelId}: ${candidateModel} failed ` +
                    `(attempt ${attempts.length}/${candidateIds.length}): ${lastError.message}`
                );

                this.recordFailure(candidateModel, health);
            } finally {
                this.releaseThrottle(candidateModel);
            }
        }

        throw new Error(
            `All models failed for composite ${compositeModelId} ` +
            `(tried: ${attempts.join(', ')}). Last error: ${lastError?.message}`
        );
    }

    // ─── Candidate selection ────────────────────────────────────────

    private getCandidates(
        compositeId: string,
        config: CompositeModelConfig,
        resolvedModels: ResolvedModelConfig[],
    ): string[] {
        const health = config.health ?? {};
        const healthyIds = resolvedModels
            .filter(m => !this.isUnhealthy(m.id, health))
            .map(m => m.id);

        if (healthyIds.length === 0) return [];

        if (config.strategy === 'round_robin') {
            return this.smoothWRRSelect(compositeId, resolvedModels, health);
        }

        // failover: strict order, but skip unhealthy
        return healthyIds;
    }

    /**
     * Smooth weighted round-robin (nginx-style).
     * Each model has a weight; we track current_weight per model and
     * select the one with highest current_weight, then subtract the
     * total weight. This avoids bursting to high-weight nodes.
     */
    private smoothWRRSelect(
        compositeId: string,
        resolvedModels: ResolvedModelConfig[],
        healthCfg: CompositeHealthConfig,
    ): string[] {
        let state = this.swrrState.get(compositeId);
        const totalWeight = resolvedModels.reduce((sum, m) => {
            if (this.isUnhealthy(m.id, healthCfg)) return sum;
            return sum + m.weight;
        }, 0);

        if (totalWeight === 0) return [];

        if (!state || state.models.length !== resolvedModels.length) {
            state = {
                models: resolvedModels.map(m => m.id),
                weights: new Map(resolvedModels.map(m => [m.id, m.weight])),
                currentWeights: new Map(resolvedModels.map(m => [m.id, 0])),
            };
            this.swrrState.set(compositeId, state);
        }

        // Return a single-model array for the SWRR pick.
        // The caller iterates; for round-robin we only return one candidate
        // per call and rely on repeated calls to distribute.
        let bestModel = '';
        let bestWeight = -1;

        for (const model of resolvedModels) {
            if (this.isUnhealthy(model.id, healthCfg)) {
                state.currentWeights.set(model.id, 0);
                continue;
            }
            const current = (state.currentWeights.get(model.id) ?? 0) + model.weight;
            state.currentWeights.set(model.id, current);
            if (current > bestWeight) {
                bestWeight = current;
                bestModel = model.id;
            }
        }

        if (bestModel) {
            state.currentWeights.set(bestModel, bestWeight - totalWeight);
        }

        return bestModel ? [bestModel] : [];
    }

    // ─── Health tracking ───────────────────────────────────────────

    private getHealth(modelId: string): ModelHealth {
        let h = this.health.get(modelId);
        if (!h) {
            h = {
                state: HealthState.Healthy,
                consecutiveFailures: 0,
                lastFailureTime: 0,
                lastStateChangeMs: 0,
            };
            this.health.set(modelId, h);
        }
        return h;
    }

    private recordSuccess(modelId: string, healthCfg: CompositeHealthConfig): void {
        const h = this.getHealth(modelId);
        h.consecutiveFailures = 0;
        if (h.state !== HealthState.Healthy) {
            h.state = HealthState.Healthy;
            h.lastStateChangeMs = Date.now();
        }
    }

    private recordFailure(modelId: string, healthCfg: CompositeHealthConfig): void {
        const h = this.getHealth(modelId);
        h.consecutiveFailures++;
        h.lastFailureTime = Date.now();

        const failureThreshold = healthCfg.failureThreshold ?? DEFAULT_HEALTH.failureThreshold;
        const degradedThreshold = healthCfg.degradedThreshold ?? DEFAULT_HEALTH.degradedThreshold;

        if (h.consecutiveFailures >= failureThreshold && h.state !== HealthState.Unhealthy) {
            h.state = HealthState.Unhealthy;
            h.lastStateChangeMs = Date.now();
            getLogger().warning(
                `Model ${modelId} marked unhealthy after ${h.consecutiveFailures} consecutive failures`
            );
        } else if (h.consecutiveFailures >= degradedThreshold && h.state === HealthState.Healthy) {
            h.state = HealthState.Degraded;
            h.lastStateChangeMs = Date.now();
            getLogger().warning(
                `Model ${modelId} degraded after ${h.consecutiveFailures} consecutive failures`
            );
        }
    }

    private isUnhealthy(modelId: string, healthCfg: CompositeHealthConfig): boolean {
        const h = this.getHealth(modelId);
        if (h.state === HealthState.Healthy) return false;

        // Degraded models are still usable
        if (h.state === HealthState.Degraded) return false;

        // Unhealthy: probe after cooldown
        const cooldownMs = healthCfg.cooldownMs ?? DEFAULT_HEALTH.cooldownMs;
        const elapsed = Date.now() - h.lastStateChangeMs;
        if (elapsed > cooldownMs) {
            h.state = HealthState.Degraded; // allow one probe
            h.lastStateChangeMs = Date.now();
            return false;
        }

        return true;
    }

    // ─── Throttling ─────────────────────────────────────────────────

    private getThrottle(modelId: string): ModelThrottle {
        let t = this.throttle.get(modelId);
        if (!t) {
            t = { windowCount: 0, windowStart: Date.now(), inFlight: 0 };
            this.throttle.set(modelId, t);
        }
        return t;
    }

    private isThrottled(modelId: string, config: ThrottlingConfig): boolean {
        const t = this.getThrottle(modelId);

        if (t.inFlight >= config.maxConcurrent) return true;

        const windowMs = config.windowMinutes * 60 * 1000;
        if (Date.now() - t.windowStart > windowMs) {
            t.windowCount = 0;
            t.windowStart = Date.now();
            return false;
        }

        return t.windowCount >= config.requestsPerWindow;
    }

    private acquireThrottle(modelId: string): void {
        const t = this.getThrottle(modelId);
        t.inFlight++;
        t.windowCount++;
    }

    private releaseThrottle(modelId: string): void {
        const t = this.throttle.get(modelId);
        if (t && t.inFlight > 0) t.inFlight--;
    }
}

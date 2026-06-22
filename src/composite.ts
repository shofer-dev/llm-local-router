/**
 * Composite model failover and load-balancing logic.
 *
 * Handles shofer/* composite models that wrap multiple underlying models
 * with configurable routing strategies:
 *   - failover: tries models in strict order; on failure, falls back
 *   - round_robin: smooth weighted round-robin (nginx-style) across models
 *   - lowest_latency: always picks the model with lowest average TTFB over
 *     a configurable sliding window (default 10 min). Falls back to equal
 *     weights when no latency data is available.
 *   - highest_reliability: always picks the model with the highest success
 *     ratio over the same sliding window. Falls back to equal weights when
 *     no reliability data is available.
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
    /** Signature of the {id,weight} set this state was built for; used to
     *  detect config changes (model swapped or reweighted) that must reset
     *  the accumulated current weights. */
    signature: string;
}

/** Per-model latency tracking for lowest_latency strategy. */

/** A single TTFB sample with its recording timestamp. */
interface LatencySample {
    /** Time-to-first-byte in milliseconds. */
    ttfbMs: number;
    /** Epoch milliseconds when the sample was recorded. */
    recordedAt: number;
}
interface LatencyTracker {
    /** Timestamped TTFB samples in milliseconds. */
    samples: LatencySample[];
}

/** A single success/failure outcome for the highest_reliability strategy. */
interface ReliabilitySample {
    /** Whether the attempt succeeded (reached first byte). */
    success: boolean;
    /** Epoch milliseconds when the outcome was recorded. */
    recordedAt: number;
}

const DEFAULT_LATENCY_WINDOW_MS = 600_000; // 10 minutes

/** Cap on retained reliability samples per model (bounds memory; the window
 *  filter at read time is the real selector). */
const MAX_RELIABILITY_SAMPLES = 500;

export class CompositeService {
    private router: ProviderRouter;
    private compositeConfigs: Map<string, CompositeModelConfig> = new Map();

    // Per-model health tracking
    private health = new Map<string, ModelHealth>();

    // Per-model throttling
    private throttle = new Map<string, ModelThrottle>();

    // Smooth WRR state per composite model
    private swrrState = new Map<string, SWRRState>();
    // Per-model latency tracking for lowest_latency strategy
    private latencyTrackers = new Map<string, LatencyTracker>();
    // Per-model success/failure samples for highest_reliability strategy
    private reliabilityTrackers = new Map<string, ReliabilitySample[]>();


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
        this.pruneStaleTrackers();
        getLogger().info(`Loaded ${this.compositeConfigs.size} composite model configs`);
    }

    /**
     * Drop per-model/per-composite tracking state for models and composites no
     * longer referenced by the current config, so long-lived processes don't
     * accumulate unbounded stale entries across reconfigurations.
     */
    private pruneStaleTrackers(): void {
        const liveModels = new Set<string>();
        for (const id of this.compositeConfigs.keys()) {
            for (const m of this.getResolvedModels(id)) liveModels.add(m.id);
        }
        const liveComposites = new Set<string>(this.compositeConfigs.keys());

        for (const key of Array.from(this.health.keys())) {
            if (!liveModels.has(key)) this.health.delete(key);
        }
        for (const key of Array.from(this.throttle.keys())) {
            if (!liveModels.has(key)) this.throttle.delete(key);
        }
        for (const key of Array.from(this.latencyTrackers.keys())) {
            if (!liveModels.has(key)) this.latencyTrackers.delete(key);
        }
        for (const key of Array.from(this.reliabilityTrackers.keys())) {
            if (!liveModels.has(key)) this.reliabilityTrackers.delete(key);
        }
        for (const key of Array.from(this.swrrState.keys())) {
            if (!liveComposites.has(key)) this.swrrState.delete(key);
        }
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

            // Acquire throttle slot (also advances the rate-limit window)
            this.acquireThrottle(candidateModel, modelThrottle);

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
                const attemptStartMs = Date.now();
                let ttfbMs = 0;
                const wrappedOnChunk = (chunk: ChatCompletionResponse) => {
                    if (!firstByteReceived) {
                        firstByteReceived = true;
                        ttfbMs = Date.now() - attemptStartMs;
                    }
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

                this.recordSuccess(candidateModel);
                if (ttfbMs > 0) {
                    this.recordLatency(candidateModel, ttfbMs, config.metricsWindowMs ?? config.latencyWindowMs ?? DEFAULT_LATENCY_WINDOW_MS);
                }

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
                    // Still a real failure for health/reliability tracking — without
                    // this, a model that consistently fails mid-stream never accrues
                    // failures and is never marked degraded/unhealthy.
                    this.recordFailure(candidateModel, health);
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

        if (config.strategy === 'lowest_latency') {
            return this.lowestLatencySelect(compositeId, resolvedModels, config, health);
        }

        if (config.strategy === 'highest_reliability') {
            return this.highestReliabilitySelect(compositeId, resolvedModels, config, health);
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

        // Rebuild when the {id,weight} set changes, not just its size — swapping
        // a model for another (same count) or changing a weight must reset the
        // accumulated current weights, otherwise routing uses stale weights or
        // references models no longer present.
        const signature = resolvedModels
            .map(m => `${m.id}:${m.weight}`)
            .sort()
            .join('|');
        if (!state || state.signature !== signature) {
            state = {
                models: resolvedModels.map(m => m.id),
                weights: new Map(resolvedModels.map(m => [m.id, m.weight])),
                currentWeights: new Map(resolvedModels.map(m => [m.id, 0])),
                signature,
            };
            this.swrrState.set(compositeId, state);
        }

        // Pick the SWRR winner, but return ALL healthy models (winner first)
        // so the caller's failover loop has fallbacks. The winner leads — that
        // is what drives the round-robin distribution across repeated calls —
        // and the remaining healthy models follow, ordered by current weight so
        // the next-best picks come first if the winner fails pre-first-byte.
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

        if (!bestModel) return [];

        // Subtract total weight from the winner (standard nginx SWRR step).
        state.currentWeights.set(bestModel, bestWeight - totalWeight);

        const fallbacks = resolvedModels
            .filter(m => m.id !== bestModel && !this.isUnhealthy(m.id, healthCfg))
            .sort((a, b) => (state!.currentWeights.get(b.id) ?? 0) - (state!.currentWeights.get(a.id) ?? 0))
            .map(m => m.id);

        return [bestModel, ...fallbacks];
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

    private recordSuccess(modelId: string): void {
        this.recordReliability(modelId, true);
        const h = this.getHealth(modelId);
        h.consecutiveFailures = 0;
        if (h.state !== HealthState.Healthy) {
            h.state = HealthState.Healthy;
            h.lastStateChangeMs = Date.now();
        }
    }

    private recordFailure(modelId: string, healthCfg: CompositeHealthConfig): void {
        this.recordReliability(modelId, false);
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


    // ─── Latency-based selection ─────────────────────────────────────

    /**
     * Record a TTFB sample for the given model. Samples are timestamped; the
     * sliding window is applied at read time (and pruned here on write to bound
     * memory).
     */
    private recordLatency(modelId: string, ttfbMs: number, windowMs: number): void {
        let tracker = this.latencyTrackers.get(modelId);
        if (!tracker) {
            tracker = { samples: [] as LatencySample[] };
            this.latencyTrackers.set(modelId, tracker);
        }

        // Prune old samples
        const cutoff = Date.now() - windowMs;
        tracker.samples = tracker.samples.filter(s => s.recordedAt > cutoff);
        tracker.samples.push({ ttfbMs, recordedAt: Date.now() });
    }

    /**
     * Get the estimated TTFB for a model: the mean of its in-window samples
     * (the documented "lowest average TTFB over a sliding window" semantics).
     * Prunes expired samples at read time and returns Infinity when no in-window
     * data remains, so an idle model's stale latency never wins selection.
     */
    private getEstimatedLatency(modelId: string, windowMs: number = DEFAULT_LATENCY_WINDOW_MS): number {
        const tracker = this.latencyTrackers.get(modelId);
        if (!tracker) return Infinity;
        const cutoff = Date.now() - windowMs;
        tracker.samples = tracker.samples.filter(s => s.recordedAt > cutoff);
        if (tracker.samples.length === 0) return Infinity;
        const sum = tracker.samples.reduce((acc, s) => acc + s.ttfbMs, 0);
        return sum / tracker.samples.length;
    }

    /**
     * Select the model with the lowest average TTFB for the
     * lowest_latency strategy. Falls back to equal-weight round-robin
     * when no latency data is available for any model.
     */
    private lowestLatencySelect(
        compositeId: string,
        resolvedModels: ResolvedModelConfig[],
        config: CompositeModelConfig,
        health: CompositeHealthConfig,
    ): string[] {
        const latencyWindowMs = config.metricsWindowMs ?? config.latencyWindowMs ?? DEFAULT_LATENCY_WINDOW_MS;
        const healthy = resolvedModels.filter(m => !this.isUnhealthy(m.id, health));

        if (healthy.length === 0) return [];

        const allUnknown = healthy.every(m => this.getEstimatedLatency(m.id, latencyWindowMs) === Infinity);

        // If no latency data exists, fall back to equal weights for all healthy models
        if (allUnknown) {
            // Use simple round-robin with equal weights (weight=1)
            const equalModels = healthy.map(m => ({ ...m, weight: 1 }));
            return this.smoothWRRSelect(compositeId, equalModels, health);
        }

        // Sort ALL healthy models by estimated TTFB ascending: the fastest
        // leads, and slower (or untested → Infinity) models remain as failover
        // candidates rather than the request aborting if the fastest fails.
        return [...healthy]
            .sort((a, b) =>
                this.getEstimatedLatency(a.id, latencyWindowMs) - this.getEstimatedLatency(b.id, latencyWindowMs))
            .map(m => m.id);
    }

    // ─── Reliability-based selection ─────────────────────────────────

    /**
     * Record a success/failure outcome for a model. Samples are timestamped;
     * the sliding window is applied at read time in getReliability(). The
     * retained list is capped to bound memory.
     */
    private recordReliability(modelId: string, success: boolean): void {
        let samples = this.reliabilityTrackers.get(modelId);
        if (!samples) {
            samples = [];
            this.reliabilityTrackers.set(modelId, samples);
        }
        samples.push({ success, recordedAt: Date.now() });
        if (samples.length > MAX_RELIABILITY_SAMPLES) {
            samples.splice(0, samples.length - MAX_RELIABILITY_SAMPLES);
        }
    }

    /**
     * Success ratio (0-1) for a model over the given sliding window, or null
     * when there are no samples in the window.
     */
    private getReliability(modelId: string, windowMs: number): number | null {
        const samples = this.reliabilityTrackers.get(modelId);
        if (!samples || samples.length === 0) return null;
        const cutoff = Date.now() - windowMs;
        let total = 0;
        let ok = 0;
        for (const s of samples) {
            if (s.recordedAt <= cutoff) continue;
            total++;
            if (s.success) ok++;
        }
        if (total === 0) return null;
        return ok / total;
    }

    /**
     * Select the model with the highest success ratio over the sliding window
     * for the highest_reliability strategy. Falls back to equal-weight
     * round-robin when no reliability data exists for any model. The chosen
     * model leads; remaining healthy models follow (sorted by reliability) so
     * failover still has candidates.
     *
     * Untested models are given the benefit of the doubt (treated as fully
     * reliable, 1.0) so they get sampled rather than being permanently ranked
     * below a model with a known-bad ratio; once a model has data in the
     * window, its measured ratio applies.
     */
    private highestReliabilitySelect(
        compositeId: string,
        resolvedModels: ResolvedModelConfig[],
        config: CompositeModelConfig,
        health: CompositeHealthConfig,
    ): string[] {
        const windowMs = config.metricsWindowMs ?? config.latencyWindowMs ?? DEFAULT_LATENCY_WINDOW_MS;
        const healthy = resolvedModels.filter(m => !this.isUnhealthy(m.id, health));

        if (healthy.length === 0) return [];

        const scored = healthy.map(m => ({ id: m.id, score: this.getReliability(m.id, windowMs) }));
        const allUnknown = scored.every(s => s.score === null);

        // No reliability data yet: fall back to equal-weight round-robin.
        if (allUnknown) {
            const equalModels = healthy.map(m => ({ ...m, weight: 1 }));
            return this.smoothWRRSelect(compositeId, equalModels, health);
        }

        // Highest reliability first; untested models (null) are optimistically
        // treated as 1.0 so they outrank known-unreliable models.
        scored.sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
        return scored.map(s => s.id);
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

    /**
     * Read-only throttle predicate. Does NOT mutate window state — the window
     * is advanced once, at acquire time, so repeated isThrottled() checks are
     * deterministic and don't reset another model's counter as a side effect.
     */
    private isThrottled(modelId: string, config: ThrottlingConfig): boolean {
        const t = this.getThrottle(modelId);

        if (t.inFlight >= config.maxConcurrent) return true;

        const windowMs = config.windowMinutes * 60 * 1000;
        // If the window has elapsed it will be reset on the next acquire, so the
        // effective count is 0 — not throttled by the per-window limit.
        if (Date.now() - t.windowStart > windowMs) return false;

        return t.windowCount >= config.requestsPerWindow;
    }

    private acquireThrottle(modelId: string, config?: ThrottlingConfig): void {
        const t = this.getThrottle(modelId);
        // Advance the rate-limit window here (the single mutation point) before
        // counting this request against it.
        if (config) {
            const windowMs = config.windowMinutes * 60 * 1000;
            if (Date.now() - t.windowStart > windowMs) {
                t.windowCount = 0;
                t.windowStart = Date.now();
            }
        }
        t.inFlight++;
        t.windowCount++;
    }

    private releaseThrottle(modelId: string): void {
        const t = this.throttle.get(modelId);
        if (t && t.inFlight > 0) t.inFlight--;
    }
}

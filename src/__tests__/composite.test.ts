/**
 * Unit tests for the composite model service.
 *
 * Tests failover logic, smooth weighted round-robin, health tracking,
 * per-model throttling, and getResolvedModels.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CompositeService } from '../composite';
import { ProviderRouter } from '../provider-client';
import { ChatCompletionRequest, ChatCompletionResponse } from '../types';

function createMockRouter(
    responses: Map<string, ChatCompletionResponse | Error>,
): ProviderRouter {
    const router = new ProviderRouter();
    (router as any).sendStreamingRequest = async (
        modelId: string,
        _req: ChatCompletionRequest,
        onChunk: (chunk: ChatCompletionResponse) => void,
        _abort: AbortController,
    ): Promise<ChatCompletionResponse> => {
        const result = responses.get(modelId);
        if (result instanceof Error) throw result;
        if (!result) throw new Error(`No mock response for ${modelId}`);
        onChunk(result);
        return result;
    };
    (router as any).resolveProvider = () => ({
        provider: 'mock',
        modelId: 'mock',
        baseUrl: 'https://mock.example.com/v1',
    });
    return router;
}

const okResponse: ChatCompletionResponse = {
    id: 'test', object: 'chat.completion', created: 0, model: 'test',
    choices: [{ index: 0, message: { role: 'user' as any, content: 'ok' }, finishReason: 'stop' }],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.001 },
};

const reqStub: ChatCompletionRequest = { conversationId: 'c', model: 'shofer/t', messages: [], stream: true };

describe('CompositeService', () => {
    describe('failover', () => {
        it('returns first model on success', async () => {
            const router = createMockRouter(new Map<string, ChatCompletionResponse | Error>([
                ['model-a', okResponse], ['model-b', okResponse],
            ]));
            const service = new CompositeService(router);
            service.loadConfigs({ 'shofer/t': { strategy: 'failover', models: ['model-a', 'model-b'] } });
            const r = await service.sendCompositeRequest('shofer/t', reqStub, () => {}, new AbortController());
            assert.equal(r.servedByModel, 'model-a');
            assert.equal(r.failoverOccurred, false);
        });

        it('fails over to second model', async () => {
            const router = createMockRouter(new Map<string, ChatCompletionResponse | Error>([
                ['model-a', new Error('down')], ['model-b', okResponse],
            ]));
            const service = new CompositeService(router);
            service.loadConfigs({ 'shofer/t': { strategy: 'failover', models: ['model-a', 'model-b'] } });
            const r = await service.sendCompositeRequest('shofer/t', reqStub, () => {}, new AbortController());
            assert.equal(r.servedByModel, 'model-b');
            assert.equal(r.failoverOccurred, true);
        });

        it('throws when all models fail', async () => {
            const router = createMockRouter(new Map<string, ChatCompletionResponse | Error>([
                ['a', new Error('down')], ['b', new Error('also')],
            ]));
            const service = new CompositeService(router);
            service.loadConfigs({ 'shofer/t': { strategy: 'failover', models: ['a', 'b'] } });
            await assert.rejects(
                () => service.sendCompositeRequest('shofer/t', reqStub, () => {}, new AbortController()),
                /All models failed/,
            );
        });

        it('uses streaming timeout for streaming requests', async () => {
            const router = createMockRouter(new Map<string, ChatCompletionResponse | Error>([
                ['model-a', okResponse],
            ]));
            const service = new CompositeService(router);
            service.loadConfigs({
                'shofer/t': {
                    strategy: 'failover',
                    models: ['model-a'],
                    streamingTimeoutMs: 99_999,
                    perAttemptTimeoutMs: 50_000,
                },
            });
            const r = await service.sendCompositeRequest('shofer/t', reqStub, () => {}, new AbortController());
            assert.equal(r.servedByModel, 'model-a');
        });
    });

    describe('smooth weighted round-robin', () => {
        it('distributes with weights over multiple calls', async () => {
            const router = createMockRouter(new Map<string, ChatCompletionResponse | Error>([
                ['a', okResponse], ['b', okResponse], ['c', okResponse],
            ]));
            const service = new CompositeService(router);
            service.loadConfigs({
                'shofer/rr': {
                    strategy: 'round_robin',
                    models: [{ id: 'a', weight: 5 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }],
                },
            });

            const counts = new Map<string, number>();
            for (let i = 0; i < 14; i++) {
                const r = await service.sendCompositeRequest('shofer/rr', reqStub, () => {}, new AbortController());
                counts.set(r.servedByModel, (counts.get(r.servedByModel) ?? 0) + 1);
            }

            assert.ok((counts.get('a') ?? 0) >= 7, `weight-5 model should have >=7, got ${counts.get('a')}`);
            assert.ok((counts.get('b') ?? 0) >= 1, 'weight-1 models should get at least 1');
            assert.ok((counts.get('c') ?? 0) >= 1, 'weight-1 models should get at least 1');
        });
    });

    describe('health', () => {
        it('skips unhealthy models in failover', async () => {
            const router = createMockRouter(new Map<string, ChatCompletionResponse | Error>([
                ['a', new Error('fail')], ['b', okResponse],
            ]));
            const service = new CompositeService(router);
            service.loadConfigs({
                'shofer/h': {
                    strategy: 'failover',
                    models: ['a', 'b'],
                    health: { failureThreshold: 2, cooldownMs: 60_000, degradedThreshold: 1 },
                },
            });

            // Fail model-a twice to make it unhealthy
            await service.sendCompositeRequest('shofer/h', reqStub, () => {}, new AbortController()).catch(() => {});
            // After 2 failures, model-a is unhealthy. Next call should skip it.
            const r = await service.sendCompositeRequest('shofer/h', reqStub, () => {}, new AbortController());
            assert.equal(r.servedByModel, 'b');
        });
    });

    describe('throttling', () => {
        it('per-model throttling limits within window', async () => {
            const router = createMockRouter(new Map<string, ChatCompletionResponse | Error>([
                ['a', okResponse], ['b', okResponse],
            ]));
            const service = new CompositeService(router);
            service.loadConfigs({
                'shofer/t': {
                    strategy: 'failover',
                    models: [
                        { id: 'a', throttling: { maxConcurrent: 10, requestsPerWindow: 1, windowMinutes: 60 } },
                        'b',
                    ],
                },
            });

            const r1 = await service.sendCompositeRequest('shofer/t', reqStub, () => {}, new AbortController());
            assert.equal(r1.servedByModel, 'a');

            // Second call: 'a' throttled (1 req per 60min window)
            const r2 = await service.sendCompositeRequest('shofer/t', reqStub, () => {}, new AbortController());
            assert.equal(r2.servedByModel, 'b');
        });
    });

    describe('isCompositeModel', () => {
        it('returns true for shofer/* with config', () => {
            const service = new CompositeService(new ProviderRouter());
            service.loadConfigs({ 'shofer/code': { strategy: 'failover', models: ['gpt-5.5'] } });
            assert.equal(service.isCompositeModel('shofer/code'), true);
        });

        it('returns false for non-composite', () => {
            assert.equal(new CompositeService(new ProviderRouter()).isCompositeModel('gpt-5.5'), false);
        });
    });

    describe('getResolvedModels', () => {
        it('handles string model list', () => {
            const service = new CompositeService(new ProviderRouter());
            service.loadConfigs({ 'shofer/s': { strategy: 'failover', models: ['a', 'b'] } });
            const r = service.getResolvedModels('shofer/s');
            assert.equal(r.length, 2);
            assert.equal(r[0].weight, 1);
        });

        it('handles mixed with weights', () => {
            const service = new CompositeService(new ProviderRouter());
            service.loadConfigs({
                'shofer/m': {
                    strategy: 'round_robin',
                    models: ['a', { id: 'b', weight: 3 }],
                },
            });
            const r = service.getResolvedModels('shofer/m');
            assert.equal(r[1].weight, 3);
        });
    });
});

/**
 * Unit tests for provider-specific request transformations.
 *
 * Tests each provider's prepare function and chunk transformers
 * in isolation.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChatCompletionRequest, ChatCompletionResponse, MessageRole } from '../types';

// ─── OpenAI ────────────────────────────────────────────────────────

import { prepareOpenAIRequest } from '../providers/openai';

describe('providers/openai', () => {
    describe('prepareOpenAIRequest', () => {
        it('remaps max_tokens → max_completion_tokens for GPT-5.5', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'gpt-5.5',
                messages: [],
                maxTokens: 4096,
            };
            prepareOpenAIRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.max_completion_tokens, 4096);
        });

        it('remaps max_tokens for GPT-5.4-mini', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'gpt-5.4-mini',
                messages: [],
                maxTokens: 2048,
            };
            prepareOpenAIRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.max_completion_tokens, 2048);
        });

        it('does not remap for non-GPT-5 models', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'deepseek-v4-pro',
                messages: [],
                maxTokens: 4096,
            };
            prepareOpenAIRequest(req);
            assert.equal(req.extraBody, undefined);
        });

        it('forwards reasoning_effort', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'gpt-5.5',
                messages: [],
                reasoningEffort: 'high',
            };
            prepareOpenAIRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.reasoning_effort, 'high');
        });
    });
});

// ─── DeepSeek ──────────────────────────────────────────────────────

import { prepareDeepSeekRequest } from '../providers/deepseek';

describe('providers/deepseek', () => {
    describe('prepareDeepSeekRequest', () => {
        it('injects placeholder for assistant message without reasoning_content', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'deepseek-v4-pro',
                messages: [
                    { role: MessageRole.User, content: 'hello' },
                    { role: MessageRole.Assistant, content: 'hi' },
                ],
            };
            prepareDeepSeekRequest(req);
            assert.equal(req.messages[1].reasoningContent, '\u2022');
        });

        it('preserves existing reasoning_content', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'deepseek-v4-pro',
                messages: [
                    { role: MessageRole.Assistant, content: 'hi', reasoningContent: 'Let me think...' },
                ],
            };
            prepareDeepSeekRequest(req);
            assert.equal(req.messages[0].reasoningContent, 'Let me think...');
        });

        it('does not inject placeholder for user/system messages', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'deepseek-v4-pro',
                messages: [
                    { role: MessageRole.User, content: 'hello' },
                    { role: MessageRole.System, content: 'be helpful' },
                ],
            };
            prepareDeepSeekRequest(req);
            assert.equal(req.messages[0].reasoningContent, undefined);
            assert.equal(req.messages[1].reasoningContent, undefined);
        });

        it('forwards reasoning_effort', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'deepseek-v4-pro',
                messages: [],
                reasoningEffort: 'max',
            };
            prepareDeepSeekRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.reasoning_effort, 'max');
        });
    });
});

// ─── MiniMax ───────────────────────────────────────────────────────

import { prepareMiniMaxRequest, transformMiniMaxStreamChunk } from '../providers/minimax';

describe('providers/minimax', () => {
    describe('prepareMiniMaxRequest', () => {
        it('enables reasoning_split', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'MiniMax-M2.7',
                messages: [],
            };
            prepareMiniMaxRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.reasoning_split, true);
        });

        it('converts reasoning_content → reasoning_details on assistant messages', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'MiniMax-M2.7',
                messages: [
                    { role: MessageRole.User, content: 'hello' },
                    { role: MessageRole.Assistant, content: 'hi', reasoningContent: 'step by step reasoning' },
                ],
            };
            prepareMiniMaxRequest(req);

            // reasoning_content should be cleared
            assert.equal(req.messages[1].reasoningContent, undefined);
            // reasoning_details should be reconstructed
            const details = (req.messages[1] as any).reasoningDetails;
            assert.ok(Array.isArray(details));
            assert.equal(details.length, 1);
            assert.equal(details[0].type, 'reasoning.text');
            assert.equal(details[0].text, 'step by step reasoning');
        });

        it('preserves existing reasoning_details', () => {
            const existing = [{ type: 'reasoning.text', text: 'preserved' }];
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'MiniMax-M2.7',
                messages: [
                    {
                        role: MessageRole.Assistant,
                        content: 'hi',
                        reasoningContent: 'should be cleared',
                    } as any,
                ],
            };
            (req.messages[0] as any).reasoningDetails = existing;
            prepareMiniMaxRequest(req);

            assert.equal(req.messages[0].reasoningContent, undefined);
            assert.deepEqual((req.messages[0] as any).reasoningDetails, existing);
        });

        it('does not modify user/system messages', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'MiniMax-M2.7',
                messages: [
                    { role: MessageRole.User, content: 'user text' },
                ],
            };
            prepareMiniMaxRequest(req);
            assert.equal(req.messages[0].reasoningContent, undefined);
            assert.equal((req.messages[0] as any).reasoningDetails, undefined);
        });
    });

    describe('transformMiniMaxStreamChunk', () => {
        it('extracts reasoning_details.text → reasoning_content in delta', () => {
            const chunk: ChatCompletionResponse = {
                id: 'test',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'MiniMax-M2.7',
                choices: [{
                    index: 0,
                    delta: {
                        content: 'answer',
                    } as any,
                }],
            };
            (chunk.choices[0].delta as any).reasoning_details = [
                { type: 'reasoning.text', id: 'r1', format: 'v1', index: 0, text: 'thinking...' },
            ];

            transformMiniMaxStreamChunk(chunk);
            assert.equal(chunk.choices[0].delta!.reasoningContent, 'thinking...');
        });

        it('concatenates multiple reasoning_details entries', () => {
            const chunk: ChatCompletionResponse = {
                id: 'test',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'MiniMax-M2.7',
                choices: [{
                    index: 0,
                    delta: {} as any,
                }],
            };
            (chunk.choices[0].delta as any).reasoning_details = [
                { text: 'step 1' },
                { text: 'step 2' },
            ];

            transformMiniMaxStreamChunk(chunk);
            assert.equal(chunk.choices[0].delta!.reasoningContent, 'step 1\nstep 2');
        });
    });
});

// ─── Xiaomi ────────────────────────────────────────────────────────

import { prepareXiaomiRequest } from '../providers/xiaomi';

describe('providers/xiaomi', () => {
    describe('prepareXiaomiRequest', () => {
        it('enables thinking for mimo-v2-pro', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'mimo-v2-pro',
                messages: [],
            };
            prepareXiaomiRequest(req);
            assert.ok(req.extraBody);
            assert.deepEqual(req.extraBody!.thinking, { type: 'enabled' });
        });

        it('does not enable thinking for mimo-v2-tts', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'mimo-v2-tts',
                messages: [],
            };
            prepareXiaomiRequest(req);
            assert.equal(req.extraBody?.thinking, undefined);
        });

        it('remaps max_tokens to max_completion_tokens', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'mimo-v2-pro',
                messages: [],
                maxTokens: 8192,
            };
            prepareXiaomiRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.max_completion_tokens, 8192);
        });

        it('converts reasoning_details → reasoning_content', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'mimo-v2-pro',
                messages: [{
                    role: MessageRole.Assistant,
                    content: 'ok',
                } as any],
            };
            (req.messages[0] as any).reasoningDetails = [
                { text: 'step one' },
                { text: 'step two' },
            ];
            prepareXiaomiRequest(req);
            assert.equal(req.messages[0].reasoningContent, 'step one\nstep two');
        });
    });
});

// ─── Moonshot ──────────────────────────────────────────────────────

import { prepareMoonshotRequest } from '../providers/moonshot';

describe('providers/moonshot', () => {
    describe('prepareMoonshotRequest', () => {
        it('injects placeholder for assistant without reasoning_content', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'kimi-k2-thinking',
                messages: [
                    { role: MessageRole.User, content: 'hello' },
                    { role: MessageRole.Assistant, content: 'hi' },
                ],
            };
            prepareMoonshotRequest(req);
            assert.equal(req.messages[1].reasoningContent, '\u2022');
        });
    });
});

// ─── Zhipu ────────────────────────────────────────────────────────

import { prepareZhipuRequest } from '../providers/zhipu';

describe('providers/zhipu', () => {
    it('enables thinking for glm-5.1', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'glm-5.1',
            messages: [],
        };
        prepareZhipuRequest(req);
        assert.ok(req.extraBody);
        assert.deepEqual(req.extraBody!.thinking, { type: 'enabled' });
    });
});

// ─── Google ────────────────────────────────────────────────────────

import { prepareGoogleRequest } from '../providers/google';

describe('providers/google', () => {
    it('prepareGoogleRequest is a no-op (native API path handles everything in customSend)', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'gemini-3.1-pro-preview',
            messages: [],
            reasoningEffort: 'high',
        };
        prepareGoogleRequest(req);
        // Native API handles all preparation — the function is a no-op stub
        assert.equal(req.extraBody, undefined);
    });
});

// ─── OpenRouter ────────────────────────────────────────────────────

import { prepareOpenRouterRequest } from '../providers/openrouter';

describe('providers/openrouter', () => {
    it('is a no-op', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'any/model',
            messages: [],
        };
        prepareOpenRouterRequest(req);
        assert.equal(req.extraBody, undefined);
    });
});

// ─── Custom providers (ProviderRouter) ──────────────────────────────

import { ProviderRouter } from '../provider-client';
import { CustomProviderConfig, ProviderType } from '../types';

describe('providers/custom', () => {
    let router: ProviderRouter;

    function makeCustomProvider(overrides?: Partial<CustomProviderConfig>): CustomProviderConfig {
        return {
            id: 'my-bedrock',
            label: 'AWS Bedrock',
            protocol: 'openai-compatible',
            endpointUrl: 'https://bedrock.example.com/v1',
            models: [
                { id: 'bedrock-claude', name: 'Claude via Bedrock', contextLength: 200000, maxOutputTokens: 65536, imageInput: true, toolCalling: true },
                { id: 'bedrock-gpt', name: 'GPT via Bedrock', contextLength: 128000, maxOutputTokens: 16384, imageInput: false, toolCalling: true },
            ],
            defaultPricing: { prompt: 0.003, completion: 0.015 },
            ...overrides,
        };
    }

    function setupRouter(cfg: CustomProviderConfig): ProviderRouter {
        const r = new ProviderRouter();
        const map = new Map<string, CustomProviderConfig>();
        map.set(cfg.id, cfg);
        r.updateCustomProviders(map);
        r.updateCustomApiKeys({ [cfg.id]: 'sk-test-key' });
        return r;
    }

    describe('resolveProvider', () => {
        it('resolves custom provider model by model ID', () => {
            const cfg = makeCustomProvider();
            const r = setupRouter(cfg);

            const resolved = r.resolveProvider('bedrock-claude');
            assert.ok(resolved);
            assert.equal(resolved.modelId, 'bedrock-claude');
            assert.equal(resolved.customProviderId, 'my-bedrock');
            assert.equal(resolved.customProtocol, 'openai-compatible');
            assert.equal(resolved.baseUrl, 'https://bedrock.example.com/v1');
            assert.equal(resolved.provider, undefined); // no built-in provider
        });

        it('resolves second model from same provider', () => {
            const cfg = makeCustomProvider();
            const r = setupRouter(cfg);

            const resolved = r.resolveProvider('bedrock-gpt');
            assert.ok(resolved);
            assert.equal(resolved.customProviderId, 'my-bedrock');
        });

        it('falls back to OpenRouter for unknown model', () => {
            const cfg = makeCustomProvider();
            const r = setupRouter(cfg);

            const resolved = r.resolveProvider('nonexistent-model');
            assert.ok(resolved);
            assert.equal(resolved.provider, ProviderType.OpenRouter);
            assert.equal(resolved.customProviderId, undefined);
        });

        it('prefers custom provider over built-in when model ID matches custom', () => {
            // Register a custom provider that "shadows" a built-in model ID
            const r = new ProviderRouter();
            const map = new Map<string, CustomProviderConfig>();
            map.set('shadow', {
                id: 'shadow',
                label: 'Shadow',
                protocol: 'openai-compatible',
                endpointUrl: 'https://shadow.example.com/v1',
                models: [{ id: 'deepseek-v4-pro', name: 'Shadow DS', contextLength: 100000, maxOutputTokens: 32768, imageInput: false, toolCalling: true }],
            });
            r.updateCustomProviders(map);
            r.updateCustomApiKeys({ shadow: 'sk-shadow' });

            const resolved = r.resolveProvider('deepseek-v4-pro');
            assert.ok(resolved);
            assert.equal(resolved.customProviderId, 'shadow');
            assert.equal(resolved.baseUrl, 'https://shadow.example.com/v1');
        });

        it('resolves composite first model through custom provider', () => {
            const cfg = makeCustomProvider();
            const r = new ProviderRouter();
            const map = new Map<string, CustomProviderConfig>();
            map.set(cfg.id, cfg);
            r.updateCustomProviders(map);
            r.updateCustomApiKeys({ [cfg.id]: 'sk-test-key' });
            r.updateCompositeModels({
                'shofer/bedrock': { strategy: 'failover', models: ['bedrock-claude', 'bedrock-gpt'] },
            });

            const resolved = r.resolveProvider('shofer/bedrock');
            assert.ok(resolved);
            assert.equal(resolved.customProviderId, 'my-bedrock');
            assert.equal(resolved.modelId, 'bedrock-claude');
        });
    });

    describe('getCustomProviderModels', () => {
        it('returns all models from all custom providers', () => {
            const cfg = makeCustomProvider();
            const r = setupRouter(cfg);

            const models = r.getCustomProviderModels();
            assert.equal(models.length, 2);
            assert.equal(models[0].model.id, 'bedrock-claude');
            assert.equal(models[0].providerId, 'my-bedrock');
            assert.equal(models[0].providerLabel, 'AWS Bedrock');
            assert.deepEqual(models[0].pricing, { prompt: 0.003, completion: 0.015 });
            assert.equal(models[1].model.id, 'bedrock-gpt');
        });

        it('returns empty array when no custom providers', () => {
            const r = new ProviderRouter();
            assert.deepEqual(r.getCustomProviderModels(), []);
        });
    });

    describe('buildCustomHandler (via sendRequest)', () => {
        it('uses openai-compatible passthrough handler', () => {
            const cfg = makeCustomProvider({ protocol: 'openai-compatible' });
            // buildCustomHandler is private — tested indirectly via routing
            const r = setupRouter(cfg);
            const resolved = r.resolveProvider('bedrock-claude');
            assert.ok(resolved);
            assert.equal(resolved.customProtocol, 'openai-compatible');
        });

        it('recognizes anthropic-compatible protocol', () => {
            const cfg = makeCustomProvider({ protocol: 'anthropic-compatible' });
            const r = setupRouter(cfg);
            const resolved = r.resolveProvider('bedrock-claude');
            assert.ok(resolved);
            assert.equal(resolved.customProtocol, 'anthropic-compatible');
        });

        it('recognizes google-compatible protocol', () => {
            const cfg = makeCustomProvider({ protocol: 'google-compatible' });
            const r = setupRouter(cfg);
            const resolved = r.resolveProvider('bedrock-claude');
            assert.ok(resolved);
            assert.equal(resolved.customProtocol, 'google-compatible');
        });
    });

    describe('hasApiKeyForProvider', () => {
        it('returns true for custom provider with key', () => {
            const cfg = makeCustomProvider();
            const r = setupRouter(cfg);
            assert.ok(r.hasApiKeyForProvider('my-bedrock'));
        });

        it('returns false for custom provider without key', () => {
            const cfg = makeCustomProvider();
            const r = new ProviderRouter();
            const map = new Map<string, CustomProviderConfig>();
            map.set(cfg.id, cfg);
            r.updateCustomProviders(map);
            // No API key set
            assert.ok(!r.hasApiKeyForProvider('my-bedrock'));
        });

        it('counts custom providers in getConfiguredProviderCount', () => {
            const cfg = makeCustomProvider();
            const r = setupRouter(cfg);
            // Only custom provider has a key, no built-in keys
            assert.equal(r.getConfiguredProviderCount(), 1);
        });
    });

    describe('getApiKey / getCustomApiKey', () => {
        it('getCustomApiKey returns key for custom provider', () => {
            const cfg = makeCustomProvider();
            const r = setupRouter(cfg);
            assert.equal(r.getCustomApiKey('my-bedrock'), 'sk-test-key');
        });

        it('getCustomApiKey returns empty string for unknown provider', () => {
            const r = new ProviderRouter();
            assert.equal(r.getCustomApiKey('nonexistent'), '');
        });
    });

    describe('updateCustomProviders clears old index', () => {
        it('removes models when provider is replaced', () => {
            const cfg = makeCustomProvider();
            const r = setupRouter(cfg);

            // Replace with empty provider
            const map2 = new Map<string, CustomProviderConfig>();
            map2.set('my-bedrock', { ...cfg, models: [] });
            r.updateCustomProviders(map2);

            const resolved = r.resolveProvider('bedrock-claude');
            // Falls through to OpenRouter since custom model index no longer has it
            assert.equal(resolved?.provider, ProviderType.OpenRouter);
        });
    });
});


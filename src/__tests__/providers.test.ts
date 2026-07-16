/**
 * Unit tests for provider-specific request transformations.
 *
 * Tests each provider's prepare function and chunk transformers
 * in isolation.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChatCompletionRequest, ChatCompletionResponse, ChatMessage, MessageRole } from '../types';

// ─── OpenAI ────────────────────────────────────────────────────────

import { prepareOpenAIRequest } from '../providers/openai';

describe('providers/openai', () => {
    describe('prepareOpenAIRequest', () => {
        it('remaps max_tokens → max_completion_tokens for GPT-5.5 and clears maxTokens', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'gpt-5.5',
                messages: [],
                maxTokens: 4096,
            };
            prepareOpenAIRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.max_completion_tokens, 4096);
            // maxTokens must be cleared to avoid sending both max_tokens
            // (top-level) and max_completion_tokens (extraBody) to the API
            assert.equal(req.maxTokens, undefined);
        });

        it('remaps max_tokens for GPT-5.4-mini and clears maxTokens', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'gpt-5.4-mini',
                messages: [],
                maxTokens: 2048,
            };
            prepareOpenAIRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.max_completion_tokens, 2048);
            assert.equal(req.maxTokens, undefined);
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
            // maxTokens should be preserved for non-GPT-5 models
            assert.equal(req.maxTokens, 4096);
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

        it('remaps max_tokens to max_completion_tokens and clears maxTokens', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'mimo-v2-pro',
                messages: [],
                maxTokens: 8192,
            };
            prepareXiaomiRequest(req);
            assert.ok(req.extraBody);
            assert.equal(req.extraBody!.max_completion_tokens, 8192);
            // maxTokens must be cleared to avoid sending both to the API
            assert.equal(req.maxTokens, undefined);
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

    it('enables thinking for glm-5.2', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'glm-5.2',
            messages: [],
        };
        prepareZhipuRequest(req);
        assert.ok(req.extraBody);
        assert.deepEqual(req.extraBody!.thinking, { type: 'enabled' });
    });
});

// ─── Bedrock ───────────────────────────────────────────────────────

import { prepareBedrockRequest } from '../providers/bedrock';

describe('providers/bedrock', () => {
    it('injects anthropic_version into extraBody', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'anthropic.claude-sonnet-4-20250514-v1:0',
            messages: [],
        };
        prepareBedrockRequest(req);
        assert.ok(req.extraBody);
        assert.equal(req.extraBody!.anthropic_version, 'bedrock-2023-05-31');
    });
});

// ─── Z.ai ──────────────────────────────────────────────────────────

import { prepareZAiRequest } from '../providers/zai';

describe('providers/zai', () => {
    it('enables thinking for GLM-4.7 models', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'glm-4.7-zai',
            messages: [],
        };
        prepareZAiRequest(req);
        assert.ok(req.extraBody);
        assert.deepEqual(req.extraBody!.thinking, { type: 'enabled' });
    });

    it('enables thinking for GLM-5 models', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'glm-5-zai',
            messages: [],
        };
        prepareZAiRequest(req);
        assert.ok(req.extraBody);
        assert.deepEqual(req.extraBody!.thinking, { type: 'enabled' });
    });

    it('does not enable thinking for non-GLM models', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'some-other-model',
            messages: [],
        };
        prepareZAiRequest(req);
        assert.equal(req.extraBody?.thinking, undefined);
    });

    it('preserves existing extraBody fields when enabling thinking', () => {
        const req: ChatCompletionRequest = {
            conversationId: 'test',
            model: 'glm-5-zai',
            messages: [],
            extraBody: { custom_param: 'value' },
        };
        prepareZAiRequest(req);
        assert.deepEqual(req.extraBody!.thinking, { type: 'enabled' });
        assert.equal(req.extraBody!.custom_param, 'value');
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
                { id: 'bedrock-claude', name: 'Claude via Bedrock', contextLength: 200000, maxOutputTokens: 65536, imageInput: true, toolCalling: true, thinking: false },
                { id: 'bedrock-gpt', name: 'GPT via Bedrock', contextLength: 128000, maxOutputTokens: 16384, imageInput: false, toolCalling: true, thinking: false },
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
                models: [{ id: 'deepseek-v4-pro', name: 'Shadow DS', contextLength: 100000, maxOutputTokens: 32768, imageInput: false, toolCalling: true, thinking: false }],
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
                'local/bedrock': { strategy: 'failover', models: ['bedrock-claude', 'bedrock-gpt'] },
            });

            const resolved = r.resolveProvider('local/bedrock');
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

// ─── Anthropic ──────────────────────────────────────────────────────

import { prepareAnthropicRequest, transformAnthropicResponse } from '../providers/anthropic';

describe('providers/anthropic', () => {
    describe('prepareAnthropicRequest', () => {
        it('extracts system message into _anthropicSystem', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [
                    { role: MessageRole.System, content: 'You are a helpful assistant.' },
                    { role: MessageRole.User, content: 'Hello' },
                ],
            };
            prepareAnthropicRequest(req);
            assert.ok((req as any)._anthropicReq);
            assert.equal((req as any)._anthropicSystem, 'You are a helpful assistant.');
            const aReq = (req as any)._anthropicReq;
            assert.equal(aReq.system, 'You are a helpful assistant.');
        });

        it('joins multiple system messages with newlines', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [
                    { role: MessageRole.System, content: 'Be helpful.' },
                    { role: MessageRole.System, content: 'Be concise.' },
                    { role: MessageRole.User, content: 'Hello' },
                ],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.equal(aReq.system, 'Be helpful.\n\nBe concise.');
        });

        it('converts user text message to string content', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [
                    { role: MessageRole.User, content: 'Hello' },
                ],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.equal(aReq.messages.length, 1);
            assert.equal(aReq.messages[0].role, 'user');
            assert.equal(aReq.messages[0].content, 'Hello');
        });

        it('converts assistant message to assistant role', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [
                    { role: MessageRole.Assistant, content: 'Hi there!' },
                ],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.equal(aReq.messages[0].role, 'assistant');
            assert.equal(aReq.messages[0].content, 'Hi there!');
        });

        it('converts assistant message with tool calls to content blocks', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [
                    {
                        role: MessageRole.Assistant,
                        content: 'Let me check the weather.',
                        toolCalls: [
                            {
                                id: 'call_123',
                                type: 'function',
                                function: {
                                    name: 'get_weather',
                                    arguments: '{"location": "Seoul"}',
                                },
                            },
                        ],
                    } as ChatMessage,
                ],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            const blocks = aReq.messages[0].content as any[];
            assert.equal(blocks.length, 2);
            assert.equal(blocks[0].type, 'text');
            assert.equal(blocks[0].text, 'Let me check the weather.');
            assert.equal(blocks[1].type, 'tool_use');
            assert.equal(blocks[1].id, 'call_123');
            assert.equal(blocks[1].name, 'get_weather');
            assert.deepEqual(blocks[1].input, { location: 'Seoul' });
        });

        it('converts tool result message to tool_result block', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [
                    {
                        role: MessageRole.Tool,
                        toolCallId: 'call_123',
                        content: 'Sunny, 25°C',
                    } as ChatMessage,
                ],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            const blocks = aReq.messages[0].content as any[];
            assert.equal(blocks.length, 1);
            assert.equal(blocks[0].type, 'tool_result');
            assert.equal(blocks[0].tool_use_id, 'call_123');
            assert.equal(blocks[0].content, 'Sunny, 25°C');
        });

        it('converts multimodal content with image parts', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [
                    {
                        role: MessageRole.User,
                        content: [
                            { type: 'text', text: 'Describe this image:' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
                        ],
                    } as ChatMessage,
                ],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            const blocks = aReq.messages[0].content as any[];
            assert.equal(blocks.length, 2);
            assert.equal(blocks[0].type, 'text');
            assert.equal(blocks[0].text, 'Describe this image:');
            assert.equal(blocks[1].type, 'image');
            assert.equal(blocks[1].source.type, 'base64');
            assert.equal(blocks[1].source.media_type, 'image/png');
            assert.equal(blocks[1].source.data, 'iVBORw0KGgo=');
        });

        it('converts OpenAI tools to Anthropic tool format', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: MessageRole.User, content: 'Hello' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'get_weather',
                            description: 'Get weather for a city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    location: { type: 'string', description: 'City name' },
                                },
                                required: ['location'],
                            },
                        },
                    },
                ],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.ok(aReq.tools);
            assert.equal(aReq.tools.length, 1);
            assert.equal(aReq.tools[0].name, 'get_weather');
            assert.equal(aReq.tools[0].description, 'Get weather for a city');
            assert.deepEqual(aReq.tools[0].input_schema.properties.location, { type: 'string', description: 'City name' });
        });

        it('defaults max_tokens to 4096 when not specified', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: MessageRole.User, content: 'Hello' }],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.equal(aReq.max_tokens, 4096);
        });

        it('uses specified maxTokens when provided', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: MessageRole.User, content: 'Hello' }],
                maxTokens: 8192,
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.equal(aReq.max_tokens, 8192);
        });

        it('applies tool_choice auto', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: MessageRole.User, content: 'Hello' }],
                toolChoice: 'auto',
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.deepEqual(aReq.tool_choice, { type: 'auto' });
        });

        it('applies tool_choice with specific function name', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: MessageRole.User, content: 'Hello' }],
                toolChoice: { type: 'function', function: { name: 'get_weather' } } as any,
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.deepEqual(aReq.tool_choice, { type: 'tool', name: 'get_weather' });
        });

        it('sets stream to true by default', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: MessageRole.User, content: 'Hello' }],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.equal(aReq.stream, true);
        });

        it('no system when no system messages present', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: MessageRole.User, content: 'Hello' }],
            };
            prepareAnthropicRequest(req);
            const aReq = (req as any)._anthropicReq;
            assert.equal(aReq.system, undefined);
        });
    });

    describe('transformAnthropicResponse', () => {
        it('converts text content block to message content', () => {
            const anthropicResp = {
                id: 'msg_001',
                model: 'claude-sonnet-4-20250514',
                role: 'assistant' as const,
                content: [{ type: 'text', text: 'Hello! How can I help?' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
            };
            const result = transformAnthropicResponse(anthropicResp, 'claude-sonnet-4-20250514');
            assert.equal(result.id, 'msg_001');
            assert.equal(result.object, 'chat.completion');
            assert.equal(result.model, 'claude-sonnet-4-20250514');
            assert.equal(result.choices[0].message!.content, 'Hello! How can I help?');
            assert.equal(result.choices[0].finishReason, 'stop');
            assert.equal(result.usage!.promptTokens, 10);
            assert.equal(result.usage!.completionTokens, 5);
            assert.equal(result.usage!.totalTokens, 15);
        });

        it('concatenates multiple text blocks', () => {
            const anthropicResp = {
                id: 'msg_002',
                model: 'claude-sonnet-4-20250514',
                role: 'assistant' as const,
                content: [
                    { type: 'text', text: 'Part 1. ' },
                    { type: 'text', text: 'Part 2.' },
                ],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 10 },
            };
            const result = transformAnthropicResponse(anthropicResp, 'claude-sonnet-4-20250514');
            assert.equal(result.choices[0].message!.content, 'Part 1. Part 2.');
        });

        it('converts tool_use blocks to tool_calls', () => {
            const anthropicResp = {
                id: 'msg_003',
                model: 'claude-sonnet-4-20250514',
                role: 'assistant' as const,
                content: [
                    { type: 'tool_use', id: 'toolu_001', name: 'get_weather', input: { location: 'Seoul' } },
                ],
                stop_reason: 'tool_use',
                stop_sequence: null,
                usage: { input_tokens: 20, output_tokens: 15 },
            };
            const result = transformAnthropicResponse(anthropicResp, 'claude-sonnet-4-20250514');
            assert.equal(result.choices[0].message!.content, '');
            assert.ok(result.choices[0].message!.toolCalls);
            assert.equal(result.choices[0].message!.toolCalls!.length, 1);
            assert.equal(result.choices[0].message!.toolCalls![0].id, 'toolu_001');
            assert.equal(result.choices[0].message!.toolCalls![0].function.name, 'get_weather');
            assert.equal(result.choices[0].message!.toolCalls![0].function.arguments, '{"location":"Seoul"}');
        });

        it('maps end_turn → stop', () => {
            const anthropicResp = {
                id: 'msg_004', model: 'claude-sonnet-4-20250514', role: 'assistant' as const,
                content: [{ type: 'text', text: 'Done' }],
                stop_reason: 'end_turn', stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            };
            const result = transformAnthropicResponse(anthropicResp, 'test');
            assert.equal(result.choices[0].finishReason, 'stop');
        });

        it('maps max_tokens → length', () => {
            const anthropicResp = {
                id: 'msg_005', model: 'claude-sonnet-4-20250514', role: 'assistant' as const,
                content: [{ type: 'text', text: 'Truncated' }],
                stop_reason: 'max_tokens', stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            };
            const result = transformAnthropicResponse(anthropicResp, 'test');
            assert.equal(result.choices[0].finishReason, 'length');
        });

        it('maps stop_sequence → stop', () => {
            const anthropicResp = {
                id: 'msg_006', model: 'claude-sonnet-4-20250514', role: 'assistant' as const,
                content: [{ type: 'text', text: 'Stopped' }],
                stop_reason: 'stop_sequence', stop_sequence: '\n\nHuman:',
                usage: { input_tokens: 1, output_tokens: 1 },
            };
            const result = transformAnthropicResponse(anthropicResp, 'test');
            assert.equal(result.choices[0].finishReason, 'stop');
        });

        it('maps tool_use → tool_calls', () => {
            const anthropicResp = {
                id: 'msg_007', model: 'claude-sonnet-4-20250514', role: 'assistant' as const,
                content: [{ type: 'tool_use', id: 't1', name: 'fn', input: {} }],
                stop_reason: 'tool_use', stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            };
            const result = transformAnthropicResponse(anthropicResp, 'test');
            assert.equal(result.choices[0].finishReason, 'tool_calls');
        });

        it('defaults null stop_reason to stop', () => {
            const anthropicResp = {
                id: 'msg_008', model: 'claude-sonnet-4-20250514', role: 'assistant' as const,
                content: [{ type: 'text', text: 'OK' }],
                stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            };
            const result = transformAnthropicResponse(anthropicResp, 'test');
            assert.equal(result.choices[0].finishReason, 'stop');
        });

        it('forwards cache tokens in usage', () => {
            const anthropicResp = {
                id: 'msg_009', model: 'claude-sonnet-4-20250514', role: 'assistant' as const,
                content: [{ type: 'text', text: 'Cached response' }],
                stop_reason: 'end_turn', stop_sequence: null,
                usage: {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_input_tokens: 80,
                    cache_creation_input_tokens: 20,
                },
            };
            const result = transformAnthropicResponse(anthropicResp, 'test');
            assert.equal(result.usage!.cachedTokens, 80);
            assert.equal(result.usage!.cacheCreationTokens, 20);
        });
    });
});

// ─── Vertex ──────────────────────────────────────────────────────────

import { prepareVertexRequest } from '../providers/vertex';

describe('providers/vertex', () => {
    describe('prepareVertexRequest', () => {
        it('is a no-op (delegates to prepareGeminiRequest at runtime)', () => {
            const req: ChatCompletionRequest = {
                conversationId: 'test',
                model: 'gemini-3.1-pro-preview',
                messages: [{ role: MessageRole.User, content: 'hello' }],
                extraBody: { vertexProjectId: 'my-project', vertexRegion: 'us-east1' },
            };
            prepareVertexRequest(req);
            // prepareVertexRequest is a no-op stub — the customSend path
            // in provider-client handles Vertex-specific routing
            assert.equal(req.model, 'gemini-3.1-pro-preview');
            assert.equal((req.extraBody as any).vertexProjectId, 'my-project');
        });
    });
});

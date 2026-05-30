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

/**
 * Unit tests for the model registry.
 *
 * Verifies model lookup, provider resolution, pricing data integrity,
 * and the get-models-by-provider helper.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    ALL_MODELS,
    getModelById,
    getModelsByProvider,
    getProviderForModel,
    isValidModel,
} from '../model-registry';
import { ProviderType } from '../types';

describe('model-registry', () => {
    describe('ALL_MODELS', () => {
        it('contains at least 45 models', () => {
            assert.ok(ALL_MODELS.length >= 45, `expected >= 45, got ${ALL_MODELS.length}`);
        });

        it('every model has a non-empty id', () => {
            for (const m of ALL_MODELS) {
                assert.ok(m.id.length > 0, `model at index ${ALL_MODELS.indexOf(m)} has empty id`);
            }
        });

        it('every model has a valid provider', () => {
            const validProviders = Object.values(ProviderType);
            for (const m of ALL_MODELS) {
                assert.ok(
                    validProviders.includes(m.provider),
                    `${m.id}: provider '${m.provider}' not in ${validProviders.join(', ')}`
                );
            }
        });

        it('every model has positive contextLength', () => {
            for (const m of ALL_MODELS) {
                assert.ok(m.contextLength > 0, `${m.id}: contextLength is ${m.contextLength}`);
            }
        });

        it('every model has positive maxOutputTokens', () => {
            for (const m of ALL_MODELS) {
                assert.ok(m.maxOutputTokens > 0, `${m.id}: maxOutputTokens is ${m.maxOutputTokens}`);
            }
        });

        it('all model ids are unique within each provider', () => {
            // Same model IDs may appear under different providers (e.g.
            // Vertex shares Google Gemini model IDs).  Duplicates are
            // allowed across providers but must be unique per provider.
            const seen = new Map<string, ProviderType>();
            for (const m of ALL_MODELS) {
                const key = `${m.provider}/${m.id}`;
                assert.ok(!seen.has(key), `duplicate model id within provider: ${m.provider}/${m.id}`);
                seen.set(key, m.provider);
            }
        });
    });

    describe('getModelById', () => {
        it('finds a model by exact id', () => {
            const m = getModelById('gpt-5.5');
            assert.ok(m);
            assert.equal(m.id, 'gpt-5.5');
            assert.equal(m.provider, ProviderType.OpenAI);
        });

        it('finds a model by provider/id format', () => {
            const m = getModelById('openai/gpt-5.5');
            assert.ok(m);
            assert.equal(m.id, 'gpt-5.5');
        });

        it('finds a model with lastIndexOf slash', () => {
            const m = getModelById('anthropic/claude-sonnet-4-6');
            assert.ok(m);
            assert.equal(m.id, 'claude-sonnet-4-6');
        });

        it('returns undefined for unknown model', () => {
            assert.equal(getModelById('nonexistent-model'), undefined);
        });

        it('returns undefined for empty string', () => {
            assert.equal(getModelById(''), undefined);
        });

        // Spot-check one model from each provider (built-in + new)
        const spotChecks: Array<[string, ProviderType]> = [
            ['gpt-5.4-mini', ProviderType.OpenAI],
            ['claude-haiku-4-5', ProviderType.Anthropic],
            ['gemini-3-flash-preview', ProviderType.Google],
            ['deepseek-v4-flash', ProviderType.DeepSeek],
            ['MiniMax-M2.5', ProviderType.MiniMax],
            ['kimi-k2.5', ProviderType.Moonshot],
            ['mimo-v2-flash', ProviderType.Xiaomi],
            ['glm-4.5', ProviderType.Zhipu],
        ];
        const newProviderChecks: Array<[string, ProviderType]> = [
            ['mistral-large-latest', ProviderType.Mistral],
            ['grok-4', ProviderType.XAI],
            ['anthropic.claude-sonnet-4-20250514-v1:0', ProviderType.Bedrock],
            ['claude-opus-4-20250514', ProviderType.AnthropicVertex],
            ['claude-opus-4-8', ProviderType.Anthropic],
            ['llama4-maverick', ProviderType.Ollama],
            ['lmstudio-default', ProviderType.LmStudio],
            ['accounts/fireworks/models/llama-v3p3-70b-instruct', ProviderType.Fireworks],
            ['Meta-Llama-3.3-70B-Instruct', ProviderType.SambaNova],
            ['deepseek-r1', ProviderType.Baseten],
            ['requesty-default', ProviderType.Requesty],
            ['unbound-default', ProviderType.Unbound],
            ['vercel-ai-gateway-default', ProviderType.VercelAiGateway],
            ['glm-4.7-zai', ProviderType.ZAi],
        ];
        for (const [id, expectedProvider] of newProviderChecks) {
            it(`finds ${id} → ${expectedProvider}`, () => {
                const m = getModelById(id);
                assert.ok(m, `${id} not found`);
                assert.equal(m.provider, expectedProvider);
            });
        }

        for (const [id, expectedProvider] of spotChecks) {
            it(`finds ${id} → ${expectedProvider}`, () => {
                const m = getModelById(id);
                assert.ok(m, `${id} not found`);
                assert.equal(m.provider, expectedProvider);
            });
        }
    });

    describe('getModelsByProvider', () => {
        it('returns OpenAI models', () => {
            const models = getModelsByProvider(ProviderType.OpenAI);
            assert.ok(models.length >= 5);
            for (const m of models) {
                assert.equal(m.provider, ProviderType.OpenAI);
            }
        });

        it('returns Anthropic models', () => {
            const models = getModelsByProvider(ProviderType.Anthropic);
            assert.equal(models.length, 3);
        });

        it('returns DeepSeek models', () => {
            const models = getModelsByProvider(ProviderType.DeepSeek);
            assert.equal(models.length, 2);
        });

        it('returns Xiaomi models', () => {
            const models = getModelsByProvider(ProviderType.Xiaomi);
            assert.equal(models.length, 4);
        });

        it('returns Zhipu models', () => {
            const models = getModelsByProvider(ProviderType.Zhipu);
            assert.equal(models.length, 7);
        });

        it('returns Mistral models', () => {
            const models = getModelsByProvider(ProviderType.Mistral);
            assert.equal(models.length, 3);
        });

        it('returns Bedrock models', () => {
            const models = getModelsByProvider(ProviderType.Bedrock);
            assert.equal(models.length, 2);
        });

        it('returns Ollama models', () => {
            const models = getModelsByProvider(ProviderType.Ollama);
            assert.equal(models.length, 2);
        });

        it('returns empty array for unknown provider', () => {
            assert.equal(getModelsByProvider('nonexistent' as ProviderType).length, 0);
        });
    });

    describe('getProviderForModel', () => {
        it('resolves deepseek-v4-pro → DeepSeek', () => {
            assert.equal(getProviderForModel('deepseek-v4-pro'), ProviderType.DeepSeek);
        });

        it('resolves claude-opus-4-8 → Anthropic', () => {
            assert.equal(getProviderForModel('claude-opus-4-8'), ProviderType.Anthropic);
        });

        it('resolves mimo-v2-pro → Xiaomi', () => {
            assert.equal(getProviderForModel('mimo-v2-pro'), ProviderType.Xiaomi);
        });

        it('returns undefined for unknown model', () => {
            assert.equal(getProviderForModel('unknown/model'), undefined);
        });
    });

    describe('isValidModel', () => {
        it('returns true for known model', () => {
            assert.equal(isValidModel('gpt-5.5'), true);
        });

        it('returns false for unknown model', () => {
            assert.equal(isValidModel('fake-model'), false);
        });
    });
});

/**
 * Unit tests for the LLM client — cost computation and pricing conversion.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeCost, toPerMillionPricing, getProviderModelInfoList } from '../llm-client';
import { getModelById } from '../model-registry';

describe('llm-client', () => {
    describe('computeCost', () => {
        it('returns 0 for unknown model', () => {
            assert.equal(computeCost('nonexistent', 1000, 100, 0, 0), 0);
        });

        it('computes cost for gpt-5.5 without caching', () => {
            // GPT-5.5: prompt=$5/1M, completion=$30/1M, discount=50%
            // 1000 prompt + 100 completion = (1000/1M * 5 + 100/1M * 30) * 0.5
            // = (0.005 + 0.003) * 0.5 = 0.004
            const cost = computeCost('gpt-5.5', 1000, 100);
            assert.ok(cost > 0, `cost should be > 0, got ${cost}`);
            const expected = (1 * 0.005 + 0.1 * 0.030) * 0.5;
            assert.ok(Math.abs(cost - expected) < 0.0001, `expected ~${expected}, got ${cost}`);
        });

        it('computes cost for deepseek-v4-pro with caching', () => {
            // DeepSeek V4 Pro (75% promo): prompt=$0.435/1M, completion=$0.87/1M,
            // cache read=$0.003625/1M, no discount
            // 10000 prompt (8000 cached, 2000 uncached) + 500 completion
            // = (2000/1M * 0.435 + 8000/1M * 0.003625 + 500/1M * 0.87)
            // = (0.00087 + 0.000029 + 0.000435) = 0.001334
            const cost = computeCost('deepseek-v4-pro', 10000, 500, 8000, 0);
            const expected = (2 * 0.000435) + (8 * 0.000003625) + (0.5 * 0.00087);
            assert.ok(Math.abs(cost - expected) < 0.0001, `expected ~${expected}, got ${cost}`);
        });

        it('computes cost for claude-sonnet-4-6 with cache write', () => {
            // Claude Sonnet 4.6: prompt=$3/1M, completion=$15/1M,
            // cache read=$0.30/1M, cache write=$3.75/1M, discount=50%
            // 5000 prompt (2000 cached read, 1000 cache creation, 3000 uncached) + 200 completion
            // uncached = 5000 - 2000 = 3000
            // = (3000/1M*3 + 2000/1M*0.3 + 1000/1M*3.75 + 200/1M*15) * 0.5
            const cost = computeCost('claude-sonnet-4-6', 5000, 200, 2000, 1000);
            assert.ok(cost > 0);
            const expected = (3 * 0.003 + 2 * 0.0003 + 1 * 0.00375 + 0.2 * 0.015) * 0.5;
            assert.ok(Math.abs(cost - expected) < 0.0001, `expected ~${expected}, got ${cost}`);
        });

        it('handles zero tokens gracefully', () => {
            const cost = computeCost('gpt-5.5', 0, 0);
            assert.equal(cost, 0);
        });

        it('handles negative tokens gracefully', () => {
            // Should clamp to 0
            const cost = computeCost('gpt-5.5', -100, -100);
            assert.equal(cost, 0);
        });

        it('mimo-v2-tts has no pricing — returns 0', () => {
            const cost = computeCost('mimo-v2-tts', 1000, 100);
            assert.equal(cost, 0);
        });
    });

    describe('toPerMillionPricing', () => {
        it('shapes gpt-5.5 pricing into the per-1M LM API form', () => {
            const pricing = toPerMillionPricing('gpt-5.5');
            assert.ok(pricing);
            assert.equal(pricing.inputPrice, 5.0);
            assert.equal(pricing.outputPrice, 30.0);
            assert.equal(pricing.cacheReadsPrice, 0.5);
        });

        it('passes deepseek-v4-flash pricing through unchanged', () => {
            const pricing = toPerMillionPricing('deepseek-v4-flash');
            assert.ok(pricing);
            // Exact, not approximate: a tolerance check here passed for a long time
            // while the real value was 0.13999999999999999 — see the artifact test below.
            assert.equal(pricing.inputPrice, 0.14);
            assert.equal(pricing.outputPrice, 0.28);
            assert.equal(pricing.cacheReadsPrice, 0.0028);
        });

        it('emits clean decimals, not binary-fraction artifacts', () => {
            // Regression guard: per-1M prices used to be derived by multiplying per-1K
            // values by 1000, which landed on binary fractions (0.00014 * 1000 ===
            // 0.13999999999999999) that rendered verbatim in the Status table. The
            // registry now stores clean per-1M literals; this keeps them clean.
            assert.equal(toPerMillionPricing('deepseek-v4-flash')?.outputPrice, 0.28);
            assert.equal(toPerMillionPricing('kimi-k2.6')?.outputPrice, 3.41);
            assert.equal(toPerMillionPricing('MiniMax-M2.7')?.cacheReadsPrice, 0.06);
            assert.equal(toPerMillionPricing('mimo-v2-omni')?.inputPrice, 0.14);

            // Nothing anywhere in the registry should stringify to a float artifact.
            const { ALL_MODELS } = require('../model-registry');
            for (const m of ALL_MODELS as Array<{ id: string }>) {
                const p = toPerMillionPricing(m.id);
                if (!p) continue;
                for (const [field, value] of Object.entries(p)) {
                    if (typeof value !== 'number') continue;
                    assert.ok(
                        String(value).length <= 10,
                        `${m.id}.${field} looks like a float artifact: ${value}`,
                    );
                }
            }
        });

        it('returns undefined for unknown model', () => {
            assert.equal(toPerMillionPricing('nonexistent'), undefined);
        });
    });

    describe('getProviderModelInfoList', () => {
        it('returns the same count as ALL_MODELS', () => {
            const { ALL_MODELS: all } = require('../model-registry');
            const info = getProviderModelInfoList();
            assert.equal(info.length, all.length);
        });

        it('each entry has family with no slashes', () => {
            for (const m of getProviderModelInfoList()) {
                assert.ok(!m.family.includes('/'), `${m.id}: family '${m.family}' contains slash`);
            }
        });

        it('each entry has valid token counts', () => {
            for (const m of getProviderModelInfoList()) {
                assert.ok(m.maxInputTokens > 0, `${m.id}: maxInputTokens is ${m.maxInputTokens}`);
                assert.ok(m.maxOutputTokens > 0, `${m.id}: maxOutputTokens is ${m.maxOutputTokens}`);
            }
        });
    });
});

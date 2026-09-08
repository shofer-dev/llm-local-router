import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { sanitizeGeminiSchema } from '../providers/google';

describe('providers/google', () => {
    describe('sanitizeGeminiSchema', () => {
        it('removes unsupported Gemini metadata fields from schema', () => {
            const schema = {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The query to search for',
                        $comment: 'This should be removed',
                        enumDescriptions: ['A query string'],
                        examples: ['hello world']
                    }
                },
                additionalProperties: false,
                $comment: 'Root comment to remove'
            };

            const sanitized = sanitizeGeminiSchema(schema);

            assert.deepEqual(sanitized, {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The query to search for'
                    }
                }
            });
        });

        it('handles primitive values correctly', () => {
            assert.equal(sanitizeGeminiSchema(null as any), null);
            assert.equal(sanitizeGeminiSchema(undefined as any), undefined);
            assert.equal(sanitizeGeminiSchema('string' as any), 'string');
            assert.equal(sanitizeGeminiSchema(123 as any), 123);
        });

        it('handles nested arrays correctly', () => {
            const schema = {
                type: 'array',
                items: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        $comment: 'Nested array comment'
                    }
                ]
            };

            const sanitized = sanitizeGeminiSchema(schema);

            assert.deepEqual(sanitized, {
                type: 'array',
                items: [
                    {
                        type: 'object'
                    }
                ]
            });
        });
    });
});

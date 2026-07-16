/**
 * SecretStorage wrapper for API keys.
 *
 * Uses VSCode's SecretStorage API to securely persist provider API keys.
 * Keys are stored under namespaced keys: `llm-local-router.provider.{name}`.
 *
 * Custom provider API keys are stored under `llm-local-router.provider.custom.{id}`.
 * Custom provider metadata (label, protocol, endpoint, models, pricing) is stored
 * in settings.json (llmLocalRouter.customProviders) — NOT here.
 */

import * as vscode from 'vscode';
import { ProviderApiKeys, ProviderType } from './types';
import { getLogger } from './logger';

const SECRET_KEY_PREFIX = 'llm-local-router.provider.';

function secretKey(provider: string): string {
    return `${SECRET_KEY_PREFIX}${provider}`;
}

/**
 * Retrieve all stored API keys from SecretStorage.
 */
export async function loadApiKeys(context: vscode.ExtensionContext): Promise<ProviderApiKeys> {
    const logger = getLogger();
    const keys: ProviderApiKeys = {};

    const providers = Object.values(ProviderType);
    for (const provider of providers) {
        try {
            const value = await context.secrets.get(secretKey(provider));
            if (value) {
                (keys as Record<string, string>)[provider] = value;
                logger.debug(`Loaded API key for provider: ${provider}`);
            }
        } catch (err) {
            logger.errorWithError(`Failed to load API key for ${provider}`, err as Error);
        }
    }

    return keys;
}

/**
 * Store an API key for a provider in SecretStorage.
 */
export async function storeApiKey(
    context: vscode.ExtensionContext,
    provider: string,
    key: string
): Promise<void> {
    const logger = getLogger();
    try {
        await context.secrets.store(secretKey(provider), key);
        logger.info(`Stored API key for provider: ${provider}`);
    } catch (err) {
        logger.errorWithError(`Failed to store API key for ${provider}`, err as Error);
        throw err;
    }
}

/**
 * Delete an API key for a provider from SecretStorage.
 */
export async function deleteApiKey(
    context: vscode.ExtensionContext,
    provider: string
): Promise<void> {
    const logger = getLogger();
    try {
        await context.secrets.delete(secretKey(provider));
        logger.info(`Deleted API key for provider: ${provider}`);
    } catch (err) {
        logger.errorWithError(`Failed to delete API key for ${provider}`, err as Error);
        throw err;
    }
}

/**
 * Load all custom endpoint URLs from SecretStorage.
 * Stored under keys: llm-local-router.provider.{name}.endpoint
 */
export async function loadEndpointUrls(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    const logger = getLogger();
    const urls: Record<string, string> = {};
    const providers = Object.values(ProviderType);

    for (const provider of providers) {
        try {
            const epKey = `llm-local-router.provider.${provider}.endpoint`;
            const value = await context.secrets.get(epKey);
            if (value) {
                urls[provider] = value;
                logger.debug(`Loaded custom endpoint for ${provider}`);
            }
        } catch (err) {
            logger.errorWithError(`Failed to load endpoint URL for ${provider}`, err as Error);
        }
    }

    return urls;
}

// ─── Custom provider API keys (metadata is in settings.json) ────────

/**
 * Store an API key for a custom provider in SecretStorage.
 * Keys are stored under `llm-local-router.provider.custom.{id}`.
 */
export async function storeCustomProviderApiKey(
    context: vscode.ExtensionContext,
    providerId: string,
    key: string
): Promise<void> {
    await context.secrets.store(secretKey(`custom.${providerId}`), key);
}

/**
 * Delete an API key for a custom provider.
 */
export async function deleteCustomProviderApiKey(
    context: vscode.ExtensionContext,
    providerId: string
): Promise<void> {
    await context.secrets.delete(secretKey(`custom.${providerId}`));
}

/**
 * Load API keys for all custom providers.
 *
 * Scans SecretStorage for keys matching `llm-local-router.provider.custom.*`
 * and returns a map of provider ID → API key.
 *
 * NOTE: This does NOT read the custom provider metadata from settings.json —
 * it only returns keys that are already present in SecretStorage.
 */
export async function loadCustomProviderApiKeys(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    const logger = getLogger();
    const keys: Record<string, string> = {};

    // We iterate the built-in providers plus look for custom.* keys.
    // Since SecretStorage doesn't support listing keys, we load the custom
    // provider IDs from settings.json and check each one.
    try {
        const raw = vscode.workspace.getConfiguration('llmLocalRouter').get<string>('customProviders');
        if (raw && raw.trim()) {
            const providers = JSON.parse(raw) as Record<string, unknown>;
            for (const providerId of Object.keys(providers)) {
                try {
                    const value = await context.secrets.get(secretKey(`custom.${providerId}`));
                    if (value) {
                        keys[providerId] = value;
                        logger.debug(`Loaded API key for custom provider: ${providerId}`);
                    }
                } catch (err) {
                    logger.errorWithError(`Failed to load API key for custom provider ${providerId}`, err as Error);
                }
            }
        }
    } catch (err) {
        logger.errorWithError('Failed to parse customProviders from settings', err as Error);
    }

    return keys;
}

/**
 * Load all per-model pricing overrides from SecretStorage across all providers.
 *
 * Reads `llm-local-router.provider.{providerId}.modelPricing` for every built-in
 * provider and returns a flat map of modelId → { prompt?, completion?, cacheRead? }
 * where values are in USD per 1M tokens (the form stored by the Config panel).
 * Converted to per-1K-token form compatible with ModelPricing.
 */
export async function loadModelPricingOverrides(
    context: vscode.ExtensionContext,
): Promise<Record<string, { prompt?: number; completion?: number; contextCacheRead?: number; contextCacheWrite?: number }>> {
    const logger = getLogger();
    const result: Record<string, { prompt?: number; completion?: number; contextCacheRead?: number; contextCacheWrite?: number }> = {};
    const providers = Object.values(ProviderType);

    for (const provider of providers) {
        try {
            const raw = await context.secrets.get(`${SECRET_KEY_PREFIX}${provider}.modelPricing`);
            if (!raw) continue;
            const parsed = JSON.parse(raw) as Record<string, { prompt?: number; completion?: number; cacheRead?: number; cacheWrite?: number }>;
            for (const [modelId, override] of Object.entries(parsed)) {
                if (!override || !(override.prompt || override.completion || override.cacheRead)) continue;
                // Convert from per-1M (stored) to per-1K (ModelPricing) form
                const pricing: { prompt?: number; completion?: number; contextCacheRead?: number; contextCacheWrite?: number } = {};
                if (override.prompt !== undefined && override.prompt > 0) pricing.prompt = override.prompt / 1000;
                if (override.completion !== undefined && override.completion > 0) pricing.completion = override.completion / 1000;
                if (override.cacheRead !== undefined && override.cacheRead > 0) pricing.contextCacheRead = override.cacheRead / 1000;
                if (override.cacheWrite !== undefined && override.cacheWrite > 0) pricing.contextCacheWrite = override.cacheWrite / 1000;
                if (Object.keys(pricing).length > 0) {
                    result[modelId] = pricing;
                }
            }
        } catch (err) {
            logger.errorWithError(`Failed to load model pricing overrides for ${provider}`, err as Error);
        }
    }

    return result;
}

/**
 * Register a listener for SecretStorage changes.
 * Returns a disposable that should be added to context.subscriptions.
 */
export function onApiKeysChanged(
    context: vscode.ExtensionContext,
    callback: () => void
): vscode.Disposable {
    return context.secrets.onDidChange((e) => {
        if (e.key.startsWith(SECRET_KEY_PREFIX)) {
            callback();
        }
    });
}

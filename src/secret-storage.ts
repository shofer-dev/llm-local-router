/**
 * SecretStorage wrapper for API keys.
 *
 * Uses VSCode's SecretStorage API to securely persist provider API keys.
 * Keys are stored under namespaced keys: `shofer-router.provider.{name}`.
 * Mirrors the pattern recommended in VSCode extension docs.
 */

import * as vscode from 'vscode';
import { ProviderApiKeys, ProviderType } from './types';
import { getLogger } from './logger';

const SECRET_KEY_PREFIX = 'shofer-router.provider.';

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

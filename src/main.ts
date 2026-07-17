/**
 * LLM Local Router — Extension Entry Point
 *
 * A VS Code extension that provides direct access to multiple LLM providers
 * provider's API from within the VS Code extension host.
 *
 * API keys are stored securely using VS Code's SecretStorage API.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanguageModelProvider, RouterConfig } from './language-model-provider';
import { RouterConfigProvider } from './router-config-provider';
import { initLogger, getLogger, setDebugMode } from './logger';
import { loadApiKeys, loadEndpointUrls, loadCustomProviderApiKeys, loadModelPricingOverrides, onApiKeysChanged, storeApiKey } from './secret-storage';
import { setModelPricingOverrides } from './llm-client';
import {
    CustomProviderConfig,
    ProviderType,
    RouterImportConfig,
    RouterImportResult,
    RouterExportResult,
} from './types';
import { getProviderForModel } from './model-registry';
import { initMetricsCollector, getMetricsCollector, shutdownMetricsCollector } from './metrics-collector';
import { MetricsStorage } from './metrics-storage';
import { startMetricsServer, stopMetricsServer } from './metrics-server';
import { ProviderHealthChecker, ProviderHealthState } from './health-checker';

// ─── Extension state ──────────────────────────────────────────────

let languageModelProvider: LanguageModelProvider | undefined;
let routerConfigProvider: RouterConfigProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let healthCheckInterval: NodeJS.Timeout | undefined;
let connectionRetryTimeout: NodeJS.Timeout | undefined;
let healthChecker: ProviderHealthChecker | undefined;
let isConnected: boolean = false;
let isConnecting: boolean = false;
let providerHealth: Map<string, boolean> = new Map();
let config: RouterConfig = {
    enabled: true,
    compositeModelsFile: '',
    compositeModelsConfig: '',
    debug: false,
};

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const RETRY_INITIAL_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
const RETRY_BACKOFF_MULTIPLIER = 2;

// ─── Configuration ────────────────────────────────────────────────

function getConfiguration(): RouterConfig {
    const wsConfig = vscode.workspace.getConfiguration('llmLocalRouter');
    return {
        enabled: wsConfig.get('enabled', true),
        compositeModelsFile: wsConfig.get('compositeModelsFile', ''),
        compositeModelsConfig: wsConfig.get('compositeModelsConfig', ''),
        debug: wsConfig.get('debug', false),
    };
}

// ─── Status bar ───────────────────────────────────────────────────

async function handleStatusBarClick(): Promise<void> {
    if (!routerConfigProvider) {
        vscode.window.showErrorMessage('LLM Local Router: Provider not initialized');
        return;
    }
    await routerConfigProvider.show('status');
}

function updateStatusBar(): void {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
        statusBarItem.command = 'llmLocalRouter.statusBarClick';
        statusBarItem.name = 'LLM Local Router';
    }

    const providerCount = languageModelProvider?.getConfiguredProviderCount() ?? 0;
    const hasAnyApiKey = providerCount > 0;
    const healthyCount = [...providerHealth.values()].filter(h => h).length;
    const totalMonitored = providerHealth.size;
    let statusText: string;

    if (!config.enabled) {
        statusText = '$(circle-slash) LLM Local Router';
        statusBarItem.tooltip = 'LLM Local Router — disabled. Click to open settings.';
        statusBarItem.backgroundColor = undefined;
    } else if (!hasAnyApiKey) {
        statusText = '$(warning) LLM Local Router';
        statusBarItem.tooltip = 'LLM Local Router — no API keys configured. Click to set up providers.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (isConnecting) {
        statusText = '$(sync~spin) LLM Local Router';
        statusBarItem.tooltip = 'LLM Local Router — connecting...';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (totalMonitored > 0 && healthyCount === 0) {
        statusText = '$(error) LLM Local Router';
        statusBarItem.tooltip = 'LLM Local Router — all providers unreachable. Click for status.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        statusText = '$(rocket) LLM Local Router';
        if (totalMonitored > 0) {
            statusBarItem.tooltip = `LLM Local Router — ${healthyCount}/${totalMonitored} provider${totalMonitored !== 1 ? 's' : ''} healthy. Click for status.`;
        } else {
            statusBarItem.tooltip = `LLM Local Router — ${providerCount} provider${providerCount !== 1 ? 's' : ''} configured. Click for status.`;
        }
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.text = statusText;
    statusBarItem.show();

    // Keep an open Status webview in sync with this transition. No-op when the
    // panel is closed; otherwise re-pushes the live connection/model/configured
    // state so it never lags behind an async (re)connect triggered by an import
    // or a provider save. Fire-and-forget — the status bar must not await secrets.
    void routerConfigProvider?.refreshStatus();
}

// ─── Health check ─────────────────────────────────────────────────

async function performHealthCheck(): Promise<void> {
    const logger = getLogger();
    if (!languageModelProvider || !config.enabled || isConnecting) return;

    try {
        const wasConnected = isConnected;
        isConnected = languageModelProvider.isReady();

        if (wasConnected && !isConnected) {
            logger.warning('Lost connectivity');
            stopHealthCheck();
            connectWithRetry();
        }
        updateStatusBar();
    } catch (error) {
        const wasConnected = isConnected;
        isConnected = false;
        if (wasConnected) {
            logger.errorWithError('Health check failed', error as Error);
            stopHealthCheck();
            connectWithRetry();
        }
    }
}

function startHealthCheck(): void {
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    healthCheckInterval = setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck(): void {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = undefined;
    }
}

function stopConnectionRetry(): void {
    if (connectionRetryTimeout) {
        clearTimeout(connectionRetryTimeout);
        connectionRetryTimeout = undefined;
    }
    isConnecting = false;
}

async function connectWithRetry(): Promise<void> {
    const logger = getLogger();

    // Re-entry guard: if a retry chain is already running, don't start a
    // parallel one — it would overwrite connectionRetryTimeout and leak the
    // previous timer. Callers that intend to restart call stopConnectionRetry()
    // first (which clears isConnecting), so they are not blocked.
    if (isConnecting) return;

    if (!languageModelProvider || !config.enabled) {
        isConnecting = false;
        isConnected = false;
        updateStatusBar();
        return;
    }

    if (languageModelProvider.getConfiguredProviderCount() === 0) {
        isConnecting = false;
        isConnected = false;
        updateStatusBar();
        logger.info('No API keys configured — waiting for provider setup');
        return;
    }

    let currentDelay = RETRY_INITIAL_DELAY_MS;
    isConnecting = true;
    updateStatusBar();

    const attemptConnection = async (): Promise<void> => {
        if (!languageModelProvider || !config.enabled) {
            isConnecting = false;
            updateStatusBar();
            return;
        }

        try {
            logger.info('Connecting to LLM providers...');
            const success = await languageModelProvider.testConnection();

            if (!success) {
                throw new Error('No API keys configured or connection test failed');
            }

            const models = await languageModelProvider.fetchModels();
            if (models.length === 0) throw new Error('No models available');

            isConnected = true;
            isConnecting = false;
            updateStatusBar();
            logger.info(`Connected — ${models.length} models available`);
            startHealthCheck();
        } catch (error) {
            isConnected = false;
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.warning(`Connection failed: ${errorMsg}. Retrying in ${currentDelay / 1000}s`);
            connectionRetryTimeout = setTimeout(attemptConnection, currentDelay);
            currentDelay = Math.min(currentDelay * RETRY_BACKOFF_MULTIPLIER, RETRY_MAX_DELAY_MS);
        }
    };

    await attemptConnection();
}

// ─── Health checker (TCP keepalive) ────────────────────────────────

function connectHealthChecker(): void {
    if (!healthChecker || !languageModelProvider) return;

    const configuredProviders = new Set<string>();
    const models = languageModelProvider.getAvailableModels();
    for (const m of models) {
        if (m.id.startsWith('local/')) continue;
        configuredProviders.add(m.family || m.id.split('-')[0]);
    }

    // Disconnect providers that are no longer configured
    for (const [p] of providerHealth) {
        if (!configuredProviders.has(p)) {
            healthChecker.disconnect(p);
            providerHealth.delete(p);
        }
    }

    // Connect newly configured providers
    for (const p of configuredProviders) {
        if (!providerHealth.has(p)) {
            const url = getDefaultEndpoint(p);
            if (url) healthChecker.connect(p, url);
        }
    }
}

function getDefaultEndpoint(provider: string): string {
    const defaults: Record<string, string> = {
        openai: 'https://api.openai.com',
        anthropic: 'https://api.anthropic.com',
        google: 'https://generativelanguage.googleapis.com',
        deepseek: 'https://api.deepseek.com',
        minimax: 'https://api.minimax.io',
        moonshot: 'https://api.moonshot.cn',
        xiaomi: 'https://api.xiaomimimo.com',
        zhipu: 'https://api.z.ai',
        dashscope: 'https://dashscope-intl.aliyuncs.com',
        openrouter: 'https://openrouter.ai',
    };
    return defaults[provider] || '';
}

// ─── Config import/export ─────────────────────────────────────────

/**
 * Bring the router to a known state from a single config object (or a path to a
 * JSON file holding one). Keys/endpoints go to SecretStorage — that fires
 * onApiKeysChanged, so the provider reloads them automatically; we also refresh
 * models so newly-keyed providers surface immediately for the caller.
 */
async function importRouterConfig(
    context: vscode.ExtensionContext,
    input: RouterImportConfig | string,
): Promise<RouterImportResult> {
    const logger = getLogger();
    let cfg: RouterImportConfig;
    if (typeof input === 'string') {
        cfg = JSON.parse(fs.readFileSync(input, 'utf8')) as RouterImportConfig;
    } else {
        cfg = input ?? {};
    }

    const validProviders = new Set<string>(Object.values(ProviderType));
    const result: RouterImportResult = { importedKeys: [], importedEndpoints: [], appliedSettings: [], skipped: [] };

    for (const [provider, key] of Object.entries(cfg.apiKeys ?? {})) {
        if (!key) { continue; }
        if (!validProviders.has(provider)) { result.skipped.push(provider); continue; }
        await storeApiKey(context, provider, key);
        result.importedKeys.push(provider);
    }
    for (const [provider, url] of Object.entries(cfg.endpoints ?? {})) {
        if (!url) { continue; }
        if (!validProviders.has(provider)) { result.skipped.push(provider); continue; }
        // Same key shape loadEndpointUrls() reads; the prefix makes onApiKeysChanged fire.
        await context.secrets.store(`llm-local-router.provider.${provider}.endpoint`, url);
        result.importedEndpoints.push(provider);
    }
    if (cfg.settings) {
        const wsConfig = vscode.workspace.getConfiguration('llmLocalRouter');
        for (const [k, v] of Object.entries(cfg.settings)) {
            await wsConfig.update(k, v, vscode.ConfigurationTarget.Global);
            result.appliedSettings.push(k);
        }
    }
    // The secrets listener reloads keys asynchronously; force a model refresh so the
    // caller sees a consistent state on return.
    try { await languageModelProvider?.fetchModels(); } catch (err) { logger.warning(`importConfig fetchModels: ${err}`); }
    logger.info(`importConfig: keys=[${result.importedKeys}] endpoints=[${result.importedEndpoints}] ` +
        `settings=[${result.appliedSettings}] skipped=[${result.skipped}]`);
    return result;
}

/**
 * Ask for a config file and import it, surfacing the outcome. Returns `undefined`
 * when the user cancels the picker.
 *
 * This is the human-facing half of `llmLocalRouter.importConfig`: the command is
 * otherwise a silent programmatic API, so invoking it from the Command Palette (or
 * the Config panel) with no argument would import an empty config and appear to do
 * nothing.
 */
async function promptAndImportRouterConfig(
    context: vscode.ExtensionContext,
): Promise<RouterImportResult | undefined> {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        openLabel: 'Import',
        title: 'Import LLM Local Router config',
        filters: { 'JSON Files': ['json'] },
    });
    if (!uris || uris.length === 0) {
        return undefined;
    }
    try {
        const result = await importRouterConfig(context, uris[0].fsPath);
        const parts: string[] = [];
        if (result.importedKeys.length) { parts.push(`keys: ${result.importedKeys.join(', ')}`); }
        if (result.importedEndpoints.length) { parts.push(`endpoints: ${result.importedEndpoints.join(', ')}`); }
        if (result.appliedSettings.length) { parts.push(`settings: ${result.appliedSettings.join(', ')}`); }
        if (result.skipped.length) { parts.push(`skipped (unknown provider): ${result.skipped.join(', ')}`); }
        vscode.window.showInformationMessage(
            parts.length ? `Imported — ${parts.join('; ')}` : 'Nothing to import: the file set no keys, endpoints, or settings.',
        );
        return result;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Import failed: ${msg}`);
        return undefined;
    }
}

/** Return the router's current state WITHOUT secret values — which providers are
 * keyed, the non-secret `llmLocalRouter.*` settings, and live runtime state. Safe to
 * log/serialise. */
async function exportRouterConfig(context: vscode.ExtensionContext): Promise<RouterExportResult> {
    const keys = await loadApiKeys(context);
    const endpoints = await loadEndpointUrls(context);
    const wsConfig = vscode.workspace.getConfiguration('llmLocalRouter');
    const keyed = new Set(Object.keys(keys));
    const allModels = languageModelProvider?.getAvailableModels() ?? [];
    // Mirror provideLanguageModelChatInformation: only models whose owning provider is
    // keyed (or composite local/* models) are actually exposed to / selectable via
    // vscode.lm. Reporting only those keeps the caller from picking an unselectable model.
    const exposed = allModels
        .map((m) => ({ id: m.id, family: m.family, provider: getProviderForModel(m.id) as string | undefined }))
        .filter((m) => m.id.startsWith('local/') || (m.provider !== undefined && keyed.has(m.provider)));
    return {
        providersWithKeys: Object.keys(keys),
        providersWithEndpoints: Object.keys(endpoints),
        settings: {
            enabled: wsConfig.get('enabled'),
            debug: wsConfig.get('debug'),
            customProviders: wsConfig.get('customProviders'),
        },
        runtime: {
            enabled: languageModelProvider?.getConfig().enabled ?? false,
            ready: languageModelProvider?.isReady() ?? false,
            configuredProviderCount: languageModelProvider?.getConfiguredProviderCount() ?? 0,
            availableModels: exposed,
        },
    };
}

// ─── Commands ─────────────────────────────────────────────────────

async function handleConfigure(): Promise<void> {
    getLogger().info('Opening webview configuration panel');
    if (!routerConfigProvider) {
        vscode.window.showErrorMessage('LLM Local Router: Provider not initialized');
        return;
    }
    await routerConfigProvider.show('config');
}

async function handleConfigureWebview(): Promise<void> {
    await handleConfigure();
}

async function handleShowModels(): Promise<void> {
    getLogger().info('Opening webview status panel');
    if (!routerConfigProvider) {
        vscode.window.showErrorMessage('LLM Local Router: Provider not initialized');
        return;
    }
    await routerConfigProvider.show('status');
}

async function handleRefreshModels(): Promise<void> {
    const logger = getLogger();
    if (!languageModelProvider) {
        vscode.window.showErrorMessage('LLM Local Router: Provider not initialized');
        return;
    }

    vscode.window.showInformationMessage('Refreshing models...');
    try {
        config = getConfiguration();
        languageModelProvider.updateConfig(config);
        const models = await languageModelProvider.fetchModels();
        updateStatusBar();
        vscode.window.showInformationMessage(`LLM Local Router: ${models.length} models available`);
        logger.info(`Refreshed ${models.length} models`);
    } catch (error) {
        const message = `Failed to refresh models: ${error}`;
        vscode.window.showErrorMessage(message);
        logger.error(message);
    }
}

async function handleTestConnection(): Promise<void> {
    const logger = getLogger();
    if (!languageModelProvider) {
        vscode.window.showErrorMessage('LLM Local Router: Provider not initialized');
        return;
    }

    vscode.window.showInformationMessage('Testing provider connections...');
    logger.info('Testing connections');

    try {
        const connected = await languageModelProvider.testConnection();
        if (connected) {
            const modelCount = languageModelProvider.getAvailableModels().length;
            vscode.window.showInformationMessage(
                `LLM Local Router: Connected — ${modelCount} models available`
            );
        } else {
            vscode.window.showWarningMessage(
                'LLM Local Router: No API keys configured. Use "LLM Local Router: Configure" to set up provider API keys.'
            );
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Connection test failed: ${error}`);
    }
}

async function handleGetMetrics(): Promise<void> {
    getLogger().info('Opening webview metrics panel');
    if (!routerConfigProvider) {
        vscode.window.showErrorMessage('LLM Local Router: Provider not initialized');
        return;
    }
    await routerConfigProvider.show('metrics');
}

async function handleGetModelStats(modelId?: string): Promise<void> {
    if (!modelId) {
        modelId = await vscode.window.showInputBox({
            title: 'Model ID',
            placeHolder: 'e.g., deepseek-v4-pro, local/code',
        });
    }
    if (!modelId) return;

    const collector = getMetricsCollector();
    const summary = collector.getModelSummary(modelId);

    if (!summary) {
        vscode.window.showInformationMessage(`No metrics found for model: ${modelId}`);
        return;
    }

    const lines = [
        `Model:     ${summary.modelId}`,
        `Provider:  ${summary.provider}`,
        `Windows:   ${summary.windowCount} × 5m`,
        `Requests:  ${summary.totalRequests} (${summary.totalSuccess} success, ${summary.totalErrors} error, ${summary.totalTimeouts} timeout)`,
        `Available: ${((summary.availability ?? 0) * 100).toFixed(2)}%`,
        `TTFB avg:  ${Math.round(summary.avgTtfbMs)}ms`,
        `TTLB avg:  ${Math.round(summary.avgTtlbMs)}ms`,
        `TTLB p90:  ${Math.round(summary.p90TtlbMs)}ms`,
        `Tokens:    ${summary.totalPromptTokens.toLocaleString()} prompt / ${summary.totalCompletionTokens.toLocaleString()} compl`,
        `Cache hit: ${(summary.cacheHitRatio * 100).toFixed(1)}%`,
        `Cost:      $${summary.totalCostUsd.toFixed(6)}`,
    ];

    const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'plaintext',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}

async function handleExportMetrics(): Promise<void> {
    const collector = getMetricsCollector();
    const text = collector.toPrometheusText();

    const doc = await vscode.workspace.openTextDocument({
        content: text,
        language: 'plaintext',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}


async function handleGetCostHistory(): Promise<void> {
    const collector = getMetricsCollector();
    const storage = collector.getStorage();

    if (!storage) {
        vscode.window.showInformationMessage('Metrics storage is not available (SQLite not initialized).');
        return;
    }

    const periods = [
        { label: 'Last 1 hour', since: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() },
        { label: 'Last 6 hours', since: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() },
        { label: 'Last 24 hours', since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
        { label: 'Last 7 days', since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() },
        { label: 'Last 30 days', since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
    ];

    const period = await vscode.window.showQuickPick(
        periods.map(p => ({ label: p.label, since: p.since })),
        { title: 'Cost History: Select time range', placeHolder: 'Choose a time range' },
    );

    if (!period) return;

    const breakdown = storage.getCostBreakdown(period.since);

    if (breakdown.length === 0) {
        vscode.window.showInformationMessage(`No cost data for ${period.label.toLowerCase()}.`);
        return;
    }

    const totalAll = breakdown.reduce((sum, m) => sum + m.totalCost, 0);
    const lines = [
        `=== Cost Breakdown (${period.label}) ===`,
        `Total: $${totalAll.toFixed(6)} across ${breakdown.reduce((s, m) => s + m.requestCount, 0)} requests`,
        '',
    ];

    for (const m of breakdown) {
        const pct = totalAll > 0 ? ((m.totalCost / totalAll) * 100).toFixed(1) : '0.0';
        lines.push(
            `  ${m.modelId.padEnd(25)} ` +
            `$${m.totalCost.toFixed(6).padStart(12)} ` +
            `(${pct}%) `.padStart(9) +
            `${String(m.requestCount).padStart(5)} reqs`
        );
    }

    const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'plaintext',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}

async function handleGetCompositeDistribution(compositeId?: string): Promise<void> {
    if (!compositeId) {
        compositeId = await vscode.window.showInputBox({
            title: 'Composite Model ID',
            placeHolder: 'e.g., local/code',
        });
    }
    if (!compositeId) return;

    const collector = getMetricsCollector();
    const history = collector.getCompositeDistributionHistory(compositeId);

    if (history.length === 0) {
        vscode.window.showInformationMessage(`No routing data for composite model: ${compositeId}`);
        return;
    }

    const lines = [`=== ${compositeId} Routing Distribution ===`, ''];

    const totalCounts: Record<string, number> = {};
    let totalFailover = 0;
    let totalAttempts = 0;
    let totalMidstream = 0;

    for (const dist of history) {
        for (const [model, count] of Object.entries(dist.modelCounts)) {
            totalCounts[model] = (totalCounts[model] ?? 0) + count;
        }
        totalFailover += dist.failoverCount;
        totalAttempts += dist.totalAttempts;
        totalMidstream += dist.midstreamFailureCount;
    }

    const totalReqs = Object.values(totalCounts).reduce((a, b) => a + b, 0);
    lines.push(`Total requests: ${totalReqs}`);
    lines.push(`Total attempts: ${totalAttempts} (avg ${(totalAttempts / Math.max(1, totalReqs)).toFixed(2)} per request)`);
    lines.push(`Failover events: ${totalFailover}`);
    lines.push(`Mid-stream failures: ${totalMidstream}`);
    lines.push('');

    const sorted = Object.entries(totalCounts).sort((a, b) => b[1] - a[1]);
    lines.push('Underlying model distribution:');
    for (const [model, count] of sorted) {
        const pct = totalReqs > 0 ? ((count / totalReqs) * 100).toFixed(1) : '0.0';
        const bar = '█'.repeat(Math.round((count / Math.max(1, sorted[0][1])) * 20));
        lines.push(`  ${model.padEnd(25)} ${String(count).padStart(4)} (${pct}%) ${bar}`);
    }

    const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'plaintext',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}

// ─── Lifecycle ────────────────────────────────────────────────────

function handleConfigurationChange(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('llmLocalRouter')) return;

    const logger = getLogger();
    logger.info('Configuration changed');

    const newConfig = getConfiguration();
    const debugChanged = event.affectsConfiguration('llmLocalRouter.debug');
    const prometheusChanged = event.affectsConfiguration('llmLocalRouter.experimental.prometheusEndpoint');

    if (debugChanged) setDebugMode(newConfig.debug);

    if (languageModelProvider) {
        languageModelProvider.updateConfig(newConfig);
    }

    config = newConfig;

    if (prometheusChanged) {
        const wsConfig = vscode.workspace.getConfiguration('llmLocalRouter');
        if (wsConfig.get('experimental.prometheusEndpoint', false)) {
            startMetricsServer().catch(err =>
                logger.warning(`Failed to start Prometheus metrics server: ${err}`)
            );
        } else {
            stopMetricsServer().catch(err =>
                logger.warning(`Failed to stop Prometheus metrics server: ${err}`)
            );
        }
    }

    if (config.enabled) {
        if (!isConnected && !isConnecting) {
            connectWithRetry();
        } else if (isConnected) {
            startHealthCheck();
        }
    } else {
        stopHealthCheck();
        stopConnectionRetry();
        isConnected = false;
    }

    updateStatusBar();
}

async function loadCompositeModels(): Promise<void> {
    if (!languageModelProvider) return;

    const filePath = config.compositeModelsFile;
    const inlineConfig = config.compositeModelsConfig;

    if (filePath) {
        try {
            const uri = vscode.Uri.file(filePath);
            const content = await vscode.workspace.fs.readFile(uri);
            const models = JSON.parse(Buffer.from(content).toString('utf-8'));
            languageModelProvider.updateCompositeModels(models);
            getLogger().info(`Loaded composite models from ${filePath}`);
            return;
        } catch (error) {
            getLogger().warning(`Failed to load composite models from ${filePath}: ${error}. Falling back to inline config.`);
        }
    }

    if (inlineConfig && inlineConfig.trim()) {
        try {
            const models = JSON.parse(inlineConfig);
            if (Object.keys(models).length > 0) {
                languageModelProvider.updateCompositeModels(models);
                getLogger().info('Loaded composite models from inline settings (llmLocalRouter.compositeModelsConfig)');
            }
        } catch (error) {
            getLogger().warning(`Failed to parse inline composite models JSON: ${error}`);
        }
    }
}

/**
 * Load custom primary providers from SecretStorage into the LanguageModelProvider.
 */
async function loadCustomProvidersIntoProvider(context: vscode.ExtensionContext, provider: LanguageModelProvider): Promise<void> {
    const logger = getLogger();
    const raw = vscode.workspace.getConfiguration('llmLocalRouter').get<string>('customProviders');
    logger.debug(`[customProvider:init] raw settings value length=${raw?.length ?? 0} hasContent=${!!raw?.trim()}`);
    let customs: Record<string, CustomProviderConfig> = {};
    if (raw && raw.trim()) {
        try {
            customs = JSON.parse(raw);
            logger.debug(`[customProvider:init] parsed ${Object.keys(customs).length} providers: ${JSON.stringify(Object.keys(customs))}`);
        } catch (err) {
            logger.warning(`[customProvider:init] JSON parse error: ${err}`);
        }
    } else {
        logger.debug(`[customProvider:init] no custom providers in settings`);
    }
    const customKeys = await loadCustomProviderApiKeys(context);
    logger.debug(`[customProvider:init] loaded ${Object.keys(customKeys).length} API keys: ${JSON.stringify(Object.keys(customKeys))}`);
    const customMap = new Map<string, CustomProviderConfig>(Object.entries(customs));
    provider.updateCustomProviders(customMap, customKeys);
    logger.info(`[customProvider:init] Loaded ${customMap.size} custom providers with ${Object.keys(customKeys).length} API keys`);
}


export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const wsConfig = vscode.workspace.getConfiguration('llmLocalRouter');
    const debugEnabled = wsConfig.get('debug', false);
    initLogger('LLM Local Router', debugEnabled);

    config = getConfiguration();
    updateStatusBar();

    const dbPath = vscode.Uri.joinPath(context.globalStorageUri, 'metrics.db').fsPath;
    let storage: MetricsStorage | undefined;
    try {
        storage = await MetricsStorage.create(dbPath);
    } catch (err) {
        getLogger().warning(`Failed to initialize metrics storage: ${err}`);
    }
    initMetricsCollector(storage);

    const logger = getLogger();
    logger.info('LLM Local Router activating...');

    const apiKeys = await loadApiKeys(context);
    const endpointUrls = await loadEndpointUrls(context);

    // Load per-model pricing overrides into the runtime cost engine
    try {
        const overrides = await loadModelPricingOverrides(context);
        setModelPricingOverrides(overrides);
        logger.info(`Loaded per-model pricing overrides (${Object.keys(overrides).length} models)`);
    } catch (err) {
        logger.warning(`Failed to load model pricing overrides: ${err}`);
    }

    languageModelProvider = new LanguageModelProvider(config);
    languageModelProvider.updateApiKeys(apiKeys as Record<string, string | undefined>);
    languageModelProvider.updateEndpointUrls(endpointUrls);

    // Load custom providers
    await loadCustomProvidersIntoProvider(context, languageModelProvider);

    await loadCompositeModels();

    try {
        await languageModelProvider.fetchModels();
    } catch (err) {
        logger.warning(`Initial model fetch failed: ${err}`);
    }

    // Initialize TCP keepalive health checker
    healthChecker = new ProviderHealthChecker();
    healthChecker.onChange((state: ProviderHealthState) => {
        providerHealth.set(state.provider, state.healthy);
        updateStatusBar();
    });
    connectHealthChecker();

    routerConfigProvider = new RouterConfigProvider(languageModelProvider, context);

    const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
        'local',
        languageModelProvider,
    );

    const statusBarClickCommand = vscode.commands.registerCommand('llmLocalRouter.statusBarClick', handleStatusBarClick);
    const configureCommand = vscode.commands.registerCommand('llmLocalRouter.configure', handleConfigure);
    const configureWebviewCommand = vscode.commands.registerCommand('llmLocalRouter.configureWebview', handleConfigureWebview);
    const showModelsCommand = vscode.commands.registerCommand('llmLocalRouter.showModels', handleShowModels);
    const refreshModelsCommand = vscode.commands.registerCommand('llmLocalRouter.refreshModels', handleRefreshModels);
    const testConnectionCommand = vscode.commands.registerCommand('llmLocalRouter.testConnection', handleTestConnection);

    // Import/export the router's configuration as a single object — used to bring the
    // router to a known state (e.g. by the L2 integration harness) without clicking
    // through the Configure UI. Accepts the config inline OR as a path to a JSON file
    // (mirrors a settings-import command). Secret values are written to SecretStorage
    // (which fires onApiKeysChanged → the provider reloads keys automatically); export
    // returns only WHICH providers are keyed, never the key values.
    // Invoked with no argument (Command Palette, or the Config panel's Import button)
    // there is nothing to import, so prompt for a file and report the outcome. A caller
    // that passes an argument (the integration harness) keeps the silent, programmatic
    // contract and never sees UI.
    const importConfigCommand = vscode.commands.registerCommand(
        'llmLocalRouter.importConfig',
        async (input?: RouterImportConfig | string) => {
            if (input !== undefined) {
                return importRouterConfig(context, input);
            }
            return promptAndImportRouterConfig(context);
        },
    );
    const exportConfigCommand = vscode.commands.registerCommand(
        'llmLocalRouter.exportConfig',
        async () => exportRouterConfig(context),
    );

    const getModelPricingCommand = vscode.commands.registerCommand(
        'llmLocalRouter.getModelPricing',
        (modelId: string) => languageModelProvider?.getPricing(modelId),
    );
    const getModelCapabilitiesCommand = vscode.commands.registerCommand(
        'llmLocalRouter.getModelCapabilities',
        (modelId: string) => languageModelProvider?.getCapabilities(modelId),
    );
    const getRequestCostCommand = vscode.commands.registerCommand(
        'llmLocalRouter.getRequestCost',
        (conversationId: string) => languageModelProvider?.getRequestCost(conversationId),
    );

    const getMetricsCommand = vscode.commands.registerCommand('llmLocalRouter.getMetrics', handleGetMetrics);
    const getModelStatsCommand = vscode.commands.registerCommand('llmLocalRouter.getModelStats', handleGetModelStats);
    const exportMetricsCommand = vscode.commands.registerCommand('llmLocalRouter.exportMetrics', handleExportMetrics);
    const getCompositeDistributionCommand = vscode.commands.registerCommand('llmLocalRouter.getCompositeDistribution', handleGetCompositeDistribution);
    const getCostHistoryCommand = vscode.commands.registerCommand('llmLocalRouter.getCostHistory', handleGetCostHistory);

    const configChangeListener = vscode.workspace.onDidChangeConfiguration(handleConfigurationChange);

    const secretsListener = onApiKeysChanged(context, async () => {
        logger.info('API keys changed, reloading...');
        const keys = await loadApiKeys(context);
        const eps = await loadEndpointUrls(context);
        languageModelProvider?.updateApiKeys(keys as Record<string, string | undefined>);
        languageModelProvider?.updateEndpointUrls(eps);
        // Reload per-model pricing overrides on SecretStorage change
        try {
            const overrides = await loadModelPricingOverrides(context);
            setModelPricingOverrides(overrides);
        } catch (err) {
            logger.warning(`Failed to reload model pricing overrides on secrets change: ${err}`);
        }
        await languageModelProvider?.fetchModels();
        connectHealthChecker();
        if (config.enabled && !isConnected) {
            connectWithRetry();
        }
    });

    context.subscriptions.push(
        providerDisposable,
        statusBarClickCommand,
        configureCommand,
        configureWebviewCommand,
        showModelsCommand,
        refreshModelsCommand,
        testConnectionCommand,
        importConfigCommand,
        exportConfigCommand,
        getModelPricingCommand,
        getModelCapabilitiesCommand,
        getRequestCostCommand,
        getMetricsCommand,
        getModelStatsCommand,
        exportMetricsCommand,
        getCompositeDistributionCommand,
        getCostHistoryCommand,
        configChangeListener,
        secretsListener,
        // These three are created lazily/conditionally and disposed explicitly in
        // deactivate(); also register them here so VS Code disposes them
        // deterministically even if activation throws before deactivate is wired.
        // dispose() is idempotent for all three, so the double call is harmless.
        { dispose: () => { healthChecker?.dispose(); routerConfigProvider?.dispose(); statusBarItem?.dispose(); } },
    );

    // First-install onboarding popup
    const hasSeenOnboarding = context.globalState.get<boolean>('llmLocalRouter.onboardingSeen');
    if (!hasSeenOnboarding) {
        vscode.window.showInformationMessage(
            'LLM Local Router is ready! 👋 Click the rocket icon in the status bar to configure.',
            'Open Dashboard',
            'Dismiss',
        ).then(async (choice) => {
            if (choice === 'Open Dashboard') {
                await handleStatusBarClick();
            }
            await context.globalState.update('llmLocalRouter.onboardingSeen', true);
        });
    }

    if (config.enabled) {
        connectWithRetry();

        setTimeout(async () => {
            try {
                const availableModels = await vscode.lm.selectChatModels({ vendor: 'local' });
                logger.info(`VS Code LM API reports ${availableModels.length} models available`);
            } catch (err) {
                logger.warning(`Failed to query available models: ${err}`);
            }
        }, 5000);
    } else {
        logger.info('LLM Local Router is disabled');
        updateStatusBar();
    }

    logger.info('LLM Local Router activated');
}

export function deactivate(): void {
    const logger = getLogger();
    logger.info('LLM Local Router deactivating...');

    stopHealthCheck();
    stopConnectionRetry();

    if (healthChecker) {
        healthChecker.dispose();
        healthChecker = undefined;
    }

    shutdownMetricsCollector();

    stopMetricsServer().catch(err =>
        logger.warning(`Failed to stop Prometheus metrics server: ${err}`)
    );

    if (routerConfigProvider) {
        routerConfigProvider.dispose();
    }

    if (statusBarItem) {
        statusBarItem.dispose();
    }

    logger.info('LLM Local Router deactivated');
}

/**
 * Shofer Router — Extension Entry Point
 *
 * A VS Code extension that provides direct access to multiple LLM providers
 * provider's API from within the VS Code extension host.
 *
 * API keys are stored securely using VS Code's SecretStorage API.
 */

import * as vscode from 'vscode';
import { LanguageModelProvider, RouterConfig } from './language-model-provider';
import { RouterConfigProvider } from './router-config-provider';
import { initLogger, getLogger, setDebugMode } from './logger';
import { loadApiKeys, loadEndpointUrls, onApiKeysChanged } from './secret-storage';
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
    const wsConfig = vscode.workspace.getConfiguration('shofer.router');
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
        vscode.window.showErrorMessage('Shofer Router: Provider not initialized');
        return;
    }
    await routerConfigProvider.show('status');
}

function updateStatusBar(): void {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
        statusBarItem.command = 'shofer.router.statusBarClick';
        statusBarItem.name = 'Shofer Router';
    }

    const providerCount = languageModelProvider?.getConfiguredProviderCount() ?? 0;
    const hasAnyApiKey = providerCount > 0;
    const healthyCount = [...providerHealth.values()].filter(h => h).length;
    const totalMonitored = providerHealth.size;
    let statusText: string;

    if (!config.enabled) {
        statusText = '$(circle-slash) Shofer Router';
        statusBarItem.tooltip = 'Shofer Router — disabled. Click to open settings.';
        statusBarItem.backgroundColor = undefined;
    } else if (!hasAnyApiKey) {
        statusText = '$(warning) Shofer Router';
        statusBarItem.tooltip = 'Shofer Router — no API keys configured. Click to set up providers.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (isConnecting) {
        statusText = '$(sync~spin) Shofer Router';
        statusBarItem.tooltip = 'Shofer Router — connecting...';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (totalMonitored > 0 && healthyCount === 0) {
        statusText = '$(error) Shofer Router';
        statusBarItem.tooltip = 'Shofer Router — all providers unreachable. Click for status.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        statusText = '$(rocket) Shofer Router';
        if (totalMonitored > 0) {
            statusBarItem.tooltip = `Shofer Router — ${healthyCount}/${totalMonitored} provider${totalMonitored !== 1 ? 's' : ''} healthy. Click for status.`;
        } else {
            statusBarItem.tooltip = `Shofer Router — ${providerCount} provider${providerCount !== 1 ? 's' : ''} configured. Click for status.`;
        }
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.text = statusText;
    statusBarItem.show();
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
        if (m.id.startsWith('shofer/')) continue;
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
        zhipu: 'https://open.bigmodel.cn',
        openrouter: 'https://openrouter.ai',
    };
    return defaults[provider] || '';
}

// ─── Commands ─────────────────────────────────────────────────────

async function handleConfigure(): Promise<void> {
    getLogger().info('Opening webview configuration panel');
    if (!routerConfigProvider) {
        vscode.window.showErrorMessage('Shofer Router: Provider not initialized');
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
        vscode.window.showErrorMessage('Shofer Router: Provider not initialized');
        return;
    }
    await routerConfigProvider.show('status');
}

async function handleRefreshModels(): Promise<void> {
    const logger = getLogger();
    if (!languageModelProvider) {
        vscode.window.showErrorMessage('Shofer Router: Provider not initialized');
        return;
    }

    vscode.window.showInformationMessage('Refreshing models...');
    try {
        config = getConfiguration();
        languageModelProvider.updateConfig(config);
        const models = await languageModelProvider.fetchModels();
        updateStatusBar();
        vscode.window.showInformationMessage(`Shofer Router: ${models.length} models available`);
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
        vscode.window.showErrorMessage('Shofer Router: Provider not initialized');
        return;
    }

    vscode.window.showInformationMessage('Testing provider connections...');
    logger.info('Testing connections');

    try {
        const connected = await languageModelProvider.testConnection();
        if (connected) {
            const modelCount = languageModelProvider.getAvailableModels().length;
            vscode.window.showInformationMessage(
                `Shofer Router: Connected — ${modelCount} models available`
            );
        } else {
            vscode.window.showWarningMessage(
                'Shofer Router: No API keys configured. Use "Shofer Router: Configure" to set up provider API keys.'
            );
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Connection test failed: ${error}`);
    }
}

async function handleGetMetrics(): Promise<void> {
    getLogger().info('Opening webview metrics panel');
    if (!routerConfigProvider) {
        vscode.window.showErrorMessage('Shofer Router: Provider not initialized');
        return;
    }
    await routerConfigProvider.show('metrics');
}

async function handleGetModelStats(modelId?: string): Promise<void> {
    if (!modelId) {
        modelId = await vscode.window.showInputBox({
            title: 'Model ID',
            placeHolder: 'e.g., deepseek-v4-pro, shofer/code',
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
            placeHolder: 'e.g., shofer/code',
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
    if (!event.affectsConfiguration('shofer.router')) return;

    const logger = getLogger();
    logger.info('Configuration changed');

    const newConfig = getConfiguration();
    const debugChanged = event.affectsConfiguration('shofer.router.debug');
    const prometheusChanged = event.affectsConfiguration('shofer.router.experimental.prometheusEndpoint');

    if (debugChanged) setDebugMode(newConfig.debug);

    if (languageModelProvider) {
        languageModelProvider.updateConfig(newConfig);
    }

    config = newConfig;

    if (prometheusChanged) {
        const wsConfig = vscode.workspace.getConfiguration('shofer.router');
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

async function loadCompositeModels(context: vscode.ExtensionContext): Promise<void> {
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
                getLogger().info('Loaded composite models from inline settings (shofer.router.compositeModelsConfig)');
            }
        } catch (error) {
            getLogger().warning(`Failed to parse inline composite models JSON: ${error}`);
        }
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const wsConfig = vscode.workspace.getConfiguration('shofer.router');
    const debugEnabled = wsConfig.get('debug', false);
    initLogger('Shofer Router', debugEnabled);

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
    logger.info('Shofer Router activating...');

    const apiKeys = await loadApiKeys(context);
    const endpointUrls = await loadEndpointUrls(context);

    languageModelProvider = new LanguageModelProvider(config);
    languageModelProvider.updateApiKeys(apiKeys as Record<string, string | undefined>);
    languageModelProvider.updateEndpointUrls(endpointUrls);

    await loadCompositeModels(context);

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
        'shofer',
        languageModelProvider,
    );

    const statusBarClickCommand = vscode.commands.registerCommand('shofer.router.statusBarClick', handleStatusBarClick);
    const configureCommand = vscode.commands.registerCommand('shofer.router.configure', handleConfigure);
    const configureWebviewCommand = vscode.commands.registerCommand('shofer.router.configureWebview', handleConfigureWebview);
    const showModelsCommand = vscode.commands.registerCommand('shofer.router.showModels', handleShowModels);
    const refreshModelsCommand = vscode.commands.registerCommand('shofer.router.refreshModels', handleRefreshModels);
    const testConnectionCommand = vscode.commands.registerCommand('shofer.router.testConnection', handleTestConnection);

    const getModelPricingCommand = vscode.commands.registerCommand(
        'shofer.router.getModelPricing',
        (modelId: string) => languageModelProvider?.getPricing(modelId),
    );
    const getModelCapabilitiesCommand = vscode.commands.registerCommand(
        'shofer.router.getModelCapabilities',
        (modelId: string) => languageModelProvider?.getCapabilities(modelId),
    );
    const getRequestCostCommand = vscode.commands.registerCommand(
        'shofer.router.getRequestCost',
        (conversationId: string) => languageModelProvider?.getRequestCost(conversationId),
    );

    const getMetricsCommand = vscode.commands.registerCommand('shofer.router.getMetrics', handleGetMetrics);
    const getModelStatsCommand = vscode.commands.registerCommand('shofer.router.getModelStats', handleGetModelStats);
    const exportMetricsCommand = vscode.commands.registerCommand('shofer.router.exportMetrics', handleExportMetrics);
    const getCompositeDistributionCommand = vscode.commands.registerCommand('shofer.router.getCompositeDistribution', handleGetCompositeDistribution);
    const getCostHistoryCommand = vscode.commands.registerCommand('shofer.router.getCostHistory', handleGetCostHistory);

    const configChangeListener = vscode.workspace.onDidChangeConfiguration(handleConfigurationChange);

    const secretsListener = onApiKeysChanged(context, async () => {
        logger.info('API keys changed, reloading...');
        const keys = await loadApiKeys(context);
        const eps = await loadEndpointUrls(context);
        languageModelProvider?.updateApiKeys(keys as Record<string, string | undefined>);
        languageModelProvider?.updateEndpointUrls(eps);
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
    );

    // First-install onboarding popup
    const hasSeenOnboarding = context.globalState.get<boolean>('shofer.router.onboardingSeen');
    if (!hasSeenOnboarding) {
        vscode.window.showInformationMessage(
            'Shofer Router is ready! \\u{1F44B} Click the rocket icon in the status bar to open the dashboard.',
            'Open Dashboard',
            'Dismiss',
        ).then(async (choice) => {
            if (choice === 'Open Dashboard') {
                await handleStatusBarClick();
            }
            await context.globalState.update('shofer.router.onboardingSeen', true);
        });
    }

    if (config.enabled) {
        connectWithRetry();

        setTimeout(async () => {
            try {
                const availableModels = await vscode.lm.selectChatModels({ vendor: 'shofer' });
                logger.info(`VS Code LM API reports ${availableModels.length} models available`);
            } catch (err) {
                logger.warning(`Failed to query available models: ${err}`);
            }
        }, 5000);
    } else {
        logger.info('Shofer Router is disabled');
        updateStatusBar();
    }

    logger.info('Shofer Router activated');
}

export function deactivate(): void {
    const logger = getLogger();
    logger.info('Shofer Router deactivating...');

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

    logger.info('Shofer Router deactivated');
}

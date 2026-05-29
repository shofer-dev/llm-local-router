/**
 * Shofer LLM Router — Extension Entry Point
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
import { loadApiKeys, onApiKeysChanged } from './secret-storage';
import { initMetricsCollector, getMetricsCollector, shutdownMetricsCollector } from './metrics-collector';
import { MetricsStorage } from './metrics-storage';
import { startMetricsServer, stopMetricsServer } from './metrics-server';

// ─── Extension state ──────────────────────────────────────────────

let languageModelProvider: LanguageModelProvider | undefined;
let routerConfigProvider: RouterConfigProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let healthCheckInterval: NodeJS.Timeout | undefined;
let connectionRetryTimeout: NodeJS.Timeout | undefined;
let isConnected: boolean = false;
let isConnecting: boolean = false;
let config: RouterConfig = {
    enabled: true,
    defaultModel: 'deepseek-v4-pro',
    timeout: 300000,
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
        defaultModel: wsConfig.get('defaultModel', 'deepseek-v4-pro'),
        timeout: wsConfig.get('timeout', 300000),
        compositeModelsFile: wsConfig.get('compositeModelsFile', ''),
        compositeModelsConfig: wsConfig.get('compositeModelsConfig', ''),
        debug: wsConfig.get('debug', false),
    };
}

// ─── Status bar ───────────────────────────────────────────────────

async function handleStatusBarMenu(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: '$(pulse) Status',
                description: 'Provider health, models, connection info',
                action: 'status',
            },
            {
                label: '$(gear) Configure',
                description: 'API keys, model settings, composite models',
                action: 'configure',
            },
            {
                label: '$(graph) Metrics',
                description: 'Cost, latency, token usage statistics',
                action: 'metrics',
            },
        ],
        { placeHolder: 'Shofer LLM Router' },
    );

    if (!picked) return;

    switch (picked.action) {
        case 'status':
            await vscode.commands.executeCommand('shofer.llm.showModels');
            break;
        case 'configure':
            await vscode.commands.executeCommand('shofer.llm.configure');
            break;
        case 'metrics':
            await vscode.commands.executeCommand('shofer.llm.getMetrics');
            break;
    }
}

function updateStatusBar(): void {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'shofer.llm.statusBarMenu';
    }

    const providerCount = languageModelProvider?.getConfiguredProviderCount() ?? 0;
    let statusText: string;

    if (!config.enabled) {
        statusText = '$(circle-slash)';
        statusBarItem.tooltip = 'Shofer LLM Router (disabled)';
        statusBarItem.backgroundColor = undefined;
    } else if (isConnecting) {
        statusText = '$(sync~spin)';
        statusBarItem.tooltip = 'Shofer LLM Router (connecting...)';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (!isConnected) {
        statusText = '$(warning)';
        statusBarItem.tooltip = 'Shofer LLM Router (disconnected — configure API keys)';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusText = `$(rocket) ${providerCount}`;
        statusBarItem.tooltip = `Shofer LLM Router — ${providerCount} provider${providerCount !== 1 ? 's' : ''} configured`;
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

// ─── Commands ─────────────────────────────────────────────────────

async function handleConfigure(): Promise<void> {
    getLogger().info('Opening extension settings');
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Shoferdev.shofer-router');
}

async function handleConfigureWebview(): Promise<void> {
    if (!routerConfigProvider) {
        vscode.window.showErrorMessage('Shofer LLM Router: Provider not initialized');
        return;
    }
    await routerConfigProvider.show();
}

async function handleShowModels(): Promise<void> {
    if (!languageModelProvider) {
        vscode.window.showErrorMessage('Shofer LLM Router: Provider not initialized');
        return;
    }

    const models = languageModelProvider.getAvailableModels();
    if (models.length === 0) {
        vscode.window.showInformationMessage('No models available. Configure API keys to get started.');
        return;
    }

    const items = models.map(m => {
        const parts: string[] = [];
        parts.push(`In: ${m.maxInputTokens.toLocaleString()}`);
        parts.push(`Out: ${m.maxOutputTokens.toLocaleString()}`);
        if (m.pricing) {
            parts.push(`$${m.pricing.inputPrice}/$${m.pricing.outputPrice}/1M`);
        }
        const caps: string[] = [];
        if (m.capabilities.imageInput) caps.push('image');
        if (m.capabilities.toolCalling) caps.push('tools');
        if (m.capabilities.promptCache) caps.push('cache');

        return {
            label: `$(rocket) ${m.name}`,
            description: m.id,
            detail: `${parts.join(' | ')}${caps.length ? `  [${caps.join(', ')}]` : ''}`,
            modelId: m.id,
        };
    });

    const selected = await vscode.window.showQuickPick(items, {
        title: `Shofer LLM Router (${models.length} models)`,
        placeHolder: 'Select a model to copy its ID to clipboard',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (selected) {
        await vscode.env.clipboard.writeText(selected.modelId);
        vscode.window.showInformationMessage(`Copied: ${selected.modelId}`);
    }
}

async function handleRefreshModels(): Promise<void> {
    const logger = getLogger();
    if (!languageModelProvider) {
        vscode.window.showErrorMessage('Shofer LLM Router: Provider not initialized');
        return;
    }

    vscode.window.showInformationMessage('Refreshing models...');
    try {
        config = getConfiguration();
        languageModelProvider.updateConfig(config);
        const models = await languageModelProvider.fetchModels();
        updateStatusBar();
        vscode.window.showInformationMessage(`Shofer LLM Router: ${models.length} models available`);
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
        vscode.window.showErrorMessage('Shofer LLM Router: Provider not initialized');
        return;
    }

    vscode.window.showInformationMessage('Testing provider connections...');
    logger.info('Testing connections');

    try {
        const connected = await languageModelProvider.testConnection();
        if (connected) {
            const modelCount = languageModelProvider.getAvailableModels().length;
            vscode.window.showInformationMessage(
                `Shofer LLM Router: Connected — ${modelCount} models available`
            );
        } else {
            vscode.window.showWarningMessage(
                'Shofer LLM Router: No API keys configured. Use "Shofer LLM Router: Configure" to set up provider API keys.'
            );
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Connection test failed: ${error}`);
    }
}

async function handleGetMetrics(): Promise<void> {
    const collector = getMetricsCollector();
    const win = collector.getCurrentWindow();
    const summaries = collector.getAllModelSummaries(1); // last window only

    if (summaries.length === 0) {
        vscode.window.showInformationMessage('No metrics collected yet. Make some LLM requests first.');
        return;
    }

    const items = summaries.map(s => ({
        label: `$(graph) ${s.modelId}`,
        description: `${s.provider}`,
        detail: [
            `Reqs: ${s.totalRequests} (${((s.availability ?? 0) * 100).toFixed(1)}% avail)`,
            `Cost: $${s.totalCostUsd.toFixed(4)}`,
            `TTLB: avg ${Math.round(s.avgTtlbMs)}ms / p90 ${Math.round(s.p90TtlbMs)}ms`,
            `Tokens: ${s.totalPromptTokens.toLocaleString()} in / ${s.totalCompletionTokens.toLocaleString()} out`,
            s.cacheHitRatio > 0 ? `Cache: ${(s.cacheHitRatio * 100).toFixed(1)}%` : '',
        ].filter(Boolean).join(' | '),
        modelId: s.modelId,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Shofer LLM Router: Model Metrics (current window)',
        placeHolder: 'Select a model for details, or ESC to dismiss',
        matchOnDescription: true,
    });

    if (selected) {
        const history = collector.getModelHistory(selected.modelId, 12); // last hour
        const summary = collector.getModelSummary(selected.modelId, 12);
        if (!summary) return;

        const lines = [
            `=== ${selected.modelId} (${summary.provider}) ===`,
            `Window: ${summary.windowCount} × 5m (${(summary.windowCount * 5 / 60).toFixed(1)}h)`,
            ``,
            `Requests:   ${summary.totalRequests} total`,
            `  Success:  ${summary.totalSuccess}`,
            `  Errors:   ${summary.totalErrors}`,
            `  Timeouts: ${summary.totalTimeouts}`,
            `  Cancel'd: ${summary.totalCancelled}`,
            `Available:  ${((summary.availability ?? 0) * 100).toFixed(2)}%`,
            ``,
            `Latency:`,
            `  TTFB avg: ${Math.round(summary.avgTtfbMs)}ms`,
            `  TTLB avg: ${Math.round(summary.avgTtlbMs)}ms`,
            `  TTLB p90: ${Math.round(summary.p90TtlbMs)}ms`,
            ``,
            `Tokens:`,
            `  Prompt:    ${summary.totalPromptTokens.toLocaleString()}`,
            `  Compl:     ${summary.totalCompletionTokens.toLocaleString()}`,
            `  Cache hit: ${(summary.cacheHitRatio * 100).toFixed(1)}%`,
            ``,
            `Cost: $${summary.totalCostUsd.toFixed(6)}`,
        ];

        // Show per-window breakdown using window history
        const windows = collector.getWindowHistory(12);
        if (windows.length > 1) {
            lines.push(``, `Per-window (newest first):`);
            for (const win of windows) {
                const modelStats = win.models[selected.modelId];
                if (!modelStats) continue;
                const ts = new Date(win.windowStart).toLocaleTimeString();
                lines.push(`  ${ts}: ${modelStats.requestCount} reqs, ${((modelStats.availability ?? 0) * 100).toFixed(0)}% avail, $${modelStats.totalCostUsd.toFixed(4)}`);
            }
        }

        const doc = await vscode.workspace.openTextDocument({
            content: lines.join('\n'),
            language: 'plaintext',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
    }
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

    // Aggregate across all windows
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

    // Handle Prometheus endpoint toggle
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

/**
 * Load composite model configurations from settings or a file.
 *
 * Priority:
 *   1. compositeModelsFile (path to a JSON file) if set and readable
 *   2. compositeModelsConfig (inline JSON string) if set and parseable
 */
async function loadCompositeModels(context: vscode.ExtensionContext): Promise<void> {
    if (!languageModelProvider) return;

    const filePath = config.compositeModelsFile;
    const inlineConfig = config.compositeModelsConfig;

    // Priority 1: file path
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

    // Priority 2: inline JSON in settings
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
    // Initialize logger
    const wsConfig = vscode.workspace.getConfiguration('shofer.router');
    const debugEnabled = wsConfig.get('debug', false);
    initLogger('Shofer LLM Router', debugEnabled);

    // Show status bar immediately — it updates as state changes
    config = getConfiguration();
    updateStatusBar();

    // Initialize metrics collector with SQLite persistence
    const dbPath = vscode.Uri.joinPath(context.globalStorageUri, 'metrics.db').fsPath;
    let storage: MetricsStorage | undefined;
    try {
        storage = await MetricsStorage.create(dbPath);
    } catch (err) {
        // Storage initialization failure is non-fatal — metrics still work in-memory
        getLogger().warning(`Failed to initialize metrics storage: ${err}`);
    }
    initMetricsCollector(storage);

    const logger = getLogger();
    logger.info('Shofer LLM Router activating...');

    // Load API keys from SecretStorage
    const apiKeys = await loadApiKeys(context);

    // Create the language model provider
    languageModelProvider = new LanguageModelProvider(config);
    languageModelProvider.updateApiKeys(apiKeys as Record<string, string | undefined>);

    // Load composite model configs if specified
    await loadCompositeModels(context);

    // Fetch models immediately
    try {
        await languageModelProvider.fetchModels();
    } catch (err) {
        logger.warning(`Initial model fetch failed: ${err}`);
    }

    // Create the webview config provider
    routerConfigProvider = new RouterConfigProvider(languageModelProvider);

    // Register language model chat provider
    const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
        'shofer',
        languageModelProvider,
    );

    // Register commands
    const statusBarMenuCommand = vscode.commands.registerCommand('shofer.llm.statusBarMenu', handleStatusBarMenu);
    const configureCommand = vscode.commands.registerCommand('shofer.llm.configure', handleConfigure);
    const configureWebviewCommand = vscode.commands.registerCommand('shofer.llm.configureWebview', handleConfigureWebview);
    const showModelsCommand = vscode.commands.registerCommand('shofer.llm.showModels', handleShowModels);
    const refreshModelsCommand = vscode.commands.registerCommand('shofer.llm.refreshModels', handleRefreshModels);
    const testConnectionCommand = vscode.commands.registerCommand('shofer.llm.testConnection', handleTestConnection);

    // Side-channel commands for downstream consumers (Shofer's vscode-lm provider)
    const getModelPricingCommand = vscode.commands.registerCommand(
        'shofer.llm.getModelPricing',
        (modelId: string) => languageModelProvider?.getPricing(modelId),
    );
    const getModelCapabilitiesCommand = vscode.commands.registerCommand(
        'shofer.llm.getModelCapabilities',
        (modelId: string) => languageModelProvider?.getCapabilities(modelId),
    );
    const getRequestCostCommand = vscode.commands.registerCommand(
        'shofer.llm.getRequestCost',
        (conversationId: string) => languageModelProvider?.getRequestCost(conversationId),
    );

    // Metrics commands
    const getMetricsCommand = vscode.commands.registerCommand(
        'shofer.llm.getMetrics',
        handleGetMetrics,
    );
    const getModelStatsCommand = vscode.commands.registerCommand(
        'shofer.llm.getModelStats',
        handleGetModelStats,
    );
    const exportMetricsCommand = vscode.commands.registerCommand(
        'shofer.llm.exportMetrics',
        handleExportMetrics,
    );
    const getCompositeDistributionCommand = vscode.commands.registerCommand(
        'shofer.llm.getCompositeDistribution',
        handleGetCompositeDistribution,
    );
    const getCostHistoryCommand = vscode.commands.registerCommand(
        'shofer.llm.getCostHistory',
        handleGetCostHistory,
    );

    // Configuration change listener
    const configChangeListener = vscode.workspace.onDidChangeConfiguration(handleConfigurationChange);

    // SecretStorage change listener (reload API keys when changed)
    const secretsListener = onApiKeysChanged(context, async () => {
        logger.info('API keys changed, reloading...');
        const keys = await loadApiKeys(context);
        languageModelProvider?.updateApiKeys(keys as Record<string, string | undefined>);
        if (config.enabled && !isConnected) {
            connectWithRetry();
        }
    });

    // Register disposables
    context.subscriptions.push(
        providerDisposable,
        statusBarMenuCommand,
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

    if (config.enabled) {
        connectWithRetry();

        // Verify model availability after a delay
        setTimeout(async () => {
            try {
                const availableModels = await vscode.lm.selectChatModels({ vendor: 'shofer' });
                logger.info(`VS Code LM API reports ${availableModels.length} models available`);
            } catch (err) {
                logger.warning(`Failed to query available models: ${err}`);
            }
        }, 5000);
    } else {
        logger.info('Shofer LLM Router is disabled');
        updateStatusBar();
    }

    logger.info('Shofer LLM Router activated');
}

export function deactivate(): void {
    const logger = getLogger();
    logger.info('Shofer LLM Router deactivating...');

    stopHealthCheck();
    stopConnectionRetry();

    // Flush metrics to storage before shutdown
    shutdownMetricsCollector();

    // Stop Prometheus metrics server
    stopMetricsServer().catch(err =>
        logger.warning(`Failed to stop Prometheus metrics server: ${err}`)
    );

    if (routerConfigProvider) {
        routerConfigProvider.dispose();
    }

    if (statusBarItem) {
        statusBarItem.dispose();
    }

    logger.info('Shofer LLM Router deactivated');
}

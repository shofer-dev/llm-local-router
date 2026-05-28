/**
 * Shofer LLM Router — Extension Entry Point
 *
 * A VS Code extension that provides direct access to multiple LLM providers
 * with composite model failover. Unlike llm-provider, this extension does
 * NOT require a separate llm-router service — it talks directly to each
 * provider's API from within the VS Code extension host.
 *
 * API keys are stored securely using VS Code's SecretStorage API.
 */

import * as vscode from 'vscode';
import { LanguageModelProvider, RouterConfig } from './language-model-provider';
import { initLogger, getLogger, setDebugMode } from './logger';
import { loadApiKeys, onApiKeysChanged } from './secret-storage';

// ─── Extension state ──────────────────────────────────────────────

let languageModelProvider: LanguageModelProvider | undefined;
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
        debug: wsConfig.get('debug', false),
    };
}

// ─── Status bar ───────────────────────────────────────────────────

function updateStatusBar(): void {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'shofer.llm.showModels';
    }

    const modelCount = languageModelProvider?.getAvailableModels().length ?? 0;
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
        statusText = `$(rocket) ${modelCount}`;
        statusBarItem.tooltip = `Shofer LLM Router (${modelCount} models)`;
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
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:arkware.shofer-router');
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

// ─── Lifecycle ────────────────────────────────────────────────────

function handleConfigurationChange(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('shofer.router')) return;

    const logger = getLogger();
    logger.info('Configuration changed');

    const newConfig = getConfiguration();
    const debugChanged = event.affectsConfiguration('shofer.router.debug');

    if (debugChanged) setDebugMode(newConfig.debug);

    if (languageModelProvider) {
        languageModelProvider.updateConfig(newConfig);
    }

    config = newConfig;

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
 * Load composite model configurations from a file if specified.
 */
async function loadCompositeModels(context: vscode.ExtensionContext): Promise<void> {
    const filePath = config.compositeModelsFile;
    if (!filePath || !languageModelProvider) return;

    try {
        // Try to read the file via workspace FS
        const uri = vscode.Uri.file(filePath);
        const content = await vscode.workspace.fs.readFile(uri);
        const models = JSON.parse(Buffer.from(content).toString('utf-8'));
        languageModelProvider.updateCompositeModels(models);
        getLogger().info(`Loaded composite models from ${filePath}`);
    } catch (error) {
        getLogger().warning(`Failed to load composite models from ${filePath}: ${error}`);
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Initialize logger
    const wsConfig = vscode.workspace.getConfiguration('shofer.router');
    const debugEnabled = wsConfig.get('debug', false);
    initLogger('Shofer LLM Router', debugEnabled);

    const logger = getLogger();
    logger.info('Shofer LLM Router activating...');

    // Load configuration
    config = getConfiguration();

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

    // Register language model chat provider
    const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
        'shofer',
        languageModelProvider,
    );

    // Register commands
    const configureCommand = vscode.commands.registerCommand('shofer.llm.configure', handleConfigure);
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
        configureCommand,
        showModelsCommand,
        refreshModelsCommand,
        testConnectionCommand,
        getModelPricingCommand,
        getModelCapabilitiesCommand,
        getRequestCostCommand,
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

    if (statusBarItem) {
        statusBarItem.dispose();
    }

    logger.info('Shofer LLM Router deactivated');
}

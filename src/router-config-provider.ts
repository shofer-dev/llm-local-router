/**
 * RouterConfigProvider — Webview-based configuration UI.
 *
 * Manages a vscode.WebviewPanel that hosts a React application for editing
 * composite model configurations, provider API keys, and viewing metrics dashboards.
 *
 * Lifecycle:
 *   1. User runs "Shofer Router: Configure" command
 *   2. Panel is created (or revealed if already open)
 *   3. Host sends initConfig with current composite models + model registry
 *   4. Webview renders the UI
 *
 * Security:
 *   - CSP with random nonce prevents XSS
 *   - Only specific message types are accepted
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { LanguageModelProvider } from './language-model-provider';
import { ALL_MODELS } from './model-registry';
import { getMetricsCollector } from './metrics-collector';
import { MetricsStorage } from './metrics-storage';
import { storeApiKey, deleteApiKey, storeCustomProviderApiKey, deleteCustomProviderApiKey } from './secret-storage';
import { CustomProviderConfig, CustomProvidersMap } from './types';
import { ProviderType } from './types';
import type { ModelRegistryEntry, ModelWindowStats, CompositeDistribution, ProviderModelInfo } from './types';
import {
  convertToHostConfig,
  convertFromHostConfigs,
  validateCompositeModels,
  type WebviewCompositeModel,
} from './config-converter';

// ─── Provider defaults ──────────────────────────────────────────────

const PROVIDER_DEFAULTS: Record<string, { label: string; defaultEndpoint: string }> = {
  openai: { label: 'OpenAI', defaultEndpoint: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', defaultEndpoint: 'https://api.anthropic.com/v1' },
  google: { label: 'Google Gemini', defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta' },
  deepseek: { label: 'DeepSeek', defaultEndpoint: 'https://api.deepseek.com/v1' },
  minimax: { label: 'MiniMax', defaultEndpoint: 'https://api.minimax.io/v1' },
  moonshot: { label: 'Moonshot / Kimi', defaultEndpoint: 'https://api.moonshot.cn/v1' },
  xiaomi: { label: 'Xiaomi MiMo', defaultEndpoint: 'https://api.xiaomimimo.com/v1' },
  zhipu: { label: 'Zhipu GLM', defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4' },
  openrouter: { label: 'OpenRouter', defaultEndpoint: 'https://openrouter.ai/api/v1' },
};

/** The tab to show when opening the webview panel. */
export type WebviewTab = 'status' | 'config' | 'metrics' | 'providers';

// ─── Webview message types (mirrors webview-ui/src/types.ts) ────────

interface ModelRegistrySummary {
  id: string;
  name: string;
  provider: string;
  description: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  imageInput: boolean;
  toolCalling: boolean;
  promptCache: boolean;
}

interface ProviderStatus {
  name: string;
  configured: boolean;
  modelCount: number;
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  imageInput: boolean;
  toolCalling: boolean;
  promptCache: boolean;
  isComposite: boolean;
  pricing?: { inputPrice: number; outputPrice: number };
}

interface StatusPayload {
  connected: boolean;
  enabled: boolean;
  providers: ProviderStatus[];
  models: ModelInfo[];
}

interface ProviderConfigEntry {
  id: string;
  label: string;
  hasApiKey: boolean;
  endpointUrl: string;
  defaultEndpoint: string;
  modelCount: number;
  pricing?: { prompt?: number; completion?: number; cacheRead?: number };
  defaultPricing?: { prompt?: number; completion?: number; cacheRead?: number };
}

interface MetricsPayload {
  windowStart: string;
  windowEnd: string;
  modelMetrics: Array<{
    modelId: string;
    provider: string;
    isComposite: boolean;
    requestCount: number;
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    cancelledCount: number;
    availability: number;
    ttfbP50: number;
    ttfbP90: number;
    ttfbP99: number;
    ttlbP50: number;
    ttlbP90: number;
    ttlbP99: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCachedTokens: number;
    cacheHitRatio: number;
    totalCostUsd: number;
    errorTypes: Record<string, number>;
  }>;
  compositeMetrics: Array<{
    compositeModelId: string;
    modelCounts: Record<string, number>;
    failoverCount: number;
    midstreamFailureCount: number;
    totalAttempts: number;
  }>;
}

type HostMessage =
  | { type: 'initConfig'; compositeModels: WebviewCompositeModel[]; modelRegistry: ModelRegistrySummary[]; activeTab?: WebviewTab }
  | { type: 'configSaved' }
  | { type: 'validationError'; errors: string[] }
  | { type: 'configImported'; compositeModels: WebviewCompositeModel[] }
  | { type: 'metricsUpdate'; metrics: MetricsPayload }
  | { type: 'statusUpdate'; status: StatusPayload }
  | { type: 'providerConfigSaved'; provider: string }
  | { type: 'initProviderConfig'; providers: ProviderConfigEntry[] }
  | { type: 'metricsQueryResponse'; data: Array<{ windowStart: string; modelId: string; value: number }>; models: string[] }
  | { type: 'initCustomProviders'; customProviders: CustomProviderConfig[] }
  | { type: 'customProviderSaved'; provider: CustomProviderConfig }
  | { type: 'customProviderDeleted'; providerId: string };

type WebviewMessage =
  | { type: 'requestCustomProviders' }
  | { type: 'webviewReady' }
  | { type: 'saveConfig'; compositeModels: WebviewCompositeModel[] }
  | { type: 'validateConfig'; compositeModels: WebviewCompositeModel[] }
  | { type: 'exportConfig'; compositeModels: WebviewCompositeModel[] }
  | { type: 'importConfig' }
  | { type: 'saveProvider'; provider: string; apiKey: string; endpointUrl: string; pricing?: { prompt?: number; completion?: number; cacheRead?: number } }
  | { type: 'saveCustomProvider'; provider: CustomProviderConfig; apiKey: string }
  | { type: 'deleteCustomProvider'; providerId: string }
  | { type: 'queryMetrics'; metric: string; modelIds: string[]; since: string; until: string };

// ─── Constants ─────────────────────────────────────────────────────

const VIEW_TYPE = 'shoferRouterConfig';
const WEBVIEW_UI_DIR = path.join(__dirname, '..', 'webview-ui');
const WEBVIEW_BUILD_DIR = path.join(WEBVIEW_UI_DIR, 'build');

// ─── Provider ──────────────────────────────────────────────────────

export class RouterConfigProvider {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private languageModelProvider: LanguageModelProvider;
  private context: vscode.ExtensionContext;
  private metricsInterval: ReturnType<typeof setInterval> | undefined;
  private pendingActiveTab: WebviewTab = 'status';

  constructor(languageModelProvider: LanguageModelProvider, context: vscode.ExtensionContext) {
    this.languageModelProvider = languageModelProvider;
    this.context = context;
  }

  async show(activeTab: WebviewTab = 'status'): Promise<void> {
    this.pendingActiveTab = activeTab;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.sendInitConfig(activeTab);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Shofer Router', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(WEBVIEW_BUILD_DIR)],
    });
    this.panel.iconPath = vscode.Uri.joinPath(vscode.Uri.file(path.join(__dirname, '..')), 'assets', 'icon.png');
    this.panel.onDidDispose(() => { this.panel = undefined; }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(this.handleMessage.bind(this), null, this.disposables);
    await this.setWebviewContent();
  }

  dispose(): void {
    this.stopMetricsPush();
    if (this.panel) { this.panel.dispose(); this.panel = undefined; }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // ─── Webview content ─────────────────────────────────────────────

  private async setWebviewContent(): Promise<void> {
    if (!this.panel) return;
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const devServer = vscode.workspace.getConfiguration('shofer.router').get<string>('webviewDevServer');
    const html = devServer
      ? await this.getDevModeHtml(devServer, nonce, webview)
      : await this.getProdModeHtml(nonce, webview);
    webview.html = html;
  }

  private async getDevModeHtml(devServer: string, nonce: string, webview: vscode.Webview): Promise<string> {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${devServer} 'unsafe-inline'; style-src 'nonce-${nonce}' ${devServer} 'unsafe-inline'; font-src 'nonce-${nonce}' ${devServer} data:; img-src 'nonce-${nonce}' ${devServer} data:; connect-src ${devServer} ws://localhost:* wss://localhost:*;"/><title>Shofer Router</title></head><body><div id="root"></div><script type="module" nonce="${nonce}" src="${devServer}/@vite/client"></script><script type="module" nonce="${nonce}" src="${devServer}/src/main.tsx"></script></body></html>`;
  }

  private async getProdModeHtml(nonce: string, webview: vscode.Webview): Promise<string> {
    const indexPath = path.join(WEBVIEW_BUILD_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline';"/></head><body><div style="padding:20px;color:var(--vscode-errorForeground,#f48771);"><h3>Webview not built</h3><p>Run <code>cd webview-ui && npm install && npm run build</code> to build the webview,<br/>or set <code>shofer.router.webviewDevServer</code> to a Vite dev server URL.</p></div></body></html>`;
    }
    let html = fs.readFileSync(indexPath, 'utf-8');
    html = html.replace(/REPLACE_NONCE/g, nonce);
    const assetsDir = path.join(WEBVIEW_BUILD_DIR, 'assets');
    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const assetUri = webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, file)));
        html = html.replace(new RegExp(`["']\\.\\/assets\\/${escapeRegex(file)}["']`, 'g'), `"${assetUri}"`);
      }
    }
    html = html.replace(/(["'])\/assets\//g, `$1${webview.asWebviewUri(vscode.Uri.file(path.join(WEBVIEW_BUILD_DIR, 'assets')))}/`);
    html = html.replace(/<script(\s)/g, `<script nonce="${nonce}"$1`);
    html = html.replace(/<link(\s[^>]*rel=["']stylesheet["'][^>]*)>/g, `<link nonce="${nonce}"$1>`);
    return html;
  }

  // ─── Message handling ────────────────────────────────────────────

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (!this.panel) return;
    switch (message.type) {
      case 'webviewReady':
        await this.sendInitConfig(this.pendingActiveTab);
        this.startMetricsPush();
        break;
      case 'saveConfig':
        await this.handleSave(message.compositeModels);
        break;
      case 'validateConfig':
        await this.handleValidate(message.compositeModels);
        break;
      case 'exportConfig':
        await this.handleExport(message.compositeModels);
        break;
      case 'importConfig':
        await this.handleImport();
        break;
      case 'requestCustomProviders':
        await this.sendCustomProviders();
        break;
      case 'saveProvider':
        await this.handleSaveProvider(message.provider, message.apiKey, message.endpointUrl, message.pricing);
        break;
      case 'saveCustomProvider':
        await this.handleSaveCustomProvider(message.provider, message.apiKey);
        break;
      case 'deleteCustomProvider':
        await this.handleDeleteCustomProvider(message.providerId);
        break;
      case 'queryMetrics':
        await this.handleQueryMetrics(message.metric, message.modelIds, message.since, message.until);
        break;
    }
  }

  private async sendInitConfig(activeTab?: WebviewTab): Promise<void> {
    if (!this.panel) return;
    const webviewModels = this.loadCompositeModelsFromSettings();
    const registry = this.buildModelRegistry();
    const status = await this.buildStatusPayload();
    this.panel.webview.postMessage({
      type: 'initConfig',
      compositeModels: webviewModels,
      modelRegistry: registry,
      ...(activeTab ? { activeTab } : {}),
    });
    this.panel.webview.postMessage({ type: 'statusUpdate', status });
    this.sendProviderConfig();
    await this.sendCustomProviders();
  }

  private async buildStatusPayload(): Promise<StatusPayload> {
    const wsConfig = vscode.workspace.getConfiguration('shofer.router');
    const enabled = wsConfig.get('enabled', true);
    const connected = this.languageModelProvider.isReady();
    const availableModels = this.languageModelProvider.getAvailableModels();
    const registryMap = new Map<string, ModelRegistryEntry>();
    for (const entry of ALL_MODELS) registryMap.set(entry.id, entry);

    // Collect all providers from the ProviderType enum (not the registry,
    // since some like OpenRouter have no model entries — they're catch-alls).
    const allProviders = Object.values(ProviderType) as string[];

    const configuredProviders = new Set<string>();
    for (const entry of ALL_MODELS) {
      if (configuredProviders.has(entry.provider)) continue;
      try {
        const key = await this.context.secrets.get(`shofer-router.provider.${entry.provider}`);
        if (key) configuredProviders.add(entry.provider);
      } catch { /* not configured */ }
    }

    const providerModels = new Map<string, ProviderModelInfo[]>();
    for (const m of availableModels) {
      const registry = registryMap.get(m.id);
      const provider = registry?.provider ?? 'unknown';
      if (!providerModels.has(provider)) providerModels.set(provider, []);
      providerModels.get(provider)!.push(m);
    }

    const providers: ProviderStatus[] = [...allProviders].map(name => ({
      name,
      configured: configuredProviders.has(name),
      modelCount: (providerModels.get(name) ?? []).length,
    }));

    const models: ModelInfo[] = availableModels
      .filter(m => {
        const registry = registryMap.get(m.id);
        const provider = registry?.provider ?? m.family;
        return configuredProviders.has(provider) || m.id.startsWith('shofer/');
      })
      .map(m => {
        const registry = registryMap.get(m.id);
        return {
          id: m.id, name: m.name, provider: registry?.provider ?? m.family,
          maxInputTokens: m.maxInputTokens, maxOutputTokens: m.maxOutputTokens,
          imageInput: m.capabilities.imageInput ?? false,
          toolCalling: m.capabilities.toolCalling ?? false,
          promptCache: m.capabilities.promptCache ?? false,
          isComposite: m.id.startsWith('shofer/'),
          pricing: m.pricing ? { inputPrice: m.pricing.inputPrice ?? 0, outputPrice: m.pricing.outputPrice ?? 0 } : undefined,
        };
      });

    return { connected, enabled, providers, models };
  }

  private startMetricsPush(): void {
    if (this.metricsInterval) return;
    this.metricsInterval = setInterval(() => this.pushMetrics(), 15_000);
    this.pushMetrics();
  }

  private stopMetricsPush(): void {
    if (this.metricsInterval) { clearInterval(this.metricsInterval); this.metricsInterval = undefined; }
  }

  private pushMetrics(): void {
    if (!this.panel) return;
    const collector = getMetricsCollector();
    const win = collector.getCurrentWindow();
    const modelMetrics = Object.entries(win.models).map(([modelId, stats]) => ({
      modelId, provider: stats.provider, isComposite: stats.isComposite,
      requestCount: stats.requestCount, successCount: stats.successCount,
      errorCount: stats.errorCount, timeoutCount: stats.timeoutCount,
      cancelledCount: stats.cancelledCount, availability: stats.availability,
      ttfbP50: stats.ttfbP50, ttfbP90: stats.ttfbP90, ttfbP99: stats.ttfbP99,
      ttlbP50: stats.ttlbP50, ttlbP90: stats.ttlbP90, ttlbP99: stats.ttlbP99,
      totalPromptTokens: stats.totalPromptTokens, totalCompletionTokens: stats.totalCompletionTokens,
      totalCachedTokens: stats.totalCachedTokens, cacheHitRatio: stats.cacheHitRatio,
      totalCostUsd: stats.totalCostUsd, errorTypes: stats.errorTypes,
    }));
    const compositeMetrics = Object.entries(win.compositeRouting).map(([compositeId, dist]) => ({
      compositeModelId: compositeId, modelCounts: dist.modelCounts,
      failoverCount: dist.failoverCount, midstreamFailureCount: dist.midstreamFailureCount,
      totalAttempts: dist.totalAttempts,
    }));
    this.panel.webview.postMessage({
      type: 'metricsUpdate',
      metrics: { windowStart: win.windowStart, windowEnd: win.windowEnd, modelMetrics, compositeMetrics },
    });
  }

  private async sendToWebview(msg: HostMessage): Promise<void> {
    this.panel?.webview.postMessage(msg);
  }

  // ─── Metrics query (dashboard charts) ────────────────────────────

  private async handleQueryMetrics(
    metric: string, modelIds: string[], since: string, _until: string,
  ): Promise<void> {
    if (!this.panel) return;
    const collector = getMetricsCollector();
    const storage = collector.getStorage();
    if (!storage) {
      this.panel.webview.postMessage({ type: 'metricsQueryResponse', data: [], models: [] });
      return;
    }
    try {
      // cost_cumulative is computed client-side from per-window cost data
      const storageMetric = metric === 'cost_cumulative' ? 'cost' : metric;
      const data = storage.getTimeSeries(since, modelIds, storageMetric);
      const models = modelIds.length > 0 ? modelIds : storage.getDistinctModels(since);
      this.panel.webview.postMessage({ type: 'metricsQueryResponse', data, models });
    } catch (err) {
      (await import('./logger')).getLogger().warning(`Metrics query failed: ${err}`);
      this.panel.webview.postMessage({ type: 'metricsQueryResponse', data: [], models: [] });
    }
  }

  // ─── Provider config ─────────────────────────────────────────────

  private async sendProviderConfig(): Promise<void> {
    if (!this.panel) return;
    const providerIds = Object.keys(PROVIDER_DEFAULTS);
    const models = this.languageModelProvider.getAvailableModels();
    const providers: ProviderConfigEntry[] = [];
    for (const id of providerIds) {
      const def = PROVIDER_DEFAULTS[id];
      try {
        const key = await this.context.secrets.get(`shofer-router.provider.${id}`);
        const ep = await this.context.secrets.get(`shofer-router.provider.${id}.endpoint`);
        const pricingRaw = await this.context.secrets.get(`shofer-router.provider.${id}.pricing`);
        const pricing = pricingRaw ? JSON.parse(pricingRaw) : undefined;
        const modelCount = models.filter(m => {
          for (const entry of ALL_MODELS) if (entry.id === m.id && entry.provider === id) return true;
          return false;
        }).length;
        const registryEntry = ALL_MODELS.find(e => e.provider === id);
        const defaultPricing = registryEntry?.pricing ? {
          prompt: (registryEntry.pricing.prompt ?? 0) * 1000,
          completion: (registryEntry.pricing.completion ?? 0) * 1000,
          cacheRead: (registryEntry.pricing.contextCacheRead ?? 0) * 1000,
        } : undefined;
        providers.push({ id, label: def.label, hasApiKey: !!key, endpointUrl: ep || def.defaultEndpoint, defaultEndpoint: def.defaultEndpoint, modelCount, pricing, defaultPricing });
      } catch {
        providers.push({ id, label: def.label, hasApiKey: false, endpointUrl: def.defaultEndpoint, defaultEndpoint: def.defaultEndpoint, modelCount: 0 });
      }
    }
    this.panel.webview.postMessage({ type: 'initProviderConfig', providers });
  }

  private async handleSaveProvider(provider: string, apiKey: string, endpointUrl: string, pricing?: { prompt?: number; completion?: number; cacheRead?: number }): Promise<void> {
    const logger = (await import('./logger')).getLogger();
    try {
      if (apiKey.trim()) { await storeApiKey(this.context, provider, apiKey.trim()); logger.info(`Saved API key for ${provider}`); }
      else { await deleteApiKey(this.context, provider); logger.info(`Deleted API key for ${provider}`); }
      const def = PROVIDER_DEFAULTS[provider];
      const epKey = `shofer-router.provider.${provider}.endpoint`;
      if (endpointUrl.trim() && endpointUrl !== def?.defaultEndpoint) { await this.context.secrets.store(epKey, endpointUrl.trim()); logger.info(`Saved custom endpoint for ${provider}: ${endpointUrl}`); }
      else { await this.context.secrets.delete(epKey); }
      const pKey = `shofer-router.provider.${provider}.pricing`;
      if (pricing && (pricing.prompt || pricing.completion || pricing.cacheRead)) { await this.context.secrets.store(pKey, JSON.stringify(pricing)); logger.info(`Saved pricing overrides for ${provider}`); }
      else { await this.context.secrets.delete(pKey); }
      const { loadApiKeys, loadEndpointUrls } = await import('./secret-storage');
      const keys = await loadApiKeys(this.context);
      const eps = await loadEndpointUrls(this.context);
      this.languageModelProvider.updateApiKeys(keys as Record<string, string | undefined>);
      this.languageModelProvider.updateEndpointUrls(eps);
      this.panel?.webview.postMessage({ type: 'providerConfigSaved', provider });
      logger.info(`Provider config saved for ${provider}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to save provider config for ${provider}: ${message}`);
      vscode.window.showErrorMessage(`Failed to save ${provider} configuration: ${message}`);
    }
  }

  // ─── Custom provider config ──────────────────────────────────────

  private async sendCustomProviders(): Promise<void> {
    if (!this.panel) return;
    try {
      const customProviders = await this.loadCustomProvidersFromSettings();
      this.panel.webview.postMessage({
        type: 'initCustomProviders',
        customProviders: Object.values(customProviders),
      });
    } catch (err) {
      (await import('./logger')).getLogger().warning(`Failed to send custom providers: ${err}`);
    }
  }

  private async handleSaveCustomProvider(provider: CustomProviderConfig, apiKey: string): Promise<void> {
    const logger = (await import('./logger')).getLogger();
    logger.info(`[customProvider:save] START — id=${provider.id} label=${provider.label} protocol=${provider.protocol} endpointUrl=${provider.endpointUrl} modelsCount=${provider.models?.length ?? 0} hasApiKey=${!!apiKey?.trim()}`);
    try {
      // Validate provider ID — must not collide with built-in ProviderType values
      const builtInProviders = ['openai', 'anthropic', 'google', 'deepseek', 'minimax', 'moonshot', 'xiaomi', 'zhipu', 'openrouter'];
      if (builtInProviders.includes(provider.id)) {
        logger.warning(`[customProvider:save] REJECTED — id=${provider.id} collides with built-in provider`);
        throw new Error(`Provider ID "${provider.id}" collides with a built-in provider. Choose a different ID.`);
      }

      // Load existing, then update/add
      const customProviders = await this.loadCustomProvidersFromSettings();
      logger.info(`[customProvider:save] loaded existing providers count=${Object.keys(customProviders).length}`);
      customProviders[provider.id] = provider;
      await this.saveCustomProvidersToSettings(customProviders);
      logger.info(`[customProvider:save] saved to settings — total providers now=${Object.keys(customProviders).length}`);
      // Verify the write took effect
      const verifyRead = await this.loadCustomProvidersFromSettings();
      logger.info(`[customProvider:save] verify re-read — count=${Object.keys(verifyRead).length} hasKey=${!!verifyRead[provider.id]}`);

      // Store or delete API key
      if (apiKey.trim()) {
        await storeCustomProviderApiKey(this.context, provider.id, apiKey.trim());
        logger.info(`[customProvider:save] stored API key for ${provider.id}`);
      } else {
        await deleteCustomProviderApiKey(this.context, provider.id);
        logger.info(`[customProvider:save] deleted API key for ${provider.id} (empty key provided)`);
      }

      // Reload into LanguageModelProvider
      logger.info(`[customProvider:save] reloading into LanguageModelProvider...`);
      await this.reloadCustomProviders();
      await this.languageModelProvider.fetchModels();
      logger.info(`[customProvider:save] fetchModels complete`);

      this.panel?.webview.postMessage({ type: 'customProviderSaved', provider });
      logger.info(`[customProvider:save] DONE — id=${provider.id} (${provider.label})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[customProvider:save] FAILED — id=${provider.id}: ${message}`);
      vscode.window.showErrorMessage(`Failed to save custom provider: ${message}`);
    }
  }

  private async handleDeleteCustomProvider(providerId: string): Promise<void> {
    const logger = (await import('./logger')).getLogger();
    try {
      // Remove from custom providers map
      const customProviders = await this.loadCustomProvidersFromSettings();
      delete customProviders[providerId];
      await this.saveCustomProvidersToSettings(customProviders);

      // Delete API key
      await deleteCustomProviderApiKey(this.context, providerId);

      // Reload into LanguageModelProvider
      await this.reloadCustomProviders();
      await this.languageModelProvider.fetchModels();

      this.panel?.webview.postMessage({ type: 'customProviderDeleted', providerId });
      logger.info(`Deleted custom provider: ${providerId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to delete custom provider ${providerId}: ${message}`);
      vscode.window.showErrorMessage(`Failed to delete custom provider: ${message}`);
    }
  }

  /**
   * Reload custom providers from SecretStorage into the LanguageModelProvider.
   */
  private async reloadCustomProviders(): Promise<void> {
    const { loadCustomProviderApiKeys } = await import('./secret-storage');
    const customs = await this.loadCustomProvidersFromSettings();
    const customKeys = await loadCustomProviderApiKeys(this.context);
    const customMap = new Map<string, CustomProviderConfig>(Object.entries(customs));
    this.languageModelProvider.updateCustomProviders(customMap, customKeys);
  }

  /**
   * Load custom providers from the shofer.router.customProviders setting.
   */
  private async loadCustomProvidersFromSettings(): Promise<CustomProvidersMap> {
    const raw = vscode.workspace.getConfiguration('shofer.router').get<string>('customProviders');
    if (raw && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as CustomProvidersMap;
        (await import('./logger')).getLogger().info(`[customProvider] loadCustomProvidersFromSettings — raw length=${raw.length} keys=${JSON.stringify(Object.keys(parsed))}`);
        return parsed;
      } catch (err) {
        (await import('./logger')).getLogger().warning(`[customProvider] loadCustomProvidersFromSettings — JSON parse error: ${err}`);
      }
    } else {
      (await import('./logger')).getLogger().info(`[customProvider] loadCustomProvidersFromSettings — empty/undefined raw value`);
    }
    return {};
  }

  /**
   * Save custom providers to the shofer.router.customProviders workspace setting.
   */
  private async saveCustomProvidersToSettings(providers: CustomProvidersMap): Promise<void> {
    const logger = (await import('./logger')).getLogger();
    const json = JSON.stringify(providers, null, 2);
    logger.info(`[customProvider] saveCustomProvidersToSettings — writing ${Object.keys(providers).length} providers, json=${json.length} bytes`);
    await vscode.workspace.getConfiguration('shofer.router').update(
      'customProviders',
      Object.keys(providers).length > 0 ? json : '',
      vscode.ConfigurationTarget.Workspace,
    );
    logger.info(`[customProvider] saveCustomProvidersToSettings — write complete`);
  }


  // ─── Save / Validate / Export / Import ──────────────────────────

  private async handleSave(models: WebviewCompositeModel[]): Promise<void> {
    try {
      const config: Record<string, import('./types').CompositeModelConfig> = {};
      for (const wm of models) config[wm.modelId] = convertToHostConfig(wm);
      await vscode.workspace.getConfiguration('shofer.router').update('compositeModelsConfig', JSON.stringify(config, null, 2), vscode.ConfigurationTarget.Workspace);
      this.languageModelProvider.updateCompositeModels(config);
      await this.languageModelProvider.fetchModels();
      await this.sendToWebview({ type: 'configSaved' });
      vscode.window.showInformationMessage(`Saved ${Object.keys(config).length} composite model(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendToWebview({ type: 'validationError', errors: [message] });
    }
  }

  private async handleValidate(models: WebviewCompositeModel[]): Promise<void> {
    const errors = validateCompositeModels(models);
    if (errors.length > 0) await this.sendToWebview({ type: 'validationError', errors });
    else vscode.window.showInformationMessage('Configuration is valid.');
  }

  private async handleExport(models: WebviewCompositeModel[]): Promise<void> {
    try {
      const config: Record<string, import('./types').CompositeModelConfig> = {};
      for (const wm of models) config[wm.modelId] = convertToHostConfig(wm);
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('composite-models.json'), filters: { 'JSON Files': ['json'] } });
      if (uri) { await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(config, null, 2), 'utf-8')); vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`); }
    } catch (error) {
      vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleImport(): Promise<void> {
    try {
      const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'JSON Files': ['json'] } });
      if (!uris || uris.length === 0) return;
      const content = await vscode.workspace.fs.readFile(uris[0]);
      const parsed = JSON.parse(Buffer.from(content).toString('utf-8')) as Record<string, import('./types').CompositeModelConfig>;
      const webviewModels = convertFromHostConfigs(parsed);
      await this.sendToWebview({ type: 'configImported', compositeModels: webviewModels });
      vscode.window.showInformationMessage(`Imported ${webviewModels.length} composite model(s) from ${uris[0].fsPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ─── Settings I/O ────────────────────────────────────────────────

  private loadCompositeModelsFromSettings(): WebviewCompositeModel[] {
    const wsConfig = vscode.workspace.getConfiguration('shofer.router');
    const filePath = wsConfig.get<string>('compositeModelsFile');
    if (filePath) {
      try {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const parsed = JSON.parse(content) as Record<string, import('./types').CompositeModelConfig>;
          return convertFromHostConfigs(parsed);
        }
      } catch { /* fall through */ }
    }
    const inlineConfig = wsConfig.get<string>('compositeModelsConfig');
    if (inlineConfig && inlineConfig.trim()) {
      try {
        const parsed = JSON.parse(inlineConfig) as Record<string, import('./types').CompositeModelConfig>;
        return convertFromHostConfigs(parsed);
      } catch { /* fall through */ }
    }
    return [];
  }

  private buildModelRegistry(): ModelRegistrySummary[] {
    return ALL_MODELS.map((m: ModelRegistryEntry) => ({
      id: m.id, name: m.name, provider: m.provider, description: m.description,
      maxInputTokens: m.contextLength, maxOutputTokens: m.maxOutputTokens,
      imageInput: m.imageInput, toolCalling: m.toolCalling, promptCache: false,
    }));
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

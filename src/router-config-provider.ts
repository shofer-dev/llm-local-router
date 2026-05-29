/**
 * RouterConfigProvider — Webview-based configuration UI for composite models.
 *
 * Manages a vscode.WebviewPanel that hosts a React application for editing
 * composite model configurations. Handles the message protocol between the
 * webview and the extension host.
 *
 * Lifecycle:
 *   1. User runs "Shofer Router: Configure Webview" command
 *   2. Panel is created (or revealed if already open)
 *   3. Host sends initConfig with current composite models + model registry
 *   4. Webview renders the editor UI
 *   5. User edits → clicks Save → webview sends saveConfig → host persists
 *
 * Security:
 *   - CSP with random nonce prevents XSS
 *   - Only specific message types are accepted
 *   - JSON is validated before saving to settings
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { LanguageModelProvider } from './language-model-provider';
import { ALL_MODELS } from './model-registry';
import { getMetricsCollector } from './metrics-collector';
import type { ModelRegistryEntry, ModelWindowStats, CompositeDistribution, ProviderModelInfo } from './types';
import {
  convertToHostConfig,
  convertFromHostConfigs,
  validateCompositeModels,
  type WebviewCompositeModel,
} from './config-converter';

/** The tab to show when opening the webview panel. */
export type WebviewTab = 'status' | 'config' | 'metrics';

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
  | { type: 'statusUpdate'; status: StatusPayload };

type WebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'saveConfig'; compositeModels: WebviewCompositeModel[] }
  | { type: 'validateConfig'; compositeModels: WebviewCompositeModel[] }
  | { type: 'exportConfig'; compositeModels: WebviewCompositeModel[] }
  | { type: 'importConfig' };

// ─── Constants ─────────────────────────────────────────────────────

const VIEW_TYPE = 'shoferRouterConfig';
const WEBVIEW_UI_DIR = path.join(__dirname, '..', 'webview-ui');
const WEBVIEW_BUILD_DIR = path.join(WEBVIEW_UI_DIR, 'build');

// ─── Provider ──────────────────────────────────────────────────────

export class RouterConfigProvider {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private languageModelProvider: LanguageModelProvider;
  private metricsInterval: ReturnType<typeof setInterval> | undefined;
  /** The activeTab requested when show() was called; used when webviewReady fires. */
  private pendingActiveTab: WebviewTab = 'status';

  constructor(languageModelProvider: LanguageModelProvider) {
    this.languageModelProvider = languageModelProvider;
  }

  /**
   * Open or reveal the webview panel.
   *
   * @param activeTab — which tab to focus when opening (defaults to 'status')
   */
  async show(activeTab: WebviewTab = 'status'): Promise<void> {
    this.pendingActiveTab = activeTab;

    if (this.panel) {
      // Reveal existing panel and switch to the requested tab
      this.panel.reveal(vscode.ViewColumn.Active);
      this.sendInitConfig(activeTab);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Shofer Router',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(WEBVIEW_BUILD_DIR),
        ],
      },
    );

    this.panel.iconPath = vscode.Uri.joinPath(
      vscode.Uri.file(path.join(__dirname, '..')),
      'assets',
      'icon.png',
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.disposables);

    // Set up message handler
    this.panel.webview.onDidReceiveMessage(
      this.handleMessage.bind(this),
      null,
      this.disposables,
    );

    // Set content
    await this.setWebviewContent();
  }

  /**
   * Dispose the provider and panel.
   */
  dispose(): void {
    this.stopMetricsPush();
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  // ─── Webview content ─────────────────────────────────────────────

  private async setWebviewContent(): Promise<void> {
    if (!this.panel) return;

    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');

    // Check for dev server override
    const devServer = vscode.workspace.getConfiguration('shofer.router').get<string>('webviewDevServer');

    let html: string;
    if (devServer) {
      // Dev mode: proxy to Vite HMR server
      html = await this.getDevModeHtml(devServer, nonce, webview);
    } else {
      // Prod mode: serve from built assets
      html = await this.getProdModeHtml(nonce, webview);
    }

    webview.html = html;

    // Send initial configuration after the webview signals readiness
    // (handled via the 'webviewReady' message in handleMessage)
  }

  private async getDevModeHtml(
    devServer: string,
    nonce: string,
    webview: vscode.Webview,
  ): Promise<string> {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-${nonce}' ${devServer} 'unsafe-inline'; style-src 'nonce-${nonce}' ${devServer} 'unsafe-inline'; font-src 'nonce-${nonce}' ${devServer} data:; img-src 'nonce-${nonce}' ${devServer} data:; connect-src ${devServer} ws://localhost:* wss://localhost:*;"
    />
    <title>Shofer Router</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${devServer}/@vite/client"></script>
    <script type="module" nonce="${nonce}" src="${devServer}/src/main.tsx"></script>
  </body>
</html>`;
  }

  private async getProdModeHtml(
    nonce: string,
    webview: vscode.Webview,
  ): Promise<string> {
    const indexPath = path.join(WEBVIEW_BUILD_DIR, 'index.html');

    if (!fs.existsSync(indexPath)) {
      return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline';" />
  </head>
  <body>
    <div style="padding:20px;color:var(--vscode-errorForeground,#f48771);">
      <h3>Webview not built</h3>
      <p>Run <code>cd webview-ui && npm install && npm run build</code> to build the webview,<br/>
      or set <code>shofer.router.webviewDevServer</code> to a Vite dev server URL (e.g., <code>http://localhost:5173</code>).</p>
    </div>
  </body>
</html>`;
    }

    let html = fs.readFileSync(indexPath, 'utf-8');
    // Replace the CSP nonce placeholder
    html = html.replace(/REPLACE_NONCE/g, nonce);

    // Resolve asset URIs for VS Code webview
    const assetsDir = path.join(WEBVIEW_BUILD_DIR, 'assets');
    if (fs.existsSync(assetsDir)) {
      const assetFiles = fs.readdirSync(assetsDir);
      for (const file of assetFiles) {
        const assetUri = webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, file)));
        html = html.replace(new RegExp(`["']\\.\\/assets\\/${escapeRegex(file)}["']`, 'g'), `"${assetUri}"`);
      }
    }

    // Replace any remaining relative asset paths
    html = html.replace(
      /(["'])\/assets\//g,
      `$1${webview.asWebviewUri(vscode.Uri.file(path.join(WEBVIEW_BUILD_DIR, 'assets')))}/`,
    );

    // Inject nonce attribute into <script> and <link> tags so they pass CSP.
    // Vite's build strips nonce from the source index.html; we add it back here.
    html = html.replace(/<script(\s)/g, `<script nonce="${nonce}"$1`);
    html = html.replace(/<link(\s[^>]*rel=["']stylesheet["'][^>]*)>/g,
      `<link nonce="${nonce}"$1>`);

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
    }
  }

  /**
   * Send initial configuration, model registry, and status payload
   * to the webview after it signals readiness.
   */
  private async sendInitConfig(activeTab?: WebviewTab): Promise<void> {
    if (!this.panel) return;

    // Read current composite models from settings
    const webviewModels = this.loadCompositeModelsFromSettings();
    const registry = this.buildModelRegistry();
    const status = this.buildStatusPayload();

    const msg: HostMessage = {
      type: 'initConfig',
      compositeModels: webviewModels,
      modelRegistry: registry,
      ...(activeTab ? { activeTab } : {}),
    };

    this.panel.webview.postMessage(msg);

    // Also send status update as a separate message
    this.panel.webview.postMessage({ type: 'statusUpdate', status });
  }

  /**
   * Build the current status payload from the language model provider.
   */
  private buildStatusPayload(): StatusPayload {
    const wsConfig = vscode.workspace.getConfiguration('shofer.router');
    const enabled = wsConfig.get('enabled', true);
    const connected = this.languageModelProvider.isReady();
    const availableModels = this.languageModelProvider.getAvailableModels();

    // Build a lookup from model ID → registry entry for provider resolution
    const registryMap = new Map<string, ModelRegistryEntry>();
    for (const entry of ALL_MODELS) {
      registryMap.set(entry.id, entry);
    }

    // Derive provider status from available models grouped by their registry provider
    const providerModels = new Map<string, ProviderModelInfo[]>();
    for (const m of availableModels) {
      const registry = registryMap.get(m.id);
      const provider = registry?.provider ?? 'unknown';
      if (!providerModels.has(provider)) {
        providerModels.set(provider, []);
      }
      providerModels.get(provider)!.push(m);
    }

    // Known providers from the static registry
    const knownProviders = [...new Set(ALL_MODELS.map(m => m.provider))];
    const providers: ProviderStatus[] = knownProviders.map(name => {
      const models = providerModels.get(name) ?? [];
      return {
        name,
        configured: models.length > 0,
        modelCount: models.length,
      };
    });

    // Build model info list
    const models: ModelInfo[] = availableModels.map(m => {
      const registry = registryMap.get(m.id);
      return {
        id: m.id,
        name: m.name,
        provider: registry?.provider ?? m.family,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        imageInput: m.capabilities.imageInput ?? false,
        toolCalling: m.capabilities.toolCalling ?? false,
        promptCache: m.capabilities.promptCache ?? false,
        isComposite: m.id.startsWith('shofer/'),
        pricing: m.pricing ? {
          inputPrice: m.pricing.inputPrice ?? 0,
          outputPrice: m.pricing.outputPrice ?? 0,
        } : undefined,
      };
    });

    return { connected, enabled, providers, models };
  }

  private startMetricsPush(): void {
    if (this.metricsInterval) return;
    // Push metrics every 15 seconds
    this.metricsInterval = setInterval(() => {
      this.pushMetrics();
    }, 15_000);
    // Also push immediately
    this.pushMetrics();
  }

  private stopMetricsPush(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = undefined;
    }
  }

  /**
   * Build and send the current metrics payload to the webview.
   * Mirrors the data available via the Prometheus /metrics endpoint.
   */
  private pushMetrics(): void {
    if (!this.panel) return;

    const collector = getMetricsCollector();
    const win = collector.getCurrentWindow();
    const summaries = collector.getAllModelSummaries();

    // Build per-model metrics from current window stats
    const modelMetrics = Object.entries(win.models).map(([modelId, stats]) => ({
      modelId,
      provider: stats.provider,
      isComposite: stats.isComposite,
      requestCount: stats.requestCount,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      timeoutCount: stats.timeoutCount,
      cancelledCount: stats.cancelledCount,
      availability: stats.availability,
      ttfbP50: stats.ttfbP50,
      ttfbP90: stats.ttfbP90,
      ttfbP99: stats.ttfbP99,
      ttlbP50: stats.ttlbP50,
      ttlbP90: stats.ttlbP90,
      ttlbP99: stats.ttlbP99,
      totalPromptTokens: stats.totalPromptTokens,
      totalCompletionTokens: stats.totalCompletionTokens,
      totalCachedTokens: stats.totalCachedTokens,
      cacheHitRatio: stats.cacheHitRatio,
      totalCostUsd: stats.totalCostUsd,
      errorTypes: stats.errorTypes,
    }));

    // Build composite distribution metrics
    const compositeMetrics = Object.entries(win.compositeRouting).map(
      ([compositeId, dist]) => ({
        compositeModelId: compositeId,
        modelCounts: dist.modelCounts,
        failoverCount: dist.failoverCount,
        midstreamFailureCount: dist.midstreamFailureCount,
        totalAttempts: dist.totalAttempts,
      }),
    );

    const payload: MetricsPayload = {
      windowStart: win.windowStart,
      windowEnd: win.windowEnd,
      modelMetrics,
      compositeMetrics,
    };

    this.panel.webview.postMessage({ type: 'metricsUpdate', metrics: payload });
  }

  private async sendToWebview(msg: HostMessage): Promise<void> {
    this.panel?.webview.postMessage(msg);
  }

  // ─── Save ────────────────────────────────────────────────────────

  private async handleSave(models: WebviewCompositeModel[]): Promise<void> {
    try {
      const config: Record<string, import('./types').CompositeModelConfig> = {};
      for (const wm of models) {
        config[wm.modelId] = convertToHostConfig(wm);
      }

      const json = JSON.stringify(config, null, 2);

      // Save to VS Code settings
      await vscode.workspace.getConfiguration('shofer.router').update(
        'compositeModelsConfig',
        json,
        vscode.ConfigurationTarget.Workspace,
      );

      // Reload composite models in the language model provider
      this.languageModelProvider.updateCompositeModels(config);

      // Refresh model list
      await this.languageModelProvider.fetchModels();

      await this.sendToWebview({ type: 'configSaved' });

      vscode.window.showInformationMessage(
        `Saved ${Object.keys(config).length} composite model(s).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendToWebview({ type: 'validationError', errors: [message] });
    }
  }

  // ─── Validate ────────────────────────────────────────────────────

  private async handleValidate(models: WebviewCompositeModel[]): Promise<void> {
    const errors = validateCompositeModels(models);

    if (errors.length > 0) {
      await this.sendToWebview({ type: 'validationError', errors });
    } else {
      vscode.window.showInformationMessage('Configuration is valid.');
    }
  }

  // ─── Export ──────────────────────────────────────────────────────

  private async handleExport(models: WebviewCompositeModel[]): Promise<void> {
    try {
      const config: Record<string, import('./types').CompositeModelConfig> = {};
      for (const wm of models) {
        config[wm.modelId] = convertToHostConfig(wm);
      }
      const json = JSON.stringify(config, null, 2);

      // Show save dialog
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('composite-models.json'),
        filters: { 'JSON Files': ['json'] },
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
        vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Export failed: ${message}`);
    }
  }

  // ─── Import ──────────────────────────────────────────────────────

  private async handleImport(): Promise<void> {
    try {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'JSON Files': ['json'] },
      });

      if (!uris || uris.length === 0) return;

      const content = await vscode.workspace.fs.readFile(uris[0]);
      const parsed = JSON.parse(Buffer.from(content).toString('utf-8')) as Record<string, import('./types').CompositeModelConfig>;

      // Convert to webview format
      const webviewModels = convertFromHostConfigs(parsed);

      await this.sendToWebview({ type: 'configImported', compositeModels: webviewModels });
      vscode.window.showInformationMessage(
        `Imported ${webviewModels.length} composite model(s) from ${uris[0].fsPath}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Import failed: ${message}`);
    }
  }

  // ─── Type conversion ─────────────────────────────────────────────
  // Delegates to pure functions in config-converter.ts for testability.

  // ─── Settings I/O ────────────────────────────────────────────────

  /**
   * Load composite models from VS Code settings and convert to webview format.
   */
  private loadCompositeModelsFromSettings(): WebviewCompositeModel[] {
    const wsConfig = vscode.workspace.getConfiguration('shofer.router');

    // Priority 1: compositeModelsFile (file path)
    const filePath = wsConfig.get<string>('compositeModelsFile');
    if (filePath) {
      try {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const parsed = JSON.parse(content) as Record<string, import('./types').CompositeModelConfig>;
          return convertFromHostConfigs(parsed);
        }
      } catch {
        // Fall through to inline config
      }
    }

    // Priority 2: compositeModelsConfig (inline JSON)
    const inlineConfig = wsConfig.get<string>('compositeModelsConfig');
    if (inlineConfig && inlineConfig.trim()) {
      try {
        const parsed = JSON.parse(inlineConfig) as Record<string, import('./types').CompositeModelConfig>;
        return convertFromHostConfigs(parsed);
      } catch {
        // Return empty
      }
    }

    return [];
  }

  /**
   * Build the model registry summary for the webview's model picker.
   */
  private buildModelRegistry(): ModelRegistrySummary[] {
    return ALL_MODELS.map((m: ModelRegistryEntry) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      description: m.description,
      maxInputTokens: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
      imageInput: m.imageInput,
      toolCalling: m.toolCalling,
      promptCache: false, // Will be updated from capabilities
    }));
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

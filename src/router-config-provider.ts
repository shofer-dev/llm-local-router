/**
 * RouterConfigProvider — Webview-based configuration UI for composite models.
 *
 * Manages a vscode.WebviewPanel that hosts a React application for editing
 * composite model configurations. Handles the message protocol between the
 * webview and the extension host.
 *
 * Lifecycle:
 *   1. User runs "Shofer LLM Router: Configure Webview" command
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
import type { ModelRegistryEntry, CompositeModelConfig as HostCompositeConfig } from './types';

// ─── Webview message types (mirrors webview-ui/src/types.ts) ────────

interface WebviewCompositeModel {
  modelId: string;
  strategy: 'failover' | 'round_robin';
  streamingTimeoutMs: number;
  nonStreamingTimeoutMs: number;
  totalTimeoutMs: number;
  health?: { failureThreshold: number; degradedThreshold: number; cooldownMs: number };
  throttling?: { maxConcurrent: number; requestsPerWindow: number; windowMinutes: number };
  underlyingModels: Array<{
    modelId: string;
    provider: string;
    weight: number;
    priority: number;
  }>;
}

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

type HostMessage =
  | { type: 'initConfig'; compositeModels: WebviewCompositeModel[]; modelRegistry: ModelRegistrySummary[] }
  | { type: 'configSaved' }
  | { type: 'validationError'; errors: string[] }
  | { type: 'configImported'; compositeModels: WebviewCompositeModel[] };

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

  constructor(languageModelProvider: LanguageModelProvider) {
    this.languageModelProvider = languageModelProvider;
  }

  /**
   * Open or reveal the webview configuration panel.
   */
  async show(): Promise<void> {
    if (this.panel) {
      // Reveal existing panel
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Shofer LLM Router: Composite Models',
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
    <title>Shofer LLM Router</title>
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

    return html;
  }

  // ─── Message handling ────────────────────────────────────────────

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (!this.panel) return;

    switch (message.type) {
      case 'webviewReady':
        await this.sendInitConfig();
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

  private async sendInitConfig(): Promise<void> {
    if (!this.panel) return;

    // Read current composite models from settings
    const webviewModels = this.loadCompositeModelsFromSettings();
    const registry = this.buildModelRegistry();

    const msg: HostMessage = {
      type: 'initConfig',
      compositeModels: webviewModels,
      modelRegistry: registry,
    };

    this.panel.webview.postMessage(msg);
  }

  private async sendToWebview(msg: HostMessage): Promise<void> {
    this.panel?.webview.postMessage(msg);
  }

  // ─── Save ────────────────────────────────────────────────────────

  private async handleSave(models: WebviewCompositeModel[]): Promise<void> {
    try {
      const config: Record<string, HostCompositeConfig> = {};
      for (const wm of models) {
        config[wm.modelId] = this.convertToHostConfig(wm);
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
    const errors: string[] = [];
    const seenIds = new Set<string>();

    for (const m of models) {
      // Check model ID
      if (!m.modelId) {
        errors.push('A composite model is missing a model_id.');
        continue;
      }
      if (!m.modelId.startsWith('shofer/')) {
        errors.push(`${m.modelId}: model_id must start with "shofer/".`);
      }
      if (seenIds.has(m.modelId)) {
        errors.push(`${m.modelId}: duplicate model_id.`);
      }
      seenIds.add(m.modelId);

      // Check strategy
      if (m.strategy !== 'failover' && m.strategy !== 'round_robin') {
        errors.push(`${m.modelId}: strategy must be "failover" or "round_robin".`);
      }

      // Check underlying models
      if (m.underlyingModels.length === 0) {
        errors.push(`${m.modelId}: at least one underlying model is required.`);
      }

      const seenUnderlying = new Set<string>();
      for (const um of m.underlyingModels) {
        if (!um.modelId) {
          errors.push(`${m.modelId}: an underlying model is missing model_id.`);
          continue;
        }
        if (seenUnderlying.has(um.modelId)) {
          errors.push(`${m.modelId}: duplicate underlying model "${um.modelId}".`);
        }
        seenUnderlying.add(um.modelId);

        // Check model exists in registry
        const found = ALL_MODELS.find(
          (r) => r.id === um.modelId || `${r.provider}/${r.id}` === um.modelId,
        );
        if (!found) {
          errors.push(`${m.modelId}: underlying model "${um.modelId}" not found in registry.`);
        }
      }

      // Check timeouts
      if (m.streamingTimeoutMs > m.totalTimeoutMs) {
        errors.push(
          `${m.modelId}: streaming_timeout_ms (${m.streamingTimeoutMs}) must be <= total_timeout_ms (${m.totalTimeoutMs}).`,
        );
      }
      if (m.nonStreamingTimeoutMs > m.totalTimeoutMs) {
        errors.push(
          `${m.modelId}: nonstreaming_timeout_ms (${m.nonStreamingTimeoutMs}) must be <= total_timeout_ms (${m.totalTimeoutMs}).`,
        );
      }
    }

    if (errors.length > 0) {
      await this.sendToWebview({ type: 'validationError', errors });
    } else {
      vscode.window.showInformationMessage('Configuration is valid.');
    }
  }

  // ─── Export ──────────────────────────────────────────────────────

  private async handleExport(models: WebviewCompositeModel[]): Promise<void> {
    try {
      const config: Record<string, HostCompositeConfig> = {};
      for (const wm of models) {
        config[wm.modelId] = this.convertToHostConfig(wm);
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
      const parsed = JSON.parse(Buffer.from(content).toString('utf-8')) as Record<string, HostCompositeConfig>;

      // Convert to webview format
      const webviewModels = this.convertFromHostConfigs(parsed);

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

  /**
   * Convert a webview CompositeModelConfig to the host CompositeModelConfig format.
   */
  private convertToHostConfig(wm: WebviewCompositeModel): HostCompositeConfig {
    const models: (string | { id: string; weight?: number })[] = [];

    if (wm.strategy === 'failover') {
      // Sort by priority, then extract just the IDs
      const sorted = [...wm.underlyingModels].sort((a, b) => a.priority - b.priority);
      for (const um of sorted) {
        models.push(um.modelId);
      }
    } else {
      // Round-robin: include weights
      for (const um of wm.underlyingModels) {
        models.push({ id: um.modelId, weight: um.weight || 1 });
      }
    }

    return {
      strategy: wm.strategy,
      models,
      throttling: wm.throttling ? { ...wm.throttling } : undefined,
      streamingTimeoutMs: wm.streamingTimeoutMs,
      perAttemptTimeoutMs: wm.nonStreamingTimeoutMs,
      totalTimeoutMs: wm.totalTimeoutMs,
      health: wm.health
        ? {
            failureThreshold: wm.health.failureThreshold,
            degradedThreshold: wm.health.degradedThreshold,
            cooldownMs: wm.health.cooldownMs,
          }
        : undefined,
    };
  }

  /**
   * Convert host configs back to webview format (for import).
   */
  private convertFromHostConfigs(configs: Record<string, HostCompositeConfig>): WebviewCompositeModel[] {
    const result: WebviewCompositeModel[] = [];

    for (const [modelId, config] of Object.entries(configs)) {
      const underlyingModels: WebviewCompositeModel['underlyingModels'] = [];

      let idx = 0;
      for (const entry of config.models) {
        idx++;
        if (typeof entry === 'string') {
          const provider = this.resolveProvider(entry);
          underlyingModels.push({
            modelId: entry,
            provider,
            weight: 1,
            priority: idx,
          });
        } else {
          const provider = this.resolveProvider(entry.id);
          underlyingModels.push({
            modelId: entry.id,
            provider,
            weight: entry.weight ?? 1,
            priority: idx,
          });
        }
      }

      result.push({
        modelId,
        strategy: config.strategy,
        streamingTimeoutMs: config.streamingTimeoutMs ?? 30000,
        nonStreamingTimeoutMs: config.perAttemptTimeoutMs ?? 120000,
        totalTimeoutMs: config.totalTimeoutMs ?? 300000,
        health: config.health
          ? {
              failureThreshold: config.health.failureThreshold ?? 3,
              degradedThreshold: config.health.degradedThreshold ?? 1,
              cooldownMs: config.health.cooldownMs ?? 30000,
            }
          : undefined,
        throttling: config.throttling,
        underlyingModels,
      });
    }

    return result;
  }

  private resolveProvider(modelId: string): string {
    const found = ALL_MODELS.find(
      (m) => m.id === modelId || `${m.provider}/${m.id}` === modelId,
    );
    return found?.provider ?? '';
  }

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
          const parsed = JSON.parse(content) as Record<string, HostCompositeConfig>;
          return this.convertFromHostConfigs(parsed);
        }
      } catch {
        // Fall through to inline config
      }
    }

    // Priority 2: compositeModelsConfig (inline JSON)
    const inlineConfig = wsConfig.get<string>('compositeModelsConfig');
    if (inlineConfig && inlineConfig.trim()) {
      try {
        const parsed = JSON.parse(inlineConfig) as Record<string, HostCompositeConfig>;
        return this.convertFromHostConfigs(parsed);
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

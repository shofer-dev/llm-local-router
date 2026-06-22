/**
 * VS Code Language Model Chat Provider implementation.
 *
 * Bridges VS Code's LanguageModelChatProvider API to the internal provider
 * router, which talks directly to LLM provider APIs. This is the main
 * integration point that makes models available to VS Code Copilot and
 * Shofer's vscode-lm handler.
 *
 * internal ProviderRouter + CompositeService.
 */

import * as vscode from 'vscode';
import { ProviderRouter } from './provider-client';
import { CompositeService } from './composite';
import {
    ProviderModelInfo,
    ModelCapabilities,
    ModelPricingPerMillion,
    ConnectionStatus,
    RouterConfig,
    MessageRole,
    ToolCall,
    ContentPart,
    ChatMessage,
    ToolDefinition,
    ChatCompletionRequest,
    ChatCompletionResponse,
    MetricsRequestEntry,
    ErrorType,
} from './types';
import { getProviderModelInfoList, toPerMillionPricing } from './llm-client';
import { CustomProviderConfig, CustomProviderModel } from './types';
import { ALL_MODELS, getProviderForModel } from './model-registry';
import { getLogger, Logger } from './logger';
import { getMetricsCollector, classifyError } from './metrics-collector';

export { ProviderModelInfo, ModelCapabilities, ModelPricingPerMillion, ConnectionStatus, RouterConfig };

export class LanguageModelProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
    private router: ProviderRouter;
    private composite: CompositeService;
    private logger: Logger;
    private availableModels: ProviderModelInfo[] = [];
    private config: RouterConfig;
    private connectionStatus: ConnectionStatus = {
        isConnected: false,
        lastChecked: new Date(),
    };
    private _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    public readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    /**
     * Per-conversation USD cost ledger. Accumulates cost from each completion
     * response. Exposed via the shofer.llm.getRequestCost command.
     */
    private requestCostLedger: Map<string, { totalUsd: number; lastUpdatedMs: number }> = new Map();
    private static readonly MAX_COST_LEDGER_SIZE = 1024;

    constructor(config: RouterConfig) {
        this.config = config;
        this.router = new ProviderRouter();
        this.composite = new CompositeService(this.router);
        this.logger = getLogger();
    }

    // ─── Configuration ────────────────────────────────────────────

    updateConfig(config: RouterConfig): void {
        this.config = config;
        this.logger.info('Configuration updated');
    }

    getConfig(): RouterConfig {
        return this.config;
    }

    /**
     * Update provider API keys from SecretStorage.
     */
    updateApiKeys(keys: Record<string, string | undefined>): void {
        this.router.updateApiKeys(keys);
    }

    /**
     * Update custom provider configurations and their API keys.
     */
    updateCustomProviders(providers: Map<string, CustomProviderConfig>, apiKeys: Record<string, string>): void {
        this.router.updateCustomProviders(providers);
        this.router.updateCustomApiKeys(apiKeys);
    }

    /**
     * Update custom provider endpoint URLs from SecretStorage.
     */
    updateEndpointUrls(urls: Record<string, string>): void {
        this.router.updateEndpointUrls(urls);
    }

    /**
     * Update composite model configurations.
     */
    updateCompositeModels(models: Record<string, any>): void {
        this.composite.loadConfigs(models);
        this.logger.info(`Loaded ${Object.keys(models).length} composite models`);
    }

    // ─── Model management ─────────────────────────────────────────

    setAvailableModels(models: ProviderModelInfo[]): void {
        this.availableModels = models;
        this._onDidChangeLanguageModelChatInformation.fire();
    }

    getAvailableModels(): ProviderModelInfo[] {
        return this.availableModels;
    }

    findModel(modelId: string): ProviderModelInfo | undefined {
        return this.availableModels.find(m => m.id === modelId || m.family === modelId);
    }

    /**
     * Refresh the model list. Since we have a built-in registry, this is
     * mostly a no-op but still fires the change event so the VS Code LM
     * API picks up models.
     */
    /**
     * Compute the capability intersection and min context/max_output for a
     * composite model based on its underlying models. Returns undefined
     * if no underlying models are found in the registry.
     */
    private computeCompositeModelInfo(compositeId: string): ProviderModelInfo | undefined {
        const resolved = this.composite.getResolvedModels(compositeId);
        if (resolved.length === 0) return undefined;

        let minInput = Infinity;
        let minOutput = Infinity;
        let imageInput = true;
        let toolCalling = true;
        let promptCache = true;

        for (const rm of resolved) {
            const m = this.availableModels.find(a => a.id === rm.id);
            if (!m) continue;
            minInput = Math.min(minInput, m.maxInputTokens);
            minOutput = Math.min(minOutput, m.maxOutputTokens);
            imageInput = imageInput && m.capabilities.imageInput;
            toolCalling = toolCalling && m.capabilities.toolCalling;
            promptCache = promptCache && m.capabilities.promptCache;
        }

        if (!isFinite(minInput)) return undefined;

        return {
            id: compositeId,
            name: compositeId,
            family: compositeId.replace(/\//g, '_'),
            version: '1.0',
            maxInputTokens: minInput,
            maxOutputTokens: minOutput,
            capabilities: { imageInput, toolCalling, promptCache },
            // Composite models don't have a single price; pricing is resolved
            // per-request based on the underlying model that served it.
            pricing: undefined,
        };
    }

    /**
     * Convert a custom provider model to a ProviderModelInfo entry.
     */
    private customModelToProviderInfo(model: CustomProviderModel, providerId: string, providerLabel: string, pricing?: { prompt?: number; completion?: number; cacheRead?: number }): ProviderModelInfo {
        const pricingPerMillion = pricing
            ? {
                inputPrice: (pricing.prompt ?? 0) * 1000,
                outputPrice: (pricing.completion ?? 0) * 1000,
                cacheReadsPrice: (pricing.cacheRead ?? 0) * 1000,
              }
            : undefined;
        return {
            id: model.id,
            name: model.name,
            family: providerId,
            version: '1.0',
            maxInputTokens: model.contextLength,
            maxOutputTokens: model.maxOutputTokens,
            capabilities: {
                imageInput: model.imageInput,
                toolCalling: model.toolCalling,
                promptCache: false,
            },
            pricing: pricingPerMillion,
        };
    }

    async fetchModels(): Promise<ProviderModelInfo[]> {
        const models = getProviderModelInfoList();

        // Append composite model entries with computed capability intersections
        for (const compositeId of this.composite.getCompositeModelIds()) {
            const info = this.computeCompositeModelInfo(compositeId);
            if (info) models.push(info);
        }

        // Append custom provider model entries
        const customModels = this.router.getCustomProviderModels();
        for (const cm of customModels) {
            models.push(this.customModelToProviderInfo(cm.model, cm.providerId, cm.providerLabel, cm.pricing));
        }

        this.setAvailableModels(models);
        this.connectionStatus = {
            isConnected: this.router.hasAnyApiKey(),
            lastChecked: new Date(),
        };
        return models;
    }

    // ─── VS Code LM API ───────────────────────────────────────────

    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (!this.config.enabled) return [];

        const allModels = this.availableModels.length > 0
            ? this.availableModels
            : await this.fetchModels();

        // Only expose models from providers with API keys configured.
        // Composite models (shofer/*) are always included since they
        // route through configured underlying providers.
        const models = allModels.filter(m => {
            if (m.id.startsWith('shofer/')) return true;
            const provider = getProviderForModel(m.id);
            if (provider) return this.router.hasApiKeyForProvider(provider);
            // Custom provider models (family = custom provider ID). A custom
            // provider is user-registered, so its presence in the config is the
            // opt-in signal to expose it — unlike built-in providers it may
            // legitimately have no API key (e.g. a local endpoint). Fall back to
            // the API-key check for robustness if it is not (yet) registered.
            return this.router.isCustomProvider(m.family) || this.router.hasApiKeyForProvider(m.family);
        });

        return models.map((model, index) => ({
            id: model.id,
            name: model.name,
            family: model.family,
            version: model.version,
            tooltip: `${model.name} via Shofer Router`,
            detail: `${model.family}`,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            isDefault: index === 0,
            isUserSelectable: true,
            capabilities: {
                imageInput: model.capabilities.imageInput,
                toolCalling: model.capabilities.toolCalling,
            },
        }));
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        if (!this.config.enabled) {
            throw new Error('Shofer Router is disabled');
        }

        const modelId = model.id;
        let conversationId = options.modelOptions?.conversationId as string | undefined;
        const parentConversationId = options.modelOptions?.parentConversationId as string | undefined;
        const rootConversationId = options.modelOptions?.rootConversationId as string | undefined;

        // Structured request log at INFO level
        const msgCount = messages.length;
        const lastMsgRole = messages.length > 0
            ? String(messages[messages.length - 1].role)
            : 'none';
        this.logger.info(
            `REQ → model=${modelId} conv=${conversationId || '?'} ` +
            `root=${rootConversationId || '?'} msgs=${msgCount} last=${lastMsgRole}`
        );

        // conversationId is optional — generate a fallback if not provided.
        // This allows the extension to work with upstream callers (e.g. Copilot)
        // that don't supply conversation IDs.
        if (!conversationId) {
            conversationId = `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        // parentConversationId and rootConversationId already extracted above

        // Extract systemPrompt from modelOptions (VS Code API lacks System role)
        const systemPrompt = options.modelOptions?.systemPrompt as string | undefined;

        // Extract maxTokens / temperature from modelOptions (caller-overridable)
        const maxTokens = options.modelOptions?.maxTokens as number | undefined;
        const temperature = (options.modelOptions?.temperature as number | undefined) ?? 0.7;

        // Convert VS Code messages to our message format
        const chatMessages = this.convertVSCodeMessages(messages);

        // Prepend system prompt as a System role message if provided
        if (systemPrompt) {
            chatMessages.unshift({
                role: MessageRole.System,
                content: systemPrompt,
            });
        }

        // Diagnostic tool call sequence validation
        this.validateOpenAIToolCallSequence(chatMessages, conversationId);

        // Convert VS Code tools
        const tools = this.convertVSCodeTools(options.tools);

        // Build the request
        const request: ChatCompletionRequest = {
            conversationId,
            parentConversationId,
            rootConversationId,
            model: modelId,
            messages: chatMessages,
            temperature,
            maxTokens,
            stream: true,
            tools: tools.length > 0 ? tools : undefined,
            toolChoice: tools.length > 0 ? 'auto' : undefined,
        };

        // Create abort controller for cancellation
        const abortController = new AbortController();
        token.onCancellationRequested(() => {
            abortController.abort();
            this.logger.debug('Chat request cancelled');
        });

        // Track tool calls being reported to avoid duplicates
        const reportedToolCalls = new Set<string>();
        const accumulatedToolCalls: Map<number, { id?: string; type?: string; name?: string; arguments?: string }> = new Map();

        let lastVisibleEmitMs = Date.now();
        const buildPreparingMarker = (name: string, byteCount: number): string =>
            `\x00tool_preparing\x00${name}\x00${byteCount}\x00`;

        // Response metadata marker for the caller (e.g. Shofer's vscode-lm).
        // Uses \x00-delimited format so the caller can parse it consistently.
        // Emitted as a LanguageModelThinkingPart at stream end.
        const buildMetadataMarker = (meta: Record<string, unknown>): string =>
            `\x00response_metadata\x00${JSON.stringify(meta)}\x00`;
        let metadataMarker = '';

        // Metrics: track timing
        const requestStartMs = Date.now();
        let ttfbMs = 0;
        const isComposite = this.composite.isCompositeModel(modelId);

        try {
            const onChunk = (chunk: ChatCompletionResponse) => {
                // Record TTFB on first chunk
                if (ttfbMs === 0) {
                    ttfbMs = Date.now() - requestStartMs;
                }
                for (const choice of chunk.choices) {
                    // Report reasoning content
                    if (choice.delta?.reasoningContent?.trim()) {
                        const thinkingPart = new vscode.LanguageModelThinkingPart(choice.delta.reasoningContent);
                        progress.report(thinkingPart);
                        lastVisibleEmitMs = Date.now();
                    }

                    // Report text content
                    if (choice.delta?.content) {
                        const textPart = new vscode.LanguageModelTextPart(choice.delta.content);
                        progress.report(textPart);
                        lastVisibleEmitMs = Date.now();
                    }

                    // Accumulate tool calls from delta
                    if (choice.delta?.toolCalls) {
                        for (const tc of choice.delta.toolCalls) {
                            const tcIndex = tc.index ?? 0;
                            const existing = accumulatedToolCalls.get(tcIndex) || {};
                            if (tc.id) existing.id = tc.id;
                            if (tc.type) existing.type = tc.type;
                            if (tc.function?.name) existing.name = tc.function.name;
                            if (tc.function?.arguments) {
                                existing.arguments = (existing.arguments || '') + tc.function.arguments;
                            }
                            accumulatedToolCalls.set(tcIndex, existing);

                            // Emit tool_preparing marker
                            if (existing.name) {
                                const byteCount = Buffer.byteLength(existing.arguments || '', 'utf8');
                                progress.report(new vscode.LanguageModelThinkingPart(
                                    buildPreparingMarker(existing.name, byteCount)
                                ));
                                lastVisibleEmitMs = Date.now();
                            }
                        }
                    }

                    // Report accumulated tool calls when stream is complete
                    if (choice.finishReason && accumulatedToolCalls.size > 0) {
                        for (const [tcIdx, tc] of accumulatedToolCalls) {
                            if (tc.id && tc.name && !reportedToolCalls.has(tc.id)) {
                                reportedToolCalls.add(tc.id);
                                try {
                                    const args = tc.arguments ? JSON.parse(tc.arguments) : {};
                                    const toolCallPart = new vscode.LanguageModelToolCallPart(tc.id, tc.name, args);
                                    progress.report(toolCallPart);
                                } catch (parseError) {
                                    this.logger.warning(`Failed to parse tool call arguments for ${tc.name}: ${parseError}`);
                                }
                            }
                        }
                    }
                }
            };

            let result: {
                response: ChatCompletionResponse;
                servedByModel: string;
                failoverOccurred: boolean;
                attempts: number;
            };

            if (isComposite) {
                const compositeResult = await this.composite.sendCompositeRequest(
                    modelId, request, onChunk, abortController
                );
                result = {
                    response: compositeResult.response,
                    servedByModel: compositeResult.servedByModel,
                    failoverOccurred: compositeResult.failoverOccurred,
                    attempts: compositeResult.attempts,
                };
            } else {
                const response = await this.router.sendStreamingRequest(
                    modelId, request, onChunk, abortController
                );
                result = { response, servedByModel: modelId, failoverOccurred: false, attempts: 1 };
            }

            const ttlbMs = Date.now() - requestStartMs;
            const usage = result.response.usage;

            // Build response metadata marker for the caller
            metadataMarker = buildMetadataMarker({
                model: modelId,
                actualModel: result.servedByModel,
                ttfbMs,
                ttlbMs,
                promptTokens: usage?.promptTokens ?? 0,
                completionTokens: usage?.completionTokens ?? 0,
                costUsd: usage?.costUsd,
                attempts: result.attempts,
            });

            // Structured success log at INFO level
            const costStr = usage?.costUsd !== undefined
                ? `$${usage.costUsd.toFixed(6)}`
                : '?';
            this.logger.info(
                `RES ← model=${modelId}` +
                (result.servedByModel !== modelId ? ` served=${result.servedByModel}` : '') +
                ` conv=${conversationId}` +
                ` ttfb=${ttfbMs}ms ttlb=${ttlbMs}ms` +
                (usage ? ` prompt=${usage.promptTokens} compl=${usage.completionTokens}` : '') +
                (result.failoverOccurred ? ` failover=${result.attempts}` : '') +
                ` cost=${costStr}`
            );

            if (usage?.costUsd !== undefined && usage.costUsd >= 0) {
                this.recordRequestCost(conversationId, usage.costUsd);
            }

            // Record success metrics
            this.recordMetrics(modelId, isComposite, result, ttfbMs, ttlbMs, requestStartMs);

            // Emit response metadata as a thinking part at the end of the stream
            if (metadataMarker) {
                progress.report(new vscode.LanguageModelThinkingPart(metadataMarker));
            }
        } catch (error) {
            const ttlbMs = Date.now() - requestStartMs;
            const err = error as Error;
            this.logger.errorWithError('Chat completion failed', err);

            // Record error metrics
            this.recordErrorMetrics(modelId, isComposite, err, ttfbMs, ttlbMs, requestStartMs);

            // Emit error metadata
            metadataMarker = buildMetadataMarker({ model: modelId, error: err.message, ttlbMs });
            if (metadataMarker) {
                progress.report(new vscode.LanguageModelThinkingPart(metadataMarker));
            }
            throw error;
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken,
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        }
        let totalTokens = 4; // overhead
        for (const part of text.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                totalTokens += Math.ceil(part.value.length / 4);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                totalTokens += 10 + Math.ceil(part.callId.length / 4) + Math.ceil(part.name.length / 4);
                if (part.input) {
                    totalTokens += Math.ceil(JSON.stringify(part.input).length / 4);
                }
            }
        }
        return totalTokens;
    }

    // ─── Message conversion ───────────────────────────────────────

    private convertVSCodeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): ChatMessage[] {
        const result: ChatMessage[] = [];
        const toolCallIdToAssistantIdx = new Map<string, number>();

        for (const msg of messages) {
            const role = this.convertRole(msg.role);
            const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
            const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            const imageParts: ContentPart[] = [];

            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelToolResultPart) {
                    toolResultParts.push(part);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCallParts.push(part);
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    const value = part.value;
                    if (typeof value === 'string') {
                        thinkingParts.push(value);
                    } else if (Array.isArray(value)) {
                        thinkingParts.push(...value);
                    }
                } else if (this.isDataPart(part)) {
                    const dataPart = part as any;
                    const rawData = dataPart.data;
                    const bytes: Uint8Array | undefined =
                        rawData instanceof Uint8Array ? rawData :
                        Array.isArray(rawData) ? new Uint8Array(rawData) :
                        (rawData && typeof rawData === 'object' && 'byteLength' in rawData) ? new Uint8Array(rawData) : undefined;
                    const mimeType: string = dataPart.mimeType ?? 'image/png';
                    if (bytes && bytes.length > 0 && mimeType.startsWith('image/')) {
                        const base64 = Buffer.from(bytes).toString('base64');
                        imageParts.push({
                            type: 'image_url',
                            image_url: { url: `data:${mimeType};base64,${base64}` },
                        });
                    }
                }
            }

            if (toolResultParts.length > 0) {
                for (const toolResult of toolResultParts) {
                    let content = '';
                    if (typeof toolResult.content === 'string') {
                        content = toolResult.content;
                    } else if (Array.isArray(toolResult.content)) {
                        content = toolResult.content
                            .map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '')
                            .join('\n');
                    }
                    result.push({ role: MessageRole.Tool, content, toolCallId: toolResult.callId });
                }
                if (textParts.length > 0 || imageParts.length > 0) {
                    const textContent = textParts.join('\n');
                    if (textContent.trim() || imageParts.length > 0) {
                        result.push({
                            role: MessageRole.User,
                            content: this.buildMultimodalContent(textContent, imageParts),
                        });
                    }
                }
            } else if (toolCallParts.length > 0 && role === MessageRole.Assistant) {
                const toolCalls: ToolCall[] = toolCallParts.map(tc => ({
                    id: tc.callId,
                    type: 'function' as const,
                    function: { name: tc.name, arguments: JSON.stringify(tc.input) },
                }));
                const assistantIdx = result.length;
                for (const tc of toolCalls) {
                    if (tc.id) toolCallIdToAssistantIdx.set(tc.id, assistantIdx);
                }
                result.push({
                    role: MessageRole.Assistant,
                    content: textParts.join('\n'),
                    toolCalls,
                    reasoningContent: thinkingParts.length > 0 ? thinkingParts.join('\n') : undefined,
                });
            } else {
                const textContent = textParts.join('\n');
                const msg: ChatMessage = {
                    role,
                    content: this.buildMultimodalContent(textContent, imageParts),
                };
                if (thinkingParts.length > 0 && role === MessageRole.Assistant) {
                    msg.reasoningContent = thinkingParts.join('\n');
                }
                result.push(msg);
            }
        }

        this.reorderToolMessages(result, toolCallIdToAssistantIdx);
        return result;
    }

    private buildMultimodalContent(text: string, images: ContentPart[]): string | ContentPart[] {
        if (images.length === 0) return text;
        const parts: ContentPart[] = [];
        if (text.length > 0) parts.push({ type: 'text', text });
        parts.push(...images);
        return parts;
    }

    private isDataPart(part: unknown): boolean {
        const DataPartCtor = (vscode as any).LanguageModelDataPart;
        if (DataPartCtor && part instanceof DataPartCtor) return true;
        if (!part || typeof part !== 'object') return false;
        const anyPart = part as any;
        return typeof anyPart.mimeType === 'string'
            && (anyPart.data instanceof Uint8Array || Array.isArray(anyPart.data)
                || (anyPart.data && typeof anyPart.data === 'object' && 'byteLength' in anyPart.data));
    }

    private reorderToolMessages(msgs: ChatMessage[], toolCallIdToAssistantIdx: ReadonlyMap<string, number>): void {
        if (msgs.length < 2 || toolCallIdToAssistantIdx.size === 0) return;

        // Dedup tool messages by tool_call_id
        const seen = new Set<string>();
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (m.role !== MessageRole.Tool) continue;
            const tcid = m.toolCallId ?? '';
            if (!tcid) continue;
            if (seen.has(tcid)) {
                this.logger.warning(`[TOOL_SEQ_INVALID] Dropping duplicate tool message for ${tcid}`);
                msgs.splice(i, 1);
                i--;
                continue;
            }
            seen.add(tcid);
        }

        // Collect out-of-place tool messages
        const moves: Array<{ msg: ChatMessage; targetIdx: number }> = [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role !== MessageRole.Tool) continue;
            const tcid = m.toolCallId ?? '';
            const assistIdx = toolCallIdToAssistantIdx.get(tcid);
            if (assistIdx === undefined) {
                this.logger.warning(`[TOOL_SEQ_INVALID] Dropping orphaned tool message for ${tcid}`);
                msgs.splice(i, 1);
                continue;
            }
            if (assistIdx >= i) continue;
            let allToolsBetween = true;
            for (let j = assistIdx + 1; j < i; j++) {
                if (msgs[j].role !== MessageRole.Tool) { allToolsBetween = false; break; }
            }
            if (allToolsBetween) continue;
            moves.push({ msg: m, targetIdx: assistIdx });
            msgs.splice(i, 1);
        }

        if (moves.length === 0) return;
        moves.sort((a, b) => a.targetIdx - b.targetIdx);
        for (let mi = moves.length - 1; mi >= 0; mi--) {
            const { msg, targetIdx } = moves[mi];
            let insertAt = targetIdx + 1;
            while (insertAt < msgs.length && msgs[insertAt].role === MessageRole.Tool) insertAt++;
            msgs.splice(insertAt, 0, msg);
        }
    }

    private validateOpenAIToolCallSequence(msgs: ChatMessage[], conversationId: string): void {
        const roleSeq = msgs.map(m => {
            if (m.role === MessageRole.Assistant) return m.toolCalls && m.toolCalls.length > 0 ? 'a*' : 'a';
            if (m.role === MessageRole.Tool) return 't';
            if (m.role === MessageRole.System) return 's';
            return 'u';
        }).join(',');

        const toolCallIdToAssistantIndices = new Map<string, number[]>();
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (m.role !== MessageRole.Assistant || !m.toolCalls) continue;
            for (const tc of m.toolCalls) {
                if (!tc.id) continue;
                const arr = toolCallIdToAssistantIndices.get(tc.id) ?? [];
                arr.push(i);
                toolCallIdToAssistantIndices.set(tc.id, arr);
            }
        }
        for (const [id, indices] of toolCallIdToAssistantIndices) {
            if (indices.length > 1) {
                this.logger.warning(
                    `[TOOL_SEQ_INVALID] duplicate tool_call.id across assistant turns ` +
                    `conversationId=${conversationId} tool_call_id=${id} ` +
                    `assistant_indices=[${indices.join(',')}] role_seq=${roleSeq}`
                );
            }
        }
    }

    private convertRole(role: vscode.LanguageModelChatMessageRole): MessageRole {
        switch (role) {
            case vscode.LanguageModelChatMessageRole.User: return MessageRole.User;
            case vscode.LanguageModelChatMessageRole.Assistant: return MessageRole.Assistant;
            default: return MessageRole.User;
        }
    }

    private convertVSCodeTools(tools?: readonly vscode.LanguageModelChatTool[]): ToolDefinition[] {
        if (!tools || tools.length === 0) return [];
        return tools.map(tool => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema as Record<string, unknown> | undefined,
            },
        }));
    }

    // ─── Cost ledger ──────────────────────────────────────────────

    private recordRequestCost(conversationId: string, costUsd: number): void {
        if (!conversationId || !Number.isFinite(costUsd) || costUsd < 0) return;
        const existing = this.requestCostLedger.get(conversationId);
        const total = (existing?.totalUsd ?? 0) + costUsd;
        this.requestCostLedger.delete(conversationId);
        this.requestCostLedger.set(conversationId, { totalUsd: total, lastUpdatedMs: Date.now() });
        while (this.requestCostLedger.size > LanguageModelProvider.MAX_COST_LEDGER_SIZE) {
            const oldestKey = this.requestCostLedger.keys().next().value;
            if (oldestKey === undefined) break;
            this.requestCostLedger.delete(oldestKey);
        }
    }

    public getRequestCost(conversationId: string): number | undefined {
        if (!conversationId) return undefined;
        return this.requestCostLedger.get(conversationId)?.totalUsd;
    }

    public getPricing(modelId: string): ModelPricingPerMillion | undefined {
        if (!modelId) return undefined;
        const direct = this.availableModels.find(m => m.id === modelId || m.family === modelId);
        if (direct?.pricing) return direct.pricing;
        const suffixMatch = this.availableModels.find(m => {
            const slash = m.id.lastIndexOf('/');
            return slash !== -1 && m.id.substring(slash + 1) === modelId;
        });
        return suffixMatch?.pricing ?? toPerMillionPricing(modelId);
    }

    public getCapabilities(modelId: string): ModelCapabilities | undefined {
        if (!modelId) return undefined;
        const direct = this.availableModels.find(m => m.id === modelId || m.family === modelId);
        if (direct) return direct.capabilities;
        const suffixMatch = this.availableModels.find(m => {
            const slash = m.id.lastIndexOf('/');
            return slash !== -1 && m.id.substring(slash + 1) === modelId;
        });
        return suffixMatch?.capabilities;
    }

    // ─── Connection ───────────────────────────────────────────────

    async testConnection(): Promise<boolean> {
        try {
            const models = await this.fetchModels();
            this.connectionStatus = {
                isConnected: models.length > 0 && this.router.hasAnyApiKey(),
                lastChecked: new Date(),
            };
            return this.connectionStatus.isConnected;
        } catch (error) {
            this.connectionStatus = {
                isConnected: false,
                lastChecked: new Date(),
                error: error instanceof Error ? error.message : String(error),
            };
            return false;
        }
    }

    getConnectionStatus(): ConnectionStatus {
        return this.connectionStatus;
    }

    isReady(): boolean {
        return this.config.enabled && this.connectionStatus.isConnected;
    }

    /**
     * Count how many upstream providers have API keys configured.
     */
    getConfiguredProviderCount(): number {
        return this.router.getConfiguredProviderCount();
    }

    // ─── Metrics recording ────────────────────────────────────────

    /**
     * Build and record a MetricsRequestEntry on successful completion.
     */
    private recordMetrics(
        modelId: string,
        isComposite: boolean,
        result: { response: ChatCompletionResponse; servedByModel: string; failoverOccurred: boolean; attempts: number },
        ttfbMs: number,
        ttlbMs: number,
        requestStartMs: number,
    ): void {
        try {
            const usage = result.response.usage;
            const provider = getProviderForModel(result.servedByModel) ?? 'unknown';

            const entry: MetricsRequestEntry = {
                timestamp: new Date(requestStartMs).toISOString(),
                modelId,
                provider,
                isComposite,
                compositeModelId: isComposite ? modelId : undefined,
                servedByModel: result.servedByModel,
                status: 'success',
                ttfbMs,
                ttlbMs,
                promptTokens: usage?.promptTokens ?? 0,
                completionTokens: usage?.completionTokens ?? 0,
                cachedTokens: usage?.cachedTokens ?? 0,
                cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
                costUsd: usage?.costUsd ?? 0,
                failoverOccurred: result.failoverOccurred,
                attempts: result.attempts,
            };

            getMetricsCollector().recordRequest(entry);
        } catch (metricsError) {
            // Metrics recording must never throw — silently ignore
            this.logger.debug(`Failed to record success metrics: ${(metricsError as Error).message}`);
        }
    }

    /**
     * Build and record a MetricsRequestEntry on failed completion.
     */
    private recordErrorMetrics(
        modelId: string,
        isComposite: boolean,
        error: Error,
        ttfbMs: number,
        ttlbMs: number,
        requestStartMs: number,
    ): void {
        try {
            const { errorType, status } = classifyError(error);
            // Best-effort provider resolution from modelId
            const provider = getProviderForModel(modelId) ?? 'unknown';

            const entry: MetricsRequestEntry = {
                timestamp: new Date(requestStartMs).toISOString(),
                modelId,
                provider,
                isComposite,
                compositeModelId: isComposite ? modelId : undefined,
                servedByModel: modelId, // unknown which would have served
                status,
                errorType,
                errorMessage: error.message,
                ttfbMs,
                ttlbMs,
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                cacheCreationTokens: 0,
                costUsd: 0,
                failoverOccurred: false,
                attempts: 0,
            };

            getMetricsCollector().recordRequest(entry);
        } catch (metricsError) {
            // Metrics recording must never throw — silently ignore
            this.logger.debug(`Failed to record error metrics: ${(metricsError as Error).message}`);
        }
    }

    dispose(): void {
        this._onDidChangeLanguageModelChatInformation.dispose();
    }
}

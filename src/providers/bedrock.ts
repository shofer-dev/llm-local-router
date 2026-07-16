/**
 * AWS Bedrock provider client.
 *
 * Bedrock uses the Converse API, which is fundamentally different from
 * the OpenAI-compatible format. This provider requires AWS SDK credentials and
 * routes through a custom send path.
 *
 * Note: Full Bedrock support requires the @aws-sdk/client-bedrock-runtime
 * package. Since llm-local-router is designed to be zero-dependency (no external
 * SDKs), this provider currently serves as a registration point. The actual
 * AWS SDK integration would need to be vendored or the extension would need
 * the SDK as a dependency.
 *
 * For now, Bedrock models are registered in the model registry for visibility
 * and routing, but the actual send path falls through to a default
 * OpenAI-compatible passthrough (users should configure Bedrock via the
 * mistral/OpenAI proxy path or use a custom provider).
 */

import { ChatCompletionRequest } from '../types';
import { getLogger } from '../logger';

export function prepareBedrockRequest(req: ChatCompletionRequest): void {
    const logger = getLogger();
    logger.warning(`[BEDROCK] Bedrock provider is a registration-only stub. Use a custom provider for AWS Bedrock integration.`);

    // Bedrock requires the anthropic_version parameter in the request body
    if (!req.extraBody) req.extraBody = {};
    req.extraBody.anthropic_version = 'bedrock-2023-05-31';
}

export function getBedrockBaseUrl(): string {
    return 'https://bedrock-runtime.us-east-1.amazonaws.com';
}

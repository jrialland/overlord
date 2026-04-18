import type { EmbeddingModel, LanguageModel } from "ai";
import { createGateway, embed } from "ai";
import { createOllama } from 'ollama-ai-provider-v2';
import { Ollama } from 'ollama';
import { logger } from '../logging';
import vendoredModelCostMap from '../model_prices_and_context_window.json';
import { asPositiveNumber } from './usage-parser';

type LiteLlmModelMetadata = {
    max_input_tokens?: unknown;
    max_tokens?: unknown;
};

type LiteLlmModelMap = Record<string, LiteLlmModelMetadata>;

/**
 * Vendored LiteLLM model metadata map.
 *
 * The file was copied from:
 * https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *
 * This is a community-maintained dataset and should be refreshed from time to time.
 * It is statically imported on purpose so Bun can bundle it into a standalone executable
 * instead of relying on a runtime file path that would break after compilation.
 */
const modelCostMap = vendoredModelCostMap as LiteLlmModelMap;

function getContextWindowFromVendoredMap(modelName: string, modelCostMap: LiteLlmModelMap): number | undefined {
    const candidateNames = [
        modelName,
        modelName.includes('/') ? modelName.slice(modelName.indexOf('/') + 1) : undefined,
    ].filter((value): value is string => Boolean(value));

    for (const candidateName of candidateNames) {
        const modelInfo = modelCostMap[candidateName];
        if (!modelInfo) {
            continue;
        }

        const contextWindow =
            asPositiveNumber(modelInfo.max_input_tokens) ??
            asPositiveNumber(modelInfo.max_tokens);

        if (contextWindow) {
            return contextWindow;
        }
    }

    return undefined;
}

/**
 * Query Ollama directly for model's context window size.
 * Ollama exposes this via the show endpoint as 'num_ctx'.
 */
async function getOllamaContextWindow(modelName: string, ollamaConfig?: Record<string, unknown>): Promise<number | undefined> {
    try {
        const ollamaHost = ollamaConfig?.host as string | undefined ?? 'http://127.0.0.1:11434';
        const ollama = new Ollama({ host: ollamaHost });
        const modelInfo = await ollama.show({ model: modelName });
        const numCtx = asPositiveNumber(modelInfo.model_info?.get?.('num_ctx'));
        if (numCtx) {
            logger.debug({ model: modelName, contextWindow: numCtx }, "Resolved context window from Ollama");
            return numCtx;
        }
    } catch (error) {
        logger.debug({ model: modelName, error: String(error) }, "Failed to query Ollama for context window, falling back to hints");
    }
    return undefined;
}

/**
 * Resolve a model context window size using a multi-strategy approach:
 * 1. Explicit config overrides (contextWindowSize, numCtx, etc.)
 * 2. For Ollama models: Query the Ollama API directly for num_ctx
 * 3. Vendored LiteLLM model metadata map
 * 4. Final fallback: 32768 tokens (last-resort default when no real metadata exists)
 */
export async function resolveContextWindowSize(modelName: string, modelConfig?: Record<string, unknown>): Promise<number> {
    // Strategy 1: Explicit configuration takes priority
    const fromConfig =
        asPositiveNumber(modelConfig?.contextWindowSize) ??
        asPositiveNumber(modelConfig?.context_window_size) ??
        asPositiveNumber(modelConfig?.contextWindow) ??
        asPositiveNumber(modelConfig?.numCtx) ??
        asPositiveNumber(modelConfig?.num_ctx);

    if (fromConfig) {
        return fromConfig;
    }

    // Strategy 2: For Ollama models, query the API directly
    if (modelName.startsWith('ollama/')) {
        const modelId = modelName.replace('ollama/', '');
        const ollamaContextWindow = await getOllamaContextWindow(modelId, modelConfig);
        if (ollamaContextWindow) {
            return ollamaContextWindow;
        }
    }

    // Strategy 3: Use the vendored LiteLLM dataset for provider/model metadata.
    const mappedContextWindow = getContextWindowFromVendoredMap(modelName, modelCostMap);
    if (mappedContextWindow) {
        logger.debug({ model: modelName, contextWindow: mappedContextWindow }, 'Resolved context window from vendored LiteLLM model map');
        return mappedContextWindow;
    }

    // Strategy 4: Last-resort fallback when no explicit config, provider API, or vendored metadata exists.
    logger.warn(
        { model: modelName, fallbackContextWindow: 32768 },
        'Falling back to default context window size because no reliable model metadata was found'
    );
    return 128 * 1024; // 32768 tokens in units of 4 bytes/token
}

/**
 * Parses model spec into a LanguageModel instance.
 * The format is "provider/model_name"
 * https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway#model-specification
 *
 * Behavior:
 * - `ollama/...` routes to the local Ollama provider.
 * - any other prefix is delegated to AI Gateway.
 *
 * @param modelName
 * @param modelConfig Optional model-specific configuration. Supports provider-specific options.
 * @returns A configured language model instance.
 */
export async function createModel(modelName: string, modelConfig?: Record<string, unknown>): Promise<LanguageModel> {

    if (modelName.startsWith("ollama/")) {
        modelName = modelName.replace("ollama/", "");
        return createOllama(modelConfig).languageModel(modelName);
    } else {
        const gateway = createGateway(modelConfig || {});
        return gateway(modelName);
    }
}

export async function createEmbeddingModel(modelName: string, modelConfig?: Record<string, unknown>): Promise<EmbeddingModel> {
    if (modelName.startsWith("ollama/")) {
        modelName = modelName.replace("ollama/", "");
        return createOllama(modelConfig).embeddingModel(modelName);
    } else {
        const gateway = createGateway(modelConfig || {});
        return gateway.embeddingModel(modelName);
    }
}

export async function getEmbeddingModelVectorLength(model: EmbeddingModel): Promise<number> {
    // Measure vector size by performing one real embedding call. This doubles as a
    // model availability/sanity check because provider errors will surface here.
    const result = await embed({
        model,
        value: "test",
    });
    return result.embedding.length;
}
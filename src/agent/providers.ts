import type { EmbeddingModel, LanguageModel } from "ai";
import { createGateway, embed } from "ai";
import { type Provider } from "ai";
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

const DEFAULT_CONTEXT_WINDOW_SIZE = 128 * 1024; // 32768 tokens in units of 4 bytes/token

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
        { model: modelName, fallbackContextWindow: DEFAULT_CONTEXT_WINDOW_SIZE },
        'Falling back to default context window size because no reliable model metadata was found'
    );
    return DEFAULT_CONTEXT_WINDOW_SIZE;
}

/**
 * Instantiate a provider instance based on the provider name and model ID.
 * The list of supported providers commes from https://ai-sdk.dev/providers/ai-sdk-providers . Note that all providers have not been tested with this dynamic instantiation approach, so some providers may not work until they are verified and potentially adapted.
 *
 * @param provider The name of the provider. For example: "openai", "anthropic", "ollama", etc.
 * @param modelId The model identifier specific to the provider. For example: "gpt-4", "claude-2", "llama-3", etc.
 * @param modelConfig Extra model configuration options that may be needed for provider instantiation. This can include API keys, base URLs, or other provider-specific settings.
 * @returns A Promise that resolves to a Provider instance configured for the specified provider and model.
 * @throws An error if the provider is not recognized or if instantiation fails.
 */
async function resolveProvider(provider: string | undefined, modelConfig: Record<string, unknown>): Promise<Provider> {
    provider = provider || "vercel_gateway"; // Default provider if none specified
    const drivers = {
        "ollama": () => createOllama(modelConfig) as Provider,
        "vercel_gateway": () => createGateway(modelConfig) as Provider,
        "openai": () => require("@ai-sdk/openai").createOpenAI(modelConfig) as Provider,
        "anthropic": () => require("@ai-sdk/anthropic").createAnthropic(modelConfig) as Provider,
        "moonshotai": () => require("@ai-sdk/moonshotai").createMoonshotAI(modelConfig) as Provider,
        "google": () => require("@ai-sdk/google").createGoogleGenerativeAI(modelConfig) as Provider,
        "google-vertex": () => require("@ai-sdk/google-vertex").createGoogleVertex(modelConfig) as Provider,
        "azure": () => require("@ai-sdk/azure").createAzure(modelConfig) as Provider,
        "mistral": () => require("@ai-sdk/mistral").createMistral(modelConfig) as Provider,
        "xai": () => require("@ai-sdk/xai").createXAI(modelConfig) as Provider,
        "deepseek": () => require("@ai-sdk/deepseek").createDeepseek(modelConfig) as Provider,
        "cohere": () => require("@ai-sdk/cohere").createCohere(modelConfig) as Provider,
        "togetherai": () => require("@ai-sdk/togetherai").createTogetherAI(modelConfig) as Provider,
        "perplexity": () => require("@ai-sdk/perplexity").createPerplexity(modelConfig) as Provider,
        "groq": () => require("@ai-sdk/groq").createGroq(modelConfig) as Provider,
        "amazon-bedrock": () => require("@ai-sdk/amazon-bedrock").createAmazonBedrock(modelConfig) as Provider,
        "fal": () => require("@ai-sdk/fal").createFal(modelConfig) as Provider,
        "deepinfra": () => require("@ai-sdk/deepinfra").createDeepinfra(modelConfig) as Provider,
        "fireworks": () => require("@ai-sdk/fireworks").createFireworks(modelConfig) as Provider,
        "cerebras": () => require("@ai-sdk/cerebras").createCerebras(modelConfig) as Provider,
        "luma": () => require("@ai-sdk/luma").createLuma(modelConfig) as Provider,
        "baseten": () => require("@ai-sdk/baseten").createBaseten(modelConfig) as Provider,
        "portkey": () => require("@portkey-ai/vercel-provider").createPortkey(modelConfig) as Provider,
        "cloudfare_workers": () => require("@ai-sdk/cloudfare-workers").createCloudfareWorkers(modelConfig) as Provider,
    }
    const driverFactory = drivers[provider] as (() => Provider) | undefined;
    if (!driverFactory) {
        throw new Error(`Unrecognized provider "${provider}". No driver factory found.`);
    }
    return driverFactory();
}

function decodeModelSpec(modelSpec: string): { provider: string; modelId: string } {
    if (!modelSpec.includes(':')) {
        // If no provider is specified, default to vercel_gateway
        return { provider: 'vercel_gateway', modelId: modelSpec };
    }
    else {
        const index = modelSpec.indexOf(':');
        const provider = modelSpec.slice(0, index);
        const modelId = modelSpec.slice(index + 1);
        return { provider, modelId };
    }
}

/**
 * Parses model spec into a LanguageModel instance.
 * The format is "provider:model_name"
 * https://ai-sdk.dev/providers/ai-sdk-providers for a list of supported providers and model names.
 * 
 * Behavior:
 * - `ollama:...` routes to the local Ollama provider.
 * - `vercel_gateway:...` routes to the Vercel Gateway provider. ( https://ai-gateway.vercel.sh )
 *
 * @param modelName
 * @param modelConfig Optional model-specific configuration. Supports provider-specific options.
 * @returns A configured language model instance.
 */
export async function createModel(modelName: string, modelConfig?: Record<string, unknown>): Promise<LanguageModel> {
    const { provider, modelId } = decodeModelSpec(modelName);
    const providerInstance = await resolveProvider(provider!, modelConfig || {});
    return providerInstance.languageModel(modelId!);
}

/**
 * Given a model name in the format "provider:model_name", this function resolves and instantiates the corresponding embedding model.
 * The provider is determined by the prefix before the colon (e.g., "ollama", "openai", "google-vertex", etc.), and the model name is the suffix after the colon.
 * The function uses the provider name to look up the appropriate provider factory function, instantiates the provider with any given model configuration, and then calls the embeddingModel method with the model ID to get an instance of the EmbeddingModel.
 * 
 * @param modelName The name of the model in the format "provider:model_name".
 * @param modelConfig Optional model-specific configuration. Supports provider-specific options.
 * @returns A configured embedding model instance.
 */
export async function createEmbeddingModel(modelName: string, modelConfig?: Record<string, unknown>): Promise<EmbeddingModel> {
    const { provider, modelId } = decodeModelSpec(modelName);
    const providerInstance = await resolveProvider(provider!, modelConfig || {});
    return providerInstance.embeddingModel(modelId!);
}

const knownVectorLengthModels = new Map<string, number>();

/**
 * Given an embedding model, this function returns the length of the vectors produced by the model.
 * It caches the result for each model to avoid redundant computations.
 * 
 * @param model The embedding model instance.
 * @returns The length of the vectors produced by the embedding model.
 */
export async function getEmbeddingModelVectorLength(model: EmbeddingModel): Promise<number> {
    const modelName = model.toString();
    if (knownVectorLengthModels.has(modelName)) {
        return knownVectorLengthModels.get(modelName)!;
    }

    // Measure vector size by performing one real embedding call. This doubles as a
    // model availability/sanity check because provider errors will surface here.
    const result = await embed({
        model,
        value: "test",
    });
    knownVectorLengthModels.set(modelName, result.embedding.length);
    return result.embedding.length;
}
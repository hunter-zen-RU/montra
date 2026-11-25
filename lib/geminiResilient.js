/**
 * Gemini Resilient Client Wrapper
 * Handles transient spikes, 503 UNAVAILABLE ("model experiencing high demand"),
 * 429 rate limits, and network errors with exponential backoff and model cascade.
 */

const { GoogleGenAI } = require('@google/genai');

// Gemini 4 Hydrogen primary fast/reasoning model with Gemini 2.5 Flash fallbacks.
const TEXT_MODELS_CASCADE = [
  'gemini-4-hydrogen',   // Primary text & reasoning model
  'gemini-2.5-flash',      // Secondary fast text/multimodal fallback
  'gemini-2.5-flash-lite'  // Lightweight high-throughput fallback
];

/**
 * Checks if a custom non-Gemini provider key is configured in the environment.
 */
function isCustomOtherProviderSpecified() {
  const customKey = process.env.MONTRA_AI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (customKey && !customKey.startsWith('AIza')) {
    return true;
  }
  if (process.env.MONTRA_AI_PROVIDER && !['gemini', 'google'].includes(process.env.MONTRA_AI_PROVIDER.toLowerCase())) {
    return true;
  }
  return false;
}

// Default Gemini key precedence. MONTRA_DEFAULT_GEMINI_API_KEY lets an installation keep one
// shared key for chat/summaries/translation/transcription/images while MONTRA_AI_API_KEY stays
// free for an explicit custom provider.
const DEFAULT_GEMINI_KEY_ENVS = [
  'MONTRA_DEFAULT_GEMINI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY'
];

/**
 * Resolves the default Gemini API key without ever exposing the value in logs or status.
 * Returns { key, source } where source is the environment variable that supplied it.
 */
function getDefaultGeminiKey() {
  for (const name of DEFAULT_GEMINI_KEY_ENVS) {
    const value = String(process.env[name] || '').trim();
    if (value) return { key: value, source: name };
  }
  const montraKey = String(process.env.MONTRA_AI_API_KEY || '').trim();
  if (montraKey.startsWith('AIza')) return { key: montraKey, source: 'MONTRA_AI_API_KEY' };
  return { key: null, source: null };
}

/**
 * Checks if the default Gemini API key is available in the environment.
 */
function hasDefaultGeminiKey() {
  return Boolean(getDefaultGeminiKey().key);
}

/**
 * Creates or gets the GoogleGenAI client singleton or a client configured with customKey.
 * Defaults automatically to the resolved default Gemini key if no custom key is provided.
 */
function getGeminiClient(customKey) {
  const apiKey = (customKey && typeof customKey === 'string' && customKey.trim())
    || getDefaultGeminiKey().key;

  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

/**
 * Returns diagnostic metadata about the active AI provider.
 */
function getProviderStatus(customKey) {
  const customOther = isCustomOtherProviderSpecified();
  const defaultKey = getDefaultGeminiKey();
  const hasCustomKey = Boolean(customKey && typeof customKey === 'string' && customKey.trim());
  const effectiveProvider = (!hasCustomKey && customOther) ? 'custom_other' : 'gemini';

  return {
    provider: effectiveProvider,
    usingDefaultGeminiKey: !hasCustomKey && !customOther && Boolean(defaultKey.key),
    hasDefaultGeminiKey: Boolean(defaultKey.key),
    defaultKeySource: defaultKey.source,
    hasCustomKey,
    customOtherProviderSpecified: customOther,
    defaultModel: 'gemini-4-hydrogen',
    availableModels: TEXT_MODELS_CASCADE
  };
}

/**
 * Checks if an error is transient (503, high demand, 429 rate limit, 500, network error).
 */
function isTransientError(err) {
  if (!err) return false;

  const rawMsg = typeof err === 'string' ? err : (err.message || String(err));
  let parsedError = null;

  try {
    if (rawMsg.startsWith('{') && rawMsg.endsWith('}')) {
      parsedError = JSON.parse(rawMsg);
    }
  } catch (e) {
    // not JSON
  }

  const code = err.status || err.statusCode || err.code || parsedError?.error?.code || parsedError?.error?.status;
  const message = (parsedError?.error?.message || rawMsg).toLowerCase();

  // Explicit HTTP/gRPC status codes
  if (code === 503 || code === 'UNAVAILABLE' || code === 429 || code === 'RESOURCE_EXHAUSTED' || code === 500 || code === 502 || code === 504) {
    return true;
  }

  // Common transient strings from Gemini API
  if (
    message.includes('503') ||
    message.includes('unavailable') ||
    message.includes('high demand') ||
    message.includes('spikes in demand') ||
    message.includes('try again later') ||
    message.includes('resource_exhausted') ||
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('overloaded') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('fetch failed')
  ) {
    return true;
  }

  return false;
}

/**
 * Formats a clean, readable error string without exposing raw JSON blobs.
 */
function formatAiErrorMessage(err) {
  if (!err) return 'Unknown AI error';
  const rawMsg = typeof err === 'string' ? err : (err.message || String(err));

  try {
    if (rawMsg.startsWith('{') && rawMsg.endsWith('}')) {
      const parsed = JSON.parse(rawMsg);
      if (parsed?.error?.message) {
        if (parsed.error.code === 503 || parsed.error.status === 'UNAVAILABLE') {
          return `Gemini AI is temporarily experiencing peak demand (${parsed.error.message}). Retries were attempted; please try again in a few moments.`;
        }
        return parsed.error.message;
      }
    }
  } catch (e) {
    // ignore
  }

  if (isTransientError(err)) {
    return 'Gemini AI is currently under temporary high demand across regional nodes. Please try again shortly.';
  }

  return rawMsg;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes generateContent with automatic exponential backoff retry and model fallback cascade.
 *
 * @param {Object} options
 * @param {string} [options.preferredModel] - Model to attempt first (defaults to gemini-2.5-flash)
 * @param {Array<string>} [options.modelsCascade] - Custom model cascade list
 * @param {Array|Object} options.contents - Content parameter for generateContent
 * @param {Object} [options.config] - Optional generation config (temperature, maxOutputTokens, etc.)
 * @param {number} [options.retriesPerModel=2] - Max retries on each model before falling back to next
 * @param {GoogleGenAI} [options.aiClient] - Optional pre-instantiated client
 * @returns {Promise<any>} Response object from gemini.models.generateContent
 */
async function generateContentWithRetry({
  preferredModel = null,
  modelsCascade = null,
  contents,
  config = {},
  retriesPerModel = 2,
  aiClient = null,
  customApiKey = null
}) {
  const ai = aiClient || getGeminiClient(customApiKey);
  if (!ai) {
    throw new Error('Gemini API client is not configured. Missing GEMINI_API_KEY.');
  }

  // Build model cascade
  let models = modelsCascade || [...TEXT_MODELS_CASCADE];
  if (preferredModel && !models.includes(preferredModel)) {
    models = [preferredModel, ...models];
  } else if (preferredModel) {
    models = [preferredModel, ...models.filter(m => m !== preferredModel)];
  }

  let lastError = null;

  for (let mIdx = 0; mIdx < models.length; mIdx++) {
    const currentModel = models[mIdx];
    const isLastModel = mIdx === models.length - 1;

    for (let attempt = 0; attempt < retriesPerModel; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: currentModel,
          contents,
          config
        });
        if (response) {
          response.modelUsed = currentModel;
        }
        return response;
      } catch (err) {
        lastError = err;
        const transient = isTransientError(err);

        console.warn(
          `[Gemini Resilience] Model '${currentModel}' (attempt ${attempt + 1}/${retriesPerModel}) failed:`,
          err.message ? err.message.slice(0, 160) : err
        );

        // If not transient (e.g. invalid syntax, blocked content), don't retry or cascade
        if (!transient) {
          throw err;
        }

        // If we have retries left on the same model, wait with jitter
        if (attempt < retriesPerModel - 1) {
          const delay = Math.min(800 * Math.pow(1.8, attempt) + Math.random() * 400, 4000);
          console.info(`[Gemini Resilience] Retrying '${currentModel}' after ${Math.round(delay)}ms...`);
          await sleep(delay);
        }
      }
    }

    // Cascade to next model if available
    if (!isLastModel) {
      const nextModel = models[mIdx + 1];
      console.warn(`[Gemini Resilience] Model '${currentModel}' unavailable due to high demand. Cascading to fallback model '${nextModel}'...`);
      await sleep(350 + Math.random() * 200); // brief pause before hitting next model
    }
  }

  // All retries and models exhausted
  const formattedMsg = formatAiErrorMessage(lastError);
  const enrichedError = new Error(formattedMsg);
  enrichedError.originalError = lastError;
  enrichedError.code = 503;
  enrichedError.status = 'UNAVAILABLE';
  throw enrichedError;
}

module.exports = {
  getGeminiClient,
  generateContentWithRetry,
  isTransientError,
  formatAiErrorMessage,
  hasDefaultGeminiKey,
  getDefaultGeminiKey,
  isCustomOtherProviderSpecified,
  getProviderStatus,
  TEXT_MODELS_CASCADE
};

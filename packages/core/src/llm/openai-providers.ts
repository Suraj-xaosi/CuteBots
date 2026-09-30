import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from "./openai-compatible-provider.js";
import type { LLMClientConfig } from "./llm-client.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: LLMClientConfig) {
    super("openai", toOpenAICompatibleConfig(config, {
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
      defaultMaxContextTokens: 1_000_000,
      requireApiKey: true,
    }));
  }
}

export class GroqProvider extends OpenAICompatibleProvider {
  constructor(config: LLMClientConfig) {
    super("groq", toOpenAICompatibleConfig(config, {
      baseUrl: config.baseUrl ?? GROQ_BASE_URL,
      defaultModel: "llama-3.3-70b-versatile",
      defaultMaxContextTokens: 131_072,
      requireApiKey: true,
    }));
  }
}

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(config: LLMClientConfig) {
    super("ollama", toOpenAICompatibleConfig(config, {
      baseUrl: config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      defaultModel: "llama3.1",
      defaultMaxContextTokens: 32_768,
      requireApiKey: false,
    }));
  }
}

function toOpenAICompatibleConfig(
  config: LLMClientConfig,
  defaults: Pick<OpenAICompatibleConfig, "baseUrl" | "defaultModel" | "defaultMaxContextTokens"> & { requireApiKey: boolean },
): OpenAICompatibleConfig {
  if (defaults.requireApiKey && !config.apiKey?.trim()) {
    throw new Error(`An API key is required for ${config.provider}`);
  }
  return {
    apiKey: config.apiKey?.trim() || "ollama",
    model: config.model,
    baseUrl: defaults.baseUrl,
    defaultModel: defaults.defaultModel,
    defaultMaxContextTokens: defaults.defaultMaxContextTokens,
    maxContextTokens: config.maxContextTokens,
    fetcher: config.fetcher,
  };
}

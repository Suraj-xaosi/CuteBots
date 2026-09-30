import type { LLMMessage, LLMProvider, LLMResponse, ProviderName, Result, ToolDefinition } from "@workspace/types";
import { AnthropicProvider } from "./anthropic-provider.js";
import { GroqProvider, OllamaProvider, OpenAIProvider } from "./openai-providers.js";

export interface LLMClientConfig {
  provider: ProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxContextTokens?: number;
  fetcher?: typeof fetch;
}

export class LLMClient implements LLMProvider {
  private readonly provider: LLMProvider;

  constructor(config: LLMClientConfig) {
    this.provider = LLMClient.createProvider(config);
  }

  get name(): string {
    return this.provider.name;
  }

  get maxContextTokens(): number {
    return this.provider.maxContextTokens;
  }

  static createProvider(config: LLMClientConfig): LLMProvider {
    switch (config.provider) {
      case "anthropic":
        return new AnthropicProvider({
          apiKey: requireApiKey(config),
          model: config.model,
          maxContextTokens: config.maxContextTokens,
          fetcher: config.fetcher,
        });
      case "openai":
        return new OpenAIProvider(config);
      case "groq":
        return new GroqProvider(config);
      case "ollama":
        return new OllamaProvider(config);
    }
  }

  chat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    systemPrompt: string,
  ): Promise<Result<LLMResponse>> {
    return this.provider.chat(messages, tools, systemPrompt);
  }

  countTokens(messages: LLMMessage[]): Promise<number> {
    return this.provider.countTokens(messages);
  }
}

function requireApiKey(config: LLMClientConfig): string {
  if (!config.apiKey?.trim()) throw new Error(`An API key is required for ${config.provider}`);
  return config.apiKey;
}
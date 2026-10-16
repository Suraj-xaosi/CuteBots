import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { ErrorCode, type LLMMessage, type LLMProvider, type LLMResponse, type ProviderName, type Result, type ToolCall, type ToolDefinition } from "@workspace/types";
import { countMessageTokens, mapProviderError } from "./provider-utils.js";

export interface LLMClientConfig {
  provider: ProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxContextTokens?: number;
}

export class LLMClient implements LLMProvider {
  readonly name: string;
  readonly maxContextTokens: number;
  private readonly model: ChatOpenAI | ChatAnthropic;
  private readonly apiKey: string;

  constructor(config: LLMClientConfig) {
    this.name = config.provider;
    this.apiKey = config.apiKey?.trim() ?? "";
    if (config.provider !== "ollama" && !this.apiKey) {
      throw new Error(`An API key is required for ${config.provider}`);
    }

    const model = config.model ?? defaultModel(config.provider);
    if (config.provider === "anthropic") {
      this.model = new ChatAnthropic({
        apiKey: this.apiKey,
        model,
        maxRetries: 0,
      });
      this.maxContextTokens = config.maxContextTokens ?? 200_000;
      return;
    }

    const baseURL = config.baseUrl ?? defaultBaseUrl(config.provider);
    this.model = new ChatOpenAI({
      apiKey: this.apiKey || "ollama",
      model,
      maxRetries: 0,
      timeout: 30_000,
      configuration: { baseURL },
    });
    this.maxContextTokens = config.maxContextTokens ?? contextWindow(config.provider);
  }

  async chat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<Result<LLMResponse>> {
    try {
      const model = tools.length
        ? this.model.bindTools(tools.map(toModelTool))
        : this.model;
      let response;
      try {
        response = await model.invoke(toLangChainMessages(messages, systemPrompt), { signal });
      } catch (error) {
        if (this.name !== "groq" || !tools.length || !isUnknownToolValidationError(error)) throw error;
        const retryPrompt = [
          systemPrompt,
          "The previous response was rejected because it called an unavailable tool.",
          `Retry using only these exact tool names: ${tools.map((tool) => tool.name).join(", ")}.`,
          "Do not use any other tool name.",
        ].join("\n");
        response = await model.invoke(toLangChainMessages(messages, retryPrompt), { signal });
      }
      if (!AIMessage.isInstance(response)) {
        return { ok: false, error: "Model returned a non-assistant message", code: ErrorCode.LLM_API_ERROR };
      }

      const toolCalls = (response.tool_calls ?? []).map(toToolCall);
      const finishReason = readFinishReason(response.response_metadata);
      return {
        ok: true,
        data: {
          content: contentToText(response.content),
          tool_calls: toolCalls,
          usage: {
            input_tokens: response.usage_metadata?.input_tokens ?? 0,
            output_tokens: response.usage_metadata?.output_tokens ?? 0,
          },
          finish_reason: finishReason === "length"
            ? "length"
            : toolCalls.length
              ? "tool_use"
              : finishReason === "error"
                ? "error"
                : "stop",
        },
      };
    } catch (error) {
      return mapProviderError(error, this.apiKey);
    }
  }

  async countTokens(messages: LLMMessage[]): Promise<number> {
    return countMessageTokens(messages);
  }
}

function toLangChainMessages(messages: LLMMessage[], systemPrompt: string): BaseMessage[] {
  return [
    new SystemMessage(systemPrompt),
    ...messages.map((message): BaseMessage => {
      if (message.role === "user") return new HumanMessage(message.content);
      if (message.role === "tool") {
        return new ToolMessage({ content: message.content, tool_call_id: message.tool_call_id });
      }
      return new AIMessage({
        content: message.content,
        ...(message.tool_calls?.length
          ? {
              tool_calls: message.tool_calls.map((call) => ({
                name: call.name,
                args: call.arguments,
                id: call.id,
                type: "tool_call" as const,
              })),
            }
          : {}),
      });
    }),
  ];
}

function toModelTool(tool: ToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toToolCall(call: { id?: string; name: string; args: unknown }): ToolCall {
  if (!isRecord(call.args)) throw new Error(`Model returned invalid arguments for tool ${call.name}`);
  if (!call.id) throw new Error(`Model returned a tool call without an ID for ${call.name}`);
  return { id: call.id, name: call.name, arguments: call.args };
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part): string[] => {
    if (typeof part !== "object" || part === null || !("text" in part) || typeof part.text !== "string") return [];
    return [part.text];
  });
  return parts.length ? parts.join("\n") : null;
}

function readFinishReason(metadata: Record<string, unknown>): "length" | "error" | "stop" {
  const reason = metadata.finish_reason;
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "error") return "error";
  return "stop";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownToolValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /attempted to call tool .+ which was not in request\.tools/i.test(error.message);
}

function defaultModel(provider: ProviderName): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-5-20250929";
    case "openai": return "gpt-4.1-mini";
    case "groq": return "llama-3.3-70b-versatile";
    case "ollama": return "llama3.1";
  }
}

function defaultBaseUrl(provider: ProviderName): string | undefined {
  switch (provider) {
    case "openai": return "https://api.openai.com/v1";
    case "groq": return "https://api.groq.com/openai/v1";
    case "ollama": return process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
    case "anthropic": return undefined;
  }
}

function contextWindow(provider: ProviderName): number {
  switch (provider) {
    case "openai": return 1_000_000;
    case "groq": return 131_072;
    case "ollama": return 32_768;
    case "anthropic": return 200_000;
  }
}

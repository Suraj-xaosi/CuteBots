import { toUIMessageStream } from "@ai-sdk/langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type AIMessageChunk } from "@langchain/core/messages";
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
    onToken?: (token: string) => void,
  ): Promise<Result<LLMResponse>> {
    try {
      const model = tools.length
        ? this.model.bindTools(tools.map(toModelTool))
        : this.model;
      let response;
      try {
        response = await streamModelResponse(
          model,
          toLangChainMessages(messages, systemPrompt),
          signal,
          onToken,
        );
      } catch (error) {
        if (this.name !== "groq" || !tools.length || !isUnknownToolValidationError(error)) throw error;
        const retryPrompt = [
          systemPrompt,
          "The previous response was rejected because it called an unavailable tool.",
          `Retry using only these exact tool names: ${tools.map((tool) => tool.name).join(", ")}.`,
          "Do not use any other tool name.",
        ].join("\n");
        response = await streamModelResponse(
          model,
          toLangChainMessages(messages, retryPrompt),
          signal,
          onToken,
        );
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
          finish_reason: getFinishReason(finishReason, toolCalls.length > 0),
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

async function streamModelResponse(
  model: {
    stream(
      messages: ReturnType<typeof toLangChainMessages>,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<AIMessageChunk>>;
  },
  messages: ReturnType<typeof toLangChainMessages>,
  signal?: AbortSignal,
  onToken?: (token: string) => void,
) {
  const chunks: AIMessageChunk[] = [];
  const stream = await model.stream(messages, { signal });
  async function* captureChunks() {
    for await (const chunk of stream) {
      chunks.push(chunk);
      yield chunk;
    }
  }

  const uiStream = toUIMessageStream(captureChunks(), {
    sendStart: false,
    sendFinish: false,
    onToken,
  });
  const reader = uiStream.getReader();
  try {
    while (!(await reader.read()).done) {}
  } finally {
    reader.releaseLock();
  }

  const responseChunk = chunks.reduce<AIMessageChunk | undefined>(
    (combined, chunk) => combined ? combined.concat(chunk) : chunk,
    undefined,
  );
  if (!responseChunk) throw new Error("Model returned an empty response stream");
  return new AIMessage({
    content: responseChunk.content,
    tool_calls: responseChunk.tool_calls,
    invalid_tool_calls: responseChunk.invalid_tool_calls,
    response_metadata: responseChunk.response_metadata,
    usage_metadata: responseChunk.usage_metadata,
  });
}

function toLangChainMessages(messages: LLMMessage[], systemPrompt: string) {
  return [
    new SystemMessage(systemPrompt),
    ...messages.map((message) => {
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

function toToolCall(call: { id?: string; name: string; args: unknown }) {
  if (!isRecord(call.args)) throw new Error(`Model returned invalid arguments for tool ${call.name}`);
  if (!call.id) throw new Error(`Model returned a tool call without an ID for ${call.name}`);
  return { id: call.id, name: call.name, arguments: call.args };
}

function contentToText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part) => {
    if (typeof part !== "object" || part === null || !("text" in part) || typeof part.text !== "string") return [];
    return [part.text];
  });
  return parts.length ? parts.join("\n") : null;
}

function readFinishReason(metadata: Record<string, unknown>) {
  const reason = metadata.finish_reason;
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "error") return "error";
  return "stop";
}

function getFinishReason(reason: string, hasToolCalls: boolean) {
  if (reason === "length") return "length";
  if (hasToolCalls) return "tool_use";
  if (reason === "error") return "error";
  return "stop";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownToolValidationError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /attempted to call tool .+ which was not in request\.tools/i.test(error.message);
}

function defaultModel(provider: ProviderName) {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-5-20250929";
    case "openai": return "gpt-4.1-mini";
    case "groq": return "llama-3.3-70b-versatile";
    case "ollama": return "llama3.1";
  }
}

function defaultBaseUrl(provider: ProviderName) {
  switch (provider) {
    case "openai": return "https://api.openai.com/v1";
    case "groq": return "https://api.groq.com/openai/v1";
    case "ollama": return "http://localhost:11434/v1";
    case "anthropic": return undefined;
  }
}

function contextWindow(provider: ProviderName) {
  switch (provider) {
    case "openai": return 1_000_000;
    case "groq": return 131_072;
    case "ollama": return 32_768;
    case "anthropic": return 200_000;
  }
}

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolDefinition,
} from "@workspace/types";
import { ErrorCode, type Result } from "@workspace/types";
import {
  countMessageTokens,
  mapOpenAIFinishReason,
  mapProviderError,
  parseToolArguments,
} from "./provider-utils.js";

export interface OpenAICompatibleConfig {
  apiKey?: string;
  model?: string;
  baseUrl: string;
  defaultModel: string;
  defaultMaxContextTokens: number;
  maxContextTokens?: number;
  fetcher?: typeof fetch;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly maxContextTokens: number;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly client: OpenAI;

  constructor(name: string, config: OpenAICompatibleConfig) {
    this.name = name;
    this.model = config.model ?? config.defaultModel;
    this.apiKey = config.apiKey ?? "";
    this.maxContextTokens = config.maxContextTokens ?? config.defaultMaxContextTokens;
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: config.baseUrl,
      timeout: 30_000,
      maxRetries: 0,
      fetch: config.fetcher,
    });
  }

  async chat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    systemPrompt: string,
  ): Promise<Result<LLMResponse>> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: toOpenAIMessages(messages, systemPrompt),
        tools: tools.length ? toOpenAITools(tools) : undefined,
        tool_choice: tools.length ? "auto" : undefined,
      });
      const choice = response.choices[0];
      if (!choice) {
        return { ok: false, error: "LLM provider returned no choices", code: ErrorCode.LLM_API_ERROR };
      }

      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => {
        if (call.type !== "function") throw new Error("LLM returned an unsupported custom tool call");
        return {
          id: call.id,
          name: call.function.name,
          arguments: parseToolArguments(call.function.arguments),
        };
      });

      return {
        ok: true,
        data: {
          content: choice.message.content,
          tool_calls: toolCalls,
          usage: {
            input_tokens: response.usage?.prompt_tokens ?? 0,
            output_tokens: response.usage?.completion_tokens ?? 0,
          },
          finish_reason: mapOpenAIFinishReason(choice.finish_reason),
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

export function toOpenAIMessages(
  messages: LLMMessage[],
  systemPrompt: string,
): ChatCompletionMessageParam[] {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((message): ChatCompletionMessageParam => {
      if (message.role === "user") return { role: "user", content: message.content };
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.tool_call_id,
          content: message.content,
        };
      }
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.tool_calls?.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }),
  ];
}

function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
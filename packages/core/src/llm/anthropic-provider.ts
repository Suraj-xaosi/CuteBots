import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  TextBlockParam,
  Tool as AnthropicTool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { ErrorCode, type LLMMessage, type LLMProvider, type LLMResponse, type ToolCall, type ToolDefinition } from "@workspace/types";
import type { Result } from "@workspace/types";
import {
  countMessageTokens,
  mapAnthropicStopReason,
  mapProviderError,
} from "./provider-utils.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  maxContextTokens?: number;
  fetcher?: typeof fetch;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly maxContextTokens: number;
  private readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicProviderConfig) {
    this.model = config.model ?? "claude-sonnet-4-5-20250929";
    this.maxContextTokens = config.maxContextTokens ?? 200_000;
    this.client = new Anthropic({
      apiKey: config.apiKey,
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
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4_096,
        system: systemPrompt,
        messages: toAnthropicMessages(messages),
        tools: tools.length ? toAnthropicTools(tools) : undefined,
      });

      const toolCalls: ToolCall[] = [];
      const text: string[] = [];
      for (const block of response.content) {
        if (block.type === "text") text.push(block.text);
        if (block.type === "tool_use") {
          if (!isRecord(block.input)) throw new Error("LLM returned invalid tool arguments");
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
        }
      }

      return {
        ok: true,
        data: {
          content: text.join("\n") || null,
          tool_calls: toolCalls,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
          finish_reason: mapAnthropicStopReason(response.stop_reason),
        },
      };
    } catch (error) {
      return mapProviderError(error, this.config.apiKey);
    }
  }

  async countTokens(messages: LLMMessage[]): Promise<number> {
    return countMessageTokens(messages);
  }
}

export function toAnthropicMessages(messages: LLMMessage[]): MessageParam[] {
  const output: MessageParam[] = [];
  let toolResults: ToolResultBlockParam[] = [];
  const flushToolResults = () => {
    if (toolResults.length) output.push({ role: "user", content: toolResults });
    toolResults = [];
  };

  for (const message of messages) {
    if (message.role === "tool") {
      toolResults.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
      });
      continue;
    }

    flushToolResults();
    if (message.role === "user") {
      output.push({ role: "user", content: message.content });
      continue;
    }

    const content: Array<TextBlockParam | ToolUseBlockParam> = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    output.push({ role: "assistant", content: content.length ? content : message.content });
  }

  flushToolResults();
  return output;
}

function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as AnthropicTool["input_schema"],
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
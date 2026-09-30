export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LLMMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage: { input_tokens: number; output_tokens: number };
  finish_reason: "stop" | "tool_use" | "length" | "error";
}

export interface LLMProvider {
  chat(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    systemPrompt: string,
  ): Promise<import("./result.js").Result<LLMResponse>>;
  countTokens(messages: LLMMessage[]): Promise<number>;
  maxContextTokens: number;
  name: string;
}

export type ProviderName = "anthropic" | "openai" | "groq" | "ollama";
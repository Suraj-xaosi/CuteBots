import { z } from "zod";
import { Tool, type ToolResult } from "./tool.js";
import type { Sandbox } from "../sandbox.js";

const searchSchema = z.object({
  query: z.string().trim().min(1).max(1_000).describe("Search query"),
}).strict();

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

export class WebSearchTool extends Tool<typeof searchSchema> {
  readonly name = "web_search";
  readonly description = "Search the web for relevant information and return up to three results.";
  protected readonly schema = searchSchema;

  constructor(
    private readonly apiKey: string | undefined = process.env.TAVILY_KEY,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    super();
  }

  protected async executeValidated(
    args: z.output<typeof searchSchema>,
    _sandbox: Sandbox,
  ): Promise<ToolResult> {
    if (!this.apiKey) {
      return { success: false, output: "Web search is disabled because TAVILY_KEY is not configured" };
    }

    try {
      const response = await this.fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.apiKey, query: args.query, max_results: 3 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return { success: false, output: `Web search returned HTTP ${response.status}` };
      }

      const data = (await response.json()) as TavilyResponse;
      const results = (data.results ?? []).slice(0, 3).map((result) => ({
        title: result.title ?? "Untitled result",
        url: result.url ?? "",
        content: (result.content ?? "").slice(0, 2_000),
      }));
      return { success: true, output: JSON.stringify(results) };
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : "Web search failed",
      };
    }
  }
}
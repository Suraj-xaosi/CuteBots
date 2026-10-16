import { z } from "zod";
import type { Sandbox } from "../sandbox.js";
import { Tool, type ToolResult } from "./tool.js";

const searchSchema = z.object({
  query: z.string().trim().min(1).max(500).describe("A focused web search query"),
}).strict();

const MAX_RESULTS = 5;
const MAX_CONTENT_LENGTH = 1_200;

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  published_date?: string;
}

export class TavilySearchTool extends Tool<typeof searchSchema> {
  readonly name = "web_search";
  readonly description = "Search the public web with Tavily and return a few relevant sources with snippets and URLs.";
  protected readonly schema = searchSchema;

  constructor(private readonly apiKey: string) {
    super();
  }

  protected async executeValidated(
    args: z.output<typeof searchSchema>,
    _sandbox: Sandbox,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: args.query,
        search_depth: "basic",
        max_results: MAX_RESULTS,
        include_answer: false,
      }),
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]),
    });

    if (!response.ok) {
      return {
        success: false,
        output: `Tavily web search failed with HTTP ${response.status} ${response.statusText}`.trim(),
      };
    }

    const payload: unknown = await response.json();
    const results = readSearchResults(payload);
    if (!results.length) return { success: true, output: "No web search results were found." };

    return {
      success: true,
      output: results.map((result, index) => [
        `${index + 1}. ${result.title}`,
        result.url,
        result.published_date ? `Published: ${result.published_date}` : "",
        result.content.slice(0, MAX_CONTENT_LENGTH),
      ].filter(Boolean).join("\n")).join("\n\n"),
    };
  }
}

function readSearchResults(payload: unknown): TavilySearchResult[] {
  if (typeof payload !== "object" || payload === null || !("results" in payload) || !Array.isArray(payload.results)) {
    throw new Error("Tavily returned an invalid search response");
  }

  return payload.results.slice(0, MAX_RESULTS).flatMap((item): TavilySearchResult[] => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("title" in item) ||
      typeof item.title !== "string" ||
      !("url" in item) ||
      typeof item.url !== "string" ||
      !("content" in item) ||
      typeof item.content !== "string"
    ) {
      return [];
    }
    const publishedDate = "published_date" in item && typeof item.published_date === "string"
      ? item.published_date
      : undefined;
    return [{
      title: item.title,
      url: item.url,
      content: item.content,
      ...(publishedDate ? { published_date: publishedDate } : {}),
    }];
  });
}

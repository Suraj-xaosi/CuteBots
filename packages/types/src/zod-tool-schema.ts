import { z } from "zod";




//web
export const searchSchema = z.object({
  query: z.string().trim().min(1).max(500).describe("A focused web search query"),
}).strict();


//humaninloop
export const askHumanSchema = z.object({
  question: z.string().trim().min(1).max(4_000).describe("Question that requires a human decision"),
}).strict();



//git
export const pushChangesSchema = z.object({
  commit_message: z.string().trim().min(1).max(500).describe("Commit message for the project's changes"),
}).strict();





//----------------------
/** command */


export const commandSchema = z.object({
  command: z.string().trim().min(1).max(20_000).describe("Shell command to run inside the project sandbox"),
}).strict();

export const commandJobSchema = z.object({
  job_id: z.string().uuid().describe("Opaque ID returned by run_command"),
}).strict();

//---------------------



//----------------

/**  workspace **/

export const pathSchema = z.object({
  path: z.string().trim().min(1).max(4_096).describe("Path inside the project workspace"),
}).strict();

export const listFilesSchema = z.object({
  path: z.string().trim().max(4_096).optional().describe("Workspace directory to list; omit this or use . for the repository root"),
}).strict();

export const writeFileSchema = pathSchema.extend({
  content: z.string().describe("UTF-8 file contents"),
}).strict();

export const strReplaceSchema = pathSchema.extend({
  oldText: z.string().min(1).describe("Exact existing text that must occur exactly once"),
  newText: z.string().describe("Replacement text"),
}).strict();

export const findFilesSchema = z.object({
  directory: z.string().trim().min(1).max(4_096).default(".").describe("Workspace directory to search"),
  glob: z.string().trim().min(1).max(256).default("**/*").describe("Simple glob: *, **, and ? wildcards"),
  max_results: z.number().int().min(1).max(50).default(30).describe("Maximum matching paths to return"),
}).strict();

export const searchFilesSchema = z.object({
  query: z.string().min(1).max(1_000).describe("Literal text to find; this is not a regular expression"),
  directory: z.string().trim().min(1).max(4_096).default(".").describe("Workspace directory to search"),
  glob: z.string().trim().min(1).max(256).default("**/*").describe("Simple glob: *, **, and ? wildcards"),
  case_sensitive: z.boolean().default(false).describe("Whether the literal search is case sensitive"),
  max_results: z.number().int().min(1).max(30).default(15).describe("Maximum matching lines to return"),
}).strict();

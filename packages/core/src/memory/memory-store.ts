export interface MemoryFact {
  id: string;
  text: string;
  score?: number;
}

export interface ToolMemoryInput {
  projectId: string;
  taskId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  success: boolean;
  output: string;
}

export interface ProjectMemoryInput {
  projectId: string;
  taskId: string;
  summary: string;
}

export interface MemoryStore {
  captureTaskToolResult(input: ToolMemoryInput): Promise<void>;
  captureProjectSummary(input: ProjectMemoryInput): Promise<void>;
  searchTask(taskId: string, query: string, limit: number): Promise<MemoryFact[]>;
  searchProject(projectId: string, query: string, limit: number): Promise<MemoryFact[]>;
}
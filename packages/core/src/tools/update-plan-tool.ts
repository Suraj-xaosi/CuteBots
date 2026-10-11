import { z } from "zod";
import { Tool, type ToolResult } from "./tool.js";

const planSchema = z.object({
  title: z.string().trim().min(1).max(200).describe("Short name for the current task plan"),
  steps: z.array(z.object({
    description: z.string().trim().min(1).max(300),
    status: z.enum(["pending", "in_progress", "completed"]),
  }).strict()).min(1).max(12),
}).strict().superRefine((plan, context) => {
  const activeSteps = plan.steps.filter((step) => step.status === "in_progress");
  if (activeSteps.length > 1) {
    context.addIssue({
      code: "custom",
      message: "At most one plan step can be in_progress",
      path: ["steps"],
    });
  }
});

export type AgentPlan = z.output<typeof planSchema>;

export class UpdatePlanTool extends Tool<typeof planSchema> {
  readonly name = "update_plan";
  readonly description = "Create or update a concise task plan with up to 12 ordered steps and at most one active step.";
  protected readonly schema = planSchema;

  constructor(private readonly publishPlan: (plan: AgentPlan) => Promise<void>) {
    super();
  }

  protected async executeValidated(plan: AgentPlan): Promise<ToolResult> {
    await this.publishPlan(plan);
    return {
      success: true,
      output: `Plan updated: ${plan.title}\n${plan.steps.map((step, index) =>
        `${index + 1}. [${step.status}] ${step.description}`,
      ).join("\n")}`,
    };
  }
}

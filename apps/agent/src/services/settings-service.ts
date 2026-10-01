import { ErrorCode, type Result } from "@workspace/types";
import { PrismaClient, SecretVault } from "@workspace/db";
import { z } from "zod";

const settingNames = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_API_KEY",
  "TAVILY_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "MEMORY_LLM_PROVIDER",
  "MEMORY_LLM_MODEL",
  "MEMORY_LLM_API_KEY",
  "MEMORY_EMBEDDER_PROVIDER",
  "MEMORY_EMBEDDER_MODEL",
  "MEMORY_EMBEDDER_API_KEY",
] as const;

export type SettingName = typeof settingNames[number];

const secretNames = new Set<SettingName>([
  "LLM_API_KEY",
  "TAVILY_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "MEMORY_LLM_API_KEY",
  "MEMORY_EMBEDDER_API_KEY",
]);

const settingsInputSchema = z.record(z.string(), z.string().max(4_000));
const llmProviderSchema = z.enum(["anthropic", "openai", "groq", "ollama"]);
const memoryProviderSchema = z.enum(["openai", "anthropic", "groq", "ollama"]);
const settingNameSet = new Set<string>(settingNames);

export interface PublicSettings {
  values: Partial<Record<SettingName, string>>;
  configuredSecrets: Partial<Record<SettingName, boolean>>;
}

export class SettingsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly createVault: () => SecretVault = () => new SecretVault(),
  ) {}

  async getResolved(name: SettingName): Promise<Result<string | undefined>> {
    try {
      const stored = await this.prisma.setting.findUnique({ where: { key: name } });
      if (!stored || !stored.value) return { ok: true, data: environmentValue(name) };
      if (!stored.is_secret) return { ok: true, data: stored.value };
      return { ok: true, data: this.createVault().decrypt(stored.value) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to read settings",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      };
    }
  }

  async getPublicSettings(): Promise<Result<PublicSettings>> {
    try {
      const stored = await this.prisma.setting.findMany({ where: { key: { in: [...settingNames] } } });
      const values: PublicSettings["values"] = {};
      const configuredSecrets: PublicSettings["configuredSecrets"] = {};
      const storedByName = new Map(stored.map((setting) => [setting.key, setting]));

      for (const name of settingNames) {
        const setting = storedByName.get(name);
        const isSecret = secretNames.has(name);
        const configured = (name === "TELEGRAM_BOT_TOKEN" || name === "TELEGRAM_CHAT_ID") && setting
          ? Boolean(this.createVault().decrypt(setting.value))
          : Boolean(setting?.value || environmentValue(name));
        if (isSecret) {
          configuredSecrets[name] = configured;
          continue;
        }
        const value = setting?.value || environmentValue(name);
        if (value) values[name] = value;
      }
      return { ok: true, data: { values, configuredSecrets } };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to read settings",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      };
    }
  }

  async update(input: unknown): Promise<Result<PublicSettings>> {
    const parsed = settingsInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; "), code: ErrorCode.TOOL_EXECUTION_FAILED };
    }

    const values = parsed.data;
    for (const [name, value] of Object.entries(values)) {
      const validation = validateSetting(name, value);
      if (!validation.ok) return validation;
    }

    try {
      const vault = Object.keys(values).some((name) => settingNameSet.has(name) && secretNames.has(name as SettingName))
        ? this.createVault()
        : undefined;
      await this.prisma.$transaction(
        Object.entries(values).map(([name, value]) => {
          const typedName = name as SettingName;
          const isSecret = secretNames.has(typedName);
          return this.prisma.setting.upsert({
            where: { key: typedName },
            create: {
              key: typedName,
              value: isSecret ? vault!.encrypt(value) : value,
              is_secret: isSecret,
            },
            update: {
              value: isSecret ? vault!.encrypt(value) : value,
              is_secret: isSecret,
            },
          });
        }),
      );
      return this.getPublicSettings();
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to save settings",
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      };
    }
  }
}

function validateSetting(name: string, value: string): Result<void> {
  if (!settingNameSet.has(name)) {
    return { ok: false, error: `Unsupported setting: ${name}`, code: ErrorCode.TOOL_EXECUTION_FAILED };
  }
  if (name === "LLM_PROVIDER") {
    const parsed = llmProviderSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: "Unsupported LLM provider", code: ErrorCode.TOOL_EXECUTION_FAILED };
  }
  if (name === "MEMORY_LLM_PROVIDER" || name === "MEMORY_EMBEDDER_PROVIDER") {
    const parsed = memoryProviderSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: "Unsupported memory provider", code: ErrorCode.TOOL_EXECUTION_FAILED };
  }
  if (name.endsWith("_MODEL") && !/^[A-Za-z0-9._:/-]{1,200}$/.test(value)) {
    return { ok: false, error: `Invalid model name for ${name}`, code: ErrorCode.TOOL_EXECUTION_FAILED };
  }
  if (name.endsWith("_API_KEY") && value && value.length < 8) {
    return { ok: false, error: `API key for ${name} is too short`, code: ErrorCode.INVALID_API_KEY };
  }
  return { ok: true, data: undefined };
}

function environmentValue(name: SettingName): string | undefined {
  if (name === "LLM_API_KEY") return process.env.LLM_API_KEY ?? process.env.API_KEY;
  return process.env[name];
}
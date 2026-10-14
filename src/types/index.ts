import { z } from "zod";

export const projectPathSchema = z.string().min(1).describe("Path to the local project directory.");
export const monthlyBudgetSchema = z.number().finite().nonnegative().describe("Maximum monthly budget in USD.");
export const envSecretsSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string());

export const analyzeProjectInfraInput = { projectPath: projectPathSchema };
export const proposeInfraPlanInput = {
  stackRequirements: z.array(z.string().min(1)),
  maxMonthlyBudgetUsd: monthlyBudgetSchema,
  commercialUse: z.boolean().default(true),
  preferProductionReliability: z.boolean().default(true),
};
export const writeEnvSecretsInput = {
  projectPath: projectPathSchema,
  secrets: envSecretsSchema,
};

export type EnvSecrets = z.infer<typeof envSecretsSchema>;
export type ProviderId = "vercel" | "supabase" | "cloudflare";

export interface ProjectAnalysis {
  projectPath: string;
  frameworks: string[];
  stackRequirements: string[];
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  evidence: Array<{ requirement: string; file: string; signal: string }>;
  envKeys: string[];
  existingConfigFiles: string[];
  missingPrerequisites: string[];
  warnings: string[];
  truncated: boolean;
}

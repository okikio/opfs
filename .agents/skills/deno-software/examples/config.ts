import { z } from "zod";

export const AppConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(8000),
  databaseUrl: z.url(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return AppConfigSchema.parse({
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
  });
}

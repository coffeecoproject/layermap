import { z } from "zod";

export const MapWorkspacePlanSchema = z
  .object({
    links: z.array(z.object({ from: z.string(), to: z.string() }).strict()),
    redirects: z.array(
      z
        .object({
          manifest: z.string(),
          configPath: z.string(),
          output: z.string(),
          source: z.string(),
        })
        .strict(),
    ),
    configurationFiles: z.array(z.string()),
    issues: z.array(
      z.enum([
        "WORKSPACE_CONFIGURATION_UNSUPPORTED",
        "WORKSPACE_MEMBERSHIP_NOT_ADMITTED",
        "WORKSPACE_DEPENDENCY_TARGET_NOT_AVAILABLE",
      ]),
    ),
  })
  .strict();
export type MapWorkspacePlan = z.infer<typeof MapWorkspacePlanSchema>;
export const MapConfigurationResultSchema = z
  .object({
    projects: z.array(
      z
        .object({
          configPath: z.string().optional(),
          rootFiles: z.array(z.string()),
          inputFiles: z.array(z.string()),
        })
        .strict(),
    ),
    workspace: MapWorkspacePlanSchema,
  })
  .strict();
export type MapConfigurationResult = z.infer<typeof MapConfigurationResultSchema>;

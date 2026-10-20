import { z } from "zod";

// Public DTOs deliberately omit instruction bodies, skill bodies and MCP environment.
export const projectContextDtoSchema = z
  .object({
    workspace: z.string().max(4096),
    instructionSources: z
      .array(
        z
          .object({
            path: z.string().max(4096),
            order: z.number().int().nonnegative(),
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(1024),
    skills: z
      .array(
        z
          .object({
            id: z.string().max(256),
            name: z.string().max(256),
            description: z.string().max(8192),
            version: z.string().max(256).nullable(),
            sourceDirectory: z.string().max(4096),
            provenance: z.enum(["workspace-forge", "workspace-agents", "user"]),
          })
          .strict(),
      )
      .max(1024),
    warnings: z.array(z.string().max(4096)).max(1024),
    counts: z
      .object({
        instructions: z.number().int().nonnegative(),
        skills: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .readonly();
export type ProjectContextDto = z.infer<typeof projectContextDtoSchema>;
export interface ContextFileSignature {
  readonly path: string;
  readonly signature: string;
}

export interface ContextFingerprint {
  readonly hash: string;
  readonly version: string;
  readonly signatures: readonly ContextFileSignature[];
}

export type InstructionSource = Readonly<
  ProjectContextDto["instructionSources"][number]
> & { readonly body: string };
export type SkillRecord = Readonly<ProjectContextDto["skills"][number]>;
export type SkillProvenance = SkillRecord["provenance"];
export interface ProjectContextCatalog {
  readonly workspace: ProjectContextDto["workspace"];
  readonly instructionSources: readonly InstructionSource[];
  readonly skills: readonly SkillRecord[];
  readonly warnings: readonly string[];
  readonly counts: Readonly<ProjectContextDto["counts"]>;
}

export interface ProjectContextService {
  readonly workspace: string;
  refresh(): Promise<void>;
  getSystemContext(): string;
  getCatalog(): ProjectContextCatalog;
  getFingerprint(): ContextFingerprint;
  loadSkill(
    id: string,
    signal?: AbortSignal,
  ): Promise<SkillRecord & { body: string }>;
  resolveInstructions(
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<readonly InstructionSource[]>;
  dispose(): Promise<void>;
}

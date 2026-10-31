import { z } from "zod";
import { agentProfilesSchema } from "../shared/agent-profiles";
import type { AgentProfile } from "../shared/agent-profiles";
import {
  type RouteGroup,
  connectionInputSchema,
  credentialInputSchema,
  routeGroupSchema,
} from "../shared/model-access";
import {
  configureInputSchema,
  providerSourceIdSchema,
  providerSourceRevisionSchema,
  providerSourceSchema,
} from "../shared/schemas";

// One authoritative transaction holds sources, private credentials and routes.
export const TRANSACTION_LIMIT = 16 * 1024 * 1024;
export const NEW_SOURCE_ID = "default";
export const NEW_SOURCE_LABEL = "Default";

// Accept and discard retired fields only when reading stored data. Public
// configuration rejects them. Old browser preferences must neither block startup
// nor enable/configure the browser plugin; that grant lives in its own store.
const fieldsSchema = configureInputSchema
  .unwrap()
  .shape.settings.unwrap()
  .unwrap()
  .extend({
    webSearch: z.enum(["disabled", "cached", "live"]).optional(),
    browserAllowedOrigins: z.unknown().optional(),
    browserExecutablePath: z.unknown().optional(),
  })
  .transform(
    ({
      webSearch: _legacyWebSearch,
      browserAllowedOrigins: _legacyOrigins,
      browserExecutablePath: _legacyBrowserExecutable,
      ...settings
    }) => settings,
  )
  .readonly();
const credentialValueSchema = configureInputSchema
  .unwrap()
  .shape.apiKey.unwrap();
export const configSchema = z
  .object({ version: z.literal(1), settings: fieldsSchema })
  .strict();
export const credentialSchema = z
  .object({
    version: z.literal(1),
    apiKey: credentialValueSchema,
  })
  .strict();
const storedSourceSchema = providerSourceSchema
  .unwrap()
  .extend({
    apiKey: credentialValueSchema,
    credentials: z.array(credentialInputSchema).readonly().optional(),
    connection: connectionInputSchema.optional(),
    // Every committed edit bumps this; UI writes must echo the revision they saw.
    revision: providerSourceRevisionSchema.optional(),
  })
  .strict()
  .readonly();
export type StoredSettings = z.infer<typeof fieldsSchema>;
export type StoredSource = z.infer<typeof storedSourceSchema> & {
  readonly revision: number;
};
export type StoredState = Readonly<{
  version?: 1 | 2;
  routeGroups?: readonly RouteGroup[];
  // Role profiles are a top-level collection, never part of the settings patch:
  // a UI settings write must not be able to replace the whole array.
  agentProfiles?: readonly AgentProfile[];
  // Monotonic allocation counter. Kept across removals so a re-created id cannot
  // reuse a revision an older window still believes is current.
  agentProfilesRevision?: number;
  settings: StoredSettings;
  apiKey: string;
  sources: readonly StoredSource[];
  activeSourceId?: string;
}>;
// One lock, one file: endpoint, credential and every provider source commit
// together, so an interruption can never expose a mixed provider pair.
export const transactionSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    settings: fieldsSchema,
    apiKey: credentialValueSchema,
    sources: z.array(storedSourceSchema).optional(),
    routeGroups: z.array(routeGroupSchema).readonly().optional(),
    // Absent in every older transaction: migrated to an empty collection.
    agentProfiles: agentProfilesSchema.optional(),
    agentProfilesRevision: z.number().int().nonnegative().optional(),
    activeSourceId: providerSourceIdSchema.optional(),
  })
  .strict()
  .refine(
    (state) =>
      new Set((state.sources ?? []).map((source) => source.id)).size ===
        (state.sources ?? []).length &&
      (state.activeSourceId === undefined ||
        (state.sources ?? []).some(
          (source) => source.id === state.activeSourceId,
        )),
    "Provider source IDs must be unique and the active source must exist",
  );

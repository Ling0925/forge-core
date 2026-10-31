import { type RoutedProvider, createRoutedProvider } from "../provider/routing";
import type { createRouteState } from "../provider/routing";
import type { PublicSettings } from "../shared/schemas";
import type { createModelAccessService } from "./model-access";

type ModelAccess = ReturnType<typeof createModelAccessService>;
type RouteGroup = NonNullable<PublicSettings["routeGroups"]>[number];
type PreparedRoute = Awaited<ReturnType<ModelAccess["prepareRoute"]>>;
type SelectionValidator = Parameters<ModelAccess["resolveProvider"]>[4];

/**
 * The routed provider for a prepared group (an explicit route group or a
 * direct source's credential rotation). Runs, their auto-titles and manual
 * compaction share it and the harness-wide route state, so failover, resting
 * members, quota and sticky selection behave the same for all of them.
 */
export const routedProviderFor = ({
  group,
  prepared,
  routeState,
  modelAccess,
  validateSelection,
}: {
  group: RouteGroup;
  prepared: PreparedRoute;
  routeState: ReturnType<typeof createRouteState>;
  modelAccess: ModelAccess;
  validateSelection?: SelectionValidator;
}): RoutedProvider =>
  createRoutedProvider({
    group,
    state: routeState,
    ...(prepared.apiMode ? { apiMode: prepared.apiMode } : {}),
    mayUseWebSearch: prepared.mayUseWebSearch,
    contextWindow: prepared.contextWindow,
    quota: prepared.quota,
    exclude: prepared.exclude,
    resolve: (member, requestSignal) =>
      modelAccess.resolveProvider(
        member.sourceId,
        member.credentialId,
        requestSignal,
        member.model,
        validateSelection,
      ),
  });

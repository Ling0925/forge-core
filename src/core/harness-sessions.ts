import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ForgeError } from "../shared/errors";
import type {
  CreateSessionInput,
  PublicSettings,
  SessionId,
  SessionSnapshot,
} from "../shared/schemas";
import type { openSessionStore } from "../store/sessions";
import { assertBoundary } from "./context";
import { inferSourceId } from "./harness-provider-selection";

/**
 * Copy a session's history up to a native-call boundary into a new session.
 * The caller holds the source session's lock.
 */
export const forkSessionSnapshot = async (
  store: Awaited<ReturnType<typeof openSessionStore>>,
  id: SessionId,
  boundary: number | undefined,
): Promise<SessionSnapshot> => {
  const source = await store.get(id);
  const end = boundary ?? source.messages.length;
  assertBoundary(source.messages, end);
  let contextSummary: SessionSnapshot["contextSummary"];
  if (source.contextSummary && source.contextSummary.boundary <= end) {
    try {
      assertBoundary(source.messages, source.contextSummary.boundary);
      contextSummary = source.contextSummary;
    } catch {
      // Do not propagate stale memory whose boundary splits native calls.
    }
  }
  const fork = await store.create({
    workspace: source.workspace,
    title: `Fork: ${source.title}`.slice(0, 256),
    model: source.model,
    ...(source.providerSourceId
      ? { providerSourceId: source.providerSourceId }
      : {}),
    ...(source.routeGroupId ? { routeGroupId: source.routeGroupId } : {}),
  });
  const next = {
    ...fork,
    messages: source.messages.slice(0, end),
    ...(contextSummary ? { contextSummary } : {}),
    plan: source.plan,
    plans: source.plans,
    permissionCeiling: source.permissionCeiling,
    parentSessionId: source.parentSessionId,
    agentTask: source.agentTask,
    ownership: source.ownership,
    writePaths: source.writePaths,
    forkedFrom: id,
  };
  await store.save(next);
  return next;
};

/**
 * Validate a new session's selection and workspace. Returns the unparsed
 * model; the caller parses it while creating the session.
 */
export const resolveNewSession = async (
  settings: PublicSettings,
  input: CreateSessionInput,
) => {
  // A new session pins the source of the model the user picked, so choosing
  // a model alone is enough to switch providers.
  const group = input.routeGroupId
    ? settings.routeGroups?.find((item) => item.id === input.routeGroupId)
    : undefined;
  if (input.routeGroupId && !group)
    throw new ForgeError("not_found", "未找到所选路由组。");
  const firstMember = group?.members.find((member) => member.enabled !== false);
  const providerSourceId =
    firstMember?.sourceId ??
    input.providerSourceId ??
    inferSourceId(settings, input.model) ??
    settings.activeSourceId;
  const source = settings.providerSources?.find(
    (candidate) => candidate.id === providerSourceId,
  );
  if (providerSourceId && !source)
    throw new ForgeError(
      "invalid_input",
      "The session's provider source is unavailable. Select an existing source explicitly.",
    );
  const model =
    firstMember?.model ?? input.model ?? source?.model ?? settings.model;
  if (!model)
    throw new ForgeError(
      "invalid_input",
      "Select a model before creating a session.",
    );
  const workspace = resolve(input.workspace);
  if (!isAbsolute(workspace))
    throw new ForgeError(
      "invalid_input",
      "Workspace must be an absolute directory.",
    );
  let directory: boolean;
  try {
    directory = (await stat(workspace)).isDirectory();
  } catch (error) {
    // Only a missing path is "not an existing directory"; access and I/O
    // failures are reported as such so they are not mistaken for typos.
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") directory = false;
    else if (code === "EACCES" || code === "EPERM")
      throw new ForgeError(
        "invalid_input",
        "Workspace is not accessible: permission denied.",
      );
    else
      throw new ForgeError(
        "invalid_input",
        `Workspace could not be inspected${code ? ` (${code})` : ""}.`,
      );
  }
  if (!directory)
    throw new ForgeError(
      "invalid_input",
      "Workspace must be an existing directory.",
    );
  return { workspace, model, providerSourceId, group };
};

import { QueueAdmissionError } from "../shared/input-queue";
import { narrowestPermission } from "../shared/permissions";
import { settingsFields } from "../shared/schemas";
import type { SessionId } from "../shared/schemas";
import type { openSessionStore } from "../store/sessions";
import type { openSettingsStore } from "../store/settings";
import {
  type createProviderSelection,
  selectSessionSource,
} from "./harness-provider-selection";
import { inputPredecessor, openInputQueue } from "./input-queue";

export type HarnessInputQueueDeps = {
  directory: string;
  store: Awaited<ReturnType<typeof openSessionStore>>;
  settingsStore: Awaited<ReturnType<typeof openSettingsStore>>;
  /** Sessions with an owned run or operation; such a session cannot be acknowledged. */
  controls: ReadonlyMap<SessionId, unknown>;
  check: () => void;
  queueProviderBinding: ReturnType<
    typeof createProviderSelection
  >["queueProviderBinding"];
};

/**
 * The durable input queue for a harness. Admission pins each queued input to
 * its resolved model, clamped permission and provider binding.
 */
export const openHarnessInputQueue = ({
  directory,
  store,
  settingsStore,
  controls,
  check,
  queueProviderBinding,
}: HarnessInputQueueDeps) =>
  openInputQueue({
    directory,
    validateSession: async (id) => {
      await store.get(id);
    },
    predecessor: async (id, acknowledge) => {
      if (!acknowledge) return inputPredecessor(await store.get(id));
      if (controls.has(id)) throw new QueueAdmissionError();
      const release = await store.acquire(id);
      try {
        return inputPredecessor(await store.get(id));
      } finally {
        await release();
      }
    },
    prepare: async (input) => {
      check();
      const [snapshot, settings] = await Promise.all([
        store.get(input.sessionId),
        settingsStore.getPublic(),
      ]);
      const { providerSourceId, routeGroupId } = selectSessionSource(
        settings,
        snapshot,
        input,
      );
      const model = settingsFields.model.parse(input.model ?? snapshot.model);
      const providerBinding = await queueProviderBinding(
        settings,
        model,
        providerSourceId,
        routeGroupId,
      );
      const permission = narrowestPermission(
        input.mode === "plan"
          ? "readonly"
          : (input.permission ?? settings.defaultPermission),
        snapshot.permissionCeiling,
      );
      return {
        input: {
          ...input,
          model,
          permission,
          mode: input.mode ?? "build",
          ...(providerSourceId ? { providerSourceId } : {}),
          ...(routeGroupId ? { routeGroupId } : {}),
        },
        providerBinding,
      };
    },
  });

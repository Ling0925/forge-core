import { ForgeError } from "../shared/errors";
import {
  exclusiveModelProtocol,
  modelProtocol,
  modelProtocolEndpoint,
  modelProtocolOverride,
} from "../shared/model-protocol";
import {
  configureInputSchema,
  defaultPublicSettings,
  providerConfigSchema,
  publicSettingsSchema,
} from "../shared/schemas";
import type { PublicSettings } from "../shared/schemas";
import type { StoredState } from "./settings-schema";
import {
  invalid,
  publicSource,
  selectedCredential,
  unknownSource,
} from "./settings-state";

export function createSettingsProvider({
  load,
}: Readonly<{
  load: () => Promise<StoredState>;
}>) {
  const effective = async (): Promise<
    Readonly<{
      stored: StoredState;
      public: PublicSettings;
      apiKey: string;
      environmentOverride: boolean;
    }>
  > => {
    const stored = await load();
    const overlay = configureInputSchema.safeParse({
      settings: {
        ...(process.env.FORGE_BASE_URL === undefined
          ? {}
          : { baseUrl: process.env.FORGE_BASE_URL }),
        ...(process.env.FORGE_MODEL === undefined
          ? {}
          : { model: process.env.FORGE_MODEL }),
      },
      ...(process.env.FORGE_API_KEY === undefined
        ? {}
        : { apiKey: process.env.FORGE_API_KEY }),
    });
    if (!overlay.success)
      throw new ForgeError(
        "invalid_input",
        "Environment configuration failed validation.",
      );
    const settings = {
      ...defaultPublicSettings,
      ...stored.settings,
      ...overlay.data.settings,
    };
    const active = stored.sources.find(
      (source) => source.id === stored.activeSourceId,
    );
    // FORGE_* keeps its original priority over the stored active source.
    const apiKey = overlay.data.apiKey ?? active?.apiKey ?? stored.apiKey;
    const environmentOverride =
      process.env.FORGE_BASE_URL !== undefined ||
      process.env.FORGE_MODEL !== undefined ||
      process.env.FORGE_API_KEY !== undefined;
    return {
      stored,
      apiKey,
      environmentOverride,
      public: publicSettingsSchema.parse({
        ...settings,
        hasApiKey: apiKey !== "",
        isConfigured: settings.baseUrl !== "" && settings.model !== "",
        providerSources: stored.sources.map(publicSource),
        // Explicit empty list: older configs migrate without rewriting the file.
        agentProfiles: stored.agentProfiles ?? [],
        ...(stored.routeGroups === undefined
          ? {}
          : { routeGroups: stored.routeGroups }),
        ...(stored.activeSourceId === undefined
          ? {}
          : { activeSourceId: stored.activeSourceId }),
        environmentOverride,
      }),
    };
  };
  const providerSnapshot = async (
    requestedSourceId?: string,
    credentialId?: string,
    model?: string,
  ) => {
    const state = await effective();
    const sourceId =
      requestedSourceId ??
      (state.environmentOverride ? undefined : state.stored.activeSourceId);
    if (sourceId !== undefined) {
      const source = state.stored.sources.find(
        (candidate) => candidate.id === sourceId,
      );
      if (!source) throw unknownSource();
      // Resolve request routing before choosing a credential: a protocol-bound
      // credential must be selected for the model's effective protocol, and an
      // explicit/active credential that disagrees still fails instead of being
      // silently replaced.
      const protocol = modelProtocol(source, model);
      const override = modelProtocolOverride(source, model);
      // Preserve the legacy private shape when neither the source nor the model
      // names a protocol: routing still defaults to chat-completions, but
      // apiMode stays omitted rather than being materialized as a setting.
      const explicitProtocol = override ?? source.apiMode;
      if (
        override !== undefined &&
        source.connection?.vertex &&
        override !== "gemini"
      )
        throw invalid(
          `Vertex 来源固定使用 gemini 协议，不能${model === undefined ? "" : `为模型 ${model} `}覆盖为 ${override}。`,
        );
      const credential = selectedCredential(source, credentialId, protocol);
      if (credential.type === "account" && !credential.account)
        throw invalid("账号已退出，请重新登录。");
      const exclusive = exclusiveModelProtocol(
        undefined,
        credential.account?.platform,
      );
      if (
        override !== undefined &&
        exclusive !== undefined &&
        override !== exclusive
      )
        throw invalid(
          `${credential.account?.platform === "codex" ? "Codex 账号" : "账号"}固定使用 ${exclusive} 协议，不能${model === undefined ? "" : `为模型 ${model} `}覆盖为 ${override}。`,
        );
      const publicSource = state.public.providerSources?.find(
        (candidate) => candidate.id === source.id,
      );
      if (!publicSource) throw invalid("未找到模型来源。");
      return {
        source: publicSource,
        config: providerConfigSchema.parse({
          ...source.connection,
          baseUrl: modelProtocolEndpoint(source, protocol) ?? source.baseUrl,
          apiKey: credential.apiKey ?? credential.account?.accessToken ?? "",
          credentialId: credential.id,
          sourceId: source.id,
          sourceRevision: source.revision,
          ...(credential.account ? { account: credential.account } : {}),
          requestTimeoutMs: state.public.requestTimeoutMs,
          ...(explicitProtocol === undefined
            ? {}
            : { apiMode: explicitProtocol }),
          reasoningEffort: state.public.reasoningEffort,
          maxOutputTokens: state.public.maxOutputTokens,
        }),
      };
    }
    const config = state.public;
    if (!config.baseUrl)
      throw new ForgeError(
        "invalid_input",
        "Configure a provider endpoint before listing models.",
      );
    return {
      config: providerConfigSchema.parse({
        baseUrl: config.baseUrl,
        apiKey: state.apiKey,
        requestTimeoutMs: config.requestTimeoutMs,
        apiMode: config.apiMode,
        reasoningEffort: config.reasoningEffort,
        maxOutputTokens: config.maxOutputTokens,
      }),
    };
  };
  return { effective, providerSnapshot };
}

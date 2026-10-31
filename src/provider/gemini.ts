import { z } from "zod";
import type { ModelProvider } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type { ModelCatalog, ModelCatalogEntry } from "../shared/model-catalog";
import {
  messageSchema,
  providerConfigSchema,
  settingsFields,
  toolDefinitionSchema,
} from "../shared/schemas";
import type { ProviderConfig } from "../shared/schemas";
import { MAX_PROVIDER_JSON_CHARS, parseProviderJson } from "./bounded-json";
import { ProviderError, httpError, protocol } from "./errors";
import { thinkingConfig, wireContents } from "./gemini-request";
import { responseReader } from "./gemini-stream";
import { modelsPageWire } from "./gemini-wire";
import { createRequestOptions } from "./request-options";
import { sdkEvents, withSdkRequest } from "./sdk-transport";
import { scopeProviderState } from "./state-scope";

// Native Google Gemini API adapter (generativelanguage.googleapis.com and
// relays that answer as it does). Protocol reference:
// references/magpie/internal/gateway/gemini.go, gemini_signature.go,
// internal/provider/gemini_api.go at the pinned commit. Forge's streaming,
// tool, cancellation and provider-state semantics are kept, not Magpie's
// gateway/IR layer.
const MAX_MODELS = 10_000;
const MAX_PAGES = 100;

// Shared request options resolve auth, custom headers and extraBody, and carry
// a proxy-aware transport when the source has one. Their headers may hold null
// to mean "remove the SDK default credential header"; raw fetch omits those.
// The native content type is the adapter's own and is never user-overridable.
const wireHeaders = (
  headers: Readonly<Record<string, string | null>>,
  contentType?: string,
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== null) values[name] = value;
  if (contentType) values["content-type"] = contentType;
  return values;
};

const send = async (
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (error instanceof TypeError)
      throw new ProviderError(
        "network",
        "The provider connection failed.",
        true,
      );
    throw error;
  }
};

const readBody = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (text.length > MAX_PROVIDER_JSON_CHARS)
    throw protocol("output_limit", {
      stage: "json_response",
      observed: text.length,
      limit: MAX_PROVIDER_JSON_CHARS,
      unit: "utf16_code_units",
    });
  return text;
};

const baseOf = (baseUrl: string): string => {
  // A pasted endpoint (…/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse)
  // or a model list URL is cut back to the base it sits under, as the reference
  // does; any other prefix (a relay's /proxy/v1beta) stays as configured.
  return baseUrl
    .trim()
    .replace(/\/models(?:\/[^/?#]*)?(?:[?#].*)?$/i, "")
    .replace(/\/+$/, "");
};
const pathOf = (model: string): string =>
  encodeURIComponent(model.replace(/^models\//, ""));

type CatalogModel = {
  readonly contextWindowTokens: number | null;
  readonly displayName: string | undefined;
  readonly maxOutputTokens: number | null;
};

const positiveTokens = (value: unknown): number | null => {
  const number =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return typeof number === "number" &&
    Number.isInteger(number) &&
    number > 0 &&
    number <= 10_000_000
    ? number
    : null;
};

export function createGeminiProvider(config: ProviderConfig): ModelProvider {
  const parsedConfig = providerConfigSchema.safeParse(config);
  if (!parsedConfig.success)
    throw new ForgeError(
      "invalid_input",
      "Configure a valid provider endpoint and timeout.",
      false,
    );
  const settings = parsedConfig.data;
  const baseUrl = baseOf(settings.baseUrl);
  // Shared request options own auth (a provider with neither a key nor an auth
  // mode is a keyless relay that sends no credential), custom headers,
  // extraBody and a proxy-aware transport. Their headers may hold null to mean
  // "remove a credential header an SDK would add"; this adapter's own fetch
  // drops those instead of sending "null".
  const transport = createRequestOptions(settings);
  let catalog = new Map<string, CatalogModel>();
  let catalogLoaded = false;
  // Always ask upstream: the host's catalog cache owns refresh decisions, and
  // this is the call it makes when the user asks for fresh metadata.
  const listModels = (signal?: AbortSignal) =>
    withSdkRequest(
      settings,
      { signal, idle: false, fetch: transport.fetch },
      async ({ signal: combined, fetch }) => {
        const next = new Map<string, CatalogModel>();
        const seen = new Set<string>();
        let pageToken: string | undefined;
        for (let page = 0; ; page += 1) {
          if (page >= MAX_PAGES) throw protocol("output_limit");
          const url = new URL(`${baseUrl}/models`);
          url.searchParams.set("pageSize", "1000");
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const response = await send(
            fetch,
            url.toString(),
            { method: "GET", headers: wireHeaders(transport.headers) },
            combined,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw httpError(response.status);
          }
          const body = modelsPageWire.safeParse(
            parseProviderJson(await readBody(response)),
          );
          if (!body.success) throw protocol();
          for (const model of body.data.models ?? []) {
            // The list also carries models no agent can ask for a reply
            // (embeddings, Imagen, Veo). A method list the upstream sent
            // decides that; a model that omits it is kept (the reference
            // keeps anything it cannot classify).
            const methods = model.supportedGenerationMethods;
            if (
              Array.isArray(methods) &&
              methods.length > 0 &&
              !methods.includes("generateContent") &&
              !methods.includes("streamGenerateContent")
            )
              continue;
            const id = settingsFields.model.parse(
              model.name.startsWith("models/")
                ? model.name.slice("models/".length)
                : model.name,
            );
            const displayName =
              typeof model.displayName === "string"
                ? model.displayName
                : undefined;
            next.set(id, {
              contextWindowTokens: positiveTokens(model.inputTokenLimit),
              displayName,
              maxOutputTokens: positiveTokens(model.outputTokenLimit),
            });
            if (next.size > MAX_MODELS) throw protocol("output_limit");
          }
          const token = body.data.nextPageToken;
          if (!token) break;
          if (seen.has(token)) throw protocol("invalid_response");
          seen.add(token);
          pageToken = token;
        }
        // Publish only after every page succeeded; a failed refresh keeps the
        // previous catalog instead of replacing it with a partial one.
        catalog = next;
        catalogLoaded = true;
        return [...next.keys()].sort();
      },
    );
  const listModelCatalog = async (
    signal?: AbortSignal,
  ): Promise<ModelCatalog> => {
    const ids = await listModels(signal);
    return ids.map((id): ModelCatalogEntry => {
      const model = catalog.get(id);
      const provenance: Record<string, "upstream"> = {};
      const entry: ModelCatalogEntry = {
        id,
        contextWindowTokens: model?.contextWindowTokens ?? null,
        ...(model?.displayName ? { displayName: model.displayName } : {}),
        ...(model?.maxOutputTokens != null
          ? { maxOutputTokens: model.maxOutputTokens }
          : {}),
      };
      if (entry.contextWindowTokens !== null)
        provenance.contextWindowTokens = "upstream";
      if (entry.displayName !== undefined) provenance.displayName = "upstream";
      if (entry.maxOutputTokens != null)
        provenance.maxOutputTokens = "upstream";
      return {
        ...entry,
        ...(Object.keys(provenance).length ? { provenance } : {}),
      };
    });
  };
  return scopeProviderState(
    {
      apiMode: "gemini",
      listModels,
      listModelCatalog,
      async getModelContextWindow(model, signal) {
        if (!catalogLoaded) await listModels(signal);
        return catalog.get(model)?.contextWindowTokens ?? null;
      },
      async complete(messages, tools, options) {
        if (options.webSearch !== undefined && options.webSearch !== "disabled")
          throw new ForgeError(
            "invalid_input",
            "Native web search requires a Responses endpoint and a model supporting web_search; no local-search fallback is used.",
          );
        const model = settingsFields.model.safeParse(options.model);
        const history = z.array(messageSchema).max(100000).safeParse(messages);
        const definitions = z
          .array(toolDefinitionSchema)
          .max(256)
          .safeParse(tools);
        if (!model.success || !history.success || !definitions.success)
          throw new ForgeError(
            "invalid_input",
            "Provide a valid model, message history and tool definitions.",
            false,
          );
        return withSdkRequest(
          settings,
          { signal: options.signal, idle: true, fetch: transport.fetch },
          async ({ signal, fetch }) => {
            const request = wireContents(
              history.data,
              baseUrl,
              model.data,
              settings.credentialId,
            );
            const declarations = definitions.data.map((tool) => ({
              name: tool.function.name,
              ...(tool.function.description
                ? { description: tool.function.description }
                : {}),
              parameters: tool.function.parameters,
            }));
            const generation: Record<string, unknown> = {};
            if (settings.maxOutputTokens)
              generation.maxOutputTokens = settings.maxOutputTokens;
            const thinking = thinkingConfig(
              model.data,
              settings.reasoningEffort,
            );
            if (thinking) generation.thinkingConfig = thinking;
            const body = transport.applyBody(
              {
                ...(request.system
                  ? { systemInstruction: { parts: [{ text: request.system }] } }
                  : {}),
                contents: request.contents,
                ...(declarations.length
                  ? { tools: [{ functionDeclarations: declarations }] }
                  : {}),
                ...(Object.keys(generation).length
                  ? { generationConfig: generation }
                  : {}),
              },
              options.sessionId,
            );
            const response = await send(
              fetch,
              `${baseUrl}/models/${pathOf(model.data)}:streamGenerateContent?alt=sse`,
              {
                method: "POST",
                headers: {
                  ...wireHeaders(transport.headers),
                  ...transport.headersFor(body),
                  "content-type": "application/json",
                },
                body: JSON.stringify(body),
              },
              signal,
            );
            if (!response.ok) {
              await response.body?.cancel();
              throw httpError(response.status);
            }
            const reader = responseReader(
              options,
              model.data,
              baseUrl,
              settings.credentialId,
            );
            const contentType = response.headers
              .get("content-type")
              ?.split(";")[0]
              ?.trim()
              .toLowerCase();
            if (contentType === "text/event-stream") {
              try {
                for await (const event of sdkEvents(response))
                  reader.dispatch(event.data);
              } catch (error) {
                if (error instanceof ForgeError) throw error;
                if (error instanceof TypeError)
                  throw new ProviderError(
                    "network",
                    "The provider connection failed.",
                    true,
                  );
                throw error;
              }
              return reader.response();
            }
            // A gateway that ignores alt=sse may answer with one JSON body
            // (Factory does, per the reference); it is the same response object.
            if (contentType === "application/json") {
              reader.accept(parseProviderJson(await readBody(response)));
              return reader.response();
            }
            await response.body?.cancel();
            throw protocol();
          },
        );
      },
    },
    settings,
  );
}

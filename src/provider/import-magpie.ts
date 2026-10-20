import { createHash } from "node:crypto";
import { ForgeError } from "../shared/errors";
import {
  credentialInputSchema,
  type CredentialInput,
} from "../shared/model-access";
import {
  jsonObjectSchema,
  providerSourceOperationSchema,
  type JsonValue,
  type ProviderSourceOperation,
} from "../shared/schemas";
import type {
  ProviderEndpoints,
  ProviderPreset,
} from "./presets";
import { findProviderPreset, presetEndpoints } from "./presets";
import { extraBodyReserved } from "./request-options";

type RecordValue = Readonly<Record<string, unknown>>;
type SourceSave = Extract<ProviderSourceOperation, { type: "save" }>;
type Connection = NonNullable<SourceSave["connection"]>;
type Auth = NonNullable<Connection["auth"]>;
type Protocol = NonNullable<SourceSave["source"]["apiMode"]>;
type Routing = NonNullable<SourceSave["source"]["credentialRouting"]>;

/**
 * A private import candidate. It is shaped like one configure(sources: [...])
 * save operation, but is never persisted or returned by a public projection.
 * Credentials and header values stay in this object until the user confirms.
 */
export type MagpieImportCandidate = Readonly<{
  ref: string;
  label: string;
  save: SourceSave;
  warnings: readonly string[];
}>;

export type MagpieImportResult = Readonly<{
  candidates: readonly MagpieImportCandidate[];
  warnings: readonly string[];
}>;

const protocolFor: Readonly<Record<string, Protocol>> = {
  chat: "chat-completions",
  "chat-completions": "chat-completions",
  responses: "responses",
  anthropic: "anthropic",
  gemini: "gemini",
};
const routingValues = new Set<Routing>(["order", "rotate", "usage", "smart", "pace"]);
const maxKeyLength = 16384;

function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validKey(key: string): boolean {
  return key.length > 0 && key.length <= maxKeyLength && !/[\r\n\0]/.test(key);
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const safe = normalized.replace(/^[^a-z]+/, "");
  return (safe || "source").slice(0, 32).replace(/[-_]+$/g, "") || "source";
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base.slice(0, 32);
  for (let index = 2; used.has(candidate); index++) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function label(value: string, fallback: string): string {
  const chosen = value.trim() || fallback;
  return [...chosen].slice(0, 80).join("") || fallback;
}

function endpoint(value: unknown, name: string, warnings: string[]): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    warnings.push(`${name} endpoint is not a string and was ignored.`);
    return undefined;
  }
  try {
    const parsed = new URL(value.trim());
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      warnings.push(`${name} endpoint must be an HTTP(S) base URL without credentials, query, or fragment; it was ignored.`);
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    warnings.push(`${name} endpoint is not a valid URL and was ignored.`);
    return undefined;
  }
}

function explicitEndpoints(raw: RecordValue, warnings: string[]): ProviderEndpoints {
  const chat = endpoint(raw.chat, "Chat", warnings);
  const responses = endpoint(raw.responses, "Responses", warnings);
  const anthropic = endpoint(raw.anthropic, "Anthropic", warnings);
  const gemini = endpoint(raw.gemini, "Gemini", warnings);
  return {
    ...(chat ? { "chat-completions": chat } : {}),
    ...(responses ? { responses } : {}),
    ...(anthropic ? { anthropic } : {}),
    ...(gemini ? { gemini } : {}),
  };
}

function primaryEndpoint(
  endpoints: ProviderEndpoints,
  raw: RecordValue,
): { baseUrl: string; apiMode: Protocol } | undefined {
  const requested = typeof raw.baseAPI === "string" ? protocolFor[raw.baseAPI.toLowerCase()] : undefined;
  if (requested && endpoints[requested]) return { baseUrl: endpoints[requested]!, apiMode: requested };
  const order: readonly Protocol[] = ["chat-completions", "responses", "anthropic", "gemini"];
  const explicitBase = endpoint(raw.baseUrl, "Base", []);
  if (explicitBase) {
    const requestedMode =
      typeof raw.apiMode === "string" ? protocolFor[raw.apiMode.toLowerCase()] : undefined;
    const matchingMode = order.find((mode) => endpoints[mode] === explicitBase);
    return {
      baseUrl: explicitBase,
      apiMode: requestedMode ?? matchingMode ?? "chat-completions",
    };
  }
  for (const mode of order) {
    const baseUrl = endpoints[mode];
    if (baseUrl) return { baseUrl, apiMode: mode };
  }
  return undefined;
}

function models(raw: RecordValue): {
  selection: NonNullable<SourceSave["source"]["modelSelection"]>;
  model: string;
  warning?: string;
} {
  if (!Object.prototype.hasOwnProperty.call(raw, "models")) {
    return { selection: { mode: "all" }, model: "" };
  }
  const value = raw.models;
  if (!Array.isArray(value)) {
    return {
      selection: { mode: "all" },
      model: "",
      warning: "Magpie models is not an array; the source was left as all models.",
    };
  }
  const ids = value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!ids.length) return { selection: { mode: "none" }, model: "" };
  return {
    selection: { mode: "selected", models: [...new Set(ids)] },
    model: ids[0]!,
  };
}

function modelAliases(raw: RecordValue, warnings: string[]): Record<string, string> | undefined {
  if (raw.modelAliases === undefined) return undefined;
  const source = object(raw.modelAliases);
  if (!source) {
    warnings.push("modelAliases is not an object and was ignored.");
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, alias] of Object.entries(source))
    if (name.trim() && typeof alias === "string" && alias.trim()) out[name] = alias.trim();
  return Object.keys(out).length ? out : undefined;
}

function headers(raw: RecordValue, warnings: string[]): Record<string, string> | undefined {
  if (raw.headers === undefined) return undefined;
  const source = object(raw.headers);
  if (!source) {
    warnings.push("headers is not an object and was ignored.");
    return undefined;
  }
  const out: Record<string, string> = {};
  const reserved = new Set([
    "host", "content-length", "connection", "transfer-encoding",
    "upgrade", "trailer", "te",
  ]);
  for (const [name, value] of Object.entries(source)) {
    if (
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      reserved.has(name.toLowerCase()) ||
      /[\r\n\0]/.test(value)
    ) {
      warnings.push(`header ${name || "(unnamed)"} is invalid and was ignored.`);
      continue;
    }
    out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function extraBody(raw: RecordValue, warnings: string[]): Record<string, JsonValue> | undefined {
  if (raw.extraBody === undefined) return undefined;
  const source = object(raw.extraBody);
  if (!source) {
    warnings.push("extraBody is not an object and was ignored.");
    return undefined;
  }
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    const forced = key.trim().startsWith("!");
    const name = (forced ? key.trim().slice(1) : key.trim()).trim();
    if (!name || extraBodyReserved.has(name) || seen.has(name)) {
      warnings.push(`extraBody field ${name || "(unnamed)"} is reserved or repeated and was ignored.`);
      continue;
    }
    seen.add(name);
    out[key] = value;
  }
  if (!Object.keys(out).length) return undefined;
  const parsed = jsonObjectSchema.safeParse(out);
  if (!parsed.success) {
    warnings.push("extraBody contains values that are not JSON and was ignored.");
    return undefined;
  }
  return { ...parsed.data };
}

function proxy(value: unknown, warnings: string[]): string | undefined {
  if (value === undefined || value === null || value === "" || value === "direct") return undefined;
  if (typeof value !== "string") {
    warnings.push("proxy is not a string and was ignored.");
    return undefined;
  }
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol)) {
      warnings.push("proxy has an unsupported URL scheme and was ignored.");
      return undefined;
    }
    return parsed.toString();
  } catch {
    warnings.push("proxy is not a valid URL and was ignored.");
    return undefined;
  }
}

function auth(raw: RecordValue, warnings: string[]): Auth | undefined {
  const explicit = object(raw.auth);
  if (explicit) {
    const type = explicit.type;
    if (
      type === "auto" || type === "bearer" || type === "api-key" ||
      type === "none" || type === "header"
    ) {
      if (type === "header" && typeof explicit.header !== "string") {
        warnings.push("auth type header needs a header name and was ignored.");
        return undefined;
      }
      return {
        type,
        ...(type === "header" && typeof explicit.header === "string"
          ? { header: explicit.header }
          : {}),
        ...(typeof explicit.prefix === "string" ? { prefix: explicit.prefix } : {}),
      };
    }
    warnings.push("auth.type is unknown and was ignored.");
  }
  if (raw.authHeader === undefined || raw.authHeader === "") return undefined;
  if (raw.authHeader === "x-api-key") return { type: "api-key" };
  if (raw.authHeader === "bearer") return { type: "bearer" };
  if (raw.authHeader === "both") return { type: "auto" };
  warnings.push("authHeader is unknown and was ignored.");
  return undefined;
}

function credential(
  key: string,
  name: string | undefined,
  index: number,
  enabled: boolean,
  protocol: Protocol | undefined,
): CredentialInput | undefined {
  if (!validKey(key)) return undefined;
  const id = `key-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  return credentialInputSchema.parse({
    id,
    label: label(name ?? "", index === 0 ? "Primary key" : `Key ${index + 1}`),
    enabled,
    type: "api-key",
    apiKey: key,
    ...(protocol ? { protocol } : {}),
  });
}

function credentials(raw: RecordValue, warnings: string[]): {
  credentials: CredentialInput[];
  activeCredentialId?: string;
} {
  const candidates: CredentialInput[] = [];
  const used = new Set<string>();
  const push = (entry: CredentialInput | undefined): void => {
    if (!entry) return;
    if (used.has(entry.id)) return;
    used.add(entry.id);
    candidates.push(entry);
  };
  if (typeof raw.key === "string" && raw.key)
    push(credential(raw.key, text(raw.keyName), 0, true, undefined));
  else if (raw.key !== undefined && raw.key !== "")
    warnings.push("The primary key is not a string and was ignored.");

  if (raw.keys !== undefined) {
    if (!Array.isArray(raw.keys)) warnings.push("keys is not an array and was ignored.");
    else {
      raw.keys.forEach((value, index) => {
        const key = object(value);
        if (!key) {
          warnings.push(`Key ${index + 1} is not an object and was ignored.`);
          return;
        }
        if (typeof key.key !== "string") {
          warnings.push(`Key ${index + 1} has no key and was ignored.`);
          return;
        }
        const protocol =
          typeof key.protocol === "string" ? protocolFor[key.protocol.toLowerCase()] : undefined;
        if (key.protocol !== undefined && !protocol)
          warnings.push(`Key ${index + 1} has an unknown protocol and was imported without one.`);
        const parsed = credential(
          key.key,
          text(key.name),
          index + 1,
          key.off !== true,
          protocol,
        );
        if (!parsed) warnings.push(`Key ${index + 1} is invalid and was ignored.`);
        else push(parsed);
      });
    }
  }
  const active = candidates.find((entry) => entry.enabled) ?? candidates[0];
  return {
    credentials: candidates,
    ...(active ? { activeCredentialId: active.id } : {}),
  };
}

function sourceFrom(raw: RecordValue, usedIds: Set<string>): {
  save: SourceSave;
  label: string;
  ref: string;
  warnings: string[];
} | { warnings: string[] } {
  const warnings: string[] = [];
  const rawId = text(raw.id) ?? text(raw.name) ?? "imported";
  const sourceId = uniqueId(slug(rawId), usedIds);
  const name = label(text(raw.name) ?? text(raw.label) ?? sourceId, sourceId);
  const presetId = text(raw.preset)?.toLowerCase();
  let preset: ProviderPreset | undefined;
  if (presetId) {
    preset = findProviderPreset(presetId);
    if (!preset) warnings.push(`Unknown preset ${presetId}; explicit endpoints were used.`);
  }
  const regionId = text(raw.region);
  const presetValues =
    preset && (!regionId || preset.regions?.some((entry) => entry.id === regionId))
      ? presetEndpoints(preset.id, regionId)
      : undefined;
  if (regionId && preset && !presetValues)
    warnings.push(`Unknown region ${regionId}; the preset's default endpoints were used.`);
  const endpoints: ProviderEndpoints = {
    ...(presetValues ?? {}),
    ...explicitEndpoints(raw, warnings),
  };
  const primary = primaryEndpoint(endpoints, raw);
  if (!primary) {
    warnings.push("No HTTP(S) endpoint was found; the provider was skipped.");
    // Keep the endpoint-specific reason instead of only the generic skip.
    return { warnings };
  }
  const selected = models(raw);
  if (selected.warning) warnings.push(selected.warning);
  const aliases = modelAliases(raw, warnings);
  const customHeaders = headers(raw, warnings);
  const customBody = extraBody(raw, warnings);
  const proxyUrl = proxy(raw.proxy, warnings);
  const authValue = auth(raw, warnings);
  const keys = credentials(raw, warnings);
  const routingValue =
    typeof raw.routing === "string" && routingValues.has(raw.routing as Routing)
      ? (raw.routing as Routing)
      : undefined;
  if (raw.routing !== undefined && !routingValue)
    warnings.push("routing is unsupported here and was ignored.");
  const sticky =
    typeof raw.sticky === "boolean"
      ? raw.sticky
      : typeof raw.affinity === "string" && raw.affinity !== "off"
        ? true
        : undefined;
  if (raw.account !== undefined)
    warnings.push("Magpie account credentials are not imported from text; configure the account sign-in separately.");
  if (raw.only !== undefined)
    warnings.push("Magpie only= prefix filtering is not imported; modelSelection follows models instead.");

  const connection: Connection = {
    ...(authValue ? { auth: authValue } : {}),
    ...(customHeaders ? { headers: customHeaders } : {}),
    ...(customBody ? { extraBody: customBody } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
  };
  const source: SourceSave["source"] = {
    id: sourceId,
    label: name,
    baseUrl: primary.baseUrl,
    model: selected.model,
    apiMode: primary.apiMode,
    ...(preset && preset.id !== "custom" ? { preset: preset.id } : {}),
    endpoints,
    modelSelection: selected.selection,
    ...(aliases ? { modelAliases: aliases } : {}),
    ...(routingValue ? { credentialRouting: routingValue } : {}),
    ...(sticky === undefined ? {} : { sticky }),
    ...(keys.activeCredentialId ? { activeCredentialId: keys.activeCredentialId } : {}),
  };
  const save = providerSourceOperationSchema.parse({
    type: "save",
    source,
    // Keep the legacy single-key field for old hosts; credentials remain the
    // authoritative multi-key representation.
    ...(keys.credentials[0]?.apiKey ? { apiKey: keys.credentials[0].apiKey } : {}),
    ...(keys.credentials.length ? { credentials: keys.credentials } : {}),
    ...(Object.keys(connection).length ? { connection } : {}),
  }) as SourceSave;
  return { save, label: name, ref: sourceId, warnings };
}

function rawProviderFromLink(link: URL): RecordValue {
  if (
    link.protocol !== "magpie:" ||
    (link.hostname !== "import" && link.pathname.replace(/^\/+/, "") !== "import")
  )
    throw new ForgeError("invalid_input", "The text is not a magpie://import link.", false);
  const params = link.searchParams;
  const get = (name: string): string | undefined => text(params.get(name));
  const modelsPresent = params.has("models");
  const models = modelsPresent
    ? params.get("models")?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? []
    : undefined;
  return {
    ...(get("id") ? { id: get("id") } : {}),
    ...(get("name") ? { name: get("name") } : {}),
    ...(get("preset") ? { preset: get("preset") } : {}),
    ...(get("region") ? { region: get("region") } : {}),
    ...(get("key") ? { key: get("key") } : {}),
    ...(get("chat") ? { chat: get("chat") } : {}),
    ...(get("responses") ? { responses: get("responses") } : {}),
    ...(get("anthropic") ? { anthropic: get("anthropic") } : {}),
    ...(get("gemini") ? { gemini: get("gemini") } : {}),
    ...(modelsPresent ? { models } : {}),
    ...(get("catalog") ? { catalog: get("catalog") } : {}),
  };
}

/**
 * Parse text the user pasted or selected: a Magpie providers JSON document, a
 * provider array/object, or a magpie://import link. This never scans an app,
 * a home directory, or a token store; no credentials are read unless they are
 * already in the supplied text.
 */
export function parseMagpieImport(textInput: string): MagpieImportResult {
  const input = textInput.trim().replace(/^\uFEFF/, "");
  if (!input)
    throw new ForgeError("invalid_input", "Paste Magpie provider JSON or an import link.", false);

  let documents: RecordValue[];
  if (input.toLowerCase().startsWith("magpie:")) {
    let link: URL;
    try {
      link = new URL(input);
    } catch {
      throw new ForgeError("invalid_input", "The Magpie import link is invalid.", false);
    }
    documents = [rawProviderFromLink(link)];
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new ForgeError(
        "invalid_input",
        "The import text is not valid JSON or a magpie://import link.",
        false,
      );
    }
    if (Array.isArray(parsed)) {
      documents = parsed.filter((entry): entry is RecordValue => object(entry) !== undefined);
    } else {
      const wrapper = object(parsed);
      if (!wrapper)
        throw new ForgeError("invalid_input", "The import JSON has no provider objects.", false);
      if (Array.isArray(wrapper.providers)) {
        documents = wrapper.providers.filter(
          (entry): entry is RecordValue => object(entry) !== undefined,
        );
      } else if (object(wrapper.provider)) {
        documents = [object(wrapper.provider)!];
      } else {
        documents = [wrapper];
      }
    }
  }
  if (!documents.length)
    throw new ForgeError("invalid_input", "The import text contains no providers.", false);

  const warnings: string[] = [];
  const candidates: MagpieImportCandidate[] = [];
  const usedIds = new Set<string>();
  for (const document of documents) {
    const parsed = sourceFrom(document, usedIds);
    if (!("save" in parsed)) {
      warnings.push(...parsed.warnings, `${text(document.name) ?? "An entry"} was skipped.`);
      continue;
    }
    warnings.push(...parsed.warnings);
    candidates.push({
      ref: parsed.ref,
      label: parsed.label,
      save: parsed.save,
      warnings: parsed.warnings,
    });
  }
  return { candidates, warnings };
}

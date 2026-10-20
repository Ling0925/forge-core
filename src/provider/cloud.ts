import { type KeyObject, createPrivateKey, sign } from "node:crypto";
import { ForgeError } from "../shared/errors";
import type { VertexConfig } from "../shared/model-access";
import type { ModelCatalog, ModelCatalogEntry } from "../shared/model-catalog";

// Google Vertex AI access with credentials the user supplied as JSON. The
// endpoint and credential behavior follows
// references/magpie/internal/provider/vertex.go at the pinned commit, but
// Forge deliberately performs no ADC, gcloud, environment, metadata-server or
// credential-file discovery: the credentials object is the only source.
//
// Vertex serves Gemini's native generateContent API under
// /v1/projects/<project>/locations/<location>/publishers/google, so the
// Gemini adapter can append /models/<exact-id> to the resolved base URL. An
// OAuth access token is always sent as Bearer, never as x-goog-api-key, and
// no quota project is sent (the project in the URL is billed).

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const IAM_CREDENTIALS_URL = "https://iamcredentials.googleapis.com/v1";
const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_REFRESH_LEAD_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// The project and location rules mirrored from Magpie's Vertex config. They
// are needed to form a safe endpoint; credentials are not restricted to a
// hand-written field whitelist beyond the fields each supported type needs.
const projectPattern = /^[a-z0-9][a-z0-9.:-]*[a-z0-9]$/;
const locationPattern = /^[a-z]+(-[a-z0-9]+)*$/;
const accountPattern = /^[^\s@/]+@[^\s@/]+$/;
const impersonationPath =
  /\/serviceAccounts\/([^/:?#]+):generateAccessToken(?:[?#].*)?$/;
const lineBreakPattern = /[\r\n\0]/;

// Magpie's static Vertex model lists. Vertex has no list endpoint that says
// which models a location serves, so these are reference data, not a fake
// upstream catalog request.
const globalModels = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-4-argon",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;
const multiRegionModels = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
] as const;
const regionModels = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

const azureHostSuffixes = [
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
  ".services.ai.azure.com",
] as const;

export type VertexAccess = Readonly<{
  baseUrl: string;
  apiKey: string;
  apiMode: "gemini";
  auth: Readonly<{ type: "bearer" }>;
}>;

export type VertexAuthOptions = Readonly<{
  fetch?: typeof fetch;
  /** Milliseconds, like Date.now. */
  now?: () => number;
  /** Per token/IAM request; defaults to 30 seconds. */
  requestTimeoutMs?: number;
}>;

export interface VertexAuth {
  /** Validated destination, available without minting an access token. */
  readonly baseUrl: string;
  /**
   * A Vertex Gemini base and a Bearer access token. The base ends at
   * publishers/google; the Gemini adapter appends /models/<exact-id>.
   */
  resolve(signal?: AbortSignal): Promise<VertexAccess>;
  /** Reference models for the configured location; never a network request. */
  listModelCatalog(signal?: AbortSignal): Promise<ModelCatalog>;
  /** Forget the token cache and abort token work this handle still owns. */
  dispose(): void;
}

type AccessToken = Readonly<{ value: string; expiresAt: number }>;

type AuthorizedUser = Readonly<{
  kind: "authorized_user";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}>;

type ServiceAccount = Readonly<{
  kind: "service_account";
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | undefined;
}>;

type ImpersonatedServiceAccount = Readonly<{
  kind: "impersonated_service_account";
  account: string;
  delegates: readonly string[];
  source: AuthorizedUser | ServiceAccount;
}>;

type Credential = AuthorizedUser | ServiceAccount | ImpersonatedServiceAccount;

const invalid = (message: string): ForgeError =>
  new ForgeError("invalid_input", message, false);
const failed = (message: string): ForgeError =>
  new ForgeError("provider", message, false);

const recordOf = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const stringField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
};

function readDelegates(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw invalid(
      "The impersonated service account's delegates must be a list of accounts.",
    );
  const delegates: string[] = [];
  for (const delegate of value) {
    if (typeof delegate !== "string" || delegate === "")
      throw invalid(
        "The impersonated service account's delegates must be a list of accounts.",
      );
    delegates.push(delegate);
  }
  return delegates;
}

function parseCredential(value: unknown, depth = 0): Credential {
  const fields = recordOf(value);
  if (!fields) throw invalid("The Google credentials must be a JSON object.");
  const type = fields.type;
  if (typeof type !== "string" || type === "")
    throw invalid("The Google credentials have no type.");
  const universeDomain = fields.universe_domain;
  if (
    typeof universeDomain === "string" &&
    universeDomain !== "" &&
    universeDomain !== "googleapis.com"
  )
    throw invalid(
      "The Google credentials target another universe domain; Vertex AI is asked at googleapis.com.",
    );

  switch (type) {
    case "service_account": {
      const clientEmail = stringField(fields, "client_email");
      const privateKey = stringField(fields, "private_key");
      if (!clientEmail || !privateKey)
        throw invalid(
          "The service_account Google credentials need client_email and private_key.",
        );
      return {
        kind: "service_account",
        clientEmail,
        privateKey,
        privateKeyId: stringField(fields, "private_key_id"),
      };
    }
    case "authorized_user": {
      const clientId = stringField(fields, "client_id");
      const refreshToken = stringField(fields, "refresh_token");
      if (!clientId || !refreshToken)
        throw invalid(
          "The authorized_user Google credentials need client_id and refresh_token.",
        );
      return {
        kind: "authorized_user",
        clientId,
        clientSecret: stringField(fields, "client_secret") ?? "",
        refreshToken,
      };
    }
    case "impersonated_service_account": {
      if (depth > 0)
        throw invalid(
          "An impersonated service account's source cannot be another impersonation.",
        );
      const impersonationUrl = stringField(
        fields,
        "service_account_impersonation_url",
      );
      if (!impersonationUrl)
        throw invalid(
          "The impersonated_service_account Google credentials need a service_account_impersonation_url.",
        );
      const match = impersonationPath.exec(impersonationUrl);
      const encodedAccount = match?.[1];
      if (!encodedAccount)
        throw invalid(
          "The service_account_impersonation_url names no service account.",
        );
      let account: string;
      try {
        account = decodeURIComponent(encodedAccount);
      } catch {
        throw invalid(
          "The service_account_impersonation_url names no service account.",
        );
      }
      if (!accountPattern.test(account))
        throw invalid(
          "The service_account_impersonation_url names no service account email.",
        );
      const source = parseCredential(fields.source_credentials, depth + 1);
      if (source.kind === "impersonated_service_account")
        throw invalid(
          "An impersonated service account's source cannot be another impersonation.",
        );
      return {
        kind: "impersonated_service_account",
        account,
        delegates: readDelegates(fields.delegates),
        source,
      };
    }
    case "external_account":
    case "external_account_authorized_user":
      throw invalid(
        "Workload identity federation credentials are not supported; use a service account key, an authorized_user refresh token or an impersonated service account.",
      );
    default:
      throw invalid(
        "The Google credentials type is not supported; use service_account, authorized_user or impersonated_service_account.",
      );
  }
}

function vertexRoot(location: string): string {
  if (location === "global") return "https://aiplatform.googleapis.com";
  if (location === "us" || location === "eu")
    return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

function vertexModels(location: string): readonly string[] {
  switch (location) {
    case "global":
      return globalModels;
    case "us":
    case "eu":
      return multiRegionModels;
    default:
      return regionModels;
  }
}

function referenceCatalog(location: string): ModelCatalog {
  return vertexModels(location).map(
    (id): ModelCatalogEntry => ({
      id,
      contextWindowTokens: null,
      provenance: { id: "reference" },
    }),
  );
}

function expiresInSeconds(value: unknown): number {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
}

function encodedJson(value: Readonly<Record<string, unknown>>): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw invalid("The service account token request could not be encoded.");
  return Buffer.from(encoded).toString("base64url");
}

function signServiceAccountJwt(
  credential: ServiceAccount,
  now: () => number,
): string {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: credential.privateKey, format: "pem" });
  } catch {
    throw invalid(
      "The service account private_key is not a readable PEM private key.",
    );
  }
  if (key.asymmetricKeyType !== "rsa")
    throw invalid("The service account private_key is not an RSA private key.");

  const issuedAt = Math.floor(now() / 1000) - 10;
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (credential.privateKeyId) header.kid = credential.privateKeyId;
  const claims = {
    iss: credential.clientEmail,
    scope: CLOUD_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const unsigned = `${encodedJson(header)}.${encodedJson(claims)}`;
  let signature: Buffer;
  try {
    signature = sign("RSA-SHA256", Buffer.from(unsigned), key);
  } catch {
    throw invalid(
      "The service account private_key could not sign the token request.",
    );
  }
  return `${unsigned}.${signature.toString("base64url")}`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    // Close the small window between the initial check and adding the listener.
    if (signal.aborted) onAbort();
  });
}

function assertUsableToken(value: string): void {
  if (lineBreakPattern.test(value))
    throw failed("The access token response contained an unusable token.");
}

function tokenStatusError(status: number): ForgeError {
  if (status === 400 || status === 401 || status === 403)
    return failed(`Google refused the credentials (HTTP ${status}).`);
  return failed(`Google's token endpoint failed (HTTP ${status}).`);
}

function iamStatusError(status: number): ForgeError {
  if (status === 403)
    return failed(
      "IAM Credentials refused the impersonation (HTTP 403); the signing account needs roles/iam.serviceAccountTokenCreator on the service account.",
    );
  if (status === 401)
    return failed("IAM Credentials refused the impersonation (HTTP 401).");
  return failed(`IAM Credentials failed (HTTP ${status}).`);
}

/**
 * Normalize a pasted Azure OpenAI resource URL or bare resource name to the
 * resource's generally available /openai/v1 base. Unknown hosts (including
 * API Management gateways, localhost and test servers) are not normalized and
 * yield undefined.
 */
export function normalizeAzureBase(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  const givenHost = url.host.toLowerCase();
  const host =
    givenHost.includes(".") || givenHost.includes(":")
      ? givenHost
      : `${givenHost}.openai.azure.com`;
  const colon = host.indexOf(":");
  const hostname = colon === -1 ? host : host.slice(0, colon);
  if (
    !azureHostSuffixes.some(
      (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
    )
  )
    return undefined;
  return `https://${host}/openai/v1`;
}

export function createVertexAuth(
  vertex: VertexConfig,
  options: VertexAuthOptions = {},
): VertexAuth {
  const project = vertex.project.trim().toLowerCase();
  const location = (vertex.location ?? "").trim().toLowerCase() || "global";
  const impersonate = (vertex.impersonate ?? "").trim().toLowerCase();
  const fetchFn: typeof fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const requestTimeoutMs =
    typeof options.requestTimeoutMs === "number" &&
    Number.isFinite(options.requestTimeoutMs) &&
    options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;

  let cache: AccessToken | undefined;
  let inflight: Promise<AccessToken> | undefined;
  let generation = 0;
  const activeRequests = new Set<AbortController>();

  const target = (): string => {
    if (!projectPattern.test(project))
      throw invalid("Google Vertex AI needs a valid Google Cloud project id.");
    if (!locationPattern.test(location))
      throw invalid(
        "Google Vertex AI needs a valid location: global, us, eu or a region such as us-central1.",
      );
    return `${vertexRoot(location)}/v1/projects/${project}/locations/${location}/publishers/google`;
  };

  const request = async <T>(
    url: string,
    init: RequestInit,
    label: string,
    read: (response: Response) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    activeRequests.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(failed(`${label} timed out.`));
      }, requestTimeoutMs);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          fetchFn(url, { ...init, signal: controller.signal }),
          timeout,
        ]);
      } catch {
        throw failed(
          timedOut ? `${label} timed out.` : `${label} could not be reached.`,
        );
      }
      try {
        // The body read shares the deadline: headers alone are not a response.
        return await Promise.race([read(response), timeout]);
      } catch (error) {
        if (error instanceof ForgeError) throw error;
        throw failed(
          timedOut ? `${label} timed out.` : `${label} could not be read.`,
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      activeRequests.delete(controller);
    }
  };

  const readRecord = async (
    response: Response,
    label: string,
  ): Promise<Readonly<Record<string, unknown>>> => {
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw failed(`${label} was not readable JSON.`);
    }
    const record = recordOf(value);
    if (!record) throw failed(`${label} was not a JSON object.`);
    return record;
  };

  const exchangeForm = async (form: URLSearchParams): Promise<AccessToken> =>
    request(
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      "Google's token request",
      async (response) => {
        if (!response.ok) throw tokenStatusError(response.status);
        const record = await readRecord(response, "Google's token response");
        const value = record.access_token;
        if (typeof value !== "string" || value === "")
          throw failed("Google's token response had no access token.");
        assertUsableToken(value);
        return {
          value,
          expiresAt: now() + expiresInSeconds(record.expires_in) * 1000,
        };
      },
    );

  const authorizedUserToken = (
    credential: AuthorizedUser,
  ): Promise<AccessToken> =>
    exchangeForm(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        refresh_token: credential.refreshToken,
      }),
    );

  const serviceAccountToken = (
    credential: ServiceAccount,
  ): Promise<AccessToken> =>
    exchangeForm(
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(credential, now),
      }),
    );

  const impersonatedToken = async (
    sourceToken: string,
    account: string,
    delegates: readonly string[],
  ): Promise<AccessToken> => {
    if (!accountPattern.test(account))
      throw invalid(
        "The impersonated service account must be an email address.",
      );
    const chain = delegates.map((delegate) =>
      delegate.startsWith("projects/")
        ? delegate
        : `projects/-/serviceAccounts/${delegate}`,
    );
    const body =
      JSON.stringify({
        scope: [CLOUD_SCOPE],
        lifetime: "3600s",
        ...(chain.length > 0 ? { delegates: chain } : {}),
      }) ?? "";
    // @ is valid in a path segment; keeping it matches Google's documented
    // IAM Credentials URL and Magpie's Go path escaping.
    const accountPath = encodeURIComponent(account).replaceAll("%40", "@");
    const token = await request(
      `${IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${accountPath}:generateAccessToken`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sourceToken}`,
          "content-type": "application/json",
        },
        body,
      },
      "The IAM Credentials request",
      async (iamResponse) => {
        if (!iamResponse.ok) throw iamStatusError(iamResponse.status);
        const record = await readRecord(
          iamResponse,
          "IAM Credentials' response",
        );
        const value = record.accessToken;
        if (typeof value !== "string" || value === "")
          throw failed("IAM Credentials returned no access token.");
        assertUsableToken(value);
        const expireTime = record.expireTime;
        let expiresAt = now() + 3_600_000;
        if (typeof expireTime === "string") {
          const parsed = Date.parse(expireTime);
          if (Number.isFinite(parsed)) expiresAt = parsed;
        }
        return { value, expiresAt };
      },
    );
    return token;
  };

  const mintToken = async (): Promise<AccessToken> => {
    if (impersonate !== "" && !accountPattern.test(impersonate))
      throw invalid(
        "The impersonated service account must be an email address.",
      );
    const configured = impersonate === "" ? undefined : impersonate;
    const credential = parseCredential(vertex.credentials);
    let token: AccessToken;
    switch (credential.kind) {
      case "authorized_user":
        token = await authorizedUserToken(credential);
        break;
      case "service_account":
        token = await serviceAccountToken(credential);
        break;
      case "impersonated_service_account": {
        const source = credential.source;
        const sourceToken =
          source.kind === "authorized_user"
            ? await authorizedUserToken(source)
            : await serviceAccountToken(source);
        token = await impersonatedToken(
          sourceToken.value,
          credential.account,
          credential.delegates,
        );
        break;
      }
    }
    if (configured)
      token = await impersonatedToken(token.value, configured, []);
    return token;
  };

  const startMint = (): Promise<AccessToken> => {
    const startedAt = generation;
    const tracked = mintToken().then((token) => {
      if (generation === startedAt) cache = token;
      return token;
    });
    inflight = tracked;
    tracked.then(
      () => {
        if (inflight === tracked) inflight = undefined;
      },
      () => {
        if (inflight === tracked) inflight = undefined;
      },
    );
    return tracked;
  };

  const accessToken = async (signal?: AbortSignal): Promise<AccessToken> => {
    throwIfAborted(signal);
    const cached = cache;
    if (cached && now() < cached.expiresAt - TOKEN_REFRESH_LEAD_MS)
      return cached;
    return waitFor(inflight ?? startMint(), signal);
  };

  return {
    get baseUrl() { return target(); },
    async resolve(signal) {
      throwIfAborted(signal);
      const baseUrl = target();
      const token = await accessToken(signal);
      throwIfAborted(signal);
      return {
        baseUrl,
        apiKey: token.value,
        apiMode: "gemini",
        auth: { type: "bearer" },
      };
    },
    async listModelCatalog(signal) {
      throwIfAborted(signal);
      target();
      return referenceCatalog(location);
    },
    dispose() {
      generation += 1;
      cache = undefined;
      inflight = undefined;
      for (const controller of [...activeRequests]) controller.abort();
      activeRequests.clear();
    },
  };
}

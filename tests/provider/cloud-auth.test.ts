import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createVertexAuth, normalizeAzureBase } from "../../src/provider/cloud";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const IAM_PREFIX =
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/";

// A runtime-generated fixture key: no secret file is written or read.
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = keyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKey = keyPair.publicKey;

const authorizedUserCredentials = {
  type: "authorized_user",
  client_id: "test-client",
  client_secret: "client-secret-value",
  refresh_token: "refresh-token-value",
} satisfies Record<string, unknown>;

const serviceAccountCredentials = (): Record<string, unknown> => ({
  type: "service_account",
  client_email: "signer@test-project.iam.gserviceaccount.com",
  private_key: privatePem,
  private_key_id: "test-key-id",
});

type FetchCall = Readonly<{
  url: string;
  init: RequestInit | undefined;
  body: string | undefined;
}>;

type FetchFixture = Readonly<{
  fetch: typeof fetch;
  calls: FetchCall[];
}>;

function fetchFixture(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): FetchFixture {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, init, body });
    return handler(url, init);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value) ?? "", {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenResponse(token: string, expiresIn = 3600): Response {
  return jsonResponse({
    access_token: token,
    expires_in: expiresIn,
    token_type: "Bearer",
  });
}

describe("normalizeAzureBase", () => {
  it.each([
    ["my-resource", "https://my-resource.openai.azure.com/openai/v1"],
    [
      "my-resource.openai.azure.com",
      "https://my-resource.openai.azure.com/openai/v1",
    ],
    [
      "https://my-resource.openai.azure.com",
      "https://my-resource.openai.azure.com/openai/v1",
    ],
    [
      "https://my-resource.openai.azure.com/openai",
      "https://my-resource.openai.azure.com/openai/v1",
    ],
    [
      "http://my-resource.openai.azure.com/openai/v1",
      "https://my-resource.openai.azure.com/openai/v1",
    ],
    [
      "https://my-resource.openai.azure.com/openai/v1/chat/completions?api-version=2024-10-21",
      "https://my-resource.openai.azure.com/openai/v1",
    ],
    [
      "https://my-resource.cognitiveservices.azure.com/openai/deployments/deployment/chat/completions?api-version=2024-10-21",
      "https://my-resource.cognitiveservices.azure.com/openai/v1",
    ],
    [
      "https://my-resource.services.ai.azure.com/models",
      "https://my-resource.services.ai.azure.com/openai/v1",
    ],
    [
      "https://user:pass@my-resource.openai.azure.com/openai/v1",
      "https://my-resource.openai.azure.com/openai/v1",
    ],
    ["my-resource/openai/v1", "https://my-resource.openai.azure.com/openai/v1"],
  ])("maps %s to the v1 base", (raw, expected) => {
    expect(normalizeAzureBase(raw)).toBe(expected);
  });

  it("leaves unknown hosts and malformed values alone", () => {
    expect(normalizeAzureBase("https://example.com/openai/v1")).toBeUndefined();
    expect(normalizeAzureBase("http://localhost:1234/v1")).toBeUndefined();
    expect(
      normalizeAzureBase("https://my-resource.openai.azure.com.evil.test"),
    ).toBeUndefined();
    expect(normalizeAzureBase("   ")).toBeUndefined();
    expect(normalizeAzureBase("not a url")).toBeUndefined();
  });
});

describe("createVertexAuth", () => {
  it("uses explicitly supplied service_account JSON to sign an RS256 JWT and resolve Vertex", async () => {
    const clock = 1_700_000_000_000;
    const fixture = fetchFixture(async (url) => {
      expect(url).toBe(TOKEN_URL);
      return tokenResponse("access-token");
    });
    const auth = createVertexAuth(
      { project: "test-project", credentials: serviceAccountCredentials() },
      { fetch: fixture.fetch, now: () => clock },
    );

    const resolved = await auth.resolve();
    expect(resolved).toEqual({
      baseUrl:
        "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google",
      apiKey: "access-token",
      apiMode: "gemini",
      auth: { type: "bearer" },
    });
    expect(fixture.calls).toHaveLength(1);
    const call = fixture.calls[0];
    if (!call) throw new Error("token request was not made");
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(new Headers(call.init?.headers).get("authorization")).toBeNull();
    if (!call.body) throw new Error("token form was not sent");
    const form = new URLSearchParams(call.body);
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const assertion = form.get("assertion");
    if (!assertion) throw new Error("JWT assertion was not sent");
    const parts = assertion.split(".");
    expect(parts).toHaveLength(3);
    const [headerPart, payloadPart, signaturePart] = parts;
    if (!headerPart || !payloadPart || !signaturePart)
      throw new Error("JWT assertion is malformed");

    const header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(header).toMatchObject({
      alg: "RS256",
      typ: "JWT",
      kid: "test-key-id",
    });
    const issuedAt = Math.floor(clock / 1000) - 10;
    expect(payload).toMatchObject({
      iss: "signer@test-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart}.${payloadPart}`);
    expect(
      verifier.verify(publicKey, Buffer.from(signaturePart, "base64url")),
    ).toBe(true);
  });

  it("caches the access token and refreshes it only near expiry", async () => {
    let clock = 1_700_000_000_000;
    let minted = 0;
    const fixture = fetchFixture(async () => {
      minted += 1;
      return tokenResponse(`access-${minted}`);
    });
    const auth = createVertexAuth(
      {
        project: "test-project",
        credentials: {
          ...authorizedUserCredentials,
          quota_project_id: "billing-project",
        },
      },
      { fetch: fixture.fetch, now: () => clock },
    );

    expect((await auth.resolve()).apiKey).toBe("access-1");
    expect((await auth.resolve()).apiKey).toBe("access-1");
    expect(fixture.calls).toHaveLength(1);
    const firstBody = fixture.calls[0]?.body;
    if (!firstBody) throw new Error("refresh form was not sent");
    const form = new URLSearchParams(firstBody);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("test-client");
    expect(form.get("client_secret")).toBe("client-secret-value");
    expect(form.get("refresh_token")).toBe("refresh-token-value");
    expect(form.get("quota_project_id")).toBeNull();

    clock += 3600_000 - 5 * 60_000 - 1;
    expect((await auth.resolve()).apiKey).toBe("access-1");
    clock += 2;
    expect((await auth.resolve()).apiKey).toBe("access-2");
    expect(fixture.calls).toHaveLength(2);
  });

  it("shares one token mint and keeps it alive when one caller aborts", async () => {
    let calls = 0;
    let release: ((response: Response) => void) | undefined;
    const observed: { signal: AbortSignal | null } = { signal: null };
    const fetchImpl: typeof fetch = (_input, init) => {
      calls += 1;
      observed.signal = init?.signal ?? null;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const auth = createVertexAuth(
      { project: "test-project", credentials: authorizedUserCredentials },
      { fetch: fetchImpl },
    );

    const first = new AbortController();
    const second = new AbortController();
    const firstPromise = auth.resolve(first.signal);
    const secondPromise = auth.resolve(second.signal);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(observed.signal).not.toBeNull();
    const firstRejected = expect(firstPromise).rejects.toMatchObject({
      name: "AbortError",
    });
    first.abort();
    await firstRejected;
    expect(observed.signal?.aborted).toBe(false);
    if (!release) throw new Error("token request did not start");
    release(tokenResponse("shared-token"));
    expect((await secondPromise).apiKey).toBe("shared-token");
    expect(calls).toBe(1);
  });

  it("times out a hung token request once without retrying", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return new Promise<Response>(() => {});
    };
    const auth = createVertexAuth(
      { project: "test-project", credentials: authorizedUserCredentials },
      { fetch: fetchImpl, requestTimeoutMs: 20 },
    );

    await expect(auth.resolve()).rejects.toThrow(/timed out/i);
    expect(calls).toBe(1);
  });

  it("times out a token response body that never finishes", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const auth = createVertexAuth(
      { project: "test-project", credentials: authorizedUserCredentials },
      { fetch: fetchImpl, requestTimeoutMs: 20 },
    );

    await expect(auth.resolve()).rejects.toThrow(/timed out/i);
    expect(calls).toBe(1);
  });

  it("reports authorization failure without credentials, subject, JWT or upstream body", async () => {
    const fixture = fetchFixture(async () =>
      jsonResponse({ error: { message: "upstream-body-secret" } }, 401),
    );
    const auth = createVertexAuth(
      { project: "test-project", credentials: serviceAccountCredentials() },
      { fetch: fixture.fetch },
    );

    let caught: unknown;
    try {
      await auth.resolve();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    const call = fixture.calls[0];
    const assertion = call?.body
      ? new URLSearchParams(call.body).get("assertion")
      : undefined;
    expect(message).toContain("HTTP 401");
    expect(message).not.toContain("upstream-body-secret");
    expect(message).not.toContain("PRIVATE KEY");
    expect(message).not.toContain(
      "signer@test-project.iam.gserviceaccount.com",
    );
    expect(assertion).toBeTruthy();
    if (assertion) expect(message).not.toContain(assertion);
    expect(fixture.calls).toHaveLength(1);
  });

  it("impersonates a configured service account through IAM Credentials", async () => {
    const clock = 1_700_000_000_000;
    const fixture = fetchFixture(async (url) => {
      if (url === TOKEN_URL) return tokenResponse("source-token");
      if (url.startsWith(IAM_PREFIX))
        return jsonResponse({
          accessToken: "impersonated-token",
          expireTime: new Date(clock + 3_600_000).toISOString(),
        });
      throw new Error(`unexpected URL: ${url}`);
    });
    const auth = createVertexAuth(
      {
        project: "test-project",
        credentials: authorizedUserCredentials,
        impersonate: " Runtime@Test-Project.IAM.GServiceAccount.com ",
      },
      { fetch: fixture.fetch, now: () => clock },
    );

    expect((await auth.resolve()).apiKey).toBe("impersonated-token");
    expect(fixture.calls).toHaveLength(2);
    const iam = fixture.calls[1];
    if (!iam) throw new Error("IAM request was not made");
    expect(iam.url).toBe(
      `${IAM_PREFIX}runtime@test-project.iam.gserviceaccount.com:generateAccessToken`,
    );
    expect(new Headers(iam.init?.headers).get("authorization")).toBe(
      "Bearer source-token",
    );
    if (!iam.body) throw new Error("IAM body was not sent");
    expect(JSON.parse(iam.body) as Record<string, unknown>).toEqual({
      scope: ["https://www.googleapis.com/auth/cloud-platform"],
      lifetime: "3600s",
    });
  });

  it("reads impersonated_service_account sources and delegates without trusting its URL host", async () => {
    const clock = 1_700_000_000_000;
    const fixture = fetchFixture(async (url) => {
      if (url === TOKEN_URL) return tokenResponse("source-token");
      if (url.startsWith(IAM_PREFIX))
        return jsonResponse({
          accessToken: "target-token",
          expireTime: new Date(clock + 3_600_000).toISOString(),
        });
      throw new Error(`unexpected URL: ${url}`);
    });
    const credentials = {
      type: "impersonated_service_account",
      service_account_impersonation_url:
        "https://attacker.example/v1/projects/-/serviceAccounts/target%40test-project.iam.gserviceaccount.com:generateAccessToken",
      delegates: [
        "delegate@test-project.iam.gserviceaccount.com",
        "projects/-/serviceAccounts/second@test-project.iam.gserviceaccount.com",
      ],
      source_credentials: authorizedUserCredentials,
    };
    const auth = createVertexAuth(
      { project: "test-project", credentials },
      { fetch: fixture.fetch, now: () => clock },
    );

    expect((await auth.resolve()).apiKey).toBe("target-token");
    expect(
      fixture.calls.some((call) => call.url.includes("attacker.example")),
    ).toBe(false);
    expect(fixture.calls).toHaveLength(2);
    const iam = fixture.calls[1];
    if (!iam) throw new Error("IAM request was not made");
    expect(iam.url).toBe(
      `${IAM_PREFIX}target@test-project.iam.gserviceaccount.com:generateAccessToken`,
    );
    if (!iam.body) throw new Error("IAM body was not sent");
    expect(JSON.parse(iam.body) as Record<string, unknown>).toMatchObject({
      delegates: [
        "projects/-/serviceAccounts/delegate@test-project.iam.gserviceaccount.com",
        "projects/-/serviceAccounts/second@test-project.iam.gserviceaccount.com",
      ],
    });
  });

  it.each([
    ["global", "https://aiplatform.googleapis.com"],
    ["us", "https://aiplatform.us.rep.googleapis.com"],
    ["eu", "https://aiplatform.eu.rep.googleapis.com"],
    ["us-central1", "https://us-central1-aiplatform.googleapis.com"],
    ["europe-west4", "https://europe-west4-aiplatform.googleapis.com"],
  ])("maps the %s location to its Vertex host", async (location, root) => {
    const fixture = fetchFixture(async () => tokenResponse("region-token"));
    const auth = createVertexAuth(
      {
        project: "test-project",
        location,
        credentials: authorizedUserCredentials,
      },
      { fetch: fixture.fetch },
    );

    await expect(auth.resolve()).resolves.toMatchObject({
      baseUrl: `${root}/v1/projects/test-project/locations/${location}/publishers/google`,
      apiMode: "gemini",
      auth: { type: "bearer" },
    });
  });

  it("lists the reference models for the location without a network request", async () => {
    const fixture = fetchFixture(async () => {
      throw new Error("network must not be used");
    });
    const auth = createVertexAuth(
      { project: "test-project", credentials: authorizedUserCredentials },
      { fetch: fixture.fetch },
    );

    const global = await auth.listModelCatalog();
    expect(global.map((entry) => entry.id)).toEqual([
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
    ]);
    for (const entry of global) {
      expect(entry.contextWindowTokens).toBeNull();
      expect(entry.provenance).toEqual({ id: "reference" });
      expect(entry.tools).toBeUndefined();
      expect(entry.vision).toBeUndefined();
    }
    const us = createVertexAuth(
      {
        project: "test-project",
        location: "us",
        credentials: authorizedUserCredentials,
      },
      { fetch: fixture.fetch },
    );
    expect((await us.listModelCatalog()).map((entry) => entry.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ]);
    const region = createVertexAuth(
      {
        project: "test-project",
        location: "europe-west4",
        credentials: authorizedUserCredentials,
      },
      { fetch: fixture.fetch },
    );
    expect((await region.listModelCatalog()).map((entry) => entry.id)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
    expect(fixture.calls).toHaveLength(0);
  });

  it("refuses unsafe endpoint configuration and unsupported credentials before requesting a token", async () => {
    const fixture = fetchFixture(async () => tokenResponse("never"));
    const badProject = createVertexAuth(
      { project: "../escape", credentials: authorizedUserCredentials },
      { fetch: fixture.fetch },
    );
    await expect(badProject.resolve()).rejects.toThrow(/project id/i);
    const badLocation = createVertexAuth(
      {
        project: "test-project",
        location: "us-central1/evil",
        credentials: authorizedUserCredentials,
      },
      { fetch: fixture.fetch },
    );
    await expect(badLocation.resolve()).rejects.toThrow(/location/i);
    const unsupported = createVertexAuth(
      {
        project: "test-project",
        credentials: { type: "external_account" },
      },
      { fetch: fixture.fetch },
    );
    await expect(unsupported.resolve()).rejects.toThrow(/not supported/i);
    expect(fixture.calls).toHaveLength(0);
  });
});

import type { ProviderProtocol } from "../shared/model-access";
import type { ModelCatalog } from "../shared/model-catalog";

/**
 * Public provider preset. This type deliberately has no key, token, header
 * value, proxy credential, sponsored placement, or free-form note: presets
 * describe where a vendor lives, never who the user is.
 */
export type ProviderPresetKind = "vendor" | "relay" | "local" | "custom";

export type ProviderEndpoints = Readonly<
  Partial<Record<ProviderProtocol, string>>
>;

export type ProviderPresetRegion = Readonly<{
  id: string;
  name: string;
  endpoints: ProviderEndpoints;
  website?: string;
  keysUrl?: string;
}>;

export type ProviderPreset = Readonly<{
  id: string;
  name: string;
  kind: ProviderPresetKind;
  /** Default endpoints; a region's same-protocol endpoint replaces one. */
  endpoints: ProviderEndpoints;
  regionLabel?: string;
  regions?: readonly ProviderPresetRegion[];
  website?: string;
  keysUrl?: string;
  /** A local server that normally runs without an API key. */
  noKey?: boolean;
}>;

const endpoints = (
  chat: string | undefined,
  responses: string | undefined,
  anthropic: string | undefined,
  gemini?: string,
): ProviderEndpoints => ({
  ...(chat ? { "chat-completions": chat } : {}),
  ...(responses ? { responses } : {}),
  ...(anthropic ? { anthropic } : {}),
  ...(gemini ? { gemini } : {}),
});

const region = (
  id: string,
  name: string,
  endpointsValue: ProviderEndpoints,
  website?: string,
  keysUrl?: string,
): ProviderPresetRegion => ({
  id,
  name,
  endpoints: endpointsValue,
  ...(website ? { website } : {}),
  ...(keysUrl ? { keysUrl } : {}),
});

const bedrockEndpoints = (location: string): ProviderEndpoints => endpoints(
  `https://bedrock-runtime.${location}.amazonaws.com/openai/v1`,
  `https://bedrock-runtime.${location}.amazonaws.com/openai/v1`,
  `https://bedrock-runtime.${location}.amazonaws.com/anthropic`,
);

/**
 * The independent-provider starter set. It intentionally mirrors Magpie's
 * useful public fields (multiple protocols and regional endpoints) but not
 * sponsored placement, editor notes, icons, catalog ids, or secret hints.
 */
export const providerPresets: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "vendor",
    endpoints: endpoints(
      "https://api.openai.com/v1",
      "https://api.openai.com/v1",
      undefined,
    ),
    website: "https://platform.openai.com",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "vendor",
    endpoints: endpoints(undefined, undefined, "https://api.anthropic.com"),
    website: "https://console.anthropic.com",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "vendor",
    endpoints: endpoints(
      "https://api.deepseek.com/v1",
      "https://api.deepseek.com/v1",
      "https://api.deepseek.com/anthropic",
    ),
    website: "https://platform.deepseek.com",
    keysUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "moonshot",
    name: "Moonshot / Kimi",
    kind: "vendor",
    endpoints: endpoints(
      "https://api.moonshot.ai/v1",
      undefined,
      "https://api.moonshot.ai/anthropic",
    ),
    regionLabel: "Region",
    regions: [
      region(
        "global",
        "Global",
        endpoints(
          "https://api.moonshot.ai/v1",
          undefined,
          "https://api.moonshot.ai/anthropic",
        ),
        "https://platform.moonshot.ai",
        "https://platform.moonshot.ai/console/api-keys",
      ),
      region(
        "cn",
        "China",
        endpoints(
          "https://api.moonshot.cn/v1",
          undefined,
          "https://api.moonshot.cn/anthropic",
        ),
        "https://platform.moonshot.cn",
        "https://platform.moonshot.cn/console/api-keys",
      ),
    ],
    website: "https://platform.moonshot.ai",
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    kind: "vendor",
    endpoints: endpoints(
      "https://open.bigmodel.cn/api/paas/v4",
      undefined,
      "https://open.bigmodel.cn/api/anthropic",
    ),
    regionLabel: "Plan",
    regions: [
      region(
        "api",
        "Pay as you go",
        endpoints(
          "https://open.bigmodel.cn/api/paas/v4",
          undefined,
          "https://open.bigmodel.cn/api/anthropic",
        ),
      ),
      region(
        "coding",
        "Coding Plan",
        endpoints(
          "https://open.bigmodel.cn/api/coding/paas/v4",
          "https://open.bigmodel.cn/api/v1",
          "https://open.bigmodel.cn/api/anthropic",
        ),
      ),
    ],
    website: "https://open.bigmodel.cn",
    keysUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "minimax",
    name: "MiniMax",
    kind: "vendor",
    endpoints: endpoints(
      "https://api.minimax.io/v1",
      undefined,
      "https://api.minimax.io/anthropic",
    ),
    regionLabel: "Region",
    regions: [
      region(
        "global",
        "Global",
        endpoints(
          "https://api.minimax.io/v1",
          undefined,
          "https://api.minimax.io/anthropic",
        ),
        "https://platform.minimax.io",
        "https://platform.minimax.io/user-center/basic-information/interface-key",
      ),
      region(
        "cn",
        "China",
        endpoints(
          "https://api.minimaxi.com/v1",
          undefined,
          "https://api.minimaxi.com/anthropic",
        ),
        "https://platform.minimaxi.com",
        "https://platform.minimaxi.com/user-center/basic-information/interface-key",
      ),
    ],
    website: "https://platform.minimax.io",
    keysUrl:
      "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "relay",
    endpoints: endpoints(
      "https://openrouter.ai/api/v1",
      undefined,
      "https://openrouter.ai/api",
    ),
    website: "https://openrouter.ai",
    keysUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    endpoints: endpoints(
      "http://localhost:11434/v1",
      undefined,
      "http://localhost:11434",
    ),
    website: "https://ollama.com",
    noKey: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "local",
    endpoints: endpoints("http://localhost:1234/v1", undefined, undefined),
    website: "https://lmstudio.ai",
    noKey: true,
  },
  {
    id: "google", name: "Google Gemini", kind: "vendor",
    endpoints: endpoints("https://generativelanguage.googleapis.com/v1beta/openai", undefined, undefined, "https://generativelanguage.googleapis.com/v1beta"),
    website: "https://aistudio.google.com", keysUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "google-vertex", name: "Google Vertex AI", kind: "vendor",
    endpoints: endpoints(undefined, undefined, undefined, "https://aiplatform.googleapis.com"),
    website: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models",
  },
  {
    id: "azure", name: "Azure OpenAI", kind: "vendor", endpoints: {},
    website: "https://ai.azure.com", keysUrl: "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI",
  },
  {
    id: "bedrock", name: "Amazon Bedrock", kind: "vendor", endpoints: bedrockEndpoints("us-east-1"),
    regionLabel: "Region", regions: ["us-east-1", "us-east-2", "us-west-2", "eu-central-1", "eu-west-1", "eu-west-3", "ap-northeast-1", "ap-southeast-1", "ap-southeast-2", "ap-south-1"].map(id => region(id, id, bedrockEndpoints(id))),
    website: "https://aws.amazon.com/bedrock/", keysUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
  },
  {
    id: "custom",
    name: "Custom",
    kind: "custom",
    endpoints: {},
  },
] as const;

// Fixed Magpie 2374ffe reference, not a live availability or quota claim.
export const bedrockReferenceCatalog: ModelCatalog = [
  "global.anthropic.claude-opus-5-5", "global.anthropic.claude-sonnet-5-5", "global.anthropic.claude-sonnet-5", "global.anthropic.claude-opus-5",
  "global.anthropic.claude-fable-5-1", "global.anthropic.claude-opus-4-8", "global.anthropic.claude-opus-4-7", "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "global.openai.gpt-6-astra", "global.openai.gpt-6-sol", "global.openai.gpt-6-luna", "openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0",
  "qwen.qwen3-coder-480b-a35b-v1:0", "deepseek.v3.2", "moonshotai.kimi-k2.5", "zai.glm-5", "minimax.minimax-m2.5",
].map(id => ({ id, contextWindowTokens: null,
  protocols: [id.startsWith("global.anthropic.") ? "anthropic" : id.startsWith("global.openai.") ? "responses" : "chat-completions"],
  provenance: { id: "reference", protocols: "reference" },
}));

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return providerPresets.find((preset) => preset.id === id.trim().toLowerCase());
}

/**
 * Resolve a preset's default endpoints, optionally with one of its regions
 * selected. An unknown region returns undefined rather than guessing.
 */
export function presetEndpoints(
  presetId: string,
  regionId?: string,
): ProviderEndpoints | undefined {
  const preset = findProviderPreset(presetId);
  if (!preset) return undefined;
  if (!regionId) return preset.endpoints;
  const selected = preset.regions?.find((entry) => entry.id === regionId);
  if (!selected) return undefined;
  return { ...preset.endpoints, ...selected.endpoints };
}

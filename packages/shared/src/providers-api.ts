import { z } from 'zod';

/**
 * Model API providers (Connections 04-D3; Phase 2 step A4): one "OpenAI-compatible provider" form with
 * presets for OpenRouter, FreeLLMAPI, Ollama and LM Studio. OpenCode is the engine that runs them.
 *
 * Keys stay in the Vault (A3). An engine never gets a provider key: its base URL points at the local
 * broker (`/llm/<provider>/…`) with a short-lived per-run pass, and the broker adds the real key.
 */
export const PROVIDERS_IPC = {
  list: 'providers:list',
  save: 'providers:save',
  setEnabled: 'providers:set-enabled',
  remove: 'providers:remove',
  /** Lists the provider's models through the broker (GET /models): proves the URL and the key work. */
  test: 'providers:test',
} as const;

export const ProviderPresetSchema = z.enum(['openrouter', 'freellmapi', 'ollama', 'lmstudio', 'custom']);
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;

export const ProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  label: z.string().trim().min(1).max(80),
  preset: ProviderPresetSchema,
  /**
   * OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1. https only, except local servers on
   * this computer (http://127.0.0.1 / localhost) for Ollama, LM Studio and FreeLLMAPI.
   */
  baseUrl: z.string().url().max(300),
  /** Vault key handle; null for local servers that need no key. */
  secretRef: z.string().regex(/^sec_[a-z0-9]{8,40}$/).nullable(),
  /** Models the hive may use, by tier (the router picks among them like Claude's opus/sonnet/haiku). */
  models: z.object({
    strongest: z.string().min(1).max(120),
    standard: z.string().min(1).max(120),
    light: z.string().min(1).max(120),
  }),
  enabled: z.boolean(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderViewSchema = ProviderSchema.extend({
  status: z.enum(['ready', 'needs-key', 'off', 'error']),
  /** Plain words, including what to do next (and FreeLLMAPI's personal-use note). */
  message: z.string(),
  /** Runs on this computer (Ollama, LM Studio, a local FreeLLMAPI): nothing leaves the PC. */
  local: z.boolean(),
  lastTestedAt: z.number().nullable(),
  /** Model ids the provider listed at the last successful test (for the model pickers). */
  knownModels: z.array(z.string()),
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/** Preset defaults for the "Add a provider" form. */
export const PROVIDER_PRESETS: Record<ProviderPreset, { label: string; baseUrl: string; needsKey: boolean; note: string }> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    note: 'One key for many models. Usage is billed by OpenRouter.',
  },
  freellmapi: {
    label: 'FreeLLMAPI',
    baseUrl: 'http://127.0.0.1:3000/v1',
    needsKey: false,
    note: 'Meant for personal use; free-tier terms can change at any time.',
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    note: 'Local models on this computer: free, private, nothing leaves the PC.',
  },
  lmstudio: {
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    note: 'Local models on this computer: free, private, nothing leaves the PC.',
  },
  custom: {
    label: 'OpenAI-compatible',
    baseUrl: 'https://',
    needsKey: true,
    note: 'Any service that speaks the OpenAI API.',
  },
};

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  message: z.string(),
  models: z.array(z.string()),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

export const ProviderResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ProviderResult = z.infer<typeof ProviderResultSchema>;

/** The providers part of `window.insectoids`. */
export interface ProvidersApi {
  list(): Promise<ProviderView[]>;
  save(p: Provider): Promise<ProviderResult>;
  setEnabled(id: string, enabled: boolean): Promise<ProviderResult>;
  remove(id: string): Promise<ProviderResult>;
  test(id: string): Promise<ProviderTestResult>;
}

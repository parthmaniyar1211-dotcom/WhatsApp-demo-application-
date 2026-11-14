// Types for meta.mjs, so the Playwright test (TypeScript) can use the harness.

export interface HarnessConfig {
  webhookUrl: string;
  appSecret: string;
  verifyToken: string;
  phoneId: string;
  from: string;
  name: string;
}

export interface WebhookPayload {
  object: string;
  entry: unknown[];
}

export function loadEnv(): void;
export function supabaseUrl(): string;
export function anonKey(): string;
export function harnessConfig(options?: { needSecret?: boolean; needVerifyToken?: boolean }): HarnessConfig;
export function newMessageId(): string;
export function incomingPayload(input: {
  kind: "text" | "image" | "document";
  phoneId: string;
  from: string;
  name: string;
  id?: string;
  text?: string;
  filename?: string;
  hoursAgo?: number;
}): WebhookPayload;
export function statusPayload(input: {
  phoneId: string;
  to: string;
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
}): WebhookPayload;
export function sign(body: string, secret: string): string;
export function postWebhook(
  url: string,
  payload: WebhookPayload | string,
  secret: string,
  options?: { signature?: string },
): Promise<{ status: number; json: Record<string, number | boolean> | null; text: string }>;
export function staffLogin(): Promise<string | null>;
export function restSelect<T = Record<string, unknown>>(accessToken: string, pathAndQuery: string): Promise<T[]>;
export function pass(message: string): void;
export function fail(message: string): void;

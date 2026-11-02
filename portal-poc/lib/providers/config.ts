import { hasEncryptionKey } from "@/lib/crypto";
import type { Provider } from "@/lib/tokens";

export type ClientCreds = { clientId: string; clientSecret: string };

const envNames: Record<Provider, [string, string]> = {
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  jira: ["ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET"],
};

export function clientCreds(p: Provider): ClientCreds | null {
  const [id, secret] = envNames[p].map((n) => process.env[n]);
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

// Real connections need: not the no-auth preview, provider credentials, and the encryption key.
export function isLive(p: Provider): boolean {
  return !process.env.PROTOTYPE_NO_AUTH && clientCreds(p) !== null && hasEncryptionKey();
}

export const liveProviders = (): Record<Provider, boolean> => ({ github: isLive("github"), jira: isLive("jira") });

// Public origin, needed to build the OAuth redirect_uri behind the Container Apps proxy.
export function publicOrigin(req: Request): string {
  if (process.env.AUTH_URL) return process.env.AUTH_URL.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

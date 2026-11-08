import { hasEncryptionKey } from "@/lib/crypto";
import type { Provider } from "@/lib/tokens";
import { githubMode, githubModeInfo, type GithubInfo } from "@/lib/githubMode";

export type ClientCreds = { clientId: string; clientSecret: string };

const envNames: Record<Provider, [string, string]> = {
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  jira: ["ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET"],
};

export function clientCreds(p: Provider): ClientCreds | null {
  const [id, secret] = envNames[p].map((n) => process.env[n]);
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

// Real connections need provider credentials and the encryption key.
let warnedBadMode = false;
export function isLive(p: Provider): boolean {
  if (p === "github" && githubMode() === null) {
    if (!warnedBadMode) console.error(`GITHUB_AUTH_MODE="${process.env.GITHUB_AUTH_MODE}" is invalid; use "app" or "oauth". GitHub is disabled.`);
    warnedBadMode = true;
    return false;
  }
  return clientCreds(p) !== null && hasEncryptionKey();
}

export const liveProviders = (): Record<Provider, boolean> => ({ github: isLive("github"), jira: isLive("jira") });

// Public origin, needed to build the OAuth redirect_uri behind the Container Apps proxy.
export function publicOrigin(req: Request): string {
  if (process.env.AUTH_URL) return process.env.AUTH_URL.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

// What the UI shows about the GitHub connection (server-computed, safe for the client).
export function githubInfo(): GithubInfo {
  const mode = githubMode();
  if (mode === null) return { mode, label: "GitHub", sees: 'GITHUB_AUTH_MODE is invalid. Set it to "app" or "oauth".' };
  if (!isLive("github")) return { mode, label: `GitHub (${githubModeInfo[mode].label})`, sees: "Not configured on this deployment. Ask an admin to add the client credentials and the token encryption key." };
  return { mode, ...githubModeInfo[mode] };
}

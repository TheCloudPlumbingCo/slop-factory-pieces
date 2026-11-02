import * as github from "@/lib/providers/github";
import * as jira from "@/lib/providers/jira";
import { clientCreds } from "@/lib/providers/config";
import { githubMode } from "@/lib/githubMode";
import { getTokenStore, type Provider, type TokenStore } from "@/lib/tokens";

// Thrown when the user has no usable token and must (re)connect from Settings.
export class NotConnectedError extends Error {}

// A GitHub connection only works under the mode it was made with; after the flag changes, the user reconnects.
export const usableUnderCurrentMode = (provider: Provider, record: { mode?: string }) =>
  provider !== "github" || record.mode === githubMode();

const REFRESH_SKEW_MS = 60_000;
const refreshers = { github: github.refresh, jira: jira.refresh };

// Returns a valid access token for the caller, refreshing and re-storing it when it is about to expire.
export async function accessTokenFor(oid: string, provider: Provider, store: TokenStore = getTokenStore(), now = Date.now()) {
  const record = await store.get(oid, provider);
  if (!record) throw new NotConnectedError("not connected");
  if (!usableUnderCurrentMode(provider, record)) throw new NotConnectedError("connected under another GITHUB_AUTH_MODE");
  if (!record.expiresAt || record.expiresAt - REFRESH_SKEW_MS > now) return record.accessToken;

  const creds = clientCreds(provider);
  if (!creds || !record.refreshToken) throw new NotConnectedError("token expired");
  try {
    const next = await refreshers[provider](creds, record, now);
    await store.put(oid, provider, next);
    return next.accessToken;
  } catch {
    await store.delete(oid, provider);
    throw new NotConnectedError("refresh rejected");
  }
}

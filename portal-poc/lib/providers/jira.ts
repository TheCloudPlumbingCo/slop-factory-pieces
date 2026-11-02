import { getJson } from "@/lib/upstream";
import type { TokenRecord } from "@/lib/tokens";
import type { ClientCreds } from "@/lib/providers/config";

// Atlassian OAuth 2.0 (3LO) + Jira Cloud REST v3 through the api.atlassian.com gateway.
export const SCOPES = "read:jira-work read:me offline_access";
const GATEWAY = "https://api.atlassian.com";

export type Issue = { key: string; title: string; url: string };
type Site = { id: string; url: string; name: string };

export function authorizeUrl(c: ClientCreds, redirectUri: string, state: string): string {
  const u = new URL("https://auth.atlassian.com/authorize");
  u.search = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: c.clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  }).toString();
  return u.toString();
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

async function tokenRequest(body: Record<string, string>, now: number): Promise<Omit<TokenRecord, "account">> {
  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !t.access_token) throw new Error(`atlassian token request rejected: ${t.error ?? res.status}`);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_in ? now + t.expires_in * 1000 : undefined,
  };
}

export const exchangeCode = (c: ClientCreds, code: string, redirectUri: string, now = Date.now()) =>
  tokenRequest(
    { grant_type: "authorization_code", client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirectUri },
    now,
  );

// Atlassian rotates refresh tokens: the new one MUST be stored (the caller does).
export async function refresh(c: ClientCreds, record: TokenRecord, now = Date.now()): Promise<TokenRecord> {
  if (!record.refreshToken) throw new Error("no refresh token");
  const t = await tokenRequest(
    { grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: record.refreshToken },
    now,
  );
  return { ...record, ...t };
}

const sites = (token: string) => getJson<Site[]>(`${GATEWAY}/oauth/token/accessible-resources`, token, "Atlassian accessible-resources");

export async function fetchAccount(token: string): Promise<string> {
  const [me, list] = await Promise.all([
    getJson<{ email?: string; name?: string }>(`${GATEWAY}/me`, token, "Atlassian /me"),
    sites(token),
  ]);
  const who = me.email ?? me.name ?? "Atlassian user";
  return list[0] ? `${who} (${new URL(list[0].url).host})` : who;
}

// Build JQL from free text. Only letters/digits are searched so user input cannot break the query.
export function buildJql(q: string): string {
  const term = q.replace(/[^\p{L}\p{N}\s_-]/gu, " ").replace(/\s+/g, " ").trim();
  const order = "ORDER BY updated DESC";
  if (!term) return order;
  const clauses = [`summary ~ "${term}*"`];
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(term)) clauses.push(`key = "${term.toUpperCase()}"`);
  return `(${clauses.join(" OR ")}) ${order}`;
}

// Uses the current enhanced JQL endpoint (GET /rest/api/3/search/jql), not the removed /search.
export async function searchIssues(token: string, q: string): Promise<Issue[]> {
  const site = (await sites(token))[0];
  if (!site) return [];
  const params = new URLSearchParams({ jql: buildJql(q), fields: "summary", maxResults: "50" });
  const body = await getJson<{ issues: { key: string; fields: { summary: string } }[] }>(
    `${GATEWAY}/ex/jira/${site.id}/rest/api/3/search/jql?${params}`,
    token,
    "Jira search",
  );
  return body.issues.map((i) => ({ key: i.key, title: i.fields.summary, url: `${site.url}/browse/${i.key}` }));
}

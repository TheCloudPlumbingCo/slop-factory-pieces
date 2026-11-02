import { NextResponse, type NextRequest } from "next/server";
import { parseProvider, settingsRedirect } from "@/lib/connect-route";
import { StateError, completeAuthorization, stateCookieName } from "@/lib/oauth-state";
import { clientCreds, isLive, publicOrigin } from "@/lib/providers/config";
import * as github from "@/lib/providers/github";
import * as jira from "@/lib/providers/jira";
import { callerOid } from "@/lib/session";
import { getTokenStore } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = parseProvider((await params).provider);
  if (!provider) return new Response("Unknown provider", { status: 404 });
  const origin = publicOrigin(req);
  const oid = await callerOid();
  if (!oid) return new Response("Sign in first", { status: 401 });
  const creds = clientCreds(provider);
  if (!creds || !isLive(provider)) return settingsRedirect(origin, "error", "not_configured");

  const url = new URL(req.url);
  const cookie = req.cookies.get(stateCookieName(provider))?.value;

  const finish = (key: "connected" | "error", value: string) => {
    const res = NextResponse.redirect(`${origin}/settings?${key}=${encodeURIComponent(value)}`, 302);
    res.cookies.delete({ name: stateCookieName(provider), path: `/api/connect/${provider}` });
    return res;
  };

  try {
    const { verifier } = completeAuthorization(cookie, { provider, oid, state: url.searchParams.get("state") });
    const providerError = url.searchParams.get("error");
    if (providerError) return finish("error", providerError); // e.g. the user clicked Cancel
    const code = url.searchParams.get("code");
    if (!code) return finish("error", "missing_code");

    const redirectUri = `${origin}/api/connect/${provider}/callback`;
    const tokens = provider === "github"
      ? await github.exchangeCode(creds, code, redirectUri, verifier)
      : await jira.exchangeCode(creds, code, redirectUri);
    const account = await (provider === "github" ? github.fetchAccount : jira.fetchAccount)(tokens.accessToken);
    await getTokenStore().put(oid, provider, { ...tokens, account });
    return finish("connected", provider);
  } catch (e) {
    if (e instanceof StateError) return finish("error", e.message);
    console.error(`[${provider}] connect callback failed`, e instanceof Error ? e.message : e);
    return finish("error", "exchange_failed");
  }
}

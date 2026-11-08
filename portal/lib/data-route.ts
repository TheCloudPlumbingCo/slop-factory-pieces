import { NotConnectedError, accessTokenFor } from "@/lib/connections";
import { isLive } from "@/lib/providers/config";
import { callerOid } from "@/lib/session";
import type { Provider } from "@/lib/tokens";
import { UpstreamError } from "@/lib/upstream";

const json = (status: number, body: unknown) => Response.json(body, { status });

// Shared wrapper for data endpoints: session check, caller's own token, uniform errors.
export async function withProviderToken(provider: Provider, run: (token: string) => Promise<unknown>): Promise<Response> {
  if (!isLive(provider)) return json(501, { error: "not_configured" });
  const oid = await callerOid();
  if (!oid) return json(401, { error: "not_signed_in" });
  try {
    return json(200, await run(await accessTokenFor(oid, provider)));
  } catch (e) {
    if (e instanceof NotConnectedError) return json(409, { error: "not_connected" });
    if (e instanceof UpstreamError) {
      // The provider refused our token: treat as needing reconnect.
      if (e.status === 401) return json(409, { error: "not_connected" });
      return json(502, { error: "upstream", status: e.status });
    }
    console.error(`[${provider}] data request failed`, e instanceof Error ? e.message : e);
    return json(500, { error: "internal" });
  }
}

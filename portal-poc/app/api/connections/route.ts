import { isLive } from "@/lib/providers/config";
import { callerOid } from "@/lib/session";
import { getTokenStore, providers } from "@/lib/tokens";

export const dynamic = "force-dynamic";

// Status and account label per provider. Never returns tokens.
export async function GET() {
  const oid = await callerOid();
  if (!oid) return Response.json({ error: "not_signed_in" }, { status: 401 });
  const out: Record<string, { live: boolean; connected: boolean; account?: string }> = {};
  for (const p of providers) {
    const live = isLive(p);
    const record = live ? await getTokenStore().get(oid, p).catch(() => null) : null;
    out[p] = { live, connected: !!record, account: record?.account };
  }
  return Response.json(out);
}

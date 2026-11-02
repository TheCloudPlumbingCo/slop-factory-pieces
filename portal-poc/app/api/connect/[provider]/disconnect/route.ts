import { parseProvider } from "@/lib/connect-route";
import { callerOid } from "@/lib/session";
import { getTokenStore } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = parseProvider((await params).provider);
  if (!provider) return new Response("Unknown provider", { status: 404 });
  const oid = await callerOid();
  if (!oid) return new Response("Sign in first", { status: 401 });
  await getTokenStore().delete(oid, provider);
  return new Response(null, { status: 204 });
}

import { auth } from "@/auth";
import { localOid, localUser } from "@/lib/localUser";

// Entra object id of the signed-in user; every stored connection is keyed by it.
export async function callerOid(): Promise<string | null> {
  const local = localUser();
  if (local) return localOid(local);
  const session = await auth();
  return session?.oid ?? null;
}

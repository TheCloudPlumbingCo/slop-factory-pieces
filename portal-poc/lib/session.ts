import { auth } from "@/auth";

// Entra object id of the signed-in user; every stored connection is keyed by it.
export async function callerOid(): Promise<string | null> {
  const session = await auth();
  return session?.oid ?? null;
}

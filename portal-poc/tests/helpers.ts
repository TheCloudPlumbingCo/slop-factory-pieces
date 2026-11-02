import { randomBytes } from "node:crypto";
import type { TokenRecord, TokenStore } from "@/lib/tokens";

export const useTestKey = () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
};

export class MemoryStore implements TokenStore {
  data = new Map<string, TokenRecord>();
  async get(oid: string, p: string) { return this.data.get(`${oid}:${p}`) ?? null; }
  async put(oid: string, p: string, r: TokenRecord) { this.data.set(`${oid}:${p}`, r); }
  async delete(oid: string, p: string) { this.data.delete(`${oid}:${p}`); }
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

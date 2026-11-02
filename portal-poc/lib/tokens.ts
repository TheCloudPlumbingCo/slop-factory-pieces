import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { open, seal } from "@/lib/crypto";

export type Provider = "github" | "jira";
export const providers: Provider[] = ["github", "jira"];

export type TokenRecord = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // ms epoch; absent = does not expire
  account: string; // label shown in the UI, e.g. "@alice-dev"
};

// Swap the implementation (e.g. Cosmos) without touching callers.
export interface TokenStore {
  get(oid: string, provider: Provider): Promise<TokenRecord | null>;
  put(oid: string, provider: Provider, record: TokenRecord): Promise<void>;
  delete(oid: string, provider: Provider): Promise<void>;
}

const aad = (oid: string, provider: Provider) => `token:${oid}:${provider}`;

// Local dev store: one encrypted file per (oid, provider) under .data/tokens.
export class FileTokenStore implements TokenStore {
  constructor(private dir = path.join(process.cwd(), ".data", "tokens")) {}

  private file(oid: string, provider: Provider) {
    const name = createHash("sha256").update(`${oid}:${provider}`).digest("hex");
    return path.join(this.dir, `${name}.enc`);
  }

  async get(oid: string, provider: Provider) {
    let sealed: string;
    try {
      sealed = await readFile(this.file(oid, provider), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return JSON.parse(open(sealed, aad(oid, provider))) as TokenRecord;
  }

  async put(oid: string, provider: Provider, record: TokenRecord) {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(oid, provider);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, seal(JSON.stringify(record), aad(oid, provider)), { mode: 0o600 });
    await rename(tmp, target);
  }

  async delete(oid: string, provider: Provider) {
    await rm(this.file(oid, provider), { force: true });
  }
}

let store: TokenStore | undefined;
export const getTokenStore = (): TokenStore => (store ??= new FileTokenStore());

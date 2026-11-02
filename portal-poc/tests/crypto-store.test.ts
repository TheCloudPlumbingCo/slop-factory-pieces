import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { open, seal } from "@/lib/crypto";
import { FileTokenStore } from "@/lib/tokens";
import { useTestKey } from "./helpers";

beforeEach(useTestKey);

describe("seal/open", () => {
  it("round-trips", () => {
    expect(open(seal("secret-token", "a"), "a")).toBe("secret-token");
  });

  it("rejects tampered ciphertext", () => {
    const buf = Buffer.from(seal("secret-token", "a"), "base64");
    buf[buf.length - 1] ^= 1;
    expect(() => open(buf.toString("base64"), "a")).toThrow(/authentication/);
  });

  it("rejects a different aad (record moved to another user)", () => {
    expect(() => open(seal("x", "user-a"), "user-b")).toThrow(/authentication/);
  });

  it("rejects a wrong key", () => {
    const sealed = seal("x", "a");
    useTestKey();
    expect(() => open(sealed, "a")).toThrow(/authentication/);
  });

  it("rejects a key of the wrong length", () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    expect(() => seal("x", "a")).toThrow(/32 bytes/);
  });
});

describe("FileTokenStore", () => {
  it("stores ciphertext only and round-trips per (oid, provider)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tokens-"));
    const store = new FileTokenStore(dir);
    const rec = { accessToken: "ghu_PLAINTEXT", account: "@alice" };
    await store.put("oid-1", "github", rec);

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(await readFile(path.join(dir, files[0]), "utf8")).not.toContain("PLAINTEXT");

    expect(await store.get("oid-1", "github")).toEqual(rec);
    expect(await store.get("oid-2", "github")).toBeNull();
    expect(await store.get("oid-1", "jira")).toBeNull();
    await store.delete("oid-1", "github");
    expect(await store.get("oid-1", "github")).toBeNull();
  });
});

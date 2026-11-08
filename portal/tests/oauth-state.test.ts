import { beforeEach, describe, expect, it } from "vitest";
import { StateError, beginAuthorization, completeAuthorization } from "@/lib/oauth-state";
import { useTestKey } from "./helpers";

beforeEach(useTestKey);

describe("OAuth state", () => {
  const start = () => beginAuthorization("github", "oid-1");

  it("accepts the matching state and returns the PKCE verifier", () => {
    const a = start();
    expect(completeAuthorization(a.cookie, { provider: "github", oid: "oid-1", state: a.state })).toEqual({ verifier: a.verifier });
  });

  it("rejects a missing cookie, missing state and wrong state", () => {
    const a = start();
    const base = { provider: "github" as const, oid: "oid-1" };
    expect(() => completeAuthorization(undefined, { ...base, state: a.state })).toThrow("missing_state_cookie");
    expect(() => completeAuthorization(a.cookie, { ...base, state: null })).toThrow("missing_state");
    expect(() => completeAuthorization(a.cookie, { ...base, state: "nope" })).toThrow("state_mismatch");
  });

  it("rejects another user, another provider, expiry and a forged cookie", () => {
    const a = start();
    expect(() => completeAuthorization(a.cookie, { provider: "github", oid: "oid-2", state: a.state })).toThrow("wrong_user");
    expect(() => completeAuthorization(a.cookie, { provider: "jira", oid: "oid-1", state: a.state })).toThrow("wrong_provider");
    expect(() => completeAuthorization(a.cookie, { provider: "github", oid: "oid-1", state: a.state }, Date.now() + 11 * 60_000)).toThrow("expired_state");
    expect(() => completeAuthorization("forged", { provider: "github", oid: "oid-1", state: a.state })).toThrow(StateError);
  });

  it("sends an S256 challenge that differs from the verifier", () => {
    const a = start();
    expect(a.challenge).toHaveLength(43);
    expect(a.challenge).not.toBe(a.verifier);
  });
});

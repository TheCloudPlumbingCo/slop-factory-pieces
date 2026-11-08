import { describe, expect, it } from "vitest";
import { localOid, localUser } from "@/lib/localUser";

describe("localUser", () => {
  it("is the configured name", () => expect(localUser({ PORTAL_LOCAL_USER: " yash " })).toBe("yash"));
  it("is off when unset or blank", () => {
    expect(localUser({})).toBeNull();
    expect(localUser({ PORTAL_LOCAL_USER: "  " })).toBeNull();
  });
  it("is ignored on Azure, so it cannot disable sign-in there", () => {
    expect(localUser({ PORTAL_LOCAL_USER: "yash", AZURE_MI_CLIENT_ID: "abc" })).toBeNull();
  });
  it("files connections under a distinct key", () => expect(localOid("yash")).toBe("local:yash"));
});

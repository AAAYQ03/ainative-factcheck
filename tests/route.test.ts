import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/check/route";

const req = (body: string) => new Request("http://x/api/check", { method: "POST", body, headers: { "Content-Type": "application/json" } });

describe("API 入参校验", () => {
  it("空稿件、超长稿件、非法 JSON 返回 400", async () => {
    expect((await POST(req(JSON.stringify({ text: "  " })))).status).toBe(400);
    expect((await POST(req(JSON.stringify({ text: "字".repeat(4001) })))).status).toBe(400);
    const bad = await POST(req("{oops"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("JSON");
  });
});

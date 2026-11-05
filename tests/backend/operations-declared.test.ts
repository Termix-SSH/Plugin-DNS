import { describe, expect, it } from "vitest";
import { parseManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json";
import { parseZone, registerOperations } from "../../src/backend/operations.js";
import type { DnsService } from "../../src/backend/service.js";

type Declared = {
  id: string;
  risk: string;
  permission: string;
  dryRun?: string;
};

const actions = (
  manifest.contributes as { operations: { actions: Declared[] } }
).operations.actions;

type Handler = {
  run: (input: Record<string, unknown>) => Promise<any>;
  describe?: (input: Record<string, unknown>) => Promise<string>;
};

const calls: string[] = [];
const records = [
  { id: "a", type: "A", name: "www", content: "1.1.1.1", ttl: 300 },
  { id: "b", type: "A", name: "www", content: "2.2.2.2", ttl: 300 },
];
const service = {
  zones: async () => ({
    zones: [
      {
        accountId: 1,
        id: "z",
        name: "example.com",
        accountName: "Main",
        provider: "cloudflare",
      },
    ],
    errors: [],
  }),
  records: async () => records,
  saveRecord: async (...args: unknown[]) => {
    calls.push(`save ${JSON.stringify(args)}`);
  },
  deleteRecord: async (_a: number, _z: string, id: string) => {
    calls.push(`delete ${id}`);
  },
  domains: async () => [
    {
      id: 1,
      name: "a.com",
      registrar: "x",
      expiresAt: "",
      daysLeft: 5,
      autoRenew: false,
    },
    {
      id: 2,
      name: "b.com",
      registrar: "x",
      expiresAt: "",
      daysLeft: 200,
      autoRenew: true,
    },
  ],
  health: async () => ({
    zoneName: "example.com",
    at: "",
    checks: [
      { code: "a", level: "fail" },
      { code: "b", level: "warn" },
      { code: "c", level: "ok" },
    ],
  }),
  takeSnapshot: async () => ({ id: 1, recordCount: 2 }),
  runLinks: async () => {
    calls.push("links");
  },
  links: async () => [{ lastError: null }, { lastError: "boom" }],
} as unknown as DnsService;

const handlers = new Map<string, Handler>();
registerOperations(
  {
    operations: {
      register: (id: string, handler: never) => handlers.set(id, handler),
    },
  } as unknown as PluginContext,
  service,
);

describe("declared actions", () => {
  it("is a valid manifest", () => {
    expect(parseManifest(manifest).errors ?? []).toEqual([]);
  });

  it("has a handler for every declared action and nothing else", () => {
    expect([...handlers.keys()].sort()).toEqual(
      actions.map((a) => a.id).sort(),
    );
  });

  it("needs edit for anything that changes DNS and describes it first", () => {
    for (const action of actions) {
      if (action.risk !== "read") {
        expect(action.permission).toBe("edit");
        expect(action.dryRun).toBeTruthy();
      }
    }
  });
});

describe("handlers", () => {
  it("reads a zone value", () => {
    expect(parseZone("3:abc:def")).toEqual({ accountId: 3, zoneId: "abc:def" });
    expect(() => parseZone("nope")).toThrow("Pick a zone");
  });

  it("lists zones as options", async () => {
    const result = await handlers.get("dns.list-zones")!.run({});
    expect(result.data.options).toEqual([
      { value: "1:z", label: "example.com (Main)" },
    ]);
  });

  it("reports domains close to expiry as a warning", async () => {
    const result = await handlers.get("dns.list-domains")!.run({});
    expect(result.data).toMatchObject({ status: "warn", value: 1 });
    expect(result.summary).toBe("1 expiring soon");
  });

  it("counts failing checks", async () => {
    const result = await handlers.get("dns.check-zone")!.run({ zone: "1:z" });
    expect(result.summary).toBe("example.com: 1 failing, 1 warnings");
  });

  it("describes a change and deletes only the matching record", async () => {
    const upsert = handlers.get("dns.upsert-record")!;
    expect(
      await upsert.describe!({ type: "A", name: "www", content: "9.9.9.9" }),
    ).toBe("Would set A www to 9.9.9.9");
    calls.length = 0;
    await handlers.get("dns.delete-record")!.run({
      zone: "1:z",
      type: "a",
      name: "www",
      content: "2.2.2.2",
    });
    expect(calls).toEqual(["delete b"]);
    const text = await handlers.get("dns.delete-record")!.describe!({
      zone: "1:z",
      type: "A",
      name: "www",
    });
    expect(text).toBe("Would delete 2 A record(s) named www");
    await expect(
      handlers.get("dns.delete-record")!.run({
        zone: "1:z",
        type: "A",
        name: "none",
      }),
    ).rejects.toThrow("No record matches");
  });

  it("syncs links", async () => {
    calls.length = 0;
    const result = await handlers.get("dns.sync-links")!.run({});
    expect(calls).toEqual(["links"]);
    expect(result.summary).toBe("2 links, 1 failing");
  });
});

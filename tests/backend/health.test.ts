import { describe, expect, it } from "vitest";
import type { DnsRecord } from "../../src/shared/types";
import {
  answerMatches,
  checkPropagation,
  checkZone,
  spfLookups,
  type DnsLookup,
} from "../../src/backend/health.js";
import { fakeFetch, json } from "./fake-fetch.js";

const rec = (over: Partial<DnsRecord>): DnsRecord => ({
  id: String(Math.random()),
  type: "A",
  name: "@",
  content: "1.2.3.4",
  ttl: 300,
  ...over,
});

function lookup(
  answers: Record<string, string[] | null>,
  serials: Record<string, number | null> = {},
): DnsLookup {
  return {
    async resolve(name, type) {
      const value = answers[`${name}|${type}`];
      if (value === null) throw new Error("timeout");
      return value ?? [];
    },
    async soaSerial(_name, server) {
      return serials[server] ?? null;
    },
  };
}

const dohOk = (ds: boolean, ad: boolean) =>
  fakeFetch((url) => {
    const type = url.searchParams.get("type");
    if (type === "DS") {
      return json({ Status: 0, Answer: ds ? [{ type: 43 }] : undefined });
    }
    return json({ Status: 0, AD: ad, Answer: [{ type: 6 }] });
  });

const codes = (checks: Array<{ code: string }>) => checks.map((c) => c.code);

describe("checkZone", () => {
  it("passes a clean zone", async () => {
    const fetch = dohOk(true, true);
    const checks = await checkZone(
      {
        zone: "example.com",
        expectedNs: ["ns1.host.net"],
        records: [
          rec({ name: "www", type: "CNAME", content: "example.com" }),
          rec({ type: "MX", content: "mail.example.com", priority: 10 }),
          rec({ type: "TXT", content: "v=spf1 include:_spf.x.com -all" }),
          rec({ type: "TXT", name: "_dmarc", content: "v=DMARC1; p=reject" }),
          rec({ type: "TXT", name: "s1._domainkey", content: "k=rsa; p=abc" }),
          rec({ type: "CAA", content: '0 issue "letsencrypt.org"' }),
        ],
      },
      lookup(
        {
          "example.com|NS": ["ns1.host.net", "ns2.host.net"],
          "ns1.host.net|A": ["203.0.113.1"],
          "ns2.host.net|A": ["203.0.113.2"],
          "example.com|A": ["1.2.3.4"],
          "mail.example.com|A": ["1.2.3.5"],
        },
        { "203.0.113.1": 5, "203.0.113.2": 5 },
      ),
      fetch as never,
    );
    expect(codes(checks)).toEqual([
      "delegation.ok",
      "soa.same",
      "dnssec.valid",
      "cname.ok",
      "spf.ok",
      "dmarc.ok",
      "dkim.found",
      "caa.ok",
    ]);
    expect(checks.every((c) => c.level === "ok")).toBe(true);
  });

  it("finds the usual problems", async () => {
    const fetch = dohOk(true, false);
    const checks = await checkZone(
      {
        zone: "example.com",
        expectedNs: ["ns1.other.net"],
        records: [
          rec({ name: "app", type: "CNAME", content: "gone.example.org" }),
          rec({ name: "app", type: "A", content: "9.9.9.9" }),
          rec({ type: "MX", content: "mail.nowhere.net", priority: 10 }),
          rec({ type: "TXT", content: "v=spf1 -all" }),
          rec({ type: "TXT", content: "v=spf1 +all" }),
        ],
      },
      lookup(
        {
          "example.com|NS": ["ns1.host.net", "ns2.host.net"],
          "ns1.host.net|A": ["203.0.113.1"],
          "ns2.host.net|A": ["203.0.113.2"],
        },
        { "203.0.113.1": 5, "203.0.113.2": 6 },
      ),
      fetch as never,
    );
    const list = codes(checks);
    expect(list).toContain("delegation.mismatch");
    expect(list).toContain("soa.differ");
    expect(list).toContain("dnssec.broken");
    expect(list).toContain("cname.conflict");
    expect(list).toContain("cname.dangling");
    expect(list).toContain("spf.multiple");
    expect(list).toContain("dmarc.missing");
    expect(list).toContain("mx.unresolved");
    expect(list).toContain("caa.none");
  });

  it("flags a zone that is not delegated and skips lookups that fail", async () => {
    const fetch = dohOk(false, false);
    const none = await checkZone(
      { zone: "example.com", records: [] },
      lookup({}),
      fetch as never,
    );
    expect(codes(none)).toContain("delegation.none");
    expect(codes(none)).toContain("dnssec.off");
    expect(codes(none)).toContain("mail.none");

    const down = await checkZone(
      {
        zone: "example.com",
        records: [rec({ name: "a", type: "CNAME", content: "t.example.org" })],
      },
      lookup({ "example.com|NS": null, "t.example.org|A": null }),
      fetch as never,
    );
    expect(codes(down)).toContain("delegation.error");
    expect(codes(down)).not.toContain("cname.dangling");
  });

  it("does not ask a private name server", async () => {
    const asked: string[] = [];
    const spy: DnsLookup = {
      resolve: async (name, type) => {
        if (name === "example.com" && type === "NS") return ["ns.lan"];
        if (name === "ns.lan") return ["192.168.1.5"];
        return [];
      },
      soaSerial: async (_name, server) => {
        asked.push(server);
        return 1;
      },
    };
    await checkZone(
      { zone: "example.com", records: [] },
      spy,
      dohOk(false, false) as never,
    );
    expect(asked).toEqual([]);
  });
});

describe("spf and answers", () => {
  it("counts the lookups", () => {
    expect(spfLookups("v=spf1 include:a include:b mx a ip4:1.2.3.4 -all")).toBe(
      4,
    );
    expect(spfLookups("v=spf1 -all")).toBe(0);
  });

  it("compares answers the way records are stored", () => {
    expect(answerMatches(rec({ content: "1.2.3.4" }), ["1.2.3.4"])).toBe(true);
    expect(answerMatches(rec({ content: "1.2.3.4" }), ["5.6.7.8"])).toBe(false);
    expect(
      answerMatches(rec({ type: "MX", content: "Mail.X.com.", priority: 10 }), [
        "10 mail.x.com",
      ]),
    ).toBe(true);
    expect(
      answerMatches(rec({ type: "CNAME", content: "a.x.com" }), ["a.x.com"]),
    ).toBe(true);
  });

  it("asks each public resolver", async () => {
    const rows = await checkPropagation(
      lookup({
        "www.example.com|A": ["1.2.3.4"],
      }),
      "example.com",
      [rec({ name: "www" }), rec({ name: "*" })],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.match)).toBe(true);
    expect(new Set(rows.map((row) => row.resolver))).toEqual(
      new Set(["Cloudflare", "Google", "Quad9"]),
    );
  });
});

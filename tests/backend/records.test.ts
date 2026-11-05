import { describe, expect, it } from "vitest";
import type { DnsRecord, ProviderFeatures } from "../../src/shared/types";
import {
  cleanInput,
  describePlan,
  parseZoneFile,
  plan,
  relative,
  toZoneFile,
} from "../../src/backend/records.js";
import {
  fromWire,
  quoteTxt,
  toWire,
  unquoteTxt,
} from "../../src/backend/providers/wire.js";

const features: ProviderFeatures = {
  types: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"],
  proxied: true,
  comment: true,
  autoTtl: true,
  minTtl: 60,
  domains: false,
};

const record = (over: Partial<DnsRecord>): DnsRecord => ({
  id: "x",
  type: "A",
  name: "@",
  content: "1.2.3.4",
  ttl: 300,
  ...over,
});

describe("wire helpers", () => {
  it("quotes and joins long TXT values", () => {
    const long = "a".repeat(300);
    const wire = quoteTxt(long);
    expect(wire.split('" "')).toHaveLength(2);
    expect(unquoteTxt(wire)).toBe(long);
    expect(unquoteTxt(quoteTxt('say "hi"'))).toBe('say "hi"');
  });

  it("round trips MX and SRV with dots", () => {
    const wire = toWire(
      "MX",
      { content: "mail.example.com", priority: 10 },
      { dot: true },
    );
    expect(wire).toBe("10 mail.example.com.");
    expect(fromWire("MX", wire)).toEqual({
      priority: 10,
      content: "mail.example.com",
    });
    expect(fromWire("SRV", "5 1 5060 sip.example.com.")).toEqual({
      priority: 5,
      content: "1 5060 sip.example.com",
    });
  });
});

describe("relative", () => {
  it("makes names relative to the zone", () => {
    expect(relative("example.com", "example.com")).toBe("@");
    expect(relative("WWW.Example.com.", "example.com")).toBe("www");
    expect(relative("a.b", "example.com")).toBe("a.b");
    expect(relative("", "example.com")).toBe("@");
  });
});

describe("cleanInput", () => {
  const ok = (raw: object) => cleanInput(raw as never, features, "example.com");

  it("accepts a good record and trims the name", () => {
    expect(
      ok({ type: "a", name: "www.example.com", content: "1.2.3.4", ttl: 300 }),
    ).toEqual({ type: "A", name: "www", content: "1.2.3.4", ttl: 300 });
  });

  it("rejects wrong addresses and types", () => {
    expect(ok({ type: "A", content: "nope", ttl: 300 })).toMatch(/IPv4/);
    expect(ok({ type: "AAAA", content: "1.2.3.4", ttl: 300 })).toMatch(/IPv6/);
    expect(ok({ type: "PTR", content: "x.com", ttl: 300 })).toMatch(
      /not supported/,
    );
    expect(
      ok({ type: "CNAME", name: "@", content: "x.com", ttl: 300 }),
    ).toMatch(/apex/);
  });

  it("checks ttl, mx and srv", () => {
    expect(ok({ type: "A", content: "1.2.3.4", ttl: 5 })).toMatch(/between/);
    expect(ok({ type: "A", content: "1.2.3.4", ttl: 1 })).toMatchObject({
      ttl: 1,
    });
    expect(
      ok({ type: "MX", content: "mail.x.com", ttl: 300, priority: 5 }),
    ).toMatchObject({ priority: 5 });
    expect(ok({ type: "SRV", content: "bad", ttl: 300 })).toMatch(/weight/);
    expect(
      ok({ type: "CAA", content: "0 issue letsencrypt.org", ttl: 300 }),
    ).toMatchObject({ type: "CAA" });
  });

  it("keeps proxied only when the provider has it", () => {
    expect(
      ok({ type: "A", content: "1.2.3.4", ttl: 300, proxied: true }),
    ).toMatchObject({ proxied: true });
    expect(
      cleanInput(
        { type: "A", content: "1.2.3.4", ttl: 300, proxied: true },
        { ...features, proxied: false },
        "example.com",
      ),
    ).not.toHaveProperty("proxied");
  });
});

describe("plan", () => {
  it("adds, changes and removes", () => {
    const current = [
      record({ id: "1", name: "www", content: "1.1.1.1" }),
      record({ id: "2", name: "old", content: "2.2.2.2" }),
      record({ id: "3", name: "keep", content: "3.3.3.3" }),
    ];
    const wanted = [
      { type: "A", name: "www", content: "9.9.9.9", ttl: 300 },
      { type: "A", name: "keep", content: "3.3.3.3", ttl: 300 },
      { type: "TXT", name: "@", content: "hello", ttl: 300 },
    ];
    const result = plan(current, wanted);
    expect(result.creates.map((r) => r.type)).toEqual(["TXT"]);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].record.id).toBe("1");
    expect(result.removes.map((r) => r.id)).toEqual(["2"]);
    expect(
      describePlan(result)
        .map((d) => d.kind)
        .sort(),
    ).toEqual(["add", "change", "remove"]);
  });

  it("leaves extra records alone when asked", () => {
    const result = plan(
      [record({ id: "1", name: "extra" })],
      [{ type: "A", name: "new", content: "1.2.3.4", ttl: 300 }],
      { keepExtra: true },
    );
    expect(result.removes).toEqual([]);
    expect(result.creates).toHaveLength(1);
  });

  it("changes a ttl in place", () => {
    const result = plan(
      [record({ id: "1", ttl: 300 })],
      [{ type: "A", name: "@", content: "1.2.3.4", ttl: 600 }],
    );
    expect(result.updates).toHaveLength(1);
    expect(result.creates).toEqual([]);
  });

  it("never touches read only records", () => {
    const result = plan(
      [record({ id: "1", readOnly: true, type: "NS", content: "ns.x.com" })],
      [],
    );
    expect(result.removes).toEqual([]);
  });
});

describe("zone files", () => {
  it("exports and parses back", () => {
    const records = [
      record({ id: "1", name: "@", content: "1.2.3.4" }),
      record({ id: "2", name: "www", type: "CNAME", content: "example.com" }),
      record({
        id: "3",
        name: "@",
        type: "MX",
        content: "mail.example.com",
        priority: 10,
      }),
      record({ id: "4", name: "@", type: "TXT", content: 'v=spf1 "x" -all' }),
    ];
    const text = toZoneFile("example.com", records);
    expect(text).toContain("$ORIGIN example.com.");
    const parsed = parseZoneFile(text, "example.com", features);
    expect(parsed.skipped).toEqual([]);
    const byType = Object.fromEntries(parsed.records.map((r) => [r.type, r]));
    expect(byType.A).toMatchObject({ name: "@", content: "1.2.3.4" });
    expect(byType.CNAME).toMatchObject({ name: "www", content: "example.com" });
    expect(byType.MX).toMatchObject({
      priority: 10,
      content: "mail.example.com",
    });
    expect(byType.TXT.content).toBe('v=spf1 "x" -all');
  });

  it("reads a hand written file", () => {
    const text = `
$ORIGIN example.com.
$TTL 1h
@   IN SOA ns1.example.com. admin.example.com. (
        2024010101 ; serial
        7200 3600 1209600 300 )
    IN NS ns1.example.com.
@   IN A 192.0.2.1
www IN CNAME @
mail 600 IN A 192.0.2.2
@   IN MX 10 mail
@   IN TXT "v=spf1 mx" " -all" ; comment
_sip._tcp IN SRV 10 60 5060 sip
loc IN LOC 1 2 3
`;
    const { records, skipped } = parseZoneFile(text, "example.com", features);
    expect(skipped).toEqual(["loc LOC"]);
    expect(records.find((r) => r.type === "NS")).toBeUndefined();
    expect(records.find((r) => r.name === "www")).toMatchObject({
      type: "CNAME",
      content: "example.com",
      ttl: 3600,
    });
    expect(records.find((r) => r.name === "mail")).toMatchObject({ ttl: 600 });
    expect(records.find((r) => r.type === "MX")).toMatchObject({
      priority: 10,
      content: "mail.example.com",
    });
    expect(records.find((r) => r.type === "TXT")?.content).toBe(
      "v=spf1 mx -all",
    );
    expect(records.find((r) => r.type === "SRV")).toMatchObject({
      name: "_sip._tcp",
      priority: 10,
      content: "60 5060 sip.example.com",
    });
  });
});

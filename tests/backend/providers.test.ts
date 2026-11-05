import { describe, expect, it } from "vitest";
import { cloudflare } from "../../src/backend/providers/cloudflare.js";
import { digitalocean } from "../../src/backend/providers/digitalocean.js";
import { gandi } from "../../src/backend/providers/gandi.js";
import { godaddy } from "../../src/backend/providers/godaddy.js";
import { hetzner } from "../../src/backend/providers/hetzner.js";
import { namecheap } from "../../src/backend/providers/namecheap.js";
import { porkbun } from "../../src/backend/providers/porkbun.js";
import { route53 } from "../../src/backend/providers/route53.js";
import { providers } from "../../src/backend/providers/index.js";
import { fakeFetch, json, status, xml } from "./fake-fetch.js";

const zone = { id: "z1", name: "example.com" };
const asFetch = (fn: ReturnType<typeof fakeFetch>) => fn as never;
const body = (call: { init: { body?: string } }) =>
  JSON.parse(call.init.body ?? "{}");

describe("registry", () => {
  it("lists eight providers with required fields", () => {
    expect(providers.map((p) => p.id)).toEqual([
      "cloudflare",
      "route53",
      "digitalocean",
      "hetzner",
      "namecheap",
      "godaddy",
      "porkbun",
      "gandi",
    ]);
    for (const provider of providers) {
      expect(provider.fields.some((f) => f.required)).toBe(true);
      expect(provider.features.types).toContain("A");
    }
  });
});

describe("cloudflare", () => {
  const creds = { apiToken: "tok" };

  it("lists zones and records with relative names", async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === "/client/v4/zones") {
        return json({
          success: true,
          result: [{ id: "z1", name: "example.com", name_servers: ["a.ns"] }],
          result_info: { total_pages: 1 },
        });
      }
      if (url.pathname === "/client/v4/zones/z1/dns_records") {
        return json({
          success: true,
          result: [
            {
              id: "r1",
              type: "A",
              name: "www.example.com",
              content: "1.2.3.4",
              ttl: 1,
              proxied: true,
            },
            {
              id: "r2",
              type: "SRV",
              name: "_sip._tcp.example.com",
              content: "ignored",
              ttl: 300,
              data: {
                priority: 5,
                weight: 10,
                port: 5060,
                target: "sip.x.com",
              },
            },
          ],
          result_info: { total_pages: 1 },
        });
      }
      return undefined;
    });
    const zones = await cloudflare.zones(creds, asFetch(fetch));
    expect(zones).toEqual([
      { id: "z1", name: "example.com", nameservers: ["a.ns"] },
    ]);
    const records = await cloudflare.records(creds, zone, asFetch(fetch));
    expect(records[0]).toMatchObject({ name: "www", proxied: true, ttl: 1 });
    expect(records[1]).toMatchObject({
      name: "_sip._tcp",
      content: "10 5060 sip.x.com",
      priority: 5,
    });
    expect(fetch.calls[0].init.headers.authorization).toBe("Bearer tok");
  });

  it("sends structured data for SRV and CAA", async () => {
    const fetch = fakeFetch(() => json({ success: true, result: {} }));
    await cloudflare.create(
      creds,
      zone,
      {
        type: "SRV",
        name: "_sip._tcp",
        content: "10 5060 sip.x.com",
        ttl: 300,
        priority: 5,
      },
      asFetch(fetch),
    );
    expect(body(fetch.calls[0]).data).toEqual({
      priority: 5,
      weight: 10,
      port: 5060,
      target: "sip.x.com",
    });
    await cloudflare.create(
      creds,
      zone,
      {
        type: "CAA",
        name: "@",
        content: '0 issue "letsencrypt.org"',
        ttl: 300,
      },
      asFetch(fetch),
    );
    expect(body(fetch.calls[1]).data).toEqual({
      flags: 0,
      tag: "issue",
      value: "letsencrypt.org",
    });
    expect(body(fetch.calls[1]).name).toBe("example.com");
  });

  it("explains API errors", async () => {
    const fetch = fakeFetch(() =>
      json({ success: false, errors: [{ message: "Invalid token" }] }),
    );
    await expect(cloudflare.zones(creds, asFetch(fetch))).rejects.toThrow(
      "Invalid token",
    );
  });

  it("explains a refused key", async () => {
    const fetch = fakeFetch(() => status(403, "nope"));
    await expect(cloudflare.zones(creds, asFetch(fetch))).rejects.toThrow(
      /refused the keys/,
    );
  });
});

describe("digitalocean", () => {
  const creds = { apiToken: "tok" };

  it("reads and writes records", async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.pathname === "/v2/domains/example.com/records") {
        if (init.method === "POST") return json({});
        return json({
          domain_records: [
            {
              id: 7,
              type: "MX",
              name: "@",
              data: "mail.example.com.",
              priority: 10,
              ttl: 300,
            },
          ],
          links: {},
        });
      }
      return undefined;
    });
    const doZone = { id: "example.com", name: "example.com" };
    const records = await digitalocean.records(creds, doZone, asFetch(fetch));
    expect(records[0]).toMatchObject({
      id: "7",
      content: "mail.example.com",
      priority: 10,
    });
    await digitalocean.create(
      creds,
      doZone,
      { type: "CNAME", name: "www", content: "other.net", ttl: 300 },
      asFetch(fetch),
    );
    expect(body(fetch.calls[1])).toMatchObject({
      type: "CNAME",
      name: "www",
      data: "other.net.",
    });
  });
});

describe("hetzner", () => {
  const creds = { apiToken: "tok" };

  it("flattens record sets and creates a new one", async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.pathname === "/v1/zones/z1/rrsets" && init.method === "POST") {
        return json({});
      }
      if (url.pathname === "/v1/zones/z1/rrsets") {
        return json({
          rrsets: [
            {
              name: "@",
              type: "MX",
              ttl: 3600,
              records: [{ value: "10 mail.example.com." }],
            },
            { name: "@", type: "SOA", ttl: 3600, records: [{ value: "x" }] },
          ],
          meta: { pagination: { next_page: null } },
        });
      }
      return undefined;
    });
    const records = await hetzner.records(creds, zone, asFetch(fetch));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "MX",
      priority: 10,
      content: "mail.example.com",
    });
    await hetzner.create(
      creds,
      zone,
      { type: "TXT", name: "@", content: "hello", ttl: 300 },
      asFetch(fetch),
    );
    const post = fetch.calls.find((c) => c.init.method === "POST")!;
    expect(body(post)).toMatchObject({
      name: "@",
      type: "TXT",
      records: [{ value: '"hello"' }],
    });
  });
});

describe("gandi", () => {
  const creds = { token: "pat" };

  it("keeps the other values when one is removed", async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.pathname.endsWith("/records") && !init.method) {
        return json([
          {
            rrset_name: "@",
            rrset_type: "A",
            rrset_ttl: 300,
            rrset_values: ["1.1.1.1", "2.2.2.2"],
          },
        ]);
      }
      return json({});
    });
    const records = await gandi.records(creds, zone, asFetch(fetch));
    expect(records).toHaveLength(2);
    await gandi.remove(creds, zone, records[0], asFetch(fetch));
    const put = fetch.calls.find((c) => c.init.method === "PUT")!;
    expect(body(put).rrset_values).toEqual(["2.2.2.2"]);
  });

  it("deletes the set when the last value goes", async () => {
    const fetch = fakeFetch((url, init) => {
      if (!init.method) {
        return json([
          {
            rrset_name: "www",
            rrset_type: "CNAME",
            rrset_ttl: 300,
            rrset_values: ["a.example.com."],
          },
        ]);
      }
      return json({});
    });
    const [only] = await gandi.records(creds, zone, asFetch(fetch));
    await gandi.remove(creds, zone, only, asFetch(fetch));
    expect(fetch.calls.at(-1)!.init.method).toBe("DELETE");
  });
});

describe("godaddy", () => {
  const creds = { apiKey: "k", apiSecret: "s", environment: "ote" };

  it("uses the test host and reads domains", async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === "/v1/domains") {
        return json([
          {
            domain: "Example.com",
            status: "ACTIVE",
            expires: "2027-01-01T00:00:00.000Z",
            renewAuto: false,
            locked: true,
            nameServers: ["ns1.x"],
          },
        ]);
      }
      return undefined;
    });
    const list = await godaddy.domains!(creds, asFetch(fetch));
    expect(list[0]).toMatchObject({
      name: "example.com",
      autoRenew: false,
      locked: true,
    });
    expect(fetch.calls[0].url).toContain("api.ote-godaddy.com");
    expect(fetch.calls[0].init.headers.authorization).toBe("sso-key k:s");
  });

  it("writes a whole set for one name", async () => {
    const fetch = fakeFetch((_url, init) =>
      init.method === "PUT"
        ? json({})
        : json([{ type: "A", name: "@", data: "1.1.1.1", ttl: 600 }]),
    );
    await godaddy.create(
      creds,
      zone,
      { type: "A", name: "@", content: "2.2.2.2", ttl: 600 },
      asFetch(fetch),
    );
    const put = fetch.calls.find((c) => c.init.method === "PUT")!;
    expect(put.url).toContain("/records/A/%40");
    expect(body(put).map((r: { data: string }) => r.data)).toEqual([
      "1.1.1.1",
      "2.2.2.2",
    ]);
  });
});

describe("porkbun", () => {
  const creds = { apiKey: "k", secretApiKey: "s" };

  it("posts the keys and maps records and domains", async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname.endsWith("/dns/retrieve/example.com")) {
        return json({
          status: "SUCCESS",
          records: [
            {
              id: "11",
              name: "www.example.com",
              type: "A",
              content: "1.2.3.4",
              ttl: "600",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/domain/listAll")) {
        return json({
          status: "SUCCESS",
          domains: [
            {
              domain: "example.com",
              status: "ACTIVE",
              expireDate: "2027-05-01 00:00:00",
              securityLock: "1",
              autoRenew: 0,
            },
          ],
        });
      }
      return json({ status: "ERROR", message: "Domain is not opted in" });
    });
    const records = await porkbun.records(creds, zone, asFetch(fetch));
    expect(records[0]).toMatchObject({ id: "11", name: "www", ttl: 600 });
    expect(body(fetch.calls[0])).toMatchObject({
      apikey: "k",
      secretapikey: "s",
    });
    const list = await porkbun.domains!(creds, asFetch(fetch));
    expect(list[0]).toMatchObject({
      locked: true,
      autoRenew: false,
      expiresAt: "2027-05-01T00:00:00.000Z",
    });
    await expect(
      porkbun.remove(creds, zone, records[0], asFetch(fetch)),
    ).rejects.toThrow("Domain is not opted in");
  });
});

describe("namecheap", () => {
  const creds = {
    apiUser: "u",
    apiKey: "k",
    clientIp: "1.2.3.4",
  };
  const hostsXml = (rows: string) =>
    `<ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult Domain="example.com">${rows}</DomainDNSGetHostsResult></CommandResponse></ApiResponse>`;

  it("replaces the whole host list on a change", async () => {
    const fetch = fakeFetch((_url, init) => {
      const params = new URLSearchParams(init.body);
      if (params.get("Command") === "namecheap.domains.dns.getHosts") {
        return xml(
          hostsXml(
            '<host HostId="1" Name="@" Type="A" Address="1.1.1.1" MXPref="10" TTL="1800" /><host HostId="2" Name="mail" Type="MX" Address="mx.x.com." MXPref="20" TTL="1800" />',
          ),
        );
      }
      return xml('<ApiResponse Status="OK"></ApiResponse>');
    });
    const records = await namecheap.records(creds, zone, asFetch(fetch));
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ type: "MX", priority: 20 });
    await namecheap.create(
      creds,
      zone,
      { type: "TXT", name: "@", content: "hi", ttl: 600 },
      asFetch(fetch),
    );
    const set = new URLSearchParams(fetch.calls.at(-1)!.init.body);
    expect(set.get("Command")).toBe("namecheap.domains.dns.setHosts");
    expect(set.get("SLD")).toBe("example");
    expect(set.get("TLD")).toBe("com");
    expect(set.get("HostName3")).toBe("@");
    expect(set.get("RecordType3")).toBe("TXT");
    expect(set.get("Address1")).toBe("1.1.1.1");
    expect(set.get("EmailType")).toBe("MX");
  });

  it("lists only domains on Namecheap DNS as zones", async () => {
    const fetch = fakeFetch(() =>
      xml(
        '<ApiResponse Status="OK"><CommandResponse><DomainGetListResult><Domain Name="a.com" Expires="06/30/2027" IsLocked="true" AutoRenew="false" IsOurDNS="true" IsExpired="false" /><Domain Name="b.com" Expires="01/02/2027" IsLocked="false" AutoRenew="true" IsOurDNS="false" IsExpired="false" /></DomainGetListResult></CommandResponse></ApiResponse>',
      ),
    );
    expect(await namecheap.zones(creds, asFetch(fetch))).toEqual([
      { id: "a.com", name: "a.com" },
    ]);
    const domains = await namecheap.domains!(creds, asFetch(fetch));
    expect(domains).toHaveLength(2);
    expect(domains[0]).toMatchObject({
      expiresAt: "2027-06-30T00:00:00.000Z",
      locked: true,
      autoRenew: false,
    });
  });

  it("shows API errors", async () => {
    const fetch = fakeFetch(() =>
      xml(
        '<ApiResponse Status="ERROR"><Errors><Error Number="1011150">Invalid request IP</Error></Errors></ApiResponse>',
      ),
    );
    await expect(namecheap.domains!(creds, asFetch(fetch))).rejects.toThrow(
      "Invalid request IP",
    );
  });
});

describe("route53", () => {
  const creds = { accessKeyId: "AKIA", secretAccessKey: "secret" };

  const rrsets = `<ListResourceRecordSetsResponse><ResourceRecordSets>
    <ResourceRecordSet><Name>example.com.</Name><Type>NS</Type><TTL>172800</TTL><ResourceRecords><ResourceRecord><Value>ns-1.awsdns.org.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>
    <ResourceRecordSet><Name>\\052.example.com.</Name><Type>A</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>1.2.3.4</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>
    <ResourceRecordSet><Name>app.example.com.</Name><Type>A</Type><AliasTarget><DNSName>lb.amazonaws.com.</DNSName></AliasTarget></ResourceRecordSet>
    <ResourceRecordSet><Name>example.com.</Name><Type>TXT</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>"v=spf1 -all"</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>
  </ResourceRecordSets><IsTruncated>false</IsTruncated></ListResourceRecordSetsResponse>`;

  it("lists zones", async () => {
    const fetch = fakeFetch(() =>
      xml(
        "<ListHostedZonesResponse><HostedZones><HostedZone><Id>/hostedzone/Z123</Id><Name>example.com.</Name></HostedZone></HostedZones><IsTruncated>false</IsTruncated></ListHostedZonesResponse>",
      ),
    );
    expect(await route53.zones(creds, asFetch(fetch))).toEqual([
      { id: "Z123", name: "example.com" },
    ]);
    expect(fetch.calls[0].init.headers.authorization).toContain(
      "AWS4-HMAC-SHA256 Credential=AKIA/",
    );
  });

  it("reads sets, decodes names and protects managed records", async () => {
    const fetch = fakeFetch((_url, init) =>
      init.method === "POST" ? xml("<ChangeInfo/>") : xml(rrsets),
    );
    const records = await route53.records(
      creds,
      { id: "Z123", name: "example.com" },
      asFetch(fetch),
    );
    const names = records.map((r) => `${r.type} ${r.name}`);
    expect(names).toEqual(["NS @", "A *", "A app", "TXT @"]);
    expect(records[0].readOnly).toBe(true);
    expect(records[2]).toMatchObject({
      readOnly: true,
      content: "ALIAS lb.amazonaws.com",
    });
    expect(records[3].content).toBe("v=spf1 -all");
    await expect(
      route53.remove(
        creds,
        { id: "Z123", name: "example.com" },
        records[2],
        asFetch(fetch),
      ),
    ).rejects.toThrow(/manages this record/);
  });

  it("upserts a set with quoted TXT values", async () => {
    const fetch = fakeFetch((_url, init) =>
      init.method === "POST" ? xml("<ChangeInfo/>") : xml(rrsets),
    );
    await route53.create(
      creds,
      { id: "Z123", name: "example.com" },
      { type: "TXT", name: "@", content: "hello", ttl: 120 },
      asFetch(fetch),
    );
    const post = fetch.calls.find((c) => c.init.method === "POST")!;
    expect(post.init.body).toContain("<Action>UPSERT</Action>");
    expect(post.init.body).toContain("<Name>example.com.</Name>");
    expect(post.init.body).toContain("&quot;v=spf1 -all&quot;");
    expect(post.init.body).toContain("&quot;hello&quot;");
  });

  it("lists domains with details", async () => {
    const fetch = fakeFetch((_url, init) => {
      const target = init.headers["x-amz-target"] as string;
      if (target.endsWith("ListDomains")) {
        return json({
          Domains: [
            {
              DomainName: "example.com",
              AutoRenew: true,
              TransferLock: true,
              Expiry: 1_800_000_000,
            },
          ],
        });
      }
      return json({
        Nameservers: [{ Name: "ns-1.awsdns.org" }],
        StatusList: ["clientTransferProhibited"],
      });
    });
    const [domain] = await route53.domains!(creds, asFetch(fetch));
    expect(domain).toMatchObject({
      name: "example.com",
      nameservers: ["ns-1.awsdns.org"],
      autoRenew: true,
    });
    expect(domain.expiresAt).toBe(new Date(1_800_000_000_000).toISOString());
  });
});

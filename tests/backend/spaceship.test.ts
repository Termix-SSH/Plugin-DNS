import { describe, expect, it } from "vitest";
import { spaceship } from "../../src/backend/providers/spaceship.js";
import { fakeFetch, json } from "./fake-fetch.js";

const zone = { id: "example.com", name: "example.com" };
const creds = { apiKey: "k", apiSecret: "s" };
const asFetch = (fn: ReturnType<typeof fakeFetch>) => fn as never;
const body = (call: { init: { body?: string } }) =>
  JSON.parse(call.init.body ?? "{}");
const custom = { type: "custom" };

describe("spaceship", () => {
  it("reads records with the key headers and keeps product records read only", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname === "/api/v1/dns/records/example.com"
        ? json({
            items: [
              {
                type: "A",
                name: "@",
                address: "1.1.1.1",
                ttl: 3600,
                group: custom,
              },
              {
                type: "MX",
                name: "@",
                exchange: "mail.example.com",
                preference: 10,
                ttl: 600,
                group: custom,
              },
              {
                type: "SRV",
                name: "@",
                service: "_sip",
                protocol: "_tcp",
                priority: 1,
                weight: 5,
                port: 5060,
                target: "sip.example.com",
                ttl: 600,
                group: custom,
              },
              {
                type: "CAA",
                name: "@",
                flag: 0,
                tag: "issue",
                value: "letsencrypt.org",
                ttl: 600,
                group: custom,
              },
              {
                type: "CNAME",
                name: "shop",
                cname: "x.example.net",
                ttl: 600,
                group: { type: "product" },
              },
            ],
            total: 5,
          })
        : undefined,
    );
    const records = await spaceship.records(creds, zone, asFetch(fetch));
    expect(fetch.calls[0].init.headers["X-API-Key"]).toBe("k");
    expect(fetch.calls[0].init.headers["X-API-Secret"]).toBe("s");
    expect(records.map((r) => [r.type, r.name, r.content, r.priority])).toEqual(
      [
        ["A", "@", "1.1.1.1", null],
        ["MX", "@", "mail.example.com", 10],
        ["SRV", "_sip._tcp", "5 5060 sip.example.com", 1],
        ["CAA", "@", '0 issue "letsencrypt.org"', null],
        ["CNAME", "shop", "x.example.net", null],
      ],
    );
    expect(records[4].readOnly).toBe(true);
    await expect(
      spaceship.remove(creds, zone, records[4], asFetch(fetch)),
    ).rejects.toThrow(/manages this record/);
  });

  it("splits SRV names and caps the TTL when saving", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 204 }));
    await spaceship.create(
      creds,
      zone,
      {
        type: "SRV",
        name: "_sip._tcp.voip",
        content: "5 5060 sip.example.com",
        priority: 1,
        ttl: 86400,
      },
      asFetch(fetch),
    );
    expect(fetch.calls[0].init.method).toBe("PUT");
    expect(body(fetch.calls[0])).toEqual({
      force: true,
      items: [
        {
          type: "SRV",
          name: "voip",
          service: "_sip",
          protocol: "_tcp",
          priority: 1,
          weight: 5,
          port: 5060,
          target: "sip.example.com",
          ttl: 3600,
        },
      ],
    });
  });

  it("refuses an SRV name without service and protocol", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(
      spaceship.create(
        creds,
        zone,
        {
          type: "SRV",
          name: "voip",
          content: "5 5060 sip.example.com",
          ttl: 600,
        },
        asFetch(fetch),
      ),
    ).rejects.toThrow(/_sip._tcp/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("deletes the old record before saving a changed one", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 204 }));
    const record = {
      id: "x",
      type: "A",
      name: "www",
      content: "1.1.1.1",
      ttl: 600,
      priority: null,
    };
    await spaceship.update(
      creds,
      zone,
      record,
      { type: "A", name: "www", content: "2.2.2.2", ttl: 600 },
      asFetch(fetch),
    );
    expect(fetch.calls.map((c) => c.init.method)).toEqual(["DELETE", "PUT"]);
    expect(body(fetch.calls[0])).toEqual([
      { type: "A", name: "www", address: "1.1.1.1" },
    ]);

    fetch.calls.length = 0;
    await spaceship.update(
      creds,
      zone,
      record,
      { type: "A", name: "www", content: "1.1.1.1", ttl: 1800 },
      asFetch(fetch),
    );
    expect(fetch.calls.map((c) => c.init.method)).toEqual(["PUT"]);
  });

  it("reads the domain list with the transfer lock", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname === "/api/v1/domains"
        ? json({
            items: [
              {
                name: "Example.com",
                autoRenew: true,
                expirationDate: "2027-05-01T00:00:00Z",
                lifecycleStatus: "registered",
                eppStatuses: ["clientTransferProhibited"],
                nameservers: {
                  provider: "basic",
                  hosts: ["launch1.spaceship.net"],
                },
              },
            ],
            total: 1,
          })
        : undefined,
    );
    const list = await spaceship.domains!(creds, asFetch(fetch));
    expect(list[0]).toMatchObject({
      name: "example.com",
      registrar: "spaceship",
      autoRenew: true,
      locked: true,
      nameservers: ["launch1.spaceship.net"],
    });
    const zones = await spaceship.zones(creds, asFetch(fetch));
    expect(zones[0]).toMatchObject({ id: "example.com", name: "example.com" });
  });
});

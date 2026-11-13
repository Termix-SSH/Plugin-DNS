import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { createService } from "../../src/backend/service.js";
import {
  accounts,
  domains,
  links,
  snapshots,
} from "../../src/backend/tables.js";
import { fakeFetch, json, status } from "./fake-fetch.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
}

let cfRecords: CfRecord[] = [];
let nextId = 1;
let publicIp = "203.0.113.7";
let expires = new Date(Date.now() + 10 * 86_400_000).toISOString();

const router = fakeFetch((url, init) => {
  if (url.hostname === "api.ipify.org") return json({ ip: publicIp });
  if (url.hostname === "rdap.org") {
    if (url.pathname.endsWith("/missing.com")) return status(404);
    return json({
      ldhName: "watched.com",
      status: ["client transfer prohibited"],
      events: [{ eventAction: "expiration", eventDate: expires }],
      nameservers: [{ ldhName: "NS1.HOST.NET" }],
      entities: [
        {
          roles: ["registrar"],
          vcardArray: ["vcard", [["fn", {}, "text", "Test Registrar"]]],
        },
      ],
    });
  }
  if (url.hostname !== "api.cloudflare.com") return undefined;
  const path = url.pathname.replace("/client/v4", "");
  const ok = (result: unknown) =>
    json({ success: true, result, result_info: { total_pages: 1 } });
  if (init.headers?.authorization !== "Bearer good-token") {
    return status(403, "bad token");
  }
  if (path === "/zones") {
    return ok([
      { id: "z1", name: "example.com", name_servers: ["a.ns.cloudflare.com"] },
    ]);
  }
  if (path === "/zones/z1/dns_records") {
    if (init.method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      const record = { id: `r${nextId++}`, ...body };
      cfRecords.push(record);
      return ok(record);
    }
    return ok(cfRecords);
  }
  const match = path.match(/^\/zones\/z1\/dns_records\/(.+)$/);
  if (match) {
    if (init.method === "DELETE") {
      cfRecords = cfRecords.filter((r) => r.id !== match[1]);
      return ok({ id: match[1] });
    }
    if (init.method === "PUT") {
      const body = JSON.parse(init.body ?? "{}");
      cfRecords = cfRecords.map((r) =>
        r.id === match[1] ? { id: r.id, ...body } : r,
      );
      return ok({});
    }
  }
  return undefined;
});

let db: TestDb;
let mock: MockPluginContext;
let server: http.Server;
let port: number;

async function setup(permissions: string[]) {
  db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
    .run("user-1", "user-1");
  let routes: Router | null = null;
  mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (routes = express.Router()),
    permissions,
    fetch: router as never,
    hosts: [
      {
        id: 5,
        userId: "user-1",
        name: "web",
        ip: "198.51.100.5",
        port: 22,
        username: "root",
        tags: null,
        folder: null,
        authType: "password",
      },
      {
        id: 6,
        userId: "user-1",
        name: "lan",
        ip: "web.lan",
        port: 22,
        username: "root",
        tags: null,
        folder: null,
        authType: "password",
      },
    ],
  });
  // Drop this once the lock moves to SDK 2.2.2, which takes a resolve option.
  Object.assign(mock.ctx.network, {
    lookup: async (name: string, options?: { family?: 4 | 6 }) =>
      name === "web.lan" && options?.family === 4 ? "192.0.2.44" : null,
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  app.use((req, res, next) => routes!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const ALL = ["dns.view", "dns.edit", "dns.manage"];
const ZONE = "/accounts/1/zones/z1";

async function addAccount(token = "good-token") {
  const created = await request("POST", "/accounts", {
    provider: "cloudflare",
    name: "Main",
    credentials: { apiToken: token },
  });
  expect(created.status).toBe(201);
  return created.body.id as number;
}

beforeEach(async () => {
  cfRecords = [];
  nextId = 1;
  publicIp = "203.0.113.7";
  expires = new Date(Date.now() + 10 * 86_400_000).toISOString();
  router.mockClear();
  router.calls.length = 0;
  await setup(ALL);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

const addRecord = (extra: Record<string, unknown> = {}) =>
  request("POST", `${ZONE}/records`, {
    type: "A",
    name: "www",
    content: "1.2.3.4",
    ttl: 300,
    ...extra,
  });

describe("accounts", () => {
  it("lists the providers", async () => {
    const result = await request("GET", "/providers");
    expect(result.body.providers).toHaveLength(8);
  });

  it("stores the keys sealed and never sends them back", async () => {
    await addAccount();
    const list = await request("GET", "/accounts");
    expect(list.body.accounts).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("good-token");
    const stored = db.sqlite
      .prepare("SELECT credentials FROM p_dns_accounts")
      .get() as { credentials: string };
    expect(stored.credentials).not.toContain("good-token");
  });

  it("checks required keys and duplicate names", async () => {
    const missing = await request("POST", "/accounts", {
      provider: "cloudflare",
      name: "A",
      credentials: {},
    });
    expect(missing.status).toBe(400);
    await addAccount();
    const dupe = await request("POST", "/accounts", {
      provider: "cloudflare",
      name: "Main",
      credentials: { apiToken: "x" },
    });
    expect(dupe.status).toBe(409);
  });

  it("tests a login and records a failure", async () => {
    const good = await addAccount();
    const test = await request("POST", `/accounts/${good}/test`);
    expect(test.body).toEqual({ zones: 1, domains: null });
    const bad = await request("PUT", `/accounts/${good}`, {
      credentials: { apiToken: "wrong" },
    });
    expect(bad.status).toBe(200);
    const failed = await request("POST", `/accounts/${good}/test`);
    expect(failed.status).toBe(502);
    const list = await request("GET", "/accounts");
    expect(list.body.accounts[0].status).toBe("error");
  });

  it("removes everything that belongs to an account", async () => {
    const id = await addAccount();
    await addRecord();
    await request("DELETE", `/accounts/${id}`);
    const count = (table: string) =>
      (
        db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    expect(count("p_dns_accounts")).toBe(0);
    expect(count("p_dns_snapshots")).toBe(0);
  });
});

describe("records", () => {
  it("lists zones across accounts", async () => {
    await addAccount();
    const zones = await request("GET", "/zones");
    expect(zones.body.zones).toEqual([
      expect.objectContaining({
        id: "z1",
        name: "example.com",
        accountName: "Main",
        provider: "cloudflare",
      }),
    ]);
  });

  it("adds, changes and deletes a record", async () => {
    await addAccount();
    expect((await addRecord()).status).toBe(201);
    let list = await request("GET", `${ZONE}/records?fresh=1`);
    expect(list.body.records).toHaveLength(1);
    expect(list.body.records[0]).toMatchObject({
      name: "www",
      content: "1.2.3.4",
    });
    const id = list.body.records[0].id;

    const changed = await request("PUT", `${ZONE}/records/${id}`, {
      type: "A",
      name: "www",
      content: "5.6.7.8",
      ttl: 600,
    });
    expect(changed.status).toBe(200);
    list = await request("GET", `${ZONE}/records?fresh=1`);
    expect(list.body.records[0]).toMatchObject({
      content: "5.6.7.8",
      ttl: 600,
    });

    await request("DELETE", `${ZONE}/records/${id}`);
    list = await request("GET", `${ZONE}/records?fresh=1`);
    expect(list.body.records).toEqual([]);
  });

  it("refuses a bad record before calling the provider", async () => {
    await addAccount();
    const calls = router.calls.length;
    const bad = await addRecord({ content: "not-an-ip" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/IPv4/);
    expect(
      router.calls.slice(calls).filter((c) => c.init.method === "POST"),
    ).toEqual([]);
  });

  it("saves a copy before the first change", async () => {
    await addAccount();
    await addRecord();
    const copies = await request("GET", `${ZONE}/snapshots`);
    expect(copies.body.snapshots).toHaveLength(1);
    expect(copies.body.snapshots[0]).toMatchObject({
      source: "before",
      recordCount: 0,
    });
  });
});

describe("copies", () => {
  it("shows a diff and restores a copy", async () => {
    await addAccount();
    await addRecord({ name: "keep" });
    const saved = await request("POST", `${ZONE}/snapshots`, { label: "good" });
    const id = saved.body.snapshot.id;
    expect(saved.body.snapshot.recordCount).toBe(1);

    await addRecord({ name: "extra", content: "9.9.9.9" });
    const diff = await request("GET", `/snapshots/${id}/diff`);
    expect(diff.body.diff).toEqual([
      expect.objectContaining({ kind: "remove", name: "extra" }),
    ]);

    const restored = await request("POST", `/snapshots/${id}/restore`);
    expect(restored.body.applied).toBe(true);
    const list = await request("GET", `${ZONE}/records?fresh=1`);
    expect(list.body.records.map((r: { name: string }) => r.name)).toEqual([
      "keep",
    ]);
    const after = await request("GET", `/snapshots/${id}/diff`);
    expect(after.body.diff).toEqual([]);
  });

  it("keeps copies out of reach of users who only view", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await setup(["dns.view"]);
    const result = await request("POST", "/accounts", {
      provider: "cloudflare",
      name: "x",
      credentials: { apiToken: "x" },
    });
    expect(result.status).toBe(403);
  });
});

describe("zone files", () => {
  it("exports, previews and applies an import", async () => {
    await addAccount();
    await addRecord();
    const file = await request("GET", `${ZONE}/export`);
    expect(file.body.text).toContain("www");

    const text = `${file.body.text}\nblog 300 IN A 10.0.0.9\n`;
    const preview = await request("POST", `${ZONE}/import`, {
      text,
      apply: false,
      replace: false,
    });
    expect(preview.body.applied).toBe(false);
    expect(preview.body.diff).toEqual([
      expect.objectContaining({ kind: "add", name: "blog" }),
    ]);
    expect(cfRecords).toHaveLength(1);

    const applied = await request("POST", `${ZONE}/import`, {
      text,
      apply: true,
      replace: false,
    });
    expect(applied.body.applied).toBe(true);
    expect(cfRecords.map((r) => r.name)).toContain("blog.example.com");
  });
});

describe("domains", () => {
  it("watches a domain through RDAP", async () => {
    const added = await request("POST", "/domains", { name: "Watched.com" });
    expect(added.status).toBe(201);
    expect(added.body.domain).toMatchObject({
      name: "watched.com",
      registrar: "Test Registrar",
      source: "watch",
      nameservers: ["ns1.host.net"],
    });
    expect(added.body.domain.daysLeft).toBeLessThanOrEqual(10);
    expect(
      (await request("POST", "/domains", { name: "watched.com" })).status,
    ).toBe(409);
    expect(
      (await request("POST", "/domains", { name: "bad name" })).status,
    ).toBe(400);
    expect(
      (await request("POST", "/domains", { name: "missing.com" })).status,
    ).toBe(502);
    const list = await request("GET", "/domains");
    expect(list.body.domains).toHaveLength(1);
    await request("DELETE", `/domains/${list.body.domains[0].id}`);
    expect((await request("GET", "/domains")).body.domains).toEqual([]);
  });

  it("alerts once per expiry step", async () => {
    await request("POST", "/domains", { name: "watched.com" });
    await request("POST", "/domains/refresh");
    await request("POST", "/domains/refresh");
    const alerts = mock.notifications.filter((n) =>
      n.notification.title.includes("watched.com"),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].notification.title).toContain("expires in");
  });
});

describe("links", () => {
  it("creates the record and keeps it in step with the public address", async () => {
    await addAccount();
    const created = await request("POST", "/links", {
      accountId: 1,
      zoneId: "z1",
      zoneName: "example.com",
      name: "home",
      type: "A",
      source: "public4",
      ttl: 300,
      proxied: false,
      enabled: true,
    });
    expect(created.status).toBe(201);
    expect(cfRecords).toEqual([
      expect.objectContaining({
        name: "home.example.com",
        content: "203.0.113.7",
      }),
    ]);

    const same = await request("POST", "/links/1/sync");
    expect(same.body.changed).toBe(false);

    publicIp = "203.0.113.99";
    const moved = await request("POST", "/links/1/sync");
    expect(moved.body.changed).toBe(true);
    expect(cfRecords[0].content).toBe("203.0.113.99");
    const list = await request("GET", "/links");
    expect(list.body.links[0]).toMatchObject({
      lastValue: "203.0.113.99",
      lastError: null,
    });
  });

  it("follows a host and rejects a mismatched type", async () => {
    await addAccount();
    const link = {
      accountId: 1,
      zoneId: "z1",
      zoneName: "example.com",
      name: "web",
      type: "A",
      source: "host",
      hostId: 5,
      ttl: 300,
      proxied: false,
      enabled: true,
    };
    expect((await request("POST", "/links", link)).status).toBe(201);
    expect(cfRecords[0].content).toBe("198.51.100.5");
    const wrong = await request("POST", "/links", {
      ...link,
      name: "v6",
      type: "AAAA",
      source: "public4",
    });
    expect(wrong.status).toBe(400);
    const dupe = await request("POST", "/links", link);
    expect(dupe.status).toBe(409);
  });

  it("looks up a host that has a name instead of an address", async () => {
    await addAccount();
    const link = {
      accountId: 1,
      zoneId: "z1",
      zoneName: "example.com",
      name: "lan",
      type: "A",
      source: "host",
      hostId: 6,
      ttl: 300,
      proxied: false,
      enabled: true,
    };
    expect((await request("POST", "/links", link)).status).toBe(201);
    expect(cfRecords[0].content).toBe("192.0.2.44");
    const v6 = await request("POST", "/links", {
      ...link,
      name: "lan6",
      type: "AAAA",
    });
    expect(v6.status).toBe(201);
    expect(cfRecords).toHaveLength(1);
    const list = await request("GET", "/links");
    const failed = (
      list.body.links as Array<{ name: string; lastError: string }>
    ).find((row) => row.name === "lan6");
    expect(failed?.lastError).toMatch(/Could not resolve web.lan/);
  });

  it("alerts when an update fails and says so once", async () => {
    await addAccount();
    await request("POST", "/links", {
      accountId: 1,
      zoneId: "z1",
      zoneName: "example.com",
      name: "home",
      type: "A",
      source: "public4",
      ttl: 300,
      proxied: false,
      enabled: true,
    });
    router.mockImplementationOnce(async () => status(500));
    publicIp = "not-an-ip";
    const failed = await request("POST", "/links/1/sync");
    expect(failed.status).toBe(502);
    await request("POST", "/links/1/sync");
    const alerts = mock.notifications.filter((n) =>
      n.notification.title.includes("could not be updated"),
    );
    expect(alerts).toHaveLength(1);
  });
});

describe("service for other plugins", () => {
  it("adds and removes a challenge record", async () => {
    await addAccount();
    const dns = await mock.ctx.services.get<{
      findZone: (name: string) => Promise<{ zoneName: string } | null>;
      setRecord: (input: object) => Promise<object>;
      removeRecord: (handle: object) => Promise<void>;
    }>("dns.records");
    expect(await dns.findZone("_acme-challenge.sub.example.com")).toMatchObject(
      {
        zoneName: "example.com",
      },
    );
    expect(await dns.findZone("other.net")).toBeNull();
    const handle = await dns.setRecord({
      name: "_acme-challenge.sub.example.com",
      type: "TXT",
      content: "token",
      ttl: 120,
    });
    expect(cfRecords).toEqual([
      expect.objectContaining({
        name: "_acme-challenge.sub.example.com",
        content: "token",
      }),
    ]);
    await dns.setRecord({
      name: "_acme-challenge.sub.example.com",
      type: "TXT",
      content: "token",
    });
    expect(cfRecords).toHaveLength(1);
    await dns.removeRecord(handle);
    expect(cfRecords).toEqual([]);
  });
});

describe("daily work", () => {
  async function service() {
    const stores = {
      accounts: await mock.ctx.db.define(accounts),
      snapshots: await mock.ctx.db.define(snapshots),
      domains: await mock.ctx.db.define(domains),
      links: await mock.ctx.db.define(links),
    };
    return createService(mock.ctx, stores as never, {
      lookup: {
        resolve: async () => [],
        soaSerial: async () => null,
      },
    });
  }

  it("copies the zone and alerts when it changes outside Termix", async () => {
    await addAccount();
    await addRecord();
    const daily = await service();
    await daily.runDaily(true);
    const first = await request("GET", `${ZONE}/snapshots`);
    const before = first.body.snapshots.length;
    expect(
      mock.notifications.filter((n) =>
        /outside Termix/.test(n.notification.title),
      ),
    ).toHaveLength(0);

    cfRecords.push({
      id: "outside",
      type: "A",
      name: "sneaky.example.com",
      content: "6.6.6.6",
      ttl: 300,
    });
    daily.flush();
    await daily.runDaily(true);
    const after = await request("GET", `${ZONE}/snapshots`);
    expect(after.body.snapshots.length).toBe(before + 1);
    expect(after.body.snapshots[0]).toMatchObject({
      source: "auto",
      label: "Changed outside Termix",
    });
    expect(
      mock.notifications.filter((n) =>
        /outside Termix/.test(n.notification.title),
      ),
    ).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import { expiryTone, formatTtl, levelTone } from "../../src/frontend/format";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const answers: Record<string, unknown> = {
  "/providers": { providers: [] },
  "/accounts": {
    accounts: [
      {
        id: 1,
        provider: "cloudflare",
        name: "Main",
        status: "ok",
        lastError: null,
        lastSyncAt: null,
        autoBackup: true,
        checkHealth: true,
      },
    ],
  },
  "/zones": {
    zones: [
      {
        id: "z1",
        name: "example.com",
        accountId: 1,
        accountName: "Main",
        provider: "cloudflare",
      },
    ],
    errors: [{ accountId: 2, name: "Broken", error: "The key was refused" }],
  },
  "/domains": { domains: [] },
  "/links": { links: [] },
};

const api = (overrides: Record<string, unknown> = {}) =>
  ({
    get: vi.fn(async (path: string) => ({
      data: { ...answers, ...overrides }[path],
    })),
  }) as never;

describe(`${manifest.id} activate`, () => {
  it("registers the rail item, tab and dashboard card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["dns"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({ id: "dns", permission: "dns.view" }),
    ]);
  });

  it("lists zones and shows a login that failed", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales, api: api() });
    rendered.renderTab("dns", { isVisible: true });
    expect(await screen.findByText("example.com")).toBeTruthy();
    expect(screen.getByText(/The key was refused/)).toBeTruthy();
  });

  it("shows the empty state", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ "/zones": { zones: [], errors: [] } }),
    });
    rendered.renderTab("dns", { isVisible: true });
    expect(await screen.findByText(locales.zones.empty)).toBeTruthy();
  });
});

describe("format", () => {
  it("shortens ttls", () => {
    expect(formatTtl(1, true)).toBe("Auto");
    expect(formatTtl(300, false)).toBe("5m");
    expect(formatTtl(3600, false)).toBe("1h");
    expect(formatTtl(172800, false)).toBe("2d");
    expect(formatTtl(45, false)).toBe("45s");
  });

  it("picks tones", () => {
    expect(expiryTone(null)).toBe("idle");
    expect(expiryTone(-3)).toBe("bad");
    expect(expiryTone(20)).toBe("warn");
    expect(expiryTone(90)).toBe("ok");
    expect(levelTone("fail")).toBe("bad");
    expect(levelTone("info")).toBe("idle");
  });
});

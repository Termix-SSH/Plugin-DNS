import net from "node:net";
import { describe, expect, it } from "vitest";
import { isIP, isIPv4, isIPv6 } from "../../src/backend/ip";

const cases = [
  "1.2.3.4",
  "0.0.0.0",
  "255.255.255.255",
  "256.1.1.1",
  "01.2.3.4",
  "1.2.3",
  "1.2.3.4.5",
  " 1.2.3.4",
  "::",
  "::1",
  "2001:db8::5",
  "2001:DB8:0:0:0:0:0:1",
  "::ffff:1.2.3.4",
  "2001:db8:::1",
  "2001:db8::g",
  "1:2:3:4:5:6:7:8:9",
  "[::1]",
  "example.com",
  "",
];

describe("ip helpers", () => {
  it.each(cases)("answers like node:net for %j", (value) => {
    expect(isIPv4(value)).toBe(net.isIPv4(value));
    expect(isIPv6(value)).toBe(net.isIPv6(value));
    expect(isIP(value)).toBe(net.isIP(value));
  });
});

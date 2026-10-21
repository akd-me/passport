import { describe, expect, it, vi } from "vitest";
import { parseListUnsubscribe, type ResolveDns, requestUnsubscribe } from "./unsubscribe.js";

describe("List-Unsubscribe parsing", () => {
  it("parses folded headers, prefers the first HTTPS target, and recognizes one-click", () => {
    const parsed = parseListUnsubscribe(
      "<http://insecure.example/u>,\r\n <HTTPS://lists.example/u?token=secret>, <https://second.example/u>, <mailto:leave@example.com>",
      "other; list-unsubscribe=one-click",
    );
    expect(parsed.https?.href).toBe("https://lists.example/u?token=secret");
    expect(parsed.mailto).toEqual({
      address: "leave@example.com",
      subject: "unsubscribe",
      textBody: "unsubscribe",
    });
    expect(parsed.oneClick).toBe(true);
  });

  it("decodes mailto addresses, subjects, and bodies while ignoring other mail headers", () => {
    expect(
      parseListUnsubscribe(
        "<mailto:leave%2Bnews@example.com?subject=Stop%20mail&body=Please%20stop%0AThanks&cc=ignored@example.com>",
      ).mailto,
    ).toEqual({
      address: "leave+news@example.com",
      subject: "Stop mail",
      textBody: "Please stop\nThanks",
    });
  });

  it("preserves explicitly empty mailto query fields", () => {
    expect(parseListUnsubscribe("<mailto:leave@example.com?subject=&body=>").mailto).toEqual({
      address: "leave@example.com",
      subject: "",
      textBody: "",
    });
  });

  it("skips malformed targets and invalid mailto recipients in favor of later valid targets", () => {
    const parsed = parseListUnsubscribe(
      "<https://>, <mailto:%ZZ@example.com>, <mailto:bad%0D%0Aaddress@example.com>, <mailto:one@example.com,two@example.com>, <mailto:valid@example.com>, <https://valid.example/u>",
    );
    expect(parsed.https?.host).toBe("valid.example");
    expect(parsed.mailto?.address).toBe("valid@example.com");
  });

  it.each([
    undefined,
    null,
    "",
    "<http://insecure.example/u>",
    "<ftp://files.example/u>",
    "<https://user:password@lists.example/u>",
    "https://unbracketed.example/u",
  ])("has no supported targets for %s", (value) => {
    expect(parseListUnsubscribe(value)).toEqual({
      https: undefined,
      mailto: undefined,
      oneClick: false,
    });
  });

  it.each([
    "List-Unsubscribe=One-Click-Other",
    "OtherList-Unsubscribe=One-Click",
    "List-Unsubscribe=No",
    "",
  ])("does not treat %s as one-click", (post) => {
    expect(parseListUnsubscribe(undefined, post).oneClick).toBe(false);
  });
});

describe("unsubscribe destination policy", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "239.255.255.255",
    "255.255.255.255",
    "100.64.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "240.0.0.1",
    "[::]",
    "[::1]",
    "[fc00::1]",
    "[fdff::1]",
    "[fe80::1]",
    "[febf::1]",
    "[ff02::1]",
    "[::ffff:127.0.0.1]",
    "[2001:db8::1]",
    "[2002:7f00:1::1]",
    "localhost",
    "LOCALHOST.",
    "sub.localhost",
    "host.local",
    "host.internal.",
    "2130706433",
    "0x7f000001",
  ];
  it.each(blocked)("F1 blocks literal/reserved/local target %s before fetch", async (host) => {
    const fetcher = vi.fn<typeof fetch>();
    const resolveDns = vi
      .fn<ResolveDns>()
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      requestUnsubscribe(fetcher, new URL(`https://${host}/?token=secret`), "GET", resolveDns),
    ).rejects.toMatchObject({
      code: "UNSUBSCRIBE_TARGET_BLOCKED",
      message: expect.not.stringContaining("secret"),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "::",
    "ff02::1",
    "192.0.2.1",
  ])("F1 blocks DNS answer %s even mixed with public addresses", async (address) => {
    const fetcher = vi.fn<typeof fetch>();
    const resolveDns = vi.fn<ResolveDns>().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await expect(
      requestUnsubscribe(fetcher, new URL("https://lists.example/u"), "POST", resolveDns),
    ).rejects.toMatchObject({ code: "UNSUBSCRIBE_TARGET_BLOCKED" });
    expect(resolveDns).toHaveBeenCalledExactlyOnceWith("lists.example", { all: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["https://127.0.0.1/u", "https://[::1]/u", "https://router.internal/u", "/same-host"])(
    "F1 revalidates redirect %s before its transport",
    async (location) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      const resolveDns = vi
        .fn<ResolveDns>()
        .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
        .mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
      await expect(
        requestUnsubscribe(fetcher, new URL("https://lists.example/u"), "GET", resolveDns),
      ).rejects.toMatchObject({ code: "UNSUBSCRIBE_TARGET_BLOCKED" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("F1 permits all-public IPv4/IPv6 answers and resolves again on same-host redirects", async () => {
    const resolveDns = vi.fn<ResolveDns>().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/done" } }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    expect(
      await requestUnsubscribe(fetcher, new URL("https://lists.example/u"), "POST", resolveDns),
    ).toEqual({ target: "lists.example", status: 204 });
    expect(resolveDns).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("F1 fails closed on empty or failed DNS without exposing resolver errors", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const resolveDns of [
      async () => [],
      async () => {
        throw new Error("secret query");
      },
    ]) {
      await expect(
        requestUnsubscribe(fetcher, new URL("https://lists.example/u"), "GET", resolveDns),
      ).rejects.toMatchObject({
        code: "UNSUBSCRIBE_TARGET_BLOCKED",
        message: expect.not.stringContaining("secret"),
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

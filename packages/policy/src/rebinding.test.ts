import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { type RequestOptions, request } from "node:https";
import { afterEach, expect, it, vi } from "vitest";
import { type ResolveDns, requestUnsubscribe } from "./unsubscribe.js";

vi.mock("node:https", () => ({ request: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("R6 pins the actual connection lookup to validated DNS addresses despite rebinding", async () => {
  const resolveDns = vi
    .fn<ResolveDns>()
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  const connected: unknown[] = [];
  vi.mocked(request).mockImplementation(((
    _url: URL,
    options: RequestOptions,
    response: (res: IncomingMessage) => void,
  ) => {
    expect(options).toMatchObject({
      servername: "list.example",
      rejectUnauthorized: true,
      agent: false,
    });
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      // Simulate Node's socket asking for all addresses, and then a single IPv4 address.
      options.lookup!("list.example", { all: true }, (error, addresses) => {
        expect(error).toBeNull();
        connected.push(addresses);
      });
      options.lookup!("list.example", { family: 4 }, (error, address, family) => {
        expect(error).toBeNull();
        connected.push({ address, family });
      });
      response({ statusCode: 204, headers: {}, destroy: vi.fn() } as unknown as IncomingMessage);
      return req;
    }) as typeof req.end;
    return req;
  }) as typeof request);
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(
    await requestUnsubscribe(undefined, new URL("https://list.example/u"), "POST", resolveDns),
  ).toEqual({ target: "list.example", status: 204 });
  expect(connected).toEqual([
    [{ address: "93.184.216.34", family: 4 }],
    { address: "93.184.216.34", family: 4 },
  ]);
  expect(resolveDns).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
});

it("R6 validates every pinned redirect hop and blocks a same-host private rebind", async () => {
  vi.mocked(request).mockImplementation(((
    _url: URL,
    _options: RequestOptions,
    response: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      response({
        statusCode: 307,
        headers: { location: "/next" },
        destroy: vi.fn(),
      } as unknown as IncomingMessage);
      return req;
    }) as typeof req.end;
    return req;
  }) as typeof request);
  vi.mocked(request).mockClear();
  const resolveDns = vi
    .fn<ResolveDns>()
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  await expect(
    requestUnsubscribe(undefined, new URL("https://list.example/u"), "GET", resolveDns),
  ).rejects.toMatchObject({ code: "UNSUBSCRIBE_TARGET_BLOCKED" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(resolveDns).toHaveBeenCalledTimes(2);
});

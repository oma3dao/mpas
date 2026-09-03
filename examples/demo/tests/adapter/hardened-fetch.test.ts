import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "undici";
import {
  createDeadline,
  createDispatcher,
  createHardenedFetch,
  HardenedFetchError,
} from "../../src/adapter/hardened-fetch.js";

/** A documentation-prefix address (RFC 3849): never routable, so it stalls or fails. */
const UNROUTABLE_IPV6 = "2001:db8::1";

type LookupCallback = (error: Error | null, addresses: unknown, family?: number) => void;

function lookupReturning(addresses: Array<{ address: string; family: number }>) {
  return (_hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    if (options.all === true) {
      callback(null, addresses);
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  };
}

function connectFailure(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

const dispatchers: Agent[] = [];
const servers: Server[] = [];

function track<T extends Agent>(...agents: T[]): void {
  dispatchers.push(...agents);
}

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function respondOk(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ issuer: "https://oauth.example" }));
}

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe("hardened fetch", () => {
  it("retries on a different transport when the first path cannot connect", async () => {
    const port = await startServer((_request, response) => respondOk(response));
    const primary = createDispatcher({
      lookup: lookupReturning([{ address: UNROUTABLE_IPV6, family: 6 }]),
      autoSelectFamily: false,
      timeout: 300,
    });
    const retry = createDispatcher({ lookup: lookupReturning([{ address: "127.0.0.1", family: 4 }]) });
    track(primary, retry);

    const send = createHardenedFetch({ testOnlyDispatchers: { primary, retry } });

    await expect(send(`http://localhost:${port}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token" }),
    })).resolves.toMatchObject({ status: 200 });
  });

  it("retries when a path completes the handshake and then goes silent", async () => {
    // The failure Happy Eyeballs cannot cover: address selection has already committed
    // by the time the path stops answering, so only a fresh attempt recovers it.
    let stalledFirstRequest = false;
    const port = await startServer((_request, response) => {
      if (!stalledFirstRequest) {
        stalledFirstRequest = true;
        return; // accept the request, never answer it
      }
      respondOk(response);
    });
    const primary = createDispatcher();
    const retry = createDispatcher();
    track(primary, retry);

    const send = createHardenedFetch({
      attemptTimeoutMs: 300,
      testOnlyDispatchers: { primary, retry },
    });

    await expect(send(`http://127.0.0.1:${port}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token" }),
    })).resolves.toMatchObject({ status: 200 });
    expect(stalledFirstRequest).toBe(true);
  });

  it("does not replay a request whose body cannot be re-read", async () => {
    const port = await startServer((_request, response) => respondOk(response));
    const primary = createDispatcher({
      lookup: lookupReturning([{ address: UNROUTABLE_IPV6, family: 6 }]),
      autoSelectFamily: false,
      timeout: 300,
    });
    const retryLookup = vi.fn(lookupReturning([{ address: "127.0.0.1", family: 4 }]));
    const retry = createDispatcher({ lookup: retryLookup });
    track(primary, retry);

    const send = createHardenedFetch({ testOnlyDispatchers: { primary, retry } });

    await expect(send(`http://localhost:${port}/token`, {
      method: "POST",
      body: new ReadableStream(),
      duplex: "half",
    } as RequestInit)).rejects.toBeInstanceOf(HardenedFetchError);
    expect(retryLookup).not.toHaveBeenCalled();
  });

  it("does not retry through a caller-supplied fetch, which would repeat the request verbatim", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(connectFailure("UND_ERR_CONNECT_TIMEOUT"));
    const send = createHardenedFetch({ fetch: fetchFn });

    await expect(send("https://oauth.example/token", {
      method: "POST",
      body: "grant_type=refresh_token",
    })).rejects.toBeInstanceOf(HardenedFetchError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("leaves a caller-cancelled request alone", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const send = createHardenedFetch({ fetch: fetchFn });

    const pending = send("https://oauth.example/metadata", { signal: controller.signal });
    const reason = new Error("caller gave up");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("shares one budget across every request in a sequence", async () => {
    const deadline = createDeadline(250);
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>((_input, init) => new Promise((resolve, reject) => {
      calls += 1;
      if (calls === 1) {
        setTimeout(() => resolve(new Response(null, { status: 200 })), 200);
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    // A per-attempt bound far larger than the budget: the budget has to be what binds.
    const send = createHardenedFetch({ fetch: fetchFn, deadline, attemptTimeoutMs: 10_000 });

    await expect(send("https://oauth.example/discovery")).resolves.toMatchObject({ status: 200 });

    const startedAt = Date.now();
    await expect(send("https://oauth.example/token")).rejects.toBeInstanceOf(HardenedFetchError);
    // The second request inherits what is left of the budget rather than a fresh bound.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("reports the transport diagnosis under the caller's label", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(connectFailure("ENETUNREACH"));
    const send = createHardenedFetch({ fetch: fetchFn, label: "OAuth request" });

    const failure = await send("https://oauth.example/token?code=secret-code").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HardenedFetchError);
    expect((failure as Error).message).toContain("OAuth request");
    expect((failure as Error).message).toContain("oauth.example");
    expect((failure as Error).message).toContain("ENETUNREACH");
    expect((failure as Error).message).not.toContain("secret-code");
    expect((failure as Error).cause).toBeDefined();
  });

  it("passes through failures that are not connect-layer problems", async () => {
    const original = new Error("TLS certificate rejected");
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(original);
    const send = createHardenedFetch({ fetch: fetchFn });

    await expect(send("https://oauth.example/metadata")).rejects.toBe(original);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

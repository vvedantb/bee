import { describe, expect, it, vi } from "vitest";
import { FAVICON_MAX_BYTES, FAVICON_TTL_MS, createFaviconResolver, faviconHost, parseIconLinks, type FaviconEntry, type FaviconStore } from "./favicon";

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const PNG_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
const image = (type = "image/png", body: Uint8Array = PNG) => new Response(Buffer.from(body), { status: 200, headers: { "content-type": type } });
const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const missing = () => new Response("nope", { status: 404 });

/** Routes by URL; anything unlisted is a 404. */
function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string) => (routes[url] ?? missing)());
}

function memoryStore() {
  const entries = new Map<string, FaviconEntry>();
  const store: FaviconStore = {
    read: async (host) => entries.get(host) ?? null,
    write: async (host, entry) => void entries.set(host, entry),
  };
  return { entries, store };
}

describe("faviconHost", () => {
  it("accepts public hosts and refuses loopback, file-like and odd input", () => {
    expect(faviconHost("Example.com")).toBe("example.com");
    for (const bad of ["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1", "file:///etc/passwd", "a/b.com", "nodot", "", "user@x.com"]) expect(faviconHost(bad)).toBeNull();
  });
});

describe("parseIconLinks", () => {
  it("resolves relative hrefs and lists plain icons before apple-touch-icons", () => {
    const page = `<head><link rel="apple-touch-icon" href="/touch.png"><link rel='shortcut icon' href='/s.ico'><link rel="stylesheet" href="/a.css"><link href=/u.png rel=icon></head>`;
    expect(parseIconLinks(page, "https://example.com/dir/")).toEqual(["https://example.com/s.ico", "https://example.com/u.png", "https://example.com/touch.png"]);
  });
});

describe("createFaviconResolver", () => {
  it("returns /favicon.ico as a data URL", async () => {
    const fetch = fakeFetch({ "https://example.com/favicon.ico": () => image() });
    expect(await createFaviconResolver({ fetch })("example.com")).toBe(PNG_URL);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the homepage's icon link, then to the favicon service", async () => {
    const viaPage = fakeFetch({ "https://example.com/": () => html(`<link rel="icon" href="/img/i.png">`), "https://example.com/img/i.png": () => image() });
    expect(await createFaviconResolver({ fetch: viaPage })("example.com")).toBe(PNG_URL);
    expect(viaPage.mock.calls.map((call) => call[0])).toEqual(["https://example.com/favicon.ico", "https://example.com/", "https://example.com/img/i.png"]);

    const viaService = fakeFetch({ "https://www.google.com/s2/favicons?domain=example.com&sz=32": () => image() });
    expect(await createFaviconResolver({ fetch: viaService })("example.com")).toBe(PNG_URL);
  });

  it("returns null when every attempt fails, including fetch errors", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await createFaviconResolver({ fetch })("example.com")).toBeNull();
  });

  it("rejects non-image types, empty bodies and oversized bodies", async () => {
    for (const response of [
      () => image("text/html"),
      () => image("image/png", new Uint8Array()),
      () => image("image/png", new Uint8Array(FAVICON_MAX_BYTES + 1)),
      () => new Response(Buffer.from(PNG), { status: 200, headers: { "content-type": "image/png", "content-length": String(FAVICON_MAX_BYTES + 1) } }),
    ]) {
      const fetch = fakeFetch({ "https://example.com/favicon.ico": response });
      expect(await createFaviconResolver({ fetch })("example.com")).toBeNull();
    }
  });

  it("refuses loopback, file and bad hosts without fetching", async () => {
    const fetch = fakeFetch({});
    const favicon = createFaviconResolver({ fetch });
    for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "file:///etc/passwd"]) expect(await favicon(host)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not follow a redirect to loopback", async () => {
    const fetch = fakeFetch({ "https://example.com/favicon.ico": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x.ico" } }) });
    expect(await createFaviconResolver({ fetch })("example.com")).toBeNull();
    expect(fetch.mock.calls.map((call) => call[0])).not.toContain("http://127.0.0.1/x.ico");
  });

  it("follows a safe redirect", async () => {
    const fetch = fakeFetch({
      "https://example.com/favicon.ico": () => new Response(null, { status: 301, headers: { location: "https://cdn.example.net/f.png" } }),
      "https://cdn.example.net/f.png": () => image(),
    });
    expect(await createFaviconResolver({ fetch })("example.com")).toBe(PNG_URL);
  });

  it("does not refetch on a memory cache hit, or for concurrent calls", async () => {
    const fetch = fakeFetch({ "https://example.com/favicon.ico": () => image() });
    const favicon = createFaviconResolver({ fetch });
    await Promise.all([favicon("example.com"), favicon("EXAMPLE.com")]);
    await favicon("example.com");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("remembers failures for the session", async () => {
    const fetch = fakeFetch({});
    const favicon = createFaviconResolver({ fetch });
    expect(await favicon("example.com")).toBeNull();
    const calls = fetch.mock.calls.length;
    expect(await favicon("example.com")).toBeNull();
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("writes to disk and serves a fresh disk entry without fetching", async () => {
    const { entries, store } = memoryStore();
    const first = fakeFetch({ "https://example.com/favicon.ico": () => image() });
    await createFaviconResolver({ fetch: first, store, now: () => 1000 })("example.com");
    expect(entries.get("example.com")).toEqual({ dataUrl: PNG_URL, savedAt: 1000 });

    const second = fakeFetch({});
    expect(await createFaviconResolver({ fetch: second, store, now: () => 1000 + FAVICON_TTL_MS - 1 })("example.com")).toBe(PNG_URL);
    expect(second).not.toHaveBeenCalled();
  });

  it("fetches again when the disk entry is stale", async () => {
    const { store } = memoryStore();
    await store.write("example.com", { dataUrl: "data:image/png;base64,AAAA", savedAt: 0 });
    const fetch = fakeFetch({ "https://example.com/favicon.ico": () => image() });
    expect(await createFaviconResolver({ fetch, store, now: () => FAVICON_TTL_MS + 1 })("example.com")).toBe(PNG_URL);
  });

  it("works when the store throws", async () => {
    const store: FaviconStore = { read: async () => Promise.reject(new Error("io")), write: async () => Promise.reject(new Error("io")) };
    const fetch = fakeFetch({ "https://example.com/favicon.ico": () => image() });
    expect(await createFaviconResolver({ fetch, store })("example.com")).toBe(PNG_URL);
  });
});

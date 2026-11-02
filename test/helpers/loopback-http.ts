import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";

/** A port that was free a moment ago on 127.0.0.1, so tests never bind Bee's real sign-in port. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export type LoopbackResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** One request on a fresh connection (no keep-alive pool), so a closed server shows up as a refused connection. */
export function send(url: string, method = "GET"): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** True when nothing listens on the URL's port. */
export async function refused(url: string): Promise<boolean> {
  try {
    await send(url);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
  }
}

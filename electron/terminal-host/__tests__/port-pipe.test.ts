/**
 * `manor-host port-pipe` (ADR-229 D3) against a real local echo server, with
 * the process's stdio injected.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import { parsePortPipeArgs, runPortPipe } from "../port-pipe";

function echoServer(host = "127.0.0.1"): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.pipe(socket));
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function io() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c: Buffer) => (out += c.toString("utf-8")));
  stderr.on("data", (c: Buffer) => (err += c.toString("utf-8")));
  return { stdin, stdout, stderr, out: () => out, err: () => err };
}

describe("parsePortPipeArgs", () => {
  it("reads a port and defaults to 127.0.0.1", () => {
    expect(parsePortPipeArgs(["5173"])).toEqual({ port: 5173, host: "127.0.0.1" });
  });

  it("takes the IPv6 loopback", () => {
    expect(parsePortPipeArgs(["8080", "--host", "::1"])).toEqual({ port: 8080, host: "::1" });
    expect(parsePortPipeArgs(["--host", "[::1]", "8080"])).toEqual({ port: 8080, host: "::1" });
  });

  it("refuses anything but loopback", () => {
    expect(() => parsePortPipeArgs(["80", "--host", "10.0.0.1"])).toThrow(/only reaches loopback/);
    expect(() => parsePortPipeArgs(["80", "--host", "localhost"])).toThrow(/only reaches loopback/);
    expect(() => parsePortPipeArgs(["80", "--host"])).toThrow(/only reaches loopback/);
  });

  it("validates the port", () => {
    expect(() => parsePortPipeArgs([])).toThrow(/Usage/);
    for (const bad of ["0", "65536", "-1", "1.5", "80a", "0x50", ""]) {
      expect(() => parsePortPipeArgs([bad])).toThrow(/Invalid port/);
    }
    expect(() => parsePortPipeArgs(["80", "81"])).toThrow(/Unexpected/);
  });
});

describe("runPortPipe", () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("pipes stdio to the port and exits when stdin ends", async () => {
    const { server, port } = await echoServer();
    servers.push(server);
    const stdio = io();
    const done = runPortPipe({ port, host: "127.0.0.1" }, stdio);
    stdio.stdin.write("hello ");
    await new Promise((r) => setTimeout(r, 20));
    stdio.stdin.write("port\n");
    await expect.poll(() => stdio.out()).toBe("hello port\n");
    stdio.stdin.end();
    expect(await done).toBe(0);
  });

  it("exits when the port's side closes", async () => {
    const server = net.createServer((socket) => socket.end("bye\n"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    const stdio = io();
    const done = runPortPipe({ port, host: "127.0.0.1" }, stdio);
    await expect.poll(() => stdio.out()).toBe("bye\n");
    stdio.stdin.end();
    expect(await done).toBe(0);
  });

  it("reaches a server listening only on ::1", async () => {
    let started: { server: net.Server; port: number };
    try {
      started = await echoServer("::1");
    } catch {
      return; // No IPv6 loopback here.
    }
    servers.push(started.server);
    const stdio = io();
    const done = runPortPipe({ port: started.port, host: "::1" }, stdio);
    stdio.stdin.write("six\n");
    await expect.poll(() => stdio.out()).toBe("six\n");
    stdio.stdin.end();
    expect(await done).toBe(0);
  });

  it("rejects without writing to stdout when the connect fails", async () => {
    const { server, port } = await echoServer();
    await new Promise<void>((r) => server.close(() => r()));
    const stdio = io();
    await expect(runPortPipe({ port, host: "127.0.0.1" }, stdio)).rejects.toThrow(/ECONNREFUSED/);
    expect(stdio.out()).toBe("");
  });

  it("still delivers the reply to a client that ends its input first", async () => {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let got = "";
      socket.on("data", (c: Buffer) => (got += c.toString("utf-8")));
      socket.on("end", () => setTimeout(() => socket.end(`reply:${got}`), 20));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    const stdio = io();
    const done = runPortPipe({ port, host: "127.0.0.1" }, stdio);
    stdio.stdin.end("request");
    expect(await done).toBe(0);
    expect(stdio.out()).toBe("reply:request");
  });

  it("still delivers stdin data after the server has ended its side", async () => {
    let received = "";
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", (c: Buffer) => (received += c.toString("utf-8")));
      socket.on("end", () => socket.end());
      socket.end("early\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    const stdio = io();
    const done = runPortPipe({ port, host: "127.0.0.1" }, stdio);
    await expect.poll(() => stdio.out()).toBe("early\n");
    stdio.stdin.write("late");
    await expect.poll(() => received).toBe("late");
    stdio.stdin.end();
    expect(await done).toBe(0);
  });

  it("gives up after the linger when the other direction never ends", async () => {
    const server = net.createServer({ allowHalfOpen: true }, () => {
      // Never replies and never ends.
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    const stdio = io();
    const started = Date.now();
    const done = runPortPipe({ port, host: "127.0.0.1" }, stdio, { lingerMs: 50 });
    stdio.stdin.end();
    expect(await done).toBe(0);
    // It waited out the linger rather than closing the moment stdin ended.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});

import { assertEquals, assertStringIncludes } from "./assert.ts";
import { connect } from "node:net";
import { join } from "node:path";
import {
  cacheDirectory,
  NodePipeListener,
  validateUnixSocketPath,
} from "../platform.ts";

Deno.test("Unix socket path validation counts UTF-8 bytes at platform boundaries", () => {
  for (const [os, maximum] of [["darwin", 103], ["linux", 107]] as const) {
    validateUnixSocketPath("/" + "x".repeat(maximum - 1), os);
    validateUnixSocketPath("/" + "é".repeat((maximum - 1) / 2), os);
    for (
      const path of [
        "/" + "x".repeat(maximum),
        "/" + "é".repeat((maximum + 1) / 2),
        "/" + "😀".repeat(Math.ceil(maximum / 4)),
      ]
    ) {
      let message = "";
      try {
        validateUnixSocketPath(path, os);
      } catch (error) {
        message = String(error);
      }
      assertStringIncludes(message, "Unix socket path is too long");
      assertStringIncludes(
        message,
        `${new TextEncoder().encode(path).byteLength} UTF-8 bytes`,
      );
      assertStringIncludes(message, `maximum ${maximum} on ${os}`);
      assertStringIncludes(message, "--cache-dir or --tcp");
    }
  }
});

Deno.test("empty XDG_CACHE_HOME uses the HOME cache fallback", () => {
  const previous = Deno.env.get("XDG_CACHE_HOME");
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".";
  try {
    Deno.env.set("XDG_CACHE_HOME", "");
    assertEquals(cacheDirectory(), join(home, ".cache", "jdv"));
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_CACHE_HOME");
    else Deno.env.set("XDG_CACHE_HOME", previous);
  }
});

Deno.test("Node pipe adapter accepts and closes one byte-stream connection", async () => {
  const directory = await Deno.makeTempDir({ prefix: "jdv-node-listener-" });
  const path = Deno.build.os === "windows"
    ? `\\\\.\\pipe\\jdv-test-${crypto.randomUUID()}`
    : `${directory}/listener.sock`;
  const listener = new NodePipeListener(path);
  try {
    await listener.ready;
    const incoming = listener[Symbol.asyncIterator]().next();
    const client = connect(path);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const serverSide = await incoming;
    assertEquals(serverSide.done, false);
    const connection = serverSide.value;
    const received = connection.read();
    client.write("ping");
    assertEquals(new TextDecoder().decode(await received), "ping");
    await connection.write(new TextEncoder().encode("pong"));
    assertEquals(
      await new Promise<string>((resolve, reject) => {
        client.once(
          "data",
          (chunk: Uint8Array) => resolve(new TextDecoder().decode(chunk)),
        );
        client.once("error", reject);
      }),
      "pong",
    );
    connection.close();
    client.destroy();
  } finally {
    listener.close();
    await Deno.remove(directory, { recursive: true });
  }
});

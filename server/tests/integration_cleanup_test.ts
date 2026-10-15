import { EventEmitter } from "node:events";
import { bodyDeadline, closeBrowserProcess } from "./bounded_browser.ts";
import {
  capabilitiesFromProbe,
  capabilityLines,
} from "./sequential_capabilities.ts";
import { assertEquals } from "./assert.ts";
import {
  finishIntegrationCleanup,
  finishRFixture,
  fixtureFrames,
  fixturePid,
  listenerClosed,
  pathWithin,
  probeListenerSocket,
  ProcessLines,
  removeCacheDirectory,
  stopRChild,
} from "./integration_cleanup.ts";

Deno.test("cache cleanup retries only transient Windows sharing violations", async () => {
  const sharing = new Error("The process cannot access the file (os error 32)");
  let attempts = 0;
  let waits = 0;
  await removeCacheDirectory("unused", "windows", () => {
    if (++attempts < 3) return Promise.reject(sharing);
    return Promise.resolve();
  }, () => {
    waits++;
    return Promise.resolve();
  });
  assertEquals(attempts, 3);
  assertEquals(waits, 2);
  for (
    const [os, error, expectedAttempts] of [
      ["windows", sharing, 20],
      ["linux", sharing, 1],
      ["windows", new Error("Access denied (os error 5)"), 1],
    ] as const
  ) {
    let calls = 0;
    let thrown: unknown;
    try {
      await removeCacheDirectory("unused", os, () => {
        calls++;
        return Promise.reject(error);
      }, () => Promise.resolve());
    } catch (caught) {
      thrown = caught;
    }
    assertEquals(thrown === error, true);
    assertEquals(calls, expectedAttempts);
  }
});

Deno.test("integration cleanup confirms exit races and retains other termination errors", async () => {
  const status = Promise.resolve({ code: 0, success: true, signal: null });
  for (
    const error of [
      new TypeError("Child process has already terminated"),
      new Deno.errors.NotFound("No such process"),
    ]
  ) {
    await stopRChild({
      status,
      kill() {
        throw error;
      },
    }, false);
  }
  const denied = new Error("Permission denied");
  let caught: unknown;
  try {
    await stopRChild({
      status,
      kill() {
        throw denied;
      },
    }, false);
  } catch (error) {
    caught = error;
  }
  assertEquals(caught === denied, true);
});

Deno.test("cleanup continues after a failure and preserves the original error", async () => {
  const original = new Error("Original assertion failed");
  const cancel = new Error("Reader cancellation failed");
  const visited: string[] = [];
  let caught: unknown;
  try {
    await finishIntegrationCleanup([
      () => {
        visited.push("reader");
        throw cancel;
      },
      () => {
        visited.push("server");
      },
      () => {
        visited.push("cache");
      },
    ], [original]);
  } catch (error) {
    caught = error;
  }
  assertEquals(visited, ["reader", "server", "cache"]);
  assertEquals(caught instanceof AggregateError, true);
  if (caught instanceof AggregateError) {
    assertEquals(caught.errors[0] === original, true);
    assertEquals(caught.errors[1] === cancel, true);
    assertEquals(caught.cause === original, true);
  }
  visited.length = 0;
  caught = undefined;
  try {
    await finishIntegrationCleanup([
      () => stopRChild({ status: new Promise(() => {}), kill() {} }, false, 1),
      () => {
        visited.push("cache");
      },
    ]);
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof AggregateError, true);
  assertEquals(visited, ["cache"]);
});

Deno.test("body deadline waits for success before cleanup and still fails", async () => {
  let release!: () => void;
  const bodyGate = new Promise<void>((resolve) => release = resolve);
  let bodySettled = false;
  let cleanupRanBeforeBody = false;
  let caught: unknown;
  const execution = (async () => {
    try {
      await bodyDeadline("deferred success", async () => {
        await bodyGate;
        bodySettled = true;
      }, 1);
    } catch (error) {
      caught = error;
    } finally {
      cleanupRanBeforeBody = !bodySettled;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(bodySettled, false);
  release();
  await execution;
  assertEquals(cleanupRanBeforeBody, false);
  assertEquals(String(caught).includes("deadline elapsed"), true);
});

Deno.test("body deadline retains timeout and body failure before cleanup", async () => {
  let reject!: (error: Error) => void;
  const bodyGate = new Promise<void>((_resolve, rejectBody) =>
    reject = rejectBody
  );
  const bodyError = new Error("deferred body failure");
  let bodySettled = false;
  let cleanupRanBeforeBody = false;
  let caught: unknown;
  const execution = (async () => {
    try {
      await bodyDeadline("deferred failure", async () => {
        try {
          await bodyGate;
        } finally {
          bodySettled = true;
        }
      }, 1);
    } catch (error) {
      caught = error;
    } finally {
      cleanupRanBeforeBody = !bodySettled;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(bodySettled, false);
  reject(bodyError);
  await execution;
  assertEquals(cleanupRanBeforeBody, false);
  assertEquals(caught instanceof AggregateError, true);
  if (caught instanceof AggregateError) {
    assertEquals(caught.errors.length, 2);
    assertEquals(String(caught.errors[0]).includes("deadline elapsed"), true);
    assertEquals(caught.errors[1] === bodyError, true);
  }
});

Deno.test("R cleanup escalates to SIGKILL and waits for confirmed exit", async () => {
  const signals: Array<Deno.Signal | number | undefined> = [];
  let complete!: (status: Deno.CommandStatus) => void;
  const status = new Promise<Deno.CommandStatus>((resolve) => {
    complete = resolve;
  });
  await stopRChild(
    {
      status,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") {
          complete({
            code: 137,
            success: false,
            signal: "SIGKILL",
          });
        }
      },
    },
    false,
    1,
  );
  assertEquals(signals, ["SIGTERM", "SIGKILL"]);
});

Deno.test("R cleanup fails within a bound when forced termination remains unconfirmed", async () => {
  const signals: Array<Deno.Signal | number | undefined> = [];
  let caught: unknown;
  try {
    await stopRChild(
      {
        status: new Promise(() => {}),
        kill(signal) {
          signals.push(signal);
        },
      },
      false,
      1,
    );
  } catch (error) {
    caught = error;
  }
  assertEquals(signals, ["SIGTERM", "SIGKILL"]);
  assertEquals(caught instanceof AggregateError, true);
  if (caught instanceof AggregateError) {
    assertEquals(caught.errors.length, 2);
    assertEquals(String(caught.errors[1]).includes("after SIGKILL"), true);
  }
});

Deno.test("R cleanup retains an unexpected hard-kill error after confirming exit", async () => {
  const denied = new Error("Unexpected hard-kill failure");
  let complete!: (status: Deno.CommandStatus) => void;
  const status = new Promise<Deno.CommandStatus>((resolve) => {
    complete = resolve;
  });
  let caught: unknown;
  try {
    await stopRChild(
      {
        status,
        kill(signal) {
          if (signal === "SIGKILL") {
            complete({ code: 0, success: true, signal: null });
            throw denied;
          }
        },
      },
      false,
      1,
    );
  } catch (error) {
    caught = error;
  }
  assertEquals(caught === denied, true);
});

Deno.test("fixture lines preserve buffered records and normalize split CRLF", async () => {
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("READY\tv-1\r"));
      controller.enqueue(new TextEncoder().encode("\nCLOSED\r\nlast"));
      controller.close();
    },
  }).getReader();
  const lines = new ProcessLines(reader);
  assertEquals(await lines.read(100), "READY\tv-1");
  assertEquals(await lines.read(100), "CLOSED");
  assertEquals(await lines.read(100), "last");
  assertEquals(await lines.read(100), undefined);
  reader.releaseLock();
  assertEquals(capabilityLines("arrow\r\nnanoarrow\r\npolars\r\n"), [
    "arrow",
    "nanoarrow",
    "polars",
  ]);
  assertEquals(capabilityLines("arrow\nnanoarrow\n"), ["arrow", "nanoarrow"]);
});

Deno.test("Windows fixture paths respect separators, case and directory boundaries", () => {
  assertEquals(
    pathWithin(
      "D:\\a_temp\\jdv-r-library\\jdv",
      "d:/a_temp/jdv-r-library",
      "windows",
    ),
    true,
  );
  assertEquals(
    pathWithin(
      "D:/a_temp/jdv-r-library/jdv/libs/jdv.dll",
      "d:\\a_temp\\jdv-r-library\\JDV\\",
      "windows",
    ),
    true,
  );
  assertEquals(pathWithin("D:/lib-other/jdv", "D:/lib", "windows"), false);
  assertEquals(pathWithin("/tmp/Lib/jdv", "/tmp/lib", "linux"), false);
  for (const invalid of ["0", "1.5", "NaN", String(Deno.pid), "42\r"]) {
    let caught = false;
    try {
      fixturePid(invalid);
    } catch {
      caught = true;
    }
    assertEquals(caught, true);
  }
});

Deno.test("mock JSONL readers accept interruption only after explicit shutdown", async () => {
  for (const requested of [false, true]) {
    for (
      const error of [
        new Deno.errors.Interrupted("canceled"),
        new Deno.errors.BadResource("closed"),
        new Error("real failure"),
      ]
    ) {
      let caught: unknown;
      try {
        for await (
          const _line of fixtureFrames({
            read() {
              return Promise.reject(error);
            },
          }, { requested })
        ) { /* No frames expected. */ }
      } catch (value) {
        caught = value;
      }
      assertEquals(
        caught === undefined,
        requested && !(error.constructor === Error),
      );
      if (caught) assertEquals(caught === error, true);
    }
  }
  let eof: unknown;
  try {
    for await (
      const _line of fixtureFrames({
        read() {
          return Promise.resolve(null);
        },
      }, { requested: false })
    ) { /* No frames expected. */ }
  } catch (error) {
    eof = error;
  }
  assertEquals(String(eof).includes("before explicit shutdown"), true);
});

Deno.test("owned browser cleanup bounds graceful and forced exit without hiding failures", async () => {
  for (const exits of [true, false]) {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: () => boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    let killed = false;
    child.kill = () => {
      killed = true;
      if (exits) {
        child.signalCode = "SIGKILL";
        child.emit("exit");
      }
      return true;
    };
    let caught: unknown;
    try {
      await closeBrowserProcess(() => new Promise(() => {}), child, 1);
    } catch (error) {
      caught = error;
    }
    assertEquals(killed, true);
    assertEquals(caught instanceof AggregateError, true);
    if (caught instanceof AggregateError) {
      assertEquals(caught.errors.length, exits ? 1 : 2);
    }
    child.removeAllListeners();
  }
});

Deno.test("R capability failures report stderr instead of pretending producers are missing", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  assertEquals(
    capabilitiesFromProbe({
      success: true,
      code: 0,
      stdout: bytes("arrow\r\nnanoarrow\r\npolars\r\n"),
      stderr: bytes(""),
    }),
    { arrow: true, nanoarrow: true, polars: true },
  );
  let caught: unknown;
  try {
    capabilitiesFromProbe({
      success: false,
      code: 42,
      stdout: bytes(""),
      stderr: bytes("R startup failed"),
    });
  } catch (error) {
    caught = error;
  }
  assertEquals(String(caught).includes("42"), true);
  assertEquals(String(caught).includes("R startup failed"), true);
});

Deno.test("R graceful cleanup retains marker failures and still drains stderr", async () => {
  const root = await Deno.makeTempDir({ prefix: "jdv-cleanup-marker-" });
  let drained = false;
  let caught: unknown;
  try {
    await finishRFixture(
      {
        pid: 42,
        status: Promise.resolve({ code: 0, success: true, signal: null }),
        kill() {
          throw new Error("An exited child must not be killed.");
        },
      },
      `${root}/absent/done`,
      Promise.resolve("").then((text) => {
        drained = true;
        return text;
      }),
    );
  } catch (error) {
    caught = error;
  } finally {
    await Deno.remove(root);
  }
  assertEquals(drained, true);
  assertEquals(caught instanceof AggregateError, true);
  if (caught instanceof AggregateError) {
    assertEquals(caught.errors[0] instanceof Deno.errors.NotFound, true);
  }
});

Deno.test("browser cleanup uses owned server force shutdown and retains the original failure", async () => {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    throw new Error("Server force shutdown already reaped its child.");
  };
  const original = new Error("Browser close failed");
  let forced = false;
  let caught: unknown;
  try {
    await closeBrowserProcess(() => Promise.reject(original), child, 10, () => {
      forced = true;
      child.signalCode = "SIGKILL";
      child.emit("exit");
      return Promise.resolve();
    });
  } catch (error) {
    caught = error;
  }
  assertEquals(forced, true);
  assertEquals(caught instanceof AggregateError, true);
  if (caught instanceof AggregateError) {
    assertEquals(caught.cause === original, true);
    assertEquals(caught.errors, [original]);
  }
});

Deno.test("listener refusal survives delayed close without connection timer overwriting it", async () => {
  const socket = new EventEmitter() as EventEmitter & { destroy(): void };
  socket.destroy = () => {
    setTimeout(() => socket.emit("close"), 10);
  };
  const probing = probeListenerSocket(socket, "fake:refused", 2, 50);
  socket.emit(
    "error",
    Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
  );
  assertEquals(await probing, true);
});

Deno.test("listener probes distinguish active, unexpected error, and unclosed socket", async () => {
  for (const active of [true, false]) {
    const socket = new EventEmitter() as EventEmitter & { destroy(): void };
    socket.destroy = () => {
      queueMicrotask(() => socket.emit("close"));
    };
    const unexpected = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const probing = probeListenerSocket(socket, "fake:outcome", 20, 20);
    let caught: unknown;
    if (active) {
      socket.emit("connect");
      assertEquals(await probing, false);
    } else {
      socket.emit("error", unexpected);
      try {
        await probing;
      } catch (error) {
        caught = error;
      }
      assertEquals(caught === unexpected, true);
    }
  }
  const socket = new EventEmitter() as EventEmitter & { destroy(): void };
  socket.destroy = () => {};
  const probing = probeListenerSocket(socket, "fake:unclosed", 2, 2);
  socket.emit(
    "error",
    Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
  );
  let caught: unknown;
  try {
    await probing;
  } catch (error) {
    caught = error;
  }
  assertEquals(String(caught).includes("socket did not close"), true);
  socket.removeAllListeners();
});

Deno.test("listener connect timeout retains its phase and closes the probe socket", async () => {
  const socket = new EventEmitter() as EventEmitter & { destroy(): void };
  let destroyed = false;
  socket.destroy = () => {
    destroyed = true;
    queueMicrotask(() => socket.emit("close"));
  };
  let caught: unknown;
  try {
    await probeListenerSocket(socket, "fake:pending", 2, 20);
  } catch (error) {
    caught = error;
  }
  assertEquals(destroyed, true);
  assertEquals(String(caught).includes("during connect"), true);
  assertEquals(String(caught).includes("events="), true);
});

Deno.test("listener probe confirms a real TCP listener is active then refused after close", async () => {
  const server = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = server.addr as Deno.NetAddr;
  const url = `tcp://127.0.0.1:${address.port}`;
  try {
    assertEquals(await listenerClosed(url), false);
  } finally {
    server.close();
  }
  assertEquals(await listenerClosed(url), true);
});

Deno.test("listener probes preserve late refusal and live results through separately bounded close", async () => {
  for (const active of [false, true]) {
    const socket = new EventEmitter() as EventEmitter & { destroy(): void };
    socket.destroy = () => {
      setTimeout(() => socket.emit("close"), 10);
    };
    const probing = probeListenerSocket(socket, "fake:late-outcome", 15, 15);
    setTimeout(() => {
      if (active) socket.emit("connect");
      else {socket.emit(
          "error",
          Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
        );}
    }, 10);
    assertEquals(await probing, !active);
  }
});

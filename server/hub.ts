import { type JsonObject, type RPeer, startRPeer } from "./r_listener.ts";
import type { ByteConnection } from "./platform.ts";

export const MAX_LIVE_REQUESTS = 32;
const MAX_OUTBOUND_FRAMES = 512;
const MAX_QUEUED_CANCELS = 32;
const MAX_QUEUED_ORDINARY = MAX_OUTBOUND_FRAMES - MAX_QUEUED_CANCELS;
const WAKE_INTERVAL_MS = 50;
const BUSY_AFTER_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const FRAMES_PER_SECOND = 128;
const FRAMES_PER_BATCH = 16;
const WIRE_MAX_FRAMES = 128;
const WIRE_MAX_BYTES = 512 * 1024;
const CANCEL_RESERVE_FRAMES = 32;
const CANCEL_RESERVE_BYTES = 16 * 1024;
const ORDINARY_MAX_FRAMES = WIRE_MAX_FRAMES - CANCEL_RESERVE_FRAMES;
const ORDINARY_MAX_BYTES = WIRE_MAX_BYTES - CANCEL_RESERVE_BYTES;
const encoder = new TextEncoder();

export interface BrowserClient {
  send(value: JsonObject): void;
  close(): void;
}

interface TableRecord {
  generation: number;
  descriptor: JsonObject;
}

interface PendingRequest {
  id: string;
  client: BrowserClient | null;
  browserId: string;
  method: string;
  table: string;
  generation: number;
  deadline: number;
  state: "queued" | "live" | "cancelled" | "expired";
  counted: boolean;
  localEnded: boolean;
  sequence: number | undefined;
  credited: boolean;
  requestFrame: OutboundFrame | null;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  busyTimer: ReturnType<typeof setTimeout> | undefined;
  cancelSent: boolean;
}

interface OutboundFrame {
  value: JsonObject;
  kind: "request" | "control" | "notification";
  pending?: PendingRequest;
  bytes: number;
}

interface WireCredit {
  kind: "ordinary" | "cancel";
  bytes: number;
  pendingId?: string;
}

interface RSession {
  id: string;
  hello: JsonObject;
  peer: RPeer;
  tables: Map<string, TableRecord>;
  pending: Map<string, PendingRequest>;
  outbound: OutboundFrame[];
  frameTimes: number[];
  liveCount: number;
  unackedRequests: number;
  unackedSequences: Set<number>;
  nextSequence: number;
  credits: Map<number, WireCredit>;
  ordinaryFrames: number;
  cancelFrames: number;
  ordinaryBytes: number;
  cancelBytes: number;
  creditPaused: boolean;
  wakeTimer: ReturnType<typeof setInterval> | undefined;
  wakeQueued: boolean;
  drainTimer: ReturnType<typeof setTimeout> | undefined;
  draining: boolean;
  closed: boolean;
}

export class Hub {
  readonly #clients = new Set<BrowserClient>();
  readonly #sessions = new Map<string, RSession>();
  readonly #peers = new Set<RPeer>();

  acceptR(connection: ByteConnection): void {
    let session: RSession | null = null;
    let rejectedHandshake = false;
    const peer = startRPeer(
      connection,
      (message) => {
        if (!session) {
          if (rejectedHandshake) return;
          session = this.#acceptHello(peer, message);
          if (!session) rejectedHandshake = true;
          return;
        }
        this.#handleRMessage(session, message);
      },
      (reason) => {
        this.#peers.delete(peer);
        if (session) this.#dropSession(session, reason);
      },
    );
    this.#peers.add(peer);
  }

  attach(client: BrowserClient): void {
    this.#clients.add(client);
    client.send({
      type: "welcome",
      protocol: 1,
      sessions: [...this.#sessions.values()].map((session) => ({
        hello: session.hello,
        tables: [...session.tables.values()].map((table) => table.descriptor),
      })),
    });
  }

  detach(client: BrowserClient): void {
    this.#clients.delete(client);
    for (const session of this.#sessions.values()) {
      for (const pending of session.pending.values()) {
        if (pending.client === client) {
          this.#cancelPending(session, pending, "client_closed");
        }
      }
    }
  }

  handleBrowser(client: BrowserClient, value: JsonObject): void {
    if (!this.#clients.has(client)) return;
    if (value.type === "cancel") {
      this.#cancelFromBrowser(client, value);
      return;
    }
    if (value.type !== "request") {
      client.send({
        type: "error",
        code: "invalid_request",
        message: "Unknown browser message type.",
      });
      return;
    }
    const browserId = value.id;
    const sessionId = value.session;
    const method = value.method;
    const params = value.params;
    if (
      typeof browserId !== "string" || browserId.length < 1 ||
      browserId.length > 128
    ) {
      client.send({
        type: "error",
        code: "invalid_request",
        message:
          "Request id must be a non-empty string of at most 128 characters.",
      });
      return;
    }
    if (
      typeof sessionId !== "string" || typeof method !== "string" ||
      !isObject(params)
    ) {
      client.send({
        type: "error",
        id: browserId,
        code: "invalid_request",
        message: "Request requires session, method, and params.",
      });
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      client.send({
        type: "error",
        id: browserId,
        code: "session_not_found",
        message: "R session is no longer connected.",
      });
      return;
    }
    if (
      [...session.pending.values()].some((pending) =>
        pending.client === client && pending.browserId === browserId
      )
    ) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "invalid_request",
        message: "A request with this client id is already active.",
      });
      return;
    }
    if (!["table/rows", "table/schema", "table/close"].includes(method)) {
      client.send({
        type: "error",
        id: browserId,
        code: "method_not_found",
        message: "Unsupported request method.",
      });
      return;
    }
    const table = params.table;
    const generation = params.generation;
    if (typeof table !== "string" || !Number.isSafeInteger(generation)) {
      client.send({
        type: "error",
        id: browserId,
        code: "invalid_request",
        message: "A table and safe integer generation are required.",
      });
      return;
    }
    const current = session.tables.get(table);
    if (!current || current.generation !== generation) {
      client.send({
        type: "error",
        id: browserId,
        code: "stale_generation",
        message: "The table is no longer current.",
      });
      return;
    }

    const timeout = Number.isFinite(value.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Number(value.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    const id = `jdv-${crypto.randomUUID()}`;
    const pending: PendingRequest = {
      id,
      client,
      browserId,
      method,
      table,
      generation: Number(generation),
      deadline: Date.now() + timeout,
      state: "queued",
      counted: false,
      localEnded: false,
      sequence: undefined,
      credited: false,
      requestFrame: null,
      timeoutTimer: undefined,
      busyTimer: undefined,
      cancelSent: false,
    };
    pending.requestFrame = {
      kind: "request",
      pending,
      bytes: 0,
      value: {
        id,
        method,
        params,
        encoding: "json",
        compression: "none",
        deadline: pending.deadline / 1000,
      },
    };
    pending.requestFrame.bytes =
      encoder.encode(`${JSON.stringify(pending.requestFrame.value)}\n`)
        .byteLength;
    if (pending.requestFrame.bytes > ORDINARY_MAX_BYTES) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "limit_exceeded",
        message: "The request exceeds the local transport frame budget.",
      });
      return;
    }
    session.pending.set(id, pending);
    this.#coalesceQueuedPage(session, pending);
    if (!this.#enqueue(session, pending.requestFrame)) {
      this.#finishPending(session, pending);
      client.send({
        type: "error",
        id: browserId,
        code: "busy",
        message: "The local request queue is full.",
      });
      return;
    }
    pending.timeoutTimer = setTimeout(
      () => this.#expire(session, pending),
      timeout,
    );
    this.#scheduleDrain(session);
  }

  close(): void {
    for (const peer of this.#peers) peer.close();
    this.#peers.clear();
    for (const session of [...this.#sessions.values()]) {
      this.#dropSession(session, "server_shutdown");
    }
    for (const client of this.#clients) client.close();
    this.#clients.clear();
  }

  #acceptHello(peer: RPeer, message: JsonObject): RSession | null {
    const params = message.params;
    if (
      message.method !== "hello" || !isObject(params) ||
      params.protocol !== 1 ||
      typeof params.session !== "string" ||
      !/^r-[0-9]+-[0-9]+$/.test(params.session)
    ) {
      void peer.send({
        id: null,
        error: {
          code: "unsupported",
          message: "Protocol version 1 hello is required.",
        },
        warnings: [],
      }).catch(() => undefined).finally(() => peer.close());
      return null;
    }
    const id = params.session;
    const previous = this.#sessions.get(id);
    if (previous) this.#dropSession(previous, "session_replaced");
    const session: RSession = {
      id,
      hello: message,
      peer,
      tables: new Map(),
      pending: new Map(),
      outbound: [],
      frameTimes: [],
      liveCount: 0,
      unackedRequests: 0,
      unackedSequences: new Set(),
      nextSequence: 0,
      credits: new Map(),
      ordinaryFrames: 0,
      cancelFrames: 0,
      ordinaryBytes: 0,
      cancelBytes: 0,
      creditPaused: false,
      wakeTimer: undefined,
      wakeQueued: false,
      drainTimer: undefined,
      draining: false,
      closed: false,
    };
    this.#sessions.set(id, session);
    this.#broadcast({ type: "session/open", session: id, hello: message });
    return session;
  }

  #handleRMessage(session: RSession, message: JsonObject): void {
    if (session.closed) return;
    if (typeof message.method === "string") {
      this.#handleNotification(session, message);
      return;
    }
    if (typeof message.id !== "string") return;
    const pending = session.pending.get(message.id);
    if (!pending) return;
    const dispatched = provesDispatch(message);
    if (dispatched && pending.sequence !== undefined) {
      this.#acknowledgeThrough(session, pending.sequence);
    }
    const table = session.tables.get(pending.table);
    const deliver = !pending.localEnded && pending.state === "live" && table &&
      table.generation === pending.generation && Date.now() < pending.deadline;
    const closedCurrentTable = pending.method === "table/close" &&
      table?.generation === pending.generation &&
      isObject(message.result) && message.result.closed === true &&
      message.result.table === pending.table &&
      message.result.generation === pending.generation;
    if (deliver) {
      pending.client?.send({
        type: "response",
        session: session.id,
        ...message,
        id: pending.browserId,
      });
    }
    this.#finishPending(session, pending);
    if (closedCurrentTable) {
      this.#cancelTableGeneration(session, pending.table, pending.generation);
      session.tables.delete(pending.table);
      this.#broadcast({
        type: "table/closed",
        session: session.id,
        message: {
          method: "table/closed",
          params: { table: pending.table, generation: pending.generation },
        },
      });
    }
    this.#scheduleDrain(session);
  }

  #handleNotification(session: RSession, message: JsonObject): void {
    const params = message.params;
    if (
      message.method === "table/open" && isObject(params) &&
      typeof params.table === "string" &&
      Number.isSafeInteger(params.generation)
    ) {
      const tableId = params.table;
      const generation = Number(params.generation);
      const previous = session.tables.get(tableId);
      if (previous && generation <= previous.generation) return;
      if (previous) {
        this.#cancelTableGeneration(session, tableId, previous.generation);
      }
      const table: TableRecord = { generation, descriptor: message };
      session.tables.set(tableId, table);
      this.#broadcast({ type: "table/open", session: session.id, message });
      return;
    }
    if (
      message.method === "table/closed" && isObject(params) &&
      typeof params.table === "string" &&
      Number.isSafeInteger(params.generation)
    ) {
      const table = session.tables.get(params.table);
      if (table && table.generation === params.generation) {
        this.#cancelTableGeneration(session, params.table, table.generation);
        session.tables.delete(params.table);
        this.#broadcast({ type: "table/closed", session: session.id, message });
      }
      return;
    }
    this.#broadcast({ type: "notification", session: session.id, message });
  }

  #cancelFromBrowser(client: BrowserClient, value: JsonObject): void {
    const session = typeof value.session === "string"
      ? this.#sessions.get(value.session)
      : undefined;
    if (!session || typeof value.id !== "string") return;
    for (const pending of session.pending.values()) {
      if (pending.client === client && pending.browserId === value.id) {
        this.#cancelPending(session, pending, "browser_cancel");
      }
    }
  }

  #cancelTableGeneration(
    session: RSession,
    table: string,
    generation: number,
  ): void {
    for (const pending of session.pending.values()) {
      if (pending.table === table && pending.generation === generation) {
        pending.client?.send({
          type: "error",
          id: pending.browserId,
          session: session.id,
          code: "stale_generation",
          message: "The table generation changed.",
        });
        this.#cancelPending(session, pending, "stale_generation");
      }
    }
  }

  #cancelPending(
    session: RSession,
    pending: PendingRequest,
    reason: string,
  ): void {
    if (pending.localEnded || pending.state === "cancelled") return;
    const wasSent = pending.state === "live";
    pending.state = "cancelled";
    if (!wasSent && pending.requestFrame) {
      const index = session.outbound.indexOf(pending.requestFrame);
      if (index >= 0) session.outbound.splice(index, 1);
    } else if (wasSent) {
      this.#sendCancel(session, pending);
    }
    if (reason !== "stale_generation" && reason !== "client_closed") {
      pending.client?.send({
        type: "cancelled",
        id: pending.browserId,
        session: session.id,
      });
    }
    if (!wasSent) this.#finishPending(session, pending);
    else {
      pending.localEnded = true;
      clearTimeout(pending.timeoutTimer);
      clearTimeout(pending.busyTimer);
      this.#releasePendingCount(session, pending);
      pending.client = null;
      pending.browserId = "";
      pending.requestFrame = null;
    }
    this.#scheduleDrain(session);
  }

  #sendCancel(session: RSession, pending: PendingRequest): void {
    if (pending.cancelSent || session.closed) return;
    const queued = this.#enqueue(session, {
      kind: "control",
      value: { method: "cancel", params: { id: pending.id } },
      bytes: 0,
    });
    pending.cancelSent = queued;
  }

  #expire(session: RSession, pending: PendingRequest): void {
    if (pending.state === "cancelled") {
      pending.state = "expired";
      clearTimeout(pending.timeoutTimer);
      clearTimeout(pending.busyTimer);
      this.#releasePendingCount(session, pending);
      return;
    }
    const wasSent = pending.state === "live";
    if (wasSent) this.#sendCancel(session, pending);
    if (!pending.localEnded) {
      pending.client?.send({
        type: "error",
        id: pending.browserId,
        session: session.id,
        code: "timeout",
        message: "R did not complete this request before its deadline.",
      });
    }
    if (wasSent) {
      pending.state = "expired";
      pending.localEnded = true;
      clearTimeout(pending.timeoutTimer);
      clearTimeout(pending.busyTimer);
      this.#releasePendingCount(session, pending);
      pending.client = null;
      pending.browserId = "";
      pending.requestFrame = null;
    } else {
      if (pending.requestFrame) {
        const index = session.outbound.indexOf(pending.requestFrame);
        if (index >= 0) session.outbound.splice(index, 1);
      }
      pending.state = "expired";
      this.#finishPending(session, pending);
    }
    this.#scheduleDrain(session);
  }

  #finishPending(session: RSession, pending: PendingRequest): void {
    if (!session.pending.has(pending.id)) return;
    clearTimeout(pending.timeoutTimer);
    clearTimeout(pending.busyTimer);
    pending.localEnded = true;
    this.#releasePendingCount(session, pending);
    session.pending.delete(pending.id);
    if (
      ![...session.pending.values()].some((item) =>
        item.state === "live" && !item.localEnded
      )
    ) this.#stopWake(session);
  }

  #releasePendingCount(session: RSession, pending: PendingRequest): void {
    if (pending.counted) {
      session.liveCount = Math.max(0, session.liveCount - 1);
      pending.counted = false;
    }
  }

  #coalesceQueuedPage(session: RSession, pending: PendingRequest): void {
    if (pending.method !== "table/rows") return;
    for (const old of [...session.pending.values()]) {
      if (
        old !== pending && old.state === "queued" &&
        old.method === "table/rows" &&
        old.client === pending.client && old.table === pending.table &&
        old.generation === pending.generation
      ) {
        old.state = "cancelled";
        old.localEnded = true;
        old.client?.send({
          type: "cancelled",
          id: old.browserId,
          session: session.id,
          reason: "superseded",
        });
        this.#finishPending(session, old);
      }
    }
    session.outbound = session.outbound.filter((frame) =>
      !frame.pending || frame.pending.state === "queued"
    );
  }

  #enqueue(session: RSession, frame: OutboundFrame): boolean {
    if (session.outbound.length >= MAX_OUTBOUND_FRAMES) return false;
    const cancel = frame.value.method === "cancel";
    const queued = session.outbound.reduce(
      (count, item) => count + Number(item.value.method === "cancel"),
      0,
    );
    if (
      cancel
        ? queued >= MAX_QUEUED_CANCELS
        : session.outbound.length - queued >= MAX_QUEUED_ORDINARY
    ) return false;
    frame.bytes ||=
      encoder.encode(`${JSON.stringify(frame.value)}\n`).byteLength;
    session.outbound.push(frame);
    return true;
  }

  #scheduleDrain(session: RSession): void {
    if (
      session.closed || session.draining || session.drainTimer !== undefined
    ) return;
    session.drainTimer = setTimeout(() => {
      session.drainTimer = undefined;
      void this.#drain(session);
    }, 0);
  }

  async #drain(session: RSession): Promise<void> {
    if (session.closed || session.draining) return;
    session.draining = true;
    let sent = 0;
    try {
      while (!session.closed && sent < FRAMES_PER_BATCH) {
        const now = performance.now();
        session.frameTimes = session.frameTimes.filter((time) =>
          now - time < 1_000
        );
        if (session.frameTimes.length >= FRAMES_PER_SECOND) {
          const delay = Math.max(1, 1_000 - (now - session.frameTimes[0]));
          session.drainTimer = setTimeout(() => {
            session.drainTimer = undefined;
            void this.#drain(session);
          }, delay);
          break;
        }
        session.outbound = session.outbound.filter((frame) =>
          !frame.pending || frame.pending.state === "queued"
        );
        const index = session.outbound.findIndex((frame) =>
          this.#frameEligible(session, frame)
        );
        if (index < 0) break;
        const frame = session.outbound[index];
        const kind = frame.value.method === "cancel" ? "cancel" : "ordinary";
        session.outbound.splice(index, 1);
        if (frame.value.method === "wake") session.wakeQueued = false;
        if (frame.pending && Date.now() >= frame.pending.deadline) {
          this.#expire(session, frame.pending);
          continue;
        }
        const sequence = ++session.nextSequence;
        this.#chargeWireCredit(
          session,
          sequence,
          kind,
          frame.bytes,
          frame.pending?.id,
        );
        if (frame.pending) {
          frame.pending.state = "live";
          frame.pending.counted = true;
          frame.pending.sequence = sequence;
          frame.pending.credited = false;
          session.liveCount++;
          session.unackedRequests++;
          session.unackedSequences.add(sequence);
        }
        try {
          await session.peer.send(frame.value);
        } catch (error) {
          this.#dropSession(session, error);
          break;
        }
        this.#queueDeferredCancels(session);
        session.frameTimes.push(performance.now());
        sent++;
        if (
          frame.pending && frame.pending.state === "live" &&
          !frame.pending.localEnded
        ) {
          frame.pending.busyTimer = setTimeout(() => {
            if (frame.pending?.state === "live" && !frame.pending.localEnded) {
              frame.pending.client?.send({
                type: "busy",
                id: frame.pending.browserId,
              });
            }
          }, BUSY_AFTER_MS);
          this.#startWake(session);
        }
      }
    } finally {
      session.draining = false;
      if (
        session.outbound.some((frame) => this.#blockedOnCredit(session, frame))
      ) {
        this.#pauseForCredit(session);
      }
      if (
        session.outbound.some((frame) => this.#frameEligible(session, frame))
      ) this.#scheduleDrain(session);
    }
  }

  #startWake(session: RSession): void {
    if (session.wakeTimer !== undefined) return;
    session.wakeTimer = setInterval(() => {
      if (
        session.closed ||
        ![...session.pending.values()].some((pending) =>
          pending.state === "live" && !pending.localEnded
        )
      ) {
        this.#stopWake(session);
        return;
      }
      if (
        !session.wakeQueued && session.outbound.length < MAX_OUTBOUND_FRAMES &&
        this.#hasWireCredit(session, "ordinary", 128)
      ) {
        session.wakeQueued = this.#enqueue(session, {
          kind: "control",
          value: { method: "wake" },
          bytes: 0,
        });
        this.#scheduleDrain(session);
      } else if (!session.wakeQueued && !session.creditPaused) {
        this.#pauseForCredit(session);
      }
    }, WAKE_INTERVAL_MS);
  }

  #stopWake(session: RSession): void {
    if (session.wakeTimer !== undefined) clearInterval(session.wakeTimer);
    session.wakeTimer = undefined;
    session.wakeQueued = false;
    session.outbound = session.outbound.filter((frame) =>
      frame.value.method !== "wake"
    );
  }

  #dropSession(session: RSession, reason: unknown): void {
    if (session.closed) return;
    session.closed = true;
    session.peer.close();
    this.#stopWake(session);
    clearTimeout(session.drainTimer);
    for (const pending of [...session.pending.values()]) {
      pending.client?.send({
        type: "error",
        id: pending.browserId,
        session: session.id,
        code: "disconnected",
        message: "The R connection closed.",
      });
      this.#finishPending(session, pending);
    }
    this.#sessions.delete(session.id);
    this.#broadcast({
      type: "session/closed",
      session: session.id,
      reason: String(reason ?? "eof"),
    });
  }

  #broadcast(value: JsonObject): void {
    for (const client of [...this.#clients]) {
      try {
        client.send(value);
      } catch {
        this.detach(client);
      }
    }
  }

  #hasWireCredit(
    session: RSession,
    kind: "ordinary" | "cancel",
    bytes: number,
  ): boolean {
    const usedFrames = session.credits.size;
    const usedBytes = session.ordinaryBytes + session.cancelBytes;
    if (usedFrames >= WIRE_MAX_FRAMES || usedBytes + bytes > WIRE_MAX_BYTES) {
      return false;
    }
    if (kind === "cancel") {
      return session.cancelFrames < CANCEL_RESERVE_FRAMES &&
        session.cancelBytes + bytes <= CANCEL_RESERVE_BYTES;
    }
    return session.ordinaryFrames < ORDINARY_MAX_FRAMES &&
      session.ordinaryBytes + bytes <= ORDINARY_MAX_BYTES;
  }

  #chargeWireCredit(
    session: RSession,
    sequence: number,
    kind: "ordinary" | "cancel",
    bytes: number,
    pendingId?: string,
  ): void {
    session.credits.set(sequence, { kind, bytes, pendingId });
    if (kind === "cancel") {
      session.cancelBytes += bytes;
      session.cancelFrames++;
    } else {
      session.ordinaryBytes += bytes;
      session.ordinaryFrames++;
    }
  }

  #acknowledgeThrough(session: RSession, sequence: number): void {
    for (const [frameSequence, credit] of session.credits) {
      if (frameSequence > sequence) continue;
      session.credits.delete(frameSequence);
      if (credit.kind === "cancel") {
        session.cancelBytes -= credit.bytes;
        session.cancelFrames--;
      } else {
        session.ordinaryBytes -= credit.bytes;
        session.ordinaryFrames--;
      }
    }
    for (const frameSequence of session.unackedSequences) {
      if (frameSequence <= sequence) {
        session.unackedSequences.delete(frameSequence);
        session.unackedRequests = Math.max(0, session.unackedRequests - 1);
      }
    }
    for (const pending of [...session.pending.values()]) {
      if (
        pending.localEnded && pending.sequence !== undefined &&
        pending.sequence <= sequence
      ) {
        this.#finishPending(session, pending);
      }
    }
    session.creditPaused = false;
    this.#scheduleDrain(session);
  }

  #frameEligible(session: RSession, frame: OutboundFrame): boolean {
    if (frame.pending && frame.pending.state !== "queued") return false;
    const pending = frame.pending;
    if (pending) {
      if (
        session.liveCount >= MAX_LIVE_REQUESTS ||
        session.unackedRequests >= MAX_LIVE_REQUESTS
      ) return false;
      if (
        pending.method === "table/rows" &&
        [...session.pending.values()].some((other) =>
          other !== pending && other.client === pending.client &&
          other.method === "table/rows" &&
          other.table === pending.table &&
          other.generation === pending.generation &&
          other.state === "live" && !other.localEnded
        )
      ) return false;
    }
    const kind = frame.value.method === "cancel" ? "cancel" : "ordinary";
    return this.#hasWireCredit(session, kind, frame.bytes);
  }

  #blockedOnCredit(session: RSession, frame: OutboundFrame): boolean {
    if (frame.pending && frame.pending.state !== "queued") return false;
    const pending = frame.pending;
    if (
      pending?.method === "table/rows" &&
      [...session.pending.values()].some((other) =>
        other !== pending && other.client === pending.client &&
        other.method === "table/rows" && other.table === pending.table &&
        other.generation === pending.generation && other.state === "live" &&
        !other.localEnded
      )
    ) return false;
    if (pending && session.liveCount >= MAX_LIVE_REQUESTS) return false;
    if (pending && session.unackedRequests >= MAX_LIVE_REQUESTS) return true;
    const kind = frame.value.method === "cancel" ? "cancel" : "ordinary";
    return !this.#hasWireCredit(session, kind, frame.bytes);
  }

  #pauseForCredit(session: RSession): void {
    if (session.creditPaused) return;
    session.creditPaused = true;
    this.#broadcast({
      type: "busy",
      session: session.id,
      reason: "wire_credit",
    });
  }

  #queueDeferredCancels(session: RSession): void {
    for (const pending of session.pending.values()) {
      if (
        pending.localEnded && !pending.cancelSent &&
        pending.sequence !== undefined
      ) {
        this.#sendCancel(session, pending);
      }
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function provesDispatch(message: JsonObject): boolean {
  if (Object.hasOwn(message, "result")) return true;
  if (!isObject(message.error) || typeof message.error.code !== "string") {
    return false;
  }
  return [
    "r_error",
    "interrupted",
    "method_not_found",
    "table_not_found",
    "stale_generation",
    "schema_changed",
  ].includes(message.error.code);
}

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
const MAX_RETAINED_REQUEST_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

interface RLimits {
  receiveFrames: number;
  receiveBytes: number;
  queueMessages: number;
  queueBytes: number;
  maxRequestBytes: number;
}

export interface BrowserClient {
  send(value: JsonObject): void;
  close(): void;
}

interface ViewRecord {
  generation: number;
  descriptor: JsonObject;
  parentView?: string;
}

interface PendingRequest {
  id: string;
  client: BrowserClient | null;
  browserId: string;
  method: string;
  view: string;
  generation: number;
  deadline: number;
  state: "queued" | "live" | "cancelled" | "expired";
  localEnded: boolean;
  sequence: number | undefined;
  requestBytes: number;
  queuedBytesAccounted: boolean;
  sentBytesAccounted: boolean;
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
  limits: RLimits;
  peer: RPeer;
  views: Map<string, ViewRecord>;
  pending: Map<string, PendingRequest>;
  outbound: OutboundFrame[];
  frameTimes: number[];
  liveCount: number;
  unackedRequests: number;
  unackedSequences: Set<number>;
  nextSequence: number;
  acknowledgedSequence: number;
  credits: Map<number, WireCredit>;
  ordinaryFrames: number;
  cancelFrames: number;
  ordinaryBytes: number;
  cancelBytes: number;
  queuedRequestBytes: number;
  sentRequestBytes: number;
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
        views: [...session.views.values()].map((view) => view.descriptor),
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
    if (
      ![
        "table/rows",
        "view/schema",
        "view/close",
        "object/children",
        "object/open",
      ].includes(method)
    ) {
      client.send({
        type: "error",
        id: browserId,
        code: "method_not_found",
        message: "Unsupported request method.",
      });
      return;
    }
    const view = params.view;
    const generation = params.generation;
    if (typeof view !== "string" || !Number.isSafeInteger(generation)) {
      client.send({
        type: "error",
        id: browserId,
        code: "invalid_request",
        message: "A view and safe integer generation are required.",
      });
      return;
    }
    const current = session.views.get(view);
    if (!current) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "view_not_found",
        message: "The view is no longer available.",
      });
      return;
    }
    if (current.generation !== generation) {
      client.send({
        type: "error",
        id: browserId,
        code: "stale_generation",
        message: "The view is no longer current.",
      });
      return;
    }
    if (
      (method === "object/children" || method === "object/open") &&
      !isTreeRequest(current.descriptor, method, params)
    ) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "invalid_request",
        message: "The request is not valid for this tree view.",
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
      view,
      generation: Number(generation),
      deadline: Date.now() + timeout,
      state: "queued",
      localEnded: false,
      sequence: undefined,
      requestBytes: 0,
      queuedBytesAccounted: false,
      sentBytesAccounted: false,
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
    const requestByteLimit = Math.min(
      MAX_RETAINED_REQUEST_BYTES,
      session.limits.queueBytes,
    );
    if (
      pending.requestFrame.bytes - 1 > session.limits.maxRequestBytes ||
      pending.requestFrame.bytes - 1 > requestByteLimit ||
      pending.requestFrame.bytes > this.#ordinaryByteLimit(session)
    ) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "limit_exceeded",
        message: "The request exceeds the negotiated transport frame budget.",
      });
      return;
    }
    pending.requestBytes = pending.requestFrame.bytes - 1;
    pending.queuedBytesAccounted = true;
    session.queuedRequestBytes += pending.requestBytes;
    session.pending.set(id, pending);
    this.#coalesceQueuedQuery(session, pending);
    if (
      [...session.pending.values()].filter((item) => item.queuedBytesAccounted)
          .length > MAX_QUEUED_ORDINARY ||
      session.queuedRequestBytes > MAX_RETAINED_REQUEST_BYTES
    ) {
      this.#finishPending(session, pending);
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "limit_exceeded",
        message: "The negotiated R request queue is full.",
      });
      return;
    }
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
    const limits = isObject(params) && isObject(params.limits)
      ? parseLimits(params.limits)
      : null;
    if (
      message.method !== "hello" || !isObject(params) ||
      params.protocol !== 1 ||
      typeof params.session !== "string" ||
      !/^r-[0-9]+-[0-9]+$/.test(params.session) || !limits
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
      limits,
      peer,
      views: new Map(),
      pending: new Map(),
      outbound: [],
      frameTimes: [],
      liveCount: 0,
      unackedRequests: 0,
      unackedSequences: new Set(),
      nextSequence: 0,
      acknowledgedSequence: 0,
      credits: new Map(),
      ordinaryFrames: 0,
      cancelFrames: 0,
      ordinaryBytes: 0,
      cancelBytes: 0,
      queuedRequestBytes: 0,
      sentRequestBytes: 0,
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
      if (message.method === "ack") {
        this.#acknowledgeFrames(session, message.params);
        return;
      }
      this.#handleNotification(session, message);
      return;
    }
    if (typeof message.id !== "string") return;
    const pending = session.pending.get(message.id);
    if (
      !pending || pending.sequence === undefined || !isTerminalResponse(message)
    ) {
      return;
    }
    this.#releaseRequestSlot(session, pending);
    const view = session.views.get(pending.view);
    const currentGeneration = view?.generation === pending.generation;
    const deliver = !pending.localEnded && pending.state === "live" &&
      currentGeneration && Date.now() < pending.deadline;
    if (
      pending.method === "object/open" && isObject(message.result) &&
      currentGeneration
    ) this.#registerChildView(session, pending.view, message.result);
    const closedCurrentView = pending.method === "view/close" &&
      currentGeneration &&
      isObject(message.result) && message.result.closed === true &&
      message.result.view === pending.view &&
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
    if (closedCurrentView) {
      this.#closeCachedView(session, pending.view, pending.generation);
    }
    this.#scheduleDrain(session);
  }

  #registerChildView(
    session: RSession,
    parentView: string,
    descriptor: JsonObject,
  ): void {
    const parent = session.views.get(parentView);
    if (
      !parent || !isObject(descriptor) ||
      (descriptor.kind !== "grid" && descriptor.kind !== "tree") ||
      descriptor.view === parentView
    ) return;
    if (descriptor.parent !== undefined && descriptor.parent !== parentView) {
      return;
    }
    const notification: JsonObject = {
      method: "view/open",
      params: descriptor,
    };
    this.#registerView(session, notification, parentView);
  }

  #registerView(
    session: RSession,
    message: JsonObject,
    parentView?: string,
  ): void {
    const params = message.params;
    if (
      !isObject(params) || typeof params.view !== "string" ||
      !Number.isSafeInteger(params.generation)
    ) return;
    const viewId = params.view;
    const generation = Number(params.generation);
    if (parentView === undefined && params.parent !== undefined) {
      if (typeof params.parent !== "string") return;
      parentView = params.parent;
    }
    if (
      parentView !== undefined &&
      !this.#hasValidParent(session, viewId, parentView)
    ) return;
    const previous = session.views.get(viewId);
    if (previous && generation <= previous.generation) return;
    if (previous) {
      this.#closeDescendants(session, viewId);
      this.#cancelViewGeneration(session, viewId, previous.generation);
    }
    session.views.set(viewId, {
      generation,
      descriptor: message,
      parentView,
    });
    this.#broadcast({ type: "view/open", session: session.id, message });
  }

  #closeCachedView(
    session: RSession,
    viewId: string,
    generation: number,
    message?: JsonObject,
  ): void {
    const view = session.views.get(viewId);
    if (!view || view.generation !== generation) return;
    this.#closeDescendants(session, viewId);
    this.#cancelViewGeneration(session, viewId, generation);
    session.views.delete(viewId);
    this.#broadcast({
      type: "view/closed",
      session: session.id,
      message: message ?? {
        method: "view/closed",
        params: { view: viewId, generation },
      },
    });
  }

  #closeDescendants(session: RSession, parentView: string): void {
    this.#closeDescendantsVisited(session, parentView, new Set([parentView]));
  }

  #closeDescendantsVisited(
    session: RSession,
    parentView: string,
    visited: Set<string>,
  ): void {
    const descendants = [...session.views.entries()].filter(([, view]) =>
      view.parentView === parentView
    );
    for (const [viewId, view] of descendants) {
      if (visited.has(viewId)) continue;
      visited.add(viewId);
      this.#closeDescendantsVisited(session, viewId, visited);
      this.#cancelViewGeneration(session, viewId, view.generation);
      session.views.delete(viewId);
      this.#broadcast({
        type: "view/closed",
        session: session.id,
        message: {
          method: "view/closed",
          params: {
            view: viewId,
            generation: view.generation,
            reason: "parent_closed",
          },
        },
      });
    }
  }

  #hasValidParent(
    session: RSession,
    viewId: string,
    parentView: string,
  ): boolean {
    const seen = new Set<string>();
    let current: string | undefined = parentView;
    while (current !== undefined) {
      if (current === viewId || seen.has(current)) return false;
      seen.add(current);
      const parent = session.views.get(current);
      if (!parent) return false;
      current = parent.parentView;
    }
    return true;
  }

  #handleNotification(session: RSession, message: JsonObject): void {
    const params = message.params;
    if (
      message.method === "view/open" && isObject(params) &&
      typeof params.view === "string" &&
      Number.isSafeInteger(params.generation)
    ) {
      this.#registerView(session, message);
      return;
    }
    if (
      message.method === "view/closed" && isObject(params) &&
      typeof params.view === "string" &&
      Number.isSafeInteger(params.generation)
    ) {
      this.#closeCachedView(
        session,
        params.view,
        Number(params.generation),
        message,
      );
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

  #cancelViewGeneration(
    session: RSession,
    view: string,
    generation: number,
  ): void {
    for (const pending of session.pending.values()) {
      if (pending.view === view && pending.generation === generation) {
        pending.client?.send({
          type: "error",
          id: pending.browserId,
          session: session.id,
          code: "stale_generation",
          message: "The view generation changed.",
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
    this.#releaseRequestBudget(session, pending);
    session.pending.delete(pending.id);
    if (
      ![...session.pending.values()].some((item) =>
        item.state === "live" && !item.localEnded
      )
    ) this.#stopWake(session);
  }

  #releaseRequestBudget(session: RSession, pending: PendingRequest): void {
    if (pending.queuedBytesAccounted) {
      session.queuedRequestBytes = Math.max(
        0,
        session.queuedRequestBytes - pending.requestBytes,
      );
      pending.queuedBytesAccounted = false;
    }
    if (pending.sentBytesAccounted) {
      session.sentRequestBytes = Math.max(
        0,
        session.sentRequestBytes - pending.requestBytes,
      );
      pending.sentBytesAccounted = false;
      if (pending.sequence !== undefined) {
        session.unackedSequences.delete(pending.sequence);
      }
      session.unackedRequests = Math.max(0, session.unackedRequests - 1);
      session.liveCount = Math.max(0, session.liveCount - 1);
    }
  }

  #coalesceQueuedQuery(session: RSession, pending: PendingRequest): void {
    if (!isCoalescibleMethod(pending.method)) return;
    for (const old of [...session.pending.values()]) {
      if (
        old !== pending && old.state === "queued" &&
        this.#sameQueryLane(old, pending)
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

  #sameQueryLane(left: PendingRequest, right: PendingRequest): boolean {
    if (
      left.client !== right.client || left.method !== right.method ||
      left.view !== right.view || left.generation !== right.generation
    ) return false;
    if (left.method === "table/rows") return true;
    if (left.method !== "object/children") return false;
    const leftParams = left.requestFrame?.value.params;
    const rightParams = right.requestFrame?.value.params;
    return isObject(leftParams) && isObject(rightParams) &&
      JSON.stringify(leftParams.path) === JSON.stringify(rightParams.path);
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
          if (frame.pending.queuedBytesAccounted) {
            session.queuedRequestBytes = Math.max(
              0,
              session.queuedRequestBytes - frame.pending.requestBytes,
            );
            frame.pending.queuedBytesAccounted = false;
          }
          frame.pending.state = "live";
          frame.pending.sequence = sequence;
          frame.pending.sentBytesAccounted = true;
          session.sentRequestBytes += frame.pending.requestBytes;
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
    const maxFrames = Math.min(WIRE_MAX_FRAMES, session.limits.receiveFrames);
    const maxBytes = Math.min(WIRE_MAX_BYTES, session.limits.receiveBytes);
    if (usedFrames >= maxFrames || usedBytes + bytes > maxBytes) {
      return false;
    }
    const reservedFrames = this.#cancelFrameReserve(session);
    const reservedBytes = this.#cancelByteReserve(session);
    if (kind === "cancel") {
      if (reservedFrames === 0 || reservedBytes === 0) {
        return session.ordinaryFrames < this.#ordinaryFrameLimit(session) &&
          session.ordinaryBytes + bytes <= this.#ordinaryByteLimit(session);
      }
      return session.cancelFrames < reservedFrames &&
        session.cancelBytes + bytes <= reservedBytes;
    }
    return session.ordinaryFrames < this.#ordinaryFrameLimit(session) &&
      session.ordinaryBytes + bytes <= this.#ordinaryByteLimit(session);
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

  #acknowledgeFrames(session: RSession, params: unknown): void {
    if (!isObject(params) || !Number.isSafeInteger(params.frames)) return;
    const sequence = Number(params.frames);
    if (
      sequence < 0 || sequence > session.nextSequence ||
      sequence <= session.acknowledgedSequence
    ) return;
    session.acknowledgedSequence = sequence;
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
    session.creditPaused = false;
    this.#scheduleDrain(session);
  }

  #releaseRequestSlot(session: RSession, pending: PendingRequest): void {
    this.#releaseRequestBudget(session, pending);
  }

  #frameEligible(session: RSession, frame: OutboundFrame): boolean {
    if (frame.pending && frame.pending.state !== "queued") return false;
    const pending = frame.pending;
    if (pending) {
      if (
        session.liveCount >= this.#liveRequestLimit(session) ||
        session.unackedRequests >= this.#liveRequestLimit(session)
      ) return false;
      if (
        session.sentRequestBytes + pending.requestBytes >
          Math.min(MAX_RETAINED_REQUEST_BYTES, session.limits.queueBytes)
      ) return false;
      if (
        isCoalescibleMethod(pending.method) &&
        [...session.pending.values()].some((other) =>
          other !== pending && other.client === pending.client &&
          this.#sameQueryLane(other, pending) &&
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
      pending && isCoalescibleMethod(pending.method) &&
      [...session.pending.values()].some((other) =>
        other !== pending && other.client === pending.client &&
        this.#sameQueryLane(other, pending) && other.state === "live" &&
        !other.localEnded
      )
    ) return false;
    if (pending && session.liveCount >= this.#liveRequestLimit(session)) {
      return false;
    }
    if (pending && session.unackedRequests >= this.#liveRequestLimit(session)) {
      return true;
    }
    if (
      pending && session.sentRequestBytes + pending.requestBytes >
        Math.min(MAX_RETAINED_REQUEST_BYTES, session.limits.queueBytes)
    ) return false;
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

  #liveRequestLimit(session: RSession): number {
    return Math.min(MAX_LIVE_REQUESTS, session.limits.queueMessages);
  }

  #ordinaryFrameLimit(session: RSession): number {
    const total = Math.min(WIRE_MAX_FRAMES, session.limits.receiveFrames);
    return total - this.#cancelFrameReserve(session);
  }

  #ordinaryByteLimit(session: RSession): number {
    const total = Math.min(WIRE_MAX_BYTES, session.limits.receiveBytes);
    return total - this.#cancelByteReserve(session);
  }

  #cancelFrameReserve(session: RSession): number {
    const total = Math.min(WIRE_MAX_FRAMES, session.limits.receiveFrames);
    const messages = this.#liveRequestLimit(session);
    return Math.min(CANCEL_RESERVE_FRAMES, messages, total - 1);
  }

  #cancelByteReserve(session: RSession): number {
    const total = Math.min(WIRE_MAX_BYTES, session.limits.receiveBytes);
    return Math.min(CANCEL_RESERVE_BYTES, total - 1);
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCoalescibleMethod(method: string): boolean {
  return method === "table/rows" || method === "object/children";
}

function isTreeRequest(
  descriptor: JsonObject,
  method: string,
  params: JsonObject,
): boolean {
  const viewParams = descriptor.params;
  const path = params.path;
  if (
    !isObject(viewParams) || viewParams.kind !== "tree" ||
    !isObject(viewParams.capabilities) ||
    viewParams.capabilities.children !== true || !isTypedPath(path)
  ) return false;
  if (method === "object/open") {
    return Array.isArray(path) && path.length > 0;
  }
  const offset = params.offset == null ? 0 : params.offset;
  const limit = params.limit == null ? 200 : params.limit;
  return Number.isSafeInteger(offset) && Number(offset) >= 0 &&
    Number.isSafeInteger(limit) && Number(limit) >= 1 &&
    Number(limit) <= 500;
}

function isTypedPath(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 32) return false;
  return value.every((step) => {
    if (!isObject(step)) return false;
    if (step.type === "index") {
      return Number.isSafeInteger(step.index) && Number(step.index) >= 1;
    }
    if (
      step.type !== "binding" && step.type !== "slot" &&
      step.type !== "attr"
    ) return false;
    return typeof step.name === "string" &&
      Array.from(step.name).length <= 1_000;
  });
}

function parseLimits(value: JsonObject): RLimits | null {
  const fields = [
    "max_receive_frames",
    "max_receive_bytes",
    "queue_messages",
    "queue_bytes",
    "max_request_bytes",
  ] as const;
  if (
    fields.some((field) =>
      !Number.isSafeInteger(value[field]) || Number(value[field]) < 1
    )
  ) return null;
  return {
    receiveFrames: Number(value.max_receive_frames),
    receiveBytes: Number(value.max_receive_bytes),
    queueMessages: Number(value.queue_messages),
    queueBytes: Number(value.queue_bytes),
    maxRequestBytes: Number(value.max_request_bytes),
  };
}

function isTerminalResponse(message: JsonObject): boolean {
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (hasResult === hasError) return false;
  if (hasResult) return true;
  return isObject(message.error) && typeof message.error.code === "string";
}

const status = document.querySelector("#status");
const sessions = document.querySelector("#sessions");
const tables = document.querySelector("#tables");
const knownSessions = new Map();
const knownTables = new Map();

const scheme = location.protocol === "https:" ? "wss:" : "ws:";
const socketUrl = new URL(`${scheme}//${location.host}/ws`);
const token = new URL(location.href).searchParams.get("token");
if (token) socketUrl.searchParams.set("token", token);
const socket = new WebSocket(socketUrl);

socket.addEventListener("open", () => {
  status.textContent = "Connected. Open a table in R with jdv::jdv_view(x).";
});
socket.addEventListener("close", () => {
  status.textContent = "Disconnected from the local viewer.";
});
socket.addEventListener("error", () => {
  status.textContent = "The local viewer connection failed.";
});
socket.addEventListener("message", (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    status.textContent = "The local viewer sent an invalid message.";
    return;
  }
  if (message.type === "welcome") {
    for (const entry of message.sessions ?? []) {
      addSession(entry.hello?.params?.session, entry.hello);
      for (const table of entry.tables ?? []) {
        addTable(entry.hello?.params?.session, table);
      }
    }
  } else if (message.type === "session/open") {
    addSession(message.session, message.hello);
  } else if (message.type === "session/closed") {
    knownSessions.delete(message.session);
    for (const key of knownTables.keys()) {
      if (key.startsWith(`${message.session}\0`)) knownTables.delete(key);
    }
    render();
  } else if (message.type === "table/open") {
    addTable(message.session, message.message);
  } else if (message.type === "table/closed") {
    const descriptor = message.message?.params;
    if (descriptor) {
      knownTables.delete(`${message.session}\0${descriptor.table}`);
    }
    render();
  } else if (message.type === "busy") {
    status.textContent = "R is busy; the request is still waiting.";
  }
});

function addSession(id, hello) {
  if (typeof id !== "string") return;
  knownSessions.set(id, hello?.params ?? {});
  render();
}

function addTable(session, message) {
  const descriptor = message?.params;
  if (typeof session !== "string" || typeof descriptor?.table !== "string") {
    return;
  }
  knownTables.set(`${session}\0${descriptor.table}`, { session, descriptor });
  render();
}

function render() {
  sessions.replaceChildren();
  for (const [id, info] of knownSessions) {
    const item = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = `R session ${id}`;
    const detail = document.createElement("p");
    detail.className = "muted";
    detail.textContent = `R ${info.r_version ?? "unknown"} · jdv ${
      info.jdv_version ?? "unknown"
    }`;
    item.append(heading, detail);
    sessions.append(item);
  }
  tables.replaceChildren();
  for (const { session, descriptor } of knownTables.values()) {
    const params = descriptor;
    const item = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = params.title ?? "Untitled table";
    const detail = document.createElement("p");
    detail.className = "muted";
    detail.textContent = `${params.nrow ?? 0} rows · ${
      params.ncol ?? 0
    } columns · ${params.mode ?? "unknown"} · ${session}`;
    item.append(heading, detail);
    tables.append(item);
  }
}

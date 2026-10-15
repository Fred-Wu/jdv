import { decodeRows, querySnapshot } from "/assets/jdv_query.js";
import {
  columnWindow,
  createBrowserTransport,
  fillRemotePage,
} from "/assets/client.js";

const $ = (selector) => document.querySelector(selector);
const status = $("#status");
const sessionsElement = $("#sessions");
const tablesElement = $("#tables");
const viewer = $("#viewer");
const treeViewer = $("#tree-viewer");
const titleElement = $("#table-title");
const metaElement = $("#table-meta");
const sortList = $("#sort-list");
const sortFieldset = sortList.closest("fieldset");
const sortColumn = $("#sort-column");
const sortDirection = $("#sort-direction");
const filterColumn = $("#filter-column");
const filterOperator = $("#filter-op");
const filterValue = $("#filter-value");
const filterUpper = $("#filter-upper");
const filterHelp = $("#filter-help");
const filterFieldset = filterHelp.closest("fieldset");
const viewport = $("#column-viewport");
const spacer = $("#column-spacer");
const windowElement = $("#column-window");
const paginationElement = $("#table-pagination");
const warningsElement = $("#warnings");
const treeTitleElement = $("#tree-title");
const treeMetaElement = $("#tree-meta");
const treeBreadcrumb = $("#tree-breadcrumb");
const treeChildList = $("#tree-child-list");
const treePageLabel = $("#tree-page-label");
const treePrevious = $("#tree-previous");
const treeNext = $("#tree-next");
const treeReturn = $("#tree-return");
const treeParentReturn = $("#tree-parent-return");
const viewBreadcrumb = $("#view-breadcrumb");
const childOpenStatus = $("#child-open-status");
const PAGE_SIZE = 200;
const TREE_PAGE_SIZE = 200;
const COLUMN_WIDTH = 180;
const ROW_WIDTH = 86;
const knownSessions = new Map();
const knownTables = new Map();
let selected = null;
let nextWindowFrame = 0;
let nextWindowTimer;
let pendingColumnQuery = false;

const scheme = location.protocol === "https:" ? "wss:" : "ws:";
const socketUrl = new URL(`${scheme}//${location.host}/ws`);
const token = new URL(location.href).searchParams.get("token");
if (token) socketUrl.searchParams.set("token", token);
const socket = new WebSocket(socketUrl);
const transport = createBrowserTransport(socket, {
  onBusy(id, session, reason) {
    if (
      (id && selected?.activeRequestIds.has(id)) ||
      (reason === "wire_credit" && session === selected?.session &&
        selected.activeRequestIds.size > 0)
    ) {
      setStatus("R is busy. The request is still waiting.", "busy");
    }
  },
});

socket.addEventListener("open", () => {
  setStatus("Connected. Open a table in R with jdv::jdv_view(x).", "connected");
});
socket.addEventListener("close", () => {
  transport.close();
  cancelColumnWindowUpdate();
  if (selected) selected.epoch++;
  setStatus("Disconnected from the local viewer.", "error");
  viewer.hidden = true;
});
socket.addEventListener("error", () => {
  setStatus("The local viewer connection failed.", "error");
});
socket.addEventListener("message", (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    setStatus("The local viewer sent an invalid message.", "error");
    return;
  }
  transport.handleMessage(message);
  if (message.type === "welcome") {
    for (const entry of message.sessions ?? []) {
      addSession(entry.hello?.params?.session, entry.hello);
      for (const view of entry.views ?? []) {
        addTable(entry.hello?.params?.session, view);
      }
    }
  } else if (message.type === "session/open") {
    addSession(message.session, message.hello);
  } else if (message.type === "session/closed") {
    knownSessions.delete(message.session);
    for (const [key, entry] of knownTables) {
      if (entry.session === message.session) knownTables.delete(key);
    }
    transport.cancelSession(message.session);
    if (selected?.session === message.session) closeSelectedTable();
    renderLists();
  } else if (message.type === "view/open") {
    addTable(message.session, message.message);
  } else if (message.type === "view/closed") {
    const descriptor = message.message?.params;
    if (descriptor) {
      const key = `${message.session}\0${descriptor.view}`;
      const current = knownTables.get(key);
      if (current?.descriptor.generation === descriptor.generation) {
        knownTables.delete(key);
      }
      transport.cancelTable(
        message.session,
        descriptor.view,
        descriptor.generation,
      );
      if (
        selected?.session === message.session &&
        selected.descriptor.view === descriptor.view &&
        selected.descriptor.generation === descriptor.generation
      ) closeSelectedTable();
      if (
        selected?.returnTree?.session === message.session &&
        selected.returnTree.descriptor.view === descriptor.view &&
        selected.returnTree.descriptor.generation === descriptor.generation
      ) {
        selected.returnTree = null;
        treeReturn.hidden = true;
      }
    }
    renderLists();
  } else if (message.type === "notification") {
    const method = message.message?.method;
    if (method) setStatus(`R notification: ${method}`, "info");
  }
});

$("#sort-add").addEventListener("click", addSortTerm);
$("#filter-apply").addEventListener("click", applyFilter);
$("#filter-clear").addEventListener("click", clearFilter);
filterOperator.addEventListener("change", updateFilterInputs);
filterColumn.addEventListener("change", updateFilterOperators);
viewport.addEventListener("scroll", scheduleColumnWindow);
treePrevious.addEventListener("click", () => {
  if (selected?.kind === "tree") {
    loadTreeChildren(selected, Math.max(0, selected.offset - TREE_PAGE_SIZE));
  }
});
treeNext.addEventListener("click", () => {
  if (selected?.kind === "tree") {
    loadTreeChildren(
      selected,
      Math.min(
        Math.max(0, selected.totalChildren - 1),
        selected.offset + TREE_PAGE_SIZE,
      ),
    );
  }
});
treeReturn.addEventListener("click", returnToTree);
treeParentReturn.addEventListener("click", returnToTree);
globalThis.addEventListener("resize", updateColumnScrollExtent);
new ResizeObserver(scheduleColumnWindow).observe(viewport);

function setStatus(message, state = "info") {
  status.textContent = message;
  status.dataset.state = state;
}

function addSession(id, hello) {
  if (typeof id !== "string") return;
  knownSessions.set(id, hello?.params ?? {});
  renderLists();
}

function addTable(session, message) {
  const descriptor = message?.params;
  if (
    typeof session !== "string" || typeof descriptor?.view !== "string" ||
    !Number.isSafeInteger(descriptor.generation)
  ) return;
  const key = `${session}\0${descriptor.view}`;
  const previous = knownTables.get(key);
  if (
    previous && descriptor.generation <= previous.descriptor.generation
  ) return;
  const replaceSelected = selected?.session === session &&
    selected.descriptor.view === descriptor.view &&
    selected.descriptor.generation < descriptor.generation;
  if (replaceSelected) closeSelectedTable();
  knownTables.set(key, { session, descriptor });
  renderLists();
  if (replaceSelected) openView(session, descriptor);
}

function viewSupport(descriptor) {
  const capabilities = descriptor?.capabilities;
  const capabilityNames = [
    "seek",
    "sort",
    "filter",
    "known_total",
    "next",
    "children",
  ];
  if (
    descriptor?.encoding !== "r-json" ||
    capabilities === null || typeof capabilities !== "object" ||
    !capabilityNames.every((name) => typeof capabilities[name] === "boolean")
  ) return false;
  if (descriptor.kind === "tree") {
    return descriptor.access === "random" &&
      capabilities.seek === true && capabilities.sort === false &&
      capabilities.filter === false && capabilities.known_total === true &&
      capabilities.next === false && capabilities.children === true;
  }
  return descriptor.kind === "grid" &&
    (descriptor.access === "snapshot" || descriptor.access === "random") &&
    descriptor.mode ===
      (descriptor.access === "snapshot" ? "snapshot" : "paged") &&
    Array.isArray(descriptor.columns);
}

function countLabel(value, noun) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return `Unknown ${noun}s`;
  }
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function queryCountLabel(total, totalUnfiltered) {
  const count = Number.isSafeInteger(total) && total >= 0 ? total : "Unknown";
  const unfiltered = Number.isSafeInteger(totalUnfiltered) &&
      totalUnfiltered >= 0
    ? totalUnfiltered
    : "Unknown";
  return `${count} of ${unfiltered} rows`;
}

function setTableMeta(state, total, totalUnfiltered) {
  metaElement.textContent = `${queryCountLabel(total, totalUnfiltered)} · ${
    countLabel(state.descriptor.ncol, "column")
  } · ${state.descriptor.mode} · ${state.session}`;
}

function renderLists() {
  sessionsElement.replaceChildren();
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
    sessionsElement.append(item);
  }

  tablesElement.replaceChildren();
  for (const { session, descriptor } of knownTables.values()) {
    const item = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = descriptor.title ??
      (descriptor.kind === "tree" ? "Untitled object" : "Untitled table");
    const detail = document.createElement("p");
    detail.className = "muted";
    detail.textContent = descriptor.kind === "tree"
      ? `Object tree · ${
        descriptor.class?.join(", ") ?? "unknown class"
      } · ${session}`
      : `${countLabel(descriptor.nrow, "row")} · ${
        countLabel(descriptor.ncol, "column")
      } · ${descriptor.mode ?? "unknown"} · ${session}`;
    const button = document.createElement("button");
    button.type = "button";
    const support = viewSupport(descriptor);
    button.textContent = support
      ? descriptor.kind === "tree" ? "Open object" : "Open view"
      : "Unsupported view";
    button.disabled = !support;
    if (support) {
      button.addEventListener("click", () => openView(session, descriptor));
    }
    item.append(heading, detail, button);
    if (typeof descriptor.parent === "string") {
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close view";
      close.dataset.action = "close-view";
      close.addEventListener("click", () => {
        close.disabled = true;
        const promise = transport.request(session, "view/close", {
          view: descriptor.view,
          generation: descriptor.generation,
        });
        promise.catch((error) => {
          close.disabled = false;
          setStatus(error?.message ?? "Could not close the view.", "error");
        });
      });
      item.append(close);
    }
    tablesElement.append(item);
  }
}

function openView(session, descriptor, returnTree = null, restored = null) {
  if (!viewSupport(descriptor)) {
    setStatus("This view format is not supported by this viewer.", "error");
    return;
  }
  if (descriptor.kind === "tree") {
    openTree(session, descriptor, returnTree);
    return;
  }
  closeSelectedTable();
  const columns = Array.isArray(descriptor.columns) ? descriptor.columns : [];
  selected = restored ?? {
    kind: "grid",
    session,
    descriptor,
    columns,
    sort: [],
    filter: null,
    epoch: 0,
    page: 1,
    activeRequestIds: new Set(),
    queryRequestIds: new Set(),
    returnTree,
    table: null,
    window: { start: 0, end: 0, columns: [], offsetPx: 0, totalWidth: 0 },
  };
  selected.childOpening = false;
  renderViewBreadcrumbs();
  viewer.hidden = false;
  treeViewer.hidden = true;
  treeParentReturn.hidden = true;
  treeReturn.hidden = returnTree === null;
  titleElement.textContent = descriptor.title ?? "Untitled table";
  metaElement.textContent = `${countLabel(descriptor.nrow, "row")} · ${
    countLabel(descriptor.ncol, "column")
  } · ${descriptor.mode} · ${session}`;
  warningsElement.replaceChildren();
  paginationElement.replaceChildren();
  populateColumnChoices();
  spacer.style.width = `${
    columnScrollExtent(ROW_WIDTH + columns.length * COLUMN_WIDTH)
  }px`;
  viewport.scrollLeft = restored?.scrollLeft ?? 0;
  const windowState = calculateColumnWindow();
  selected.window = windowState;
  spacer.style.width = `${columnScrollExtent(windowState.totalWidth)}px`;
  windowElement.style.transform = `translateX(${windowState.offsetPx}px)`;
  updateRowColumnCompensation();
  windowElement.style.width = `${
    ROW_WIDTH + windowState.columns.length * COLUMN_WIDTH
  }px`;
  const initialColumns = buildTableColumns(windowState.columns);
  selected.table = new globalThis.Tabulator(windowElement, {
    height: "460px",
    layout: "fitData",
    columnDefaults: {
      width: COLUMN_WIDTH,
      minWidth: COLUMN_WIDTH,
      maxWidth: COLUMN_WIDTH,
      resizable: false,
    },
    columns: initialColumns,
    index: "row_index",
    placeholder: "No rows match this query.",
    pagination: descriptor.capabilities.seek === true &&
      descriptor.capabilities.known_total === true,
    paginationMode: "remote",
    paginationSize: PAGE_SIZE,
    paginationInitialPage: selected.page,
    paginationButtonCount: 5,
    paginationCounter: "rows",
    paginationElement,
    sortMode: "remote",
    filterMode: "remote",
    ajaxURL: "/query",
    ajaxRequestFunc: (_url, _config, params) => requestRows(params),
  });
  setStatus("Loading table…", "loading");
  updateFilterOperators();
  renderSortTerms();
  if (restored?.form) restoreQueryForm(restored.form);
}

function closeSelectedTable() {
  if (!selected) return;
  if (selected.kind === "grid") {
    selected.scrollLeft = viewport.scrollLeft;
    selected.form = captureQueryForm();
  }
  cancelColumnWindowUpdate();
  selected.epoch++;
  transport.cancelTable(
    selected.session,
    selected.descriptor.view,
    selected.descriptor.generation,
    "The selected table was closed.",
  );
  selected.table?.destroy();
  paginationElement.replaceChildren();
  selected = null;
  viewer.hidden = true;
  treeViewer.hidden = true;
  treeReturn.hidden = true;
  treeParentReturn.hidden = true;
  viewBreadcrumb.replaceChildren();
  childOpenStatus.hidden = true;
}

function openTree(session, descriptor, returnTree = null) {
  closeSelectedTable();
  selected = {
    kind: "tree",
    session,
    descriptor,
    path: [],
    breadcrumbs: [{ path: [], label: descriptor.title ?? "Object" }],
    offset: 0,
    totalChildren: 0,
    activeRequestIds: new Set(),
    queryRequestIds: new Set(),
    epoch: 0,
    children: [],
    returnTree,
  };
  renderViewBreadcrumbs();
  viewer.hidden = true;
  treeViewer.hidden = false;
  treeParentReturn.hidden = returnTree === null;
  treeTitleElement.textContent = descriptor.title ?? "Untitled object";
  treeMetaElement.textContent =
    (descriptor.class?.join(", ") ?? "unknown class") +
    " · " + session;
  treeChildList.replaceChildren();
  renderTreeBreadcrumbs(selected);
  loadTreeChildren(selected, 0);
}

function cancelQueryRequests(state) {
  for (const id of state.queryRequestIds) {
    transport.cancel(id, "A newer page or object path replaced this request.");
    state.activeRequestIds.delete(id);
  }
  state.queryRequestIds.clear();
}

function loadTreeChildren(state, offset) {
  if (selected !== state || state.kind !== "tree") return;
  state.epoch++;
  const epoch = state.epoch;
  cancelQueryRequests(state);
  state.offset = Math.max(0, offset);
  setStatus("Loading object children…", "loading");
  treePrevious.disabled = state.offset === 0;
  treeNext.disabled = true;
  const promise = transport.request(
    state.session,
    "object/children",
    {
      view: state.descriptor.view,
      generation: state.descriptor.generation,
      path: state.path,
      offset: state.offset,
      limit: TREE_PAGE_SIZE,
    },
    60_000,
  );
  const id = promise.id;
  if (id) {
    state.activeRequestIds.add(id);
    state.queryRequestIds.add(id);
  }
  promise.then((response) => {
    if (selected !== state || state.epoch !== epoch) return;
    const result = response?.result;
    if (
      !result || result.view !== state.descriptor.view ||
      result.generation !== state.descriptor.generation ||
      !Array.isArray(result.path) ||
      JSON.stringify(result.path) !== JSON.stringify(state.path) ||
      result.offset !== state.offset || !Array.isArray(result.children) ||
      !Number.isSafeInteger(result.total_children) ||
      result.total_children < 0 || result.children.length > TREE_PAGE_SIZE
    ) throw new Error("R returned an invalid object children page.");
    state.totalChildren = result.total_children;
    state.children = result.children;
    renderTreePage(state);
    setStatus("Connected.", "connected");
  }).catch((error) => {
    if (selected !== state || state.epoch !== epoch) return;
    if (error?.name === "AbortError") return;
    treeChildList.replaceChildren();
    treeMetaElement.textContent = error?.code
      ? error.code + ": " + error.message
      : error?.message ?? String(error);
    setStatus("The object request failed.", "error");
  }).finally(() => {
    if (id) {
      state.activeRequestIds.delete(id);
      state.queryRequestIds.delete(id);
    }
  });
}

function renderTreeBreadcrumbs(state) {
  treeBreadcrumb.replaceChildren();
  state.breadcrumbs.forEach((crumb, depth) => {
    const item = document.createElement("li");
    if (depth === state.breadcrumbs.length - 1) {
      item.textContent = crumb.label;
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.treeDepth = String(depth);
      button.textContent = crumb.label;
      button.addEventListener("click", () => {
        state.breadcrumbs = state.breadcrumbs.slice(0, depth + 1);
        state.path = crumb.path;
        renderTreeBreadcrumbs(state);
        loadTreeChildren(state, 0);
      });
      item.append(button);
    }
    treeBreadcrumb.append(item);
  });
}

function renderTreePage(state) {
  treeChildList.replaceChildren();
  for (const [position, child] of state.children.entries()) {
    if (!child || typeof child !== "object") continue;
    const item = document.createElement("li");
    item.dataset.childIndex = String(
      child.index ?? state.offset + position + 1,
    );
    const label = typeof child.label === "string" ? child.label : "(unnamed)";
    if (child.has_children === true) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.dataset.action = "expand-child";
      expand.textContent = label;
      expand.addEventListener("click", () => {
        if (!Array.isArray(child.path)) return;
        state.path = child.path;
        state.breadcrumbs.push({ path: child.path, label });
        renderTreeBreadcrumbs(state);
        loadTreeChildren(state, 0);
      });
      item.append(expand);
    } else {
      const text = document.createElement("span");
      text.textContent = label;
      item.append(text);
    }
    const classes = Array.isArray(child.class)
      ? child.class.filter((value) => typeof value === "string").join(", ")
      : "";
    const summary = document.createElement("span");
    summary.className = "muted tree-summary";
    summary.textContent = [classes, child.summary]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join(" · ");
    item.append(summary);
    if (typeof child.unavailable === "string") {
      const unavailable = document.createElement("span");
      unavailable.className = "tree-unavailable";
      unavailable.textContent = "Unavailable: " + child.unavailable;
      item.append(unavailable);
    } else if (child.viewable === true && Array.isArray(child.path)) {
      const open = document.createElement("button");
      open.type = "button";
      open.dataset.action = "open-child";
      open.textContent = "Open view";
      open.addEventListener("click", () => openChild(state, child.path));
      item.append(open);
    }
    treeChildList.append(item);
  }
  const start = state.totalChildren === 0 ? 0 : state.offset + 1;
  const end = Math.min(
    state.totalChildren,
    state.offset + state.children.length,
  );
  treePageLabel.textContent = start + "–" + end + " of " +
    state.totalChildren + " children";
  treePrevious.disabled = state.offset === 0;
  treeNext.disabled = end >= state.totalChildren;
}

async function openChild(state, path) {
  if (!isActiveView(state) || state.childOpening) return;
  state.childOpening = true;
  childOpenStatus.hidden = false;
  childOpenStatus.dataset.state = "waiting";
  childOpenStatus.textContent = "Opening the captured value. Waiting for R…";
  const promise = transport.request(
    state.session,
    "object/open",
    {
      view: state.descriptor.view,
      generation: state.descriptor.generation,
      path,
    },
    60_000,
  );
  const id = promise.id;
  if (id) state.activeRequestIds.add(id);
  try {
    const response = await promise;
    if (!isActiveView(state)) return;
    const descriptor = response?.result;
    if (!viewSupport(descriptor)) {
      throw new Error("R returned an invalid child view descriptor.");
    }
    addTable(state.session, { method: "view/open", params: descriptor });
    if (descriptor.kind === "tree") {
      openTree(state.session, descriptor, state);
    } else {
      openView(state.session, descriptor, state);
    }
  } catch (error) {
    if (!isActiveView(state)) return;
    if (error?.name !== "AbortError") {
      childOpenStatus.dataset.state = "error";
      childOpenStatus.textContent = error?.code
        ? error.code + ": " + error.message
        : error?.message ?? String(error);
    }
  } finally {
    if (id) state.activeRequestIds.delete(id);
    state.childOpening = false;
    if (selected === state && childOpenStatus.dataset.state !== "error") {
      childOpenStatus.hidden = true;
    }
  }
}

function returnToTree() {
  returnToView(selected?.returnTree);
}

function returnToView(state) {
  if (!state || !viewSupport(state.descriptor) || !isKnownView(state)) return;
  closeSelectedTable();
  if (state.kind === "tree") {
    selected = state;
    renderViewBreadcrumbs();
    viewer.hidden = true;
    treeViewer.hidden = false;
    treeParentReturn.hidden = state.returnTree === null;
    treeTitleElement.textContent = state.descriptor.title ?? "Untitled object";
    treeMetaElement.textContent =
      (state.descriptor.class?.join(", ") ?? "unknown class") +
      " · " + state.session;
    renderTreeBreadcrumbs(state);
    loadTreeChildren(state, state.offset);
  } else {
    openView(state.session, state.descriptor, state.returnTree, state);
  }
}

function isActiveView(state) {
  return selected === state && isKnownView(state);
}

function isKnownView(state) {
  const current = knownTables.get(`${state.session}\0${state.descriptor.view}`);
  return current?.descriptor.generation === state.descriptor.generation;
}

function renderViewBreadcrumbs() {
  viewBreadcrumb.replaceChildren();
  childOpenStatus.hidden = true;
  const chain = [];
  for (let state = selected; state; state = state.returnTree) {
    chain.unshift(state);
  }
  chain.forEach((state, depth) => {
    const item = document.createElement("li");
    const label = state.descriptor.title ?? "Untitled view";
    if (state === selected) item.textContent = label;
    else {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.viewDepth = String(depth);
      button.textContent = label;
      button.addEventListener("click", () => returnToView(state));
      item.append(button);
    }
    viewBreadcrumb.append(item);
  });
}

function captureQueryForm() {
  return [
    sortColumn,
    sortDirection,
    filterColumn,
    filterOperator,
    filterValue,
    filterUpper,
  ]
    .map((element) => element.value);
}

function restoreQueryForm(values) {
  [sortColumn.value, sortDirection.value, filterColumn.value] = values;
  updateFilterOperators();
  [filterOperator.value, filterValue.value, filterUpper.value] = values.slice(
    3,
  );
  updateFilterInputs();
}

function populateColumnChoices() {
  if (!selected) return;
  fillColumnSelect(sortColumn, true);
  fillColumnSelect(filterColumn, false);
  sortFieldset.hidden = selected.descriptor.capabilities.sort !== true ||
    !selected.columns.some((schema) => schema.sortable === true);
  filterFieldset.hidden = selected.descriptor.capabilities.filter !== true ||
    selected.columns.length === 0;
  updateFilterOperators();
}

function fillColumnSelect(select, sortableOnly) {
  select.replaceChildren();
  for (const schema of selected.columns) {
    if (sortableOnly && schema.sortable !== true) continue;
    const option = document.createElement("option");
    option.value = String(schema.position);
    option.textContent = `${schema.name ?? ""} · ${
      schema.type ?? "other"
    } (#${schema.position})`;
    select.append(option);
  }
}

function filterOperators(schema) {
  if (!schema) return [];
  if (selected?.descriptor.capabilities.filter !== true) return [];
  const common = [["is_na", "Is missing"]];
  if (schema.filterable !== true) return common;
  if (["string", "factor", "other"].includes(schema.type)) {
    return common.concat([
      ["contains", "Contains"],
      ["starts_with", "Starts with"],
      ["ends_with", "Ends with"],
      ["text_equals", "Equals text"],
    ]);
  }
  if (["integer", "number", "date", "datetime"].includes(schema.type)) {
    return common.concat([
      ["eq", "Equals"],
      ["ne", "Does not equal"],
      ["lt", "Less than"],
      ["le", "At most"],
      ["gt", "Greater than"],
      ["ge", "At least"],
      ["between", "Between"],
    ]);
  }
  if (schema.type === "int64") {
    return common.concat([["eq", "Equals"], ["between", "Between"]]);
  }
  if (schema.type === "boolean") {
    return common.concat([["is_true", "Is true"], ["is_false", "Is false"]]);
  }
  return common;
}

function updateFilterOperators() {
  if (!selected) return;
  const schema = selected.columns.find((column) =>
    String(column.position) === filterColumn.value
  );
  filterOperator.replaceChildren();
  for (const [value, label] of filterOperators(schema)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    filterOperator.append(option);
  }
  const enabled = filterOperator.options.length > 0;
  filterValue.disabled = !enabled;
  filterUpper.disabled = !enabled;
  $("#filter-apply").disabled = !enabled;
  updateFilterInputs();
}

function updateFilterInputs() {
  const operator = filterOperator.value;
  const schema = selected?.columns.find((column) =>
    String(column.position) === filterColumn.value
  );
  const usesValue = !["is_na", "is_true", "is_false"].includes(operator);
  filterValue.hidden = !usesValue;
  filterUpper.hidden = operator !== "between";
  filterValue.placeholder = valuePlaceholder(schema);
  filterUpper.placeholder = valuePlaceholder(schema, "Upper bound");
  if (schema?.type === "datetime") {
    filterHelp.textContent =
      "Use YYYY-MM-DDTHH:MM:SSZ or an explicit offset such as +05:30. R's local timezone is not inferred by the Snapshot viewer.";
  } else if (["string", "factor", "other"].includes(schema?.type)) {
    filterHelp.textContent =
      "Text comparisons ignore ASCII letter case; non-ASCII case is preserved.";
  } else {
    filterHelp.textContent =
      "Values follow the selected column type. Missing values can be filtered explicitly.";
  }
}

function valuePlaceholder(schema, fallback = "Value") {
  if (schema?.type === "datetime") return "YYYY-MM-DDTHH:MM:SSZ or ±HH:MM";
  if (schema?.type === "date") return "YYYY-MM-DD";
  if (schema?.type === "int64") return "Exact decimal integer";
  return fallback;
}

function addSortTerm() {
  if (!selected) return;
  const position = Number(sortColumn.value);
  const schema = selected.columns.find((column) =>
    column.position === position
  );
  if (
    selected.descriptor.capabilities.sort !== true ||
    !Number.isSafeInteger(position) ||
    schema?.sortable !== true ||
    selected.sort.some((item) => item.col === position)
  ) return;
  if (selected.sort.length >= 16) {
    showNotice("The protocol supports at most 16 sort columns.", "warning");
    return;
  }
  selected.sort.push({ col: position, desc: sortDirection.value === "desc" });
  renderSortTerms();
  reloadFirstPage();
}

function renderSortTerms() {
  sortList.replaceChildren();
  if (!selected) return;
  selected.sort.forEach((term, index) => {
    const schema = selected.columns[term.col];
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${schema?.name ?? ""} (#${term.col}) · ${
      term.desc ? "descending" : "ascending"
    }`;
    const direction = document.createElement("button");
    direction.type = "button";
    direction.textContent = "Reverse";
    direction.addEventListener("click", () => {
      term.desc = !term.desc;
      renderSortTerms();
      reloadFirstPage();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      selected.sort.splice(index, 1);
      renderSortTerms();
      reloadFirstPage();
    });
    item.append(label, direction, remove);
    sortList.append(item);
  });
}

function buildFilterAst() {
  const position = Number(filterColumn.value);
  const schema = selected?.columns.find((column) =>
    column.position === position
  );
  const op = filterOperator.value;
  if (
    selected?.descriptor.capabilities.filter !== true || !schema ||
    (schema.filterable !== true && op !== "is_na")
  ) throw new Error("Choose a filterable column.");
  const node = { op, col: position };
  if (op === "is_na" || op === "is_true" || op === "is_false") return node;
  const value = parseFilterValue(schema, filterValue.value);
  if (op === "between") {
    node.lower = value;
    node.upper = parseFilterValue(schema, filterUpper.value, "Upper bound");
  } else {
    node.value = value;
  }
  return node;
}

function parseFilterValue(schema, value, label = "Value") {
  if (["string", "factor", "other"].includes(schema.type)) return value;
  if (schema.type === "boolean") {
    throw new Error("Choose a Boolean filter operation.");
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (!value.trim()) throw new Error(`${label} is required.`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label} must be a finite number.`);
    }
    if (schema.type === "integer" && !Number.isInteger(parsed)) {
      throw new Error(`${label} must be an integer.`);
    }
    return parsed;
  }
  if (schema.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${label} must use YYYY-MM-DD.`);
    }
    return value;
  }
  if (schema.type === "datetime") {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
        .test(value)
    ) {
      throw new Error(
        `${label} must include Z or an explicit timezone offset.`,
      );
    }
    return value;
  }
  if (schema.type === "int64") {
    if (!/^(?:0|-?[1-9]\d*)$/.test(value)) {
      throw new Error(`${label} must be a canonical decimal integer.`);
    }
    return value;
  }
  throw new Error(
    `Filtering is not available for ${schema.type ?? "this"} column.`,
  );
}

function applyFilter() {
  if (!selected) return;
  try {
    selected.filter = buildFilterAst();
    showNotice("", "info");
    reloadFirstPage();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function clearFilter() {
  if (!selected) return;
  selected.filter = null;
  filterValue.value = "";
  filterUpper.value = "";
  showNotice("", "info");
  reloadFirstPage();
}

function reloadFirstPage() {
  if (!selected?.table) return;
  selected.epoch++;
  cancelQueryRequests(selected);
  const currentPage = selected.table.getPage();
  const reload = currentPage === 1
    ? selected.table.setData()
    : selected.table.setPage(1);
  reload.catch((error) => showTableError(error));
}

function calculateColumnWindow() {
  const window = columnWindow(
    selected?.columns.length ?? 0,
    viewport.scrollLeft,
    viewport.clientWidth || 720,
    {
      columnWidth: COLUMN_WIDTH,
      overscan: 2,
      maxColumns: 256,
      leadingWidth: ROW_WIDTH,
    },
  );
  return window;
}

function columnScrollExtent(totalWidth) {
  const viewportWidth = viewport.clientWidth || 720;
  const maximumScroll = Math.max(0, totalWidth - viewportWidth);
  const alignedMaximum = Math.ceil(maximumScroll / COLUMN_WIDTH) *
    COLUMN_WIDTH;
  return Math.max(totalWidth, viewportWidth + alignedMaximum);
}

function updateColumnScrollExtent() {
  if (selected?.kind !== "grid" || !selected.window) return;
  spacer.style.width = `${columnScrollExtent(selected.window.totalWidth)}px`;
  scheduleColumnWindow();
}

function scheduleColumnWindow() {
  if (selected?.kind !== "grid" || !selected.window) return;
  if (nextWindowFrame === 0) {
    nextWindowFrame = requestAnimationFrame(() => {
      nextWindowFrame = 0;
      if (!selected) return;
      updateRowColumnCompensation();
      updateColumnWindow();
    });
  }
  clearTimeout(nextWindowTimer);
  nextWindowTimer = setTimeout(requestColumnWindowPage, 80);
}

function cancelColumnWindowUpdate() {
  if (nextWindowFrame !== 0) cancelAnimationFrame(nextWindowFrame);
  nextWindowFrame = 0;
  clearTimeout(nextWindowTimer);
  nextWindowTimer = undefined;
  pendingColumnQuery = false;
}

function updateRowColumnCompensation() {
  const offset = selected?.window?.offsetPx ?? 0;
  const compensation = Math.max(0, viewport.scrollLeft - offset);
  windowElement.style.setProperty(
    "--row-horizontal-compensation",
    `${compensation}px`,
  );
}

function updateColumnWindow() {
  if (selected?.kind !== "grid" || !selected.table || !selected.window) {
    return;
  }
  const next = calculateColumnWindow();
  if (
    next.start === selected.window.start && next.end === selected.window.end
  ) return;
  const state = selected;
  state.window = next;
  state.epoch++;
  updateRowColumnCompensation();
  cancelQueryRequests(state);
  spacer.style.width = `${columnScrollExtent(next.totalWidth)}px`;
  windowElement.style.transform = `translateX(${next.offsetPx}px)`;
  windowElement.style.width = `${
    ROW_WIDTH + next.columns.length * COLUMN_WIDTH
  }px`;
  windowElement.classList.add("is-loading-window");
  state.table.setColumns(buildTableColumns(next.columns));
  pendingColumnQuery = true;
  if (nextWindowTimer === undefined) {
    nextWindowTimer = setTimeout(requestColumnWindowPage, 80);
  }
}

function requestColumnWindowPage() {
  nextWindowTimer = undefined;
  if (selected?.kind !== "grid" || !selected.window) return;
  spacer.style.width = `${columnScrollExtent(selected.window.totalWidth)}px`;
  const maximumScroll = Math.max(
    0,
    viewport.scrollWidth - viewport.clientWidth,
  );
  const nearRightEdge = maximumScroll - viewport.scrollLeft <= COLUMN_WIDTH;
  const alignedScrollLeft = nearRightEdge
    ? maximumScroll
    : Math.floor(viewport.scrollLeft / COLUMN_WIDTH) * COLUMN_WIDTH;
  if (alignedScrollLeft !== viewport.scrollLeft) {
    viewport.scrollLeft = alignedScrollLeft;
    return;
  }
  if (!pendingColumnQuery || !selected.table) return;
  pendingColumnQuery = false;
  selected.table.setPage(selected.page).catch((error) => showTableError(error));
}

function buildTableColumns(positions) {
  const state = selected;
  const columns = [{
    title: "Row",
    field: "row_index",
    width: 86,
    minWidth: 86,
    maxWidth: 86,
    headerSort: false,
    resizable: false,
    formatter: textFormatter,
  }];
  for (const position of positions) {
    const schema = selected.columns[position];
    if (!schema) continue;
    columns.push({
      title: "",
      titleFormatter: () => textNode(schema.name ?? ""),
      field: `c${schema.position}`,
      width: COLUMN_WIDTH,
      minWidth: COLUMN_WIDTH,
      maxWidth: COLUMN_WIDTH,
      headerSort: false,
      resizable: false,
      tooltip: false,
      formatter: schema.drillable === true &&
          selected.descriptor.capabilities.children === true
        ? (cell) => cellFormatter(cell, schema, state)
        : textFormatter,
    });
  }
  return columns;
}

function cellFormatter(cell, schema, state) {
  const content = textNode(cell.getValue() ?? "");
  const rowIndex = cell.getRow().getData().row_index;
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 1) return content;
  content.className = "drillable-cell";
  const open = document.createElement("button");
  open.type = "button";
  open.dataset.action = "open-cell";
  open.dataset.rowIndex = String(rowIndex);
  open.dataset.column = String(schema.position);
  open.textContent = "Open";
  open.setAttribute(
    "aria-label",
    `Open row ${rowIndex}, column ${schema.position}`,
  );
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    openChild(state, [{
      kind: "cell",
      row_index: rowIndex,
      column: schema.position,
    }]);
  });
  content.append(open);
  return content;
}

function textFormatter(cell) {
  return textNode(cell.getValue() ?? "");
}

function textNode(value) {
  const span = document.createElement("span");
  span.textContent = String(value);
  return span;
}

async function requestRows(params) {
  const state = selected;
  if (!state) throw new Error("No table is selected.");
  const pageNumber = Number.isSafeInteger(params.page) && params.page > 0
    ? params.page
    : 1;
  state.page = pageNumber;
  const pageSize = Number.isSafeInteger(params.size) && params.size > 0
    ? params.size
    : PAGE_SIZE;
  const offset = (pageNumber - 1) * pageSize;
  const epoch = ++state.epoch;
  cancelQueryRequests(state);
  const sort = state.sort.map(({ col, desc }) => ({ col, desc }));
  const filter = state.filter;
  const cols = state.window.columns;
  setStatus("Loading rows…", "loading");
  windowElement.classList.add("is-loading-window");
  try {
    let result;
    if (state.descriptor.access === "snapshot") {
      const page = querySnapshot(state.descriptor, {
        sort,
        filter,
        offset,
        limit: pageSize,
        cols,
      });
      const schemas = page.data.columns.map((column) => column.schema);
      const data = page.data.columns.map((column) => column.data);
      result = {
        total: page.total,
        total_unfiltered: page.total_unfiltered,
        rows: decodeRows(
          schemas,
          data,
          page.data.row_index,
          page.data.row_names,
        ),
        warnings: page.warnings ?? [],
      };
    } else if (state.descriptor.access === "random") {
      result = await requestPagedRows(state, {
        epoch,
        offset,
        limit: pageSize,
        sort,
        filter,
        cols,
      });
    } else {
      throw new Error("This view access method is not supported.");
    }
    if (!isCurrent(state, epoch)) throw abortError("The query was replaced.");
    setTableMeta(state, result.total, result.total_unfiltered);
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
    windowElement.classList.remove("is-loading-window");
    setStatus("Connected.", "connected");
    showWarnings(result.warnings ?? []);
    return { last_page: lastPage, last_row: result.total, data: result.rows };
  } catch (error) {
    if (!isCurrent(state, epoch) || error?.name === "AbortError") throw error;
    windowElement.classList.remove("is-loading-window");
    showTableError(error);
    throw error;
  }
}

async function requestPagedRows(state, query) {
  return await fillRemotePage({
    offset: query.offset,
    limit: query.limit,
    fetchPage: ({ offset, limit }) =>
      sendPagedRequest(state, {
        view: state.descriptor.view,
        generation: state.descriptor.generation,
        offset,
        limit,
        sort: query.sort,
        filter: query.filter,
        cols: query.cols,
      }),
    decode: (result) => {
      const schemas = result.data.columns.map((column) => column.schema);
      const data = result.data.columns.map((column) => column.data);
      return decodeRows(
        schemas,
        data,
        result.data.row_index,
        result.data.row_names,
      );
    },
    isCurrent: () => isCurrent(state, query.epoch),
  });
}

function sendPagedRequest(state, params) {
  const promise = transport.request(
    state.session,
    "table/rows",
    params,
    60_000,
  );
  const id = promise.id;
  if (id) {
    state.activeRequestIds.add(id);
    state.queryRequestIds.add(id);
  }
  return promise.finally(() => {
    if (id) {
      state.activeRequestIds.delete(id);
      state.queryRequestIds.delete(id);
    }
  });
}

function isCurrent(state, epoch) {
  return selected === state && state.epoch === epoch;
}

function showWarnings(warnings) {
  warningsElement.replaceChildren();
  const messages = Array.isArray(warnings) ? warnings : [];
  for (const warning of messages) {
    const item = document.createElement("li");
    item.textContent = String(warning);
    warningsElement.append(item);
  }
  if (messages.length) setStatus(`${messages.length} R warning(s).`, "warning");
}

function showTableError(error) {
  if (error?.name === "AbortError") return;
  showNotice(
    error?.code
      ? `${error.code}: ${error.message}`
      : error?.message ?? String(error),
    "error",
  );
  setStatus("The table request failed.", "error");
}

function showNotice(message, state) {
  warningsElement.replaceChildren();
  if (!message) return;
  const item = document.createElement("li");
  item.textContent = message;
  item.dataset.state = state;
  warningsElement.append(item);
}

function abortError(message) {
  return new DOMException(message, "AbortError");
}

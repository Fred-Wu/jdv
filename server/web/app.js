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
const titleElement = $("#table-title");
const metaElement = $("#table-meta");
const sortList = $("#sort-list");
const sortColumn = $("#sort-column");
const sortDirection = $("#sort-direction");
const filterColumn = $("#filter-column");
const filterOperator = $("#filter-op");
const filterValue = $("#filter-value");
const filterUpper = $("#filter-upper");
const filterHelp = $("#filter-help");
const viewport = $("#column-viewport");
const spacer = $("#column-spacer");
const windowElement = $("#column-window");
const paginationElement = $("#table-pagination");
const warningsElement = $("#warnings");
const PAGE_SIZE = 200;
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
      for (const table of entry.tables ?? []) {
        addTable(entry.hello?.params?.session, table);
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
  } else if (message.type === "table/open") {
    addTable(message.session, message.message);
  } else if (message.type === "table/closed") {
    const descriptor = message.message?.params;
    if (descriptor) {
      const key = `${message.session}\0${descriptor.table}`;
      const current = knownTables.get(key);
      if (current?.descriptor.generation === descriptor.generation) {
        knownTables.delete(key);
      }
      transport.cancelTable(
        message.session,
        descriptor.table,
        descriptor.generation,
      );
      if (
        selected?.session === message.session &&
        selected.descriptor.table === descriptor.table &&
        selected.descriptor.generation === descriptor.generation
      ) closeSelectedTable();
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
    typeof session !== "string" || typeof descriptor?.table !== "string" ||
    !Number.isSafeInteger(descriptor.generation)
  ) return;
  const key = `${session}\0${descriptor.table}`;
  const previous = knownTables.get(key);
  if (
    previous && descriptor.generation <= previous.descriptor.generation
  ) return;
  const replaceSelected = selected?.session === session &&
    selected.descriptor.table === descriptor.table &&
    selected.descriptor.generation < descriptor.generation;
  if (replaceSelected) closeSelectedTable();
  knownTables.set(key, { session, descriptor });
  renderLists();
  if (replaceSelected) openTable(session, descriptor);
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
    heading.textContent = descriptor.title ?? "Untitled table";
    const detail = document.createElement("p");
    detail.className = "muted";
    detail.textContent = `${descriptor.nrow ?? 0} rows · ${
      descriptor.ncol ?? 0
    } columns · ${descriptor.mode ?? "unknown"} · ${session}`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "View table";
    button.addEventListener("click", () => openTable(session, descriptor));
    item.append(heading, detail, button);
    tablesElement.append(item);
  }
}

function openTable(session, descriptor) {
  closeSelectedTable();
  const columns = Array.isArray(descriptor.columns) ? descriptor.columns : [];
  selected = {
    session,
    descriptor,
    columns,
    sort: [],
    filter: null,
    epoch: 0,
    page: 1,
    activeRequestIds: new Set(),
    table: null,
    window: { start: 0, end: 0, columns: [], offsetPx: 0, totalWidth: 0 },
  };
  viewer.hidden = false;
  titleElement.textContent = descriptor.title ?? "Untitled table";
  metaElement.textContent = `${descriptor.nrow ?? 0} rows · ${
    descriptor.ncol ?? 0
  } columns · ${descriptor.mode ?? "unknown"} · ${session}`;
  warningsElement.replaceChildren();
  paginationElement.replaceChildren();
  populateColumnChoices();
  const windowState = calculateColumnWindow();
  selected.window = windowState;
  spacer.style.width = `${windowState.totalWidth}px`;
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
    pagination: true,
    paginationMode: "remote",
    paginationSize: PAGE_SIZE,
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
}

function closeSelectedTable() {
  if (!selected) return;
  cancelColumnWindowUpdate();
  selected.epoch++;
  transport.cancelTable(
    selected.session,
    selected.descriptor.table,
    selected.descriptor.generation,
    "The selected table was closed.",
  );
  selected.table?.destroy();
  paginationElement.replaceChildren();
  selected = null;
  viewer.hidden = true;
}

function populateColumnChoices() {
  if (!selected) return;
  fillColumnSelect(sortColumn, true);
  fillColumnSelect(filterColumn, false);
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
  if (
    !Number.isSafeInteger(position) ||
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
  if (!schema) throw new Error("Choose a filterable column.");
  const op = filterOperator.value;
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
  transport.cancelTable(
    selected.session,
    selected.descriptor.table,
    selected.descriptor.generation,
    "A newer query replaced this request.",
  );
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

function scheduleColumnWindow() {
  if (!selected) return;
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
  if (!selected?.table) return;
  const next = calculateColumnWindow();
  if (
    next.start === selected.window.start && next.end === selected.window.end
  ) return;
  const state = selected;
  state.window = next;
  state.epoch++;
  updateRowColumnCompensation();
  transport.cancelTable(
    state.session,
    state.descriptor.table,
    state.descriptor.generation,
    "A newer column window replaced this request.",
  );
  spacer.style.width = `${next.totalWidth}px`;
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
  if (!pendingColumnQuery || !selected?.table) return;
  pendingColumnQuery = false;
  selected.table.setPage(selected.page).catch((error) => showTableError(error));
}

function buildTableColumns(positions) {
  const columns = [{
    title: "Row",
    field: "row_index",
    width: 86,
    minWidth: 86,
    maxWidth: 86,
    frozen: true,
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
      formatter: textFormatter,
    });
  }
  return columns;
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
  transport.cancelTable(
    state.session,
    state.descriptor.table,
    state.descriptor.generation,
    "A newer page request replaced this request.",
  );
  state.activeRequestIds.clear();
  const sort = state.sort.map(({ col, desc }) => ({ col, desc }));
  const filter = state.filter;
  const cols = state.window.columns;
  setStatus("Loading rows…", "loading");
  windowElement.classList.add("is-loading-window");
  try {
    let result;
    if (state.descriptor.mode === "snapshot") {
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
        rows: decodeRows(
          schemas,
          data,
          page.data.row_index,
          page.data.row_names,
        ),
        warnings: page.warnings ?? [],
      };
    } else {
      result = await requestPagedRows(state, {
        epoch,
        offset,
        limit: pageSize,
        sort,
        filter,
        cols,
      });
    }
    if (!isCurrent(state, epoch)) throw abortError("The query was replaced.");
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
        table: state.descriptor.table,
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
  if (id) state.activeRequestIds.add(id);
  return promise.finally(() => {
    if (id) state.activeRequestIds.delete(id);
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

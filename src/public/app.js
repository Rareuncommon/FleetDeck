"use strict";
/*
 * FleetDeck frontend. Plain JS, no build step (see index.html header).
 * Layout of this file:
 *   1. tiny DOM/format helpers + api()
 *   2. toast + modal systems (replace every native alert/confirm/prompt)
 *   3. app state + WebSocket live channel (REST/polling stays as fallback)
 *   4. client table pipeline (search -> filter -> sort -> paginate -> render)
 *   5. row/bulk actions, detail drawer
 *   6. golden / reconcile / settings / audit tabs
 *   7. command palette, nav, login/boot
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (t, p) => Object.assign(document.createElement(t), p || {});
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(method, path, body) {
  const opt = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || (res.status + " " + res.statusText));
  return data;
}

function fmtBytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}
function fmtTime(t) {
  if (!t) return "—";
  const d = new Date(t), s = (Date.now() - d) / 1000;
  if (isNaN(d)) return esc(t);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return d.toISOString().slice(0, 16).replace("T", " ");
}
function safeJson(j) { if (j == null) return null; try { return typeof j === "string" ? JSON.parse(j) : j; } catch (e) { return j; } }

/* ============================== Toasts ================================== */

function toast(msg, kind = "ok", ms = 4000) {
  const t = el("div", { className: `toast ${kind}`, textContent: msg });
  $("#toast-root").appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/* ============================== Modals ==================================
 * openModal replaces confirm()/prompt(). Resolves to:
 *   - null on cancel/escape/backdrop click
 *   - true on confirm with no fields
 *   - {fieldName: value, ...} on confirm with fields
 * typeToConfirm keeps the destructive "type the name" pattern: the confirm
 * button stays disabled until the input matches exactly.
 */

function openModal({ title, bodyHTML = "", danger = false, confirmText = "Confirm",
                     cancelText = "Cancel", typeToConfirm = null, fields = null }) {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    const overlay = el("div", { className: "overlay" });
    const box = el("div", { className: "modal" + (danger ? " danger" : "") });

    let fieldsHTML = "";
    for (const f of (fields || [])) {
      if (f.type === "select") {
        const opts = (f.options || []).map((o) =>
          `<option value="${esc(o.value)}"${o.value === f.value ? " selected" : ""}>${esc(o.label)}</option>`).join("");
        fieldsHTML += `<div><label>${esc(f.label)}</label><select data-field="${esc(f.name)}">${opts}</select></div>`;
      } else {
        fieldsHTML += `<div><label>${esc(f.label)}</label>` +
          `<input data-field="${esc(f.name)}" placeholder="${esc(f.placeholder || "")}" value="${esc(f.value || "")}"></div>`;
      }
    }
    const typeHTML = typeToConfirm == null ? "" :
      `<div><label>Type <b class="mono" style="color:var(--text)">${esc(typeToConfirm)}</b> to confirm</label>` +
      `<input data-type-confirm autocomplete="off" spellcheck="false"></div>`;

    box.innerHTML = `
      <header>${esc(title)}</header>
      <div class="body">${bodyHTML}${fieldsHTML}${typeHTML}</div>
      <footer>
        <button data-cancel>${esc(cancelText)}</button>
        <button data-confirm class="${danger ? "confirm-danger" : "accent"}">${esc(confirmText)}</button>
      </footer>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const confirmBtn = box.querySelector("[data-confirm]");
    const typeInput = box.querySelector("[data-type-confirm]");
    if (typeInput) {
      confirmBtn.disabled = true;
      typeInput.addEventListener("input", () => {
        confirmBtn.disabled = typeInput.value !== typeToConfirm;
      });
    }

    const done = (value) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const confirm = () => {
      if (confirmBtn.disabled) return;
      if (!fields) return done(true);
      const out = {};
      for (const inp of box.querySelectorAll("[data-field]")) out[inp.dataset.field] = inp.value;
      done(out);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(null); }
      else if (e.key === "Enter" && e.target.tagName !== "SELECT") { e.preventDefault(); confirm(); }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    box.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    confirmBtn.addEventListener("click", confirm);

    const first = box.querySelector("input, select");
    if (first) first.focus();
  });
}

const confirmModal = (title, bodyHTML, opts = {}) =>
  openModal({ title, bodyHTML, confirmText: opts.confirmText || "Confirm", danger: !!opts.danger });

/* ============================ App state ================================= */

const state = {
  clients: [],
  goldenNames: [],
  selected: new Set(),      // client ids (survives re-render + pagination)
  search: "",
  statusFilter: "",
  sort: { key: null, dir: 1 }, // null = server order (by id)
  page: 0,
  loadedClientsOnce: false,   // gates the skeleton row rendering
  wsConnected: false,
  truenasConnected: null,     // null until the first ws greeting
  goldenBuild: null,          // active golden build session row, or null
};
const PER_PAGE = 50;

/* ======================= WebSocket live channel =========================
 * Additive on top of REST: every message is just a "refetch/patch" hint.
 * When the socket is down we fall back to the 10s polling loop below, so
 * nothing breaks if /ws is unreachable (e.g. a proxy that won't upgrade).
 */

let ws = null;
let wsRetryMs = 1000;

function connectWS() {
  if (ws) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try { ws = new WebSocket(`${proto}//${location.host}/ws`); } catch (e) { ws = null; return; }

  ws.addEventListener("open", () => {
    state.wsConnected = true;
    wsRetryMs = 1000;
    renderStamp();
  });
  ws.addEventListener("message", (e) => {
    let msg = null;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (!msg || !msg.type) return;
    if (msg.type === "clients_changed") {
      loadClients();
    } else if (msg.type === "event") {
      onPushedEvent(msg.payload);
    } else if (msg.type === "truenas") {
      const was = state.truenasConnected;
      state.truenasConnected = !!(msg.payload && msg.payload.connected);
      // Only announce transitions, not the greeting a fresh tab receives.
      if (was !== null && was !== state.truenasConnected) {
        toast(state.truenasConnected ? "TrueNAS reconnected" : "TrueNAS connection lost", state.truenasConnected ? "ok" : "err");
      }
      renderStamp();
    }
  });
  ws.addEventListener("close", () => {
    ws = null;
    state.wsConnected = false;
    renderStamp();
    setTimeout(connectWS, wsRetryMs);
    wsRetryMs = Math.min(wsRetryMs * 2, 30000);
  });
  ws.addEventListener("error", () => { try { ws.close(); } catch (e) {} });
}

function onPushedEvent(evt) {
  if (!evt) return;
  // Live-prepend on the Audit tab if it's showing.
  if ($("#events").classList.contains("active")) prependEventRow(evt);
  // Refresh an open drawer if the event concerns that client.
  if (drawerClientId != null && evt.client_id === drawerClientId) refreshDrawerEvents();
  // Discovered machines only surface via boot.* audit entries — refresh the
  // discovered table on those instead of polling for them.
  if (String(evt.action || "").startsWith("boot.") && $("#dashboard").classList.contains("active")) loadDiscovered();
}

function renderStamp() {
  const bits = [];
  bits.push(state.wsConnected ? "live" : "polling");
  if (state.truenasConnected === false) bits.push("truenas down");
  $("#poll-stamp").textContent = bits.join(" · ") + " · " + new Date().toLocaleTimeString();
}

/* ========================= Client table ================================= */

function visibleClients() {
  let list = state.clients;
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((c) =>
    String(c.name).toLowerCase().includes(q) || String(c.mac).toLowerCase().includes(q));
  if (state.statusFilter) list = list.filter((c) => c.status === state.statusFilter);
  if (state.sort.key) {
    const { key, dir } = state.sort;
    list = [...list].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;              // nulls last regardless of dir
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }
  return list;
}

function statusBadge(status) {
  const known = status === "booted" || status === "offline" ? status : "unknown";
  return `<span class="badge-status ${known}"><span class="dot"></span>${esc(status)}</span>`;
}

function renderClients() {
  const body = $("#clients-body");
  const emptyRoot = $("#clients-empty");

  // Skeleton rows until the first fetch lands.
  if (!state.loadedClientsOnce) {
    body.innerHTML = Array.from({ length: 5 }, () =>
      `<tr class="skel-row">${'<td><span class="skel">&nbsp;</span></td>'.repeat(10)}</tr>`).join("");
    emptyRoot.innerHTML = "";
    return;
  }

  const list = visibleClients();
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  if (state.page >= pages) state.page = pages - 1;
  const pageList = list.slice(state.page * PER_PAGE, (state.page + 1) * PER_PAGE);

  body.innerHTML = "";
  for (const c of pageList) {
    const tr = el("tr", { className: "clickable" });
    tr.dataset.id = c.id;
    const picker = state.goldenNames.map((g) =>
      `<option${g === c.golden_snapshot ? " selected" : ""}>${esc(g)}</option>`).join("");
    tr.innerHTML = `
      <td data-th=""><input type="checkbox" class="sel" value="${c.id}"${state.selected.has(String(c.id)) ? " checked" : ""}></td>
      <td data-th="Name">${esc(c.name)}</td>
      <td data-th="MAC" class="mono">${esc(c.mac)}</td>
      <td data-th="Zvol" class="mono muted">${esc(c.zvol)}</td>
      <td data-th="Golden" class="mono badge">${esc(c.golden_snapshot)}</td>
      <td data-th="Status">${statusBadge(c.status)}</td>
      <td data-th="Space">${fmtBytes(c.space_used_bytes)}</td>
      <td data-th="Last boot" class="muted">${fmtTime(c.last_boot_at)}</td>
      <td data-th="Flags">${c.boot_golden_once ? '<span class="tag toggle-on">golden-once</span>' : ""}${c.nightly_reset ? ' <span class="tag">nightly</span>' : ""}</td>
      <td data-th="Actions" class="actions">
        <button data-act="reset" data-id="${c.id}">Reset</button>
        <select data-act="rebase-pick" data-id="${c.id}" style="width:110px"><option value="">Rebase…</option>${picker}</select>
        <button data-act="golden-once" data-id="${c.id}">${c.boot_golden_once ? "Unset⚑" : "Golden⚑"}</button>
        <button data-act="nightly" data-id="${c.id}" data-on="${c.nightly_reset ? "1" : "0"}">${c.nightly_reset ? "Nightly✓" : "Nightly?"}</button>
        <button class="danger" data-act="retire" data-id="${c.id}" data-name="${esc(c.name)}">Retire</button>
      </td>`;
    body.appendChild(tr);
  }

  // Empty states: distinguish "no clients at all" from "filters match nothing".
  if (list.length === 0) {
    if (state.clients.length === 0) {
      emptyRoot.innerHTML = `<div class="empty">
        <div class="big">No clients yet</div>
        <div>Create one above, or import a fleet from CSV.</div>
        <button class="accent" id="empty-create-cta">Create your first client</button>
      </div>`;
      const cta = $("#empty-create-cta");
      if (cta) cta.addEventListener("click", () => $("#new-client [name=name]").focus());
    } else {
      emptyRoot.innerHTML = `<div class="empty">No clients match the current search/filter.</div>`;
    }
  } else {
    emptyRoot.innerHTML = "";
  }

  // Pagination controls only when the fleet outgrows one page.
  const pager = $("#clients-pager");
  if (list.length > PER_PAGE) {
    pager.style.display = "";
    $("#page-info").textContent = `${state.page + 1} / ${pages} (${list.length} clients)`;
    $("#page-prev").disabled = state.page === 0;
    $("#page-next").disabled = state.page >= pages - 1;
  } else {
    pager.style.display = "none";
  }

  // Sort arrows on headers.
  for (const th of $$("#clients th.sortable")) {
    const base = th.textContent.replace(/ [▲▼]$/, "");
    th.innerHTML = esc(base) + (state.sort.key === th.dataset.sort
      ? ` <span class="sort-arrow">${state.sort.dir > 0 ? "▲" : "▼"}</span>` : "");
  }

  updateBulkButtons();
}

function updateBulkButtons() {
  // Selection is tracked in state.selected (a Set), not the DOM, so it holds
  // across pagination/re-render; prune ids whose clients no longer exist.
  const alive = new Set(state.clients.map((c) => String(c.id)));
  for (const id of [...state.selected]) if (!alive.has(id)) state.selected.delete(id);
  const n = state.selected.size;
  $("#bulk-reset").disabled = n === 0;
  $("#bulk-retire").disabled = n === 0;
  $("#bulk-nightly-on").disabled = n === 0;
  $("#bulk-nightly-off").disabled = n === 0;
  $("#bulk-rebase-pick").disabled = n === 0;
  $("#bulk-reset").textContent = n ? `Reset selected (${n})` : "Reset selected";
  $("#bulk-retire").textContent = n ? `Retire selected (${n})` : "Retire selected";
}

async function loadClients() {
  try {
    state.clients = await api("GET", "/api/clients");
    state.loadedClientsOnce = true;
    renderClients();
    renderStamp();
  } catch (e) {}
  renderStatTiles(await loadPoolStatus());
}

async function loadPoolStatus() {
  try {
    const r = await api("GET", "/api/pool/status");
    return r && r.status;
  } catch (e) { return null; }
}

function renderStatTiles(poolStatus) {
  if (!state.loadedClientsOnce) {
    $("#stat-tiles").innerHTML = Array.from({ length: 4 }, () =>
      `<div class="tile"><div class="n skel">&nbsp;&nbsp;&nbsp;</div><div class="l skel">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div></div>`).join("");
    return;
  }
  const total = state.clients.length;
  const booted = state.clients.filter((c) => c.status === "booted").length;
  const offline = state.clients.filter((c) => c.status === "offline").length;
  const tiles = [
    { l: "Clients", n: total },
    { l: "Booted", n: booted },
    { l: "Offline", n: offline },
  ];
  if (poolStatus && poolStatus.usedPercent != null) {
    const pct = poolStatus.usedPercent;
    const cls = pct >= 95 ? "crit" : pct >= 85 ? "warn" : "";
    tiles.push({ l: "Pool used", n: pct.toFixed(1) + "%", cls });
  } else {
    tiles.push({ l: "Pool used", n: "—" });
  }
  $("#stat-tiles").innerHTML = tiles.map((t) =>
    `<div class="tile ${t.cls || ""}"><div class="n">${esc(t.n)}</div><div class="l">${esc(t.l)}</div></div>`).join("");
}

async function loadDiscovered() {
  let list = [];
  try { list = await api("GET", "/api/discovered"); } catch (e) { return; }
  const body = $("#discovered-body");
  body.innerHTML = "";
  if (!list.length) { body.innerHTML = '<tr><td colspan="5" class="muted">None</td></tr>'; return; }
  for (const d of list) {
    const tr = el("tr");
    // Two distinct actions: Adopt (safe — clones golden into a new managed
    // client) and Golden Build Mode (dangerous — sanhooks this MAC directly
    // into the live golden image). They must never be confused, hence the
    // separate amber button and the confirmation modal it opens.
    tr.innerHTML = `<td class="mono">${esc(d.mac)}</td><td class="muted">${fmtTime(d.first_seen_at)}</td>
      <td class="muted">${fmtTime(d.last_seen_at)}</td><td>${esc(d.request_count)}</td>
      <td class="actions"><button class="accent" data-act="adopt" data-mac="${esc(d.mac)}">Adopt</button>
      <button class="warn" data-act="golden-build" data-mac="${esc(d.mac)}">Boot into Golden Build Mode</button></td>`;
    body.appendChild(tr);
  }
  applyGoldenBuildDisabled();
}

/* ====================== Row + bulk client actions ======================= */

async function resetWithForceFlow(id, label) {
  try {
    await api("POST", `/api/clients/${id}/reset`, {});
    toast(`${label}: reset started`);
  } catch (err) {
    if (!/session/i.test(err.message)) throw err;
    const ok = await confirmModal("Active session", `<p>${esc(err.message)}</p><p>Force reset anyway? The disk will be wiped while in use.</p>`, { danger: true, confirmText: "Force reset" });
    if (!ok) return;
    await api("POST", `/api/clients/${id}/reset`, { force: true });
    toast(`${label}: force reset started`);
  }
}

async function retireFlow(id, name) {
  const typed = await openModal({
    title: `Retire ${name}`,
    bodyHTML: `<p>This deletes the client's iSCSI target, extent, and zvol on TrueNAS, and removes it from FleetDeck. A quarantine safety-snapshot gives a brief undo window.</p>`,
    danger: true, confirmText: "Retire", typeToConfirm: name,
  });
  if (!typed) return;
  try {
    await api("DELETE", `/api/clients/${id}`);
    toast(`${name} retired`);
  } catch (err) {
    if (!/session/i.test(err.message)) { toast(err.message, "err"); return; }
    const ok = await confirmModal("Active session", `<p>${esc(err.message)}</p><p>Force retire anyway? The machine is currently running from this disk.</p>`, { danger: true, confirmText: "Force retire" });
    if (!ok) return;
    try {
      await api("DELETE", `/api/clients/${id}`, { force: true });
      toast(`${name} force retired`);
    } catch (err2) { toast(err2.message, "err"); }
  }
  loadClients();
}

$("#dashboard").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  if (!act) return;
  try {
    if (act === "reset") {
      const c = state.clients.find((x) => String(x.id) === String(id));
      await resetWithForceFlow(id, c ? c.name : `client ${id}`);
      loadClients();
    } else if (act === "golden-once") {
      await api("POST", `/api/clients/${id}/boot-golden-once`);
      toast("Golden-once flag toggled");
      loadClients();
    } else if (act === "nightly") {
      const enabled = b.dataset.on !== "1";
      await api("POST", `/api/clients/${id}/nightly-reset`, { enabled });
      toast(`Nightly reset ${enabled ? "enabled" : "disabled"}`);
      loadClients();
    } else if (act === "retire") {
      await retireFlow(id, b.dataset.name);
    } else if (act === "adopt") {
      const vals = await openModal({
        title: `Adopt ${b.dataset.mac}`, confirmText: "Adopt",
        fields: [{ name: "name", label: "Client name", placeholder: "pc-07" }],
      });
      if (!vals || !vals.name.trim()) return;
      await api("POST", `/api/discovered/${encodeURIComponent(b.dataset.mac)}/adopt`, { name: vals.name.trim() });
      toast(`Adopted ${vals.name.trim()}`);
      loadClients(); loadDiscovered();
    } else if (act === "golden-build") {
      await goldenBuildArmFlow(b.dataset.mac);
    }
  } catch (err) {
    if (err.message !== "unauthorized") toast(err.message, "err");
  }
});

// Row click opens the detail drawer — but not clicks on controls inside it.
$("#clients-body").addEventListener("click", (e) => {
  if (e.target.closest("button, select, input, a")) return;
  const tr = e.target.closest("tr[data-id]");
  if (tr) openDrawer(Number(tr.dataset.id));
});

$("#clients-body").addEventListener("change", async (e) => {
  if (e.target.matches(".sel")) {
    if (e.target.checked) state.selected.add(e.target.value);
    else state.selected.delete(e.target.value);
    return updateBulkButtons();
  }
  const sel = e.target.closest("select[data-act='rebase-pick']");
  if (sel && sel.value) {
    const id = sel.dataset.id, snap = sel.value;
    try {
      try {
        await api("POST", `/api/clients/${id}/rebase`, { goldenSnapshot: snap });
        toast(`Rebased onto ${snap}`);
      } catch (err) {
        if (!/session|409/i.test(err.message)) throw err;
        const ok = await confirmModal("Active session", `<p>${esc(err.message)}</p><p>Force rebase?</p>`, { danger: true, confirmText: "Force rebase" });
        if (ok) { await api("POST", `/api/clients/${id}/rebase`, { goldenSnapshot: snap, force: true }); toast(`Force rebased onto ${snap}`); }
      }
      loadClients();
    } catch (err) { toast(err.message, "err"); loadClients(); }
  }
});

$("#sel-all").addEventListener("change", (e) => {
  // Applies to the visible page only — selecting across hidden pages
  // silently would make bulk retire far too easy to over-scope.
  for (const c of $$("#clients-body .sel")) {
    c.checked = e.target.checked;
    if (e.target.checked) state.selected.add(c.value);
    else state.selected.delete(c.value);
  }
  updateBulkButtons();
});

// Search / filter / sort / pagination wiring.
$("#client-search").addEventListener("input", (e) => { state.search = e.target.value; state.page = 0; renderClients(); });
$("#status-filter").addEventListener("change", (e) => { state.statusFilter = e.target.value; state.page = 0; renderClients(); });
$("#page-prev").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); renderClients(); });
$("#page-next").addEventListener("click", () => { state.page += 1; renderClients(); });
// Client-side sort is fine at homelab fleet sizes (tens of rows). If a fleet
// ever exceeds a few hundred clients, move sort/filter/pagination into
// GET /api/clients query params instead of sorting in the browser.
$("#clients thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.sort;
  if (state.sort.key === key) {
    if (state.sort.dir === 1) state.sort.dir = -1;
    else state.sort = { key: null, dir: 1 };   // third click clears sorting
  } else {
    state.sort = { key, dir: 1 };
  }
  renderClients();
});

/* ---- Bulk actions ---- */

// Bulk reset does NOT force by default — a machine with an active iSCSI
// session is presumably in use. Session-blocked ids get an explicit forced
// retry offer afterwards, same as before, just via modal instead of confirm().
$("#bulk-reset").addEventListener("click", async () => {
  const ids = [...state.selected];
  const ok = await confirmModal("Bulk reset", `<p>Reset ${ids.length} client(s) to their golden snapshot? Machines with an active session are skipped (you'll be offered a force pass).</p>`, { confirmText: "Reset" });
  if (!ok) return;
  let done = 0, fail = 0; const stuck = [];
  for (const id of ids) {
    try { await api("POST", `/api/clients/${id}/reset`, {}); done++; }
    catch (e) { if (/session/i.test(e.message)) stuck.push(id); else fail++; }
  }
  toast(`Reset ${done} ok, ${fail} failed${stuck.length ? `, ${stuck.length} skipped (active session)` : ""}`, fail ? "err" : "ok");
  loadClients();
  if (stuck.length) {
    const force = await confirmModal("Force reset stuck", `<p>${stuck.length} client(s) have an active session. Their disks will be destroyed while in use.</p>`, { danger: true, confirmText: `Force reset ${stuck.length}` });
    if (!force) return;
    let fOk = 0, fFail = 0;
    for (const id of stuck) {
      try { await api("POST", `/api/clients/${id}/reset`, { force: true }); fOk++; } catch (e) { fFail++; }
    }
    toast(`Force reset ${fOk} ok, ${fFail} failed`, fFail ? "err" : "ok");
    loadClients();
  }
});

$("#bulk-retire").addEventListener("click", async () => {
  const ids = [...state.selected];
  const names = ids.map((id) => { const c = state.clients.find((x) => String(x.id) === id); return c ? c.name : id; });
  const typed = await openModal({
    title: `Retire ${ids.length} client(s)`,
    bodyHTML: `<p>Deletes targets, extents and zvols for: <b>${esc(names.join(", "))}</b>.</p>`,
    danger: true, confirmText: "Retire all", typeToConfirm: "retire",
  });
  if (!typed) return;
  let done = 0, fail = 0; const stuck = [];
  for (const id of ids) {
    try { await api("DELETE", `/api/clients/${id}`); done++; }
    catch (e) { if (/session/i.test(e.message)) stuck.push(id); else fail++; }
  }
  toast(`Retired ${done} ok, ${fail} failed${stuck.length ? `, ${stuck.length} skipped (active session)` : ""}`, fail ? "err" : "ok");
  state.selected.clear();
  loadClients();
  if (stuck.length) {
    const force = await confirmModal("Force retire stuck", `<p>${stuck.length} client(s) have an active session — they are running right now.</p>`, { danger: true, confirmText: `Force retire ${stuck.length}` });
    if (!force) return;
    let fOk = 0, fFail = 0;
    for (const id of stuck) {
      try { await api("DELETE", `/api/clients/${id}`, { force: true }); fOk++; } catch (e) { fFail++; }
    }
    toast(`Force retired ${fOk} ok, ${fFail} failed`, fFail ? "err" : "ok");
    loadClients();
  }
});

async function bulkNightly(enabled) {
  const ids = [...state.selected];
  let done = 0, fail = 0;
  for (const id of ids) {
    try { await api("POST", `/api/clients/${id}/nightly-reset`, { enabled }); done++; } catch (e) { fail++; }
  }
  toast(`Nightly ${enabled ? "enabled" : "disabled"} for ${done} client(s)${fail ? `, ${fail} failed` : ""}`, fail ? "err" : "ok");
  loadClients();
}
$("#bulk-nightly-on").addEventListener("click", () => bulkNightly(true));
$("#bulk-nightly-off").addEventListener("click", () => bulkNightly(false));

$("#bulk-rebase-pick").addEventListener("change", async (e) => {
  const snap = e.target.value;
  e.target.value = "";
  if (!snap) return;
  const ids = [...state.selected].map(Number);
  const ok = await confirmModal("Bulk rebase", `<p>Rebase ${ids.length} selected client(s) onto <b class="mono">${esc(snap)}</b>? Their current disks are wiped and re-cloned.</p>`, { confirmText: "Rebase" });
  if (!ok) return;
  try {
    const r = await api("POST", "/api/golden/bulk-rebase", { clientIds: ids, goldenSnapshot: snap, force: false });
    const results = r.results || [];
    const stuck = results.filter((x) => !x.ok && /session/i.test(x.error || "")).map((x) => x.id);
    const fail = results.filter((x) => !x.ok && !stuck.includes(x.id)).length;
    toast(`Rebased ${results.length - fail - stuck.length} ok, ${fail} failed${stuck.length ? `, ${stuck.length} skipped (active session)` : ""}`, fail ? "err" : "ok");
    loadClients();
    if (stuck.length) {
      const force = await confirmModal("Force rebase stuck", `<p>${stuck.length} client(s) have an active session.</p>`, { danger: true, confirmText: `Force rebase ${stuck.length}` });
      if (!force) return;
      const r2 = await api("POST", "/api/golden/bulk-rebase", { clientIds: stuck, goldenSnapshot: snap, force: true });
      const fail2 = (r2.results || []).filter((x) => !x.ok).length;
      toast(`Force rebased ${(r2.results || []).length - fail2} ok, ${fail2} failed`, fail2 ? "err" : "ok");
      loadClients();
    }
  } catch (err) { toast(err.message, "err"); }
});

/* ---- New client / bulk import ---- */

$("#new-client").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, body = { name: f.name.value.trim(), mac: f.mac.value.trim() };
  try {
    await api("POST", "/api/clients", body);
    f.reset();
    toast(`Created ${body.name}`);
    loadClients();
  } catch (err) { toast(err.message, "err"); }
});

$("#bulk-import-btn").addEventListener("click", async () => {
  const fileInput = $("#bulk-import-file");
  const resultsEl = $("#bulk-import-results");
  if (!fileInput.files[0]) { toast("Choose a CSV file first", "err"); return; }
  const text = await fileInput.files[0].text();
  try {
    const r = await api("POST", "/api/clients/bulk-import", { csv: text });
    const results = r.results || [];
    const ok = results.filter((x) => x.ok).length;
    const fail = results.length - ok;
    toast(`Imported ${ok} ok, ${fail} failed`, fail ? "err" : "ok");
    resultsEl.innerHTML = "<pre>" + esc(results.map((x) =>
      `row ${x.row}: ${x.name} (${x.mac}) — ${x.ok ? "ok" : x.error}`).join("\n")) + "</pre>";
    fileInput.value = "";
    loadClients();
  } catch (err) { toast(err.message, "err"); }
});

/* ========================= Detail drawer ================================ */

let drawerClientId = null;

function closeDrawer() {
  drawerClientId = null;
  $("#drawer-root").classList.remove("open");
}
$("#drawer-root .scrim").addEventListener("click", closeDrawer);

function lineageHTML(client, events) {
  // Snapshot lineage: which gold-vN this clone came from and every reprovision
  // since, derived from the client's own audit trail (create/reset/rebase).
  const hops = events.filter((e) => /^client\.(create|reset|rebase)$/.test(e.action)).reverse();
  if (!hops.length) return `<div class="muted">No provisioning history recorded.</div>`;
  return hops.map((e) => {
    const after = safeJson(e.after_json) || {};
    const verb = e.action.split(".")[1];
    const snap = after.golden_snapshot || client.golden_snapshot;
    return `<div class="evt"><div>${esc(verb)} → <b class="mono">${esc(snap)}</b></div>
      <div class="when">${esc((e.ts || "").replace("T", " ").slice(0, 19))}</div></div>`;
  }).join("");
}

async function openDrawer(id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  drawerClientId = id;
  const drawer = $("#drawer-root .drawer");
  drawer.innerHTML = `
    <header>
      <span class="name">${esc(c.name)}</span>
      ${statusBadge(c.status)}
      <button data-close>✕</button>
    </header>
    <div class="content">
      <div class="kv">
        <span class="k">MAC</span><span class="mono">${esc(c.mac)}</span>
        <span class="k">Zvol</span><span class="mono">${esc(c.zvol)}</span>
        <span class="k">Target</span><span class="mono">${esc(c.target_name)}</span>
        <span class="k">Golden</span><span class="mono">${esc(c.golden_snapshot)}</span>
        <span class="k">Space</span><span>${fmtBytes(c.space_used_bytes)}</span>
        <span class="k">Last boot</span><span>${fmtTime(c.last_boot_at)}</span>
        <span class="k">Created</span><span>${fmtTime(c.created_at)}</span>
        <span class="k">Flags</span><span>${c.boot_golden_once ? '<span class="tag toggle-on">golden-once</span> ' : ""}${c.nightly_reset ? '<span class="tag">nightly</span>' : ""}</span>
      </div>
      <h2>Snapshot lineage</h2>
      <div data-lineage><div class="skel" style="height:40px"></div></div>
      <h2>Session history</h2>
      <div class="muted">Per-session history lands with the sessions table (Phase 2); this panel will list start/end/duration here.</div>
      <h2>Audit history</h2>
      <div data-drawer-events><div class="skel" style="height:80px"></div></div>
    </div>`;
  drawer.querySelector("[data-close]").addEventListener("click", closeDrawer);
  $("#drawer-root").classList.add("open");
  await refreshDrawerEvents();
}

async function refreshDrawerEvents() {
  if (drawerClientId == null) return;
  const c = state.clients.find((x) => x.id === drawerClientId);
  let events = [];
  try { events = await api("GET", `/api/events?client_id=${drawerClientId}&limit=100`); } catch (e) { return; }
  const evRoot = $("#drawer-root [data-drawer-events]");
  const linRoot = $("#drawer-root [data-lineage]");
  if (!evRoot || !linRoot) return;
  linRoot.innerHTML = c ? lineageHTML(c, events) : "";
  evRoot.innerHTML = events.length ? events.map((e) => {
    const failed = /fail|error|rollback/i.test(e.action);
    return `<div class="evt${failed ? " fail" : ""}">
      <div><span class="tag">${esc(e.action)}</span></div>
      <div class="when">${esc((e.ts || "").replace("T", " ").slice(0, 19))} · ${esc(e.actor || "system")}</div>
    </div>`;
  }).join("") : '<div class="muted">No events for this client.</div>';
}

/* ======================= Golden Build Mode =============================
 * Distinct from Adopt: arming a MAC sanhooks it directly into the LIVE
 * golden zvol (no clone), so its writes land permanently on the image every
 * future client is cloned from. Status is polled (state.goldenBuild) and
 * drives both the Golden-tab banner and the discovered-list disabled state.
 */

async function goldenBuildArmFlow(mac) {
  if (state.goldenBuild) {
    toast(`Golden Build Mode is already armed for ${state.goldenBuild.mac}. End it first.`, "err");
    return;
  }
  const vals = await openModal({
    title: "Boot into Golden Build Mode",
    danger: true,
    confirmText: "Arm Golden Build Mode",
    bodyHTML: `
      <p><b style="color:var(--amber)">This is not Adopt.</b> Machine
      <b class="mono" style="color:var(--text)">${esc(mac)}</b> will boot with
      <b>direct write access to the live golden image</b> — <b>not</b> a clone.
      Anything it changes lands permanently on <span class="mono">win-golden</span>
      and every client cloned from it afterward.</p>
      <p>Only one machine can be armed at a time. The session auto-expires after
      the duration below (expiry stops future boots but can't disconnect a live
      session).</p>`,
    fields: [{ name: "duration", label: "Duration (minutes)", value: "240", placeholder: "240" }],
  });
  if (!vals) return;
  const body = { mac };
  const dur = parseInt(vals.duration, 10);
  if (Number.isInteger(dur) && dur > 0) body.duration_minutes = dur;
  try {
    const session = await api("POST", "/api/golden-build/arm", body);
    state.goldenBuild = session;
    toast(`Golden Build Mode armed for ${session.mac}`, "ok");
    renderGoldenBuildBanner();
    applyGoldenBuildDisabled();
    loadDiscovered();
  } catch (err) {
    toast(err.message, "err");
  }
}

async function loadGoldenBuildStatus() {
  try {
    const r = await api("GET", "/api/golden-build/status");
    state.goldenBuild = (r && r.active) || null;
  } catch (e) { return; }
  renderGoldenBuildBanner();
  applyGoldenBuildDisabled();
}

function fmtRemaining(expiresAt) {
  const ms = new Date(expiresAt) - Date.now();
  if (isNaN(ms)) return "—";
  if (ms <= 0) return "expiring…";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60, s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function renderGoldenBuildBanner() {
  const root = $("#golden-build-banner");
  if (!root) return;
  const gb = state.goldenBuild;
  if (!gb) { root.innerHTML = ""; return; }
  root.innerHTML = `<div class="gb-banner">
    <span class="icon">⚠️</span>
    <div>
      <div class="headline">Golden Build Mode is ACTIVE</div>
      <div class="detail">Machine <span class="mono">${esc(gb.mac)}</span> has direct write access to the live golden image. Every client cloned or reset after this session inherits its changes.</div>
    </div>
    <span class="spacer"></span>
    <div class="detail">Auto-expires in <span class="remain">${esc(fmtRemaining(gb.expires_at))}</span></div>
    <button class="danger" id="gb-end">End session</button>
  </div>`;
  const endBtn = $("#gb-end");
  if (endBtn) endBtn.addEventListener("click", goldenBuildEndFlow);
}

async function goldenBuildEndFlow() {
  const ok = await confirmModal("End Golden Build session",
    `<p>Stop serving the golden-build boot script. Note: if the machine is currently connected, this does <b>not</b> disconnect its live iSCSI session — it only prevents future golden-build boots.</p>`,
    { danger: true, confirmText: "End session" });
  if (!ok) return;
  try {
    await api("POST", "/api/golden-build/end");
    state.goldenBuild = null;
    toast("Golden Build Mode ended", "ok");
    renderGoldenBuildBanner();
    applyGoldenBuildDisabled();
    loadDiscovered();
  } catch (err) { toast(err.message, "err"); }
}

// Only one session at a time, so once armed, every "Boot into Golden Build
// Mode" button is disabled until the session ends (drives the UI off the same
// active-session query the backend enforces the invariant with).
function applyGoldenBuildDisabled() {
  const active = !!state.goldenBuild;
  for (const btn of $$('#discovered-body button[data-act="golden-build"]')) {
    btn.disabled = active;
    btn.title = active ? `Golden Build Mode already armed for ${state.goldenBuild.mac}` : "";
  }
}

/* ============================ Golden tab ================================ */

async function loadGolden() {
  await loadGoldenBuildStatus();
  let snaps = [];
  try { snaps = await api("GET", "/api/golden/snapshots"); } catch (e) { return; }
  state.goldenNames = snaps.map((s) => s.name);
  // Keep the bulk-rebase picker in sync with available snapshots.
  $("#bulk-rebase-pick").innerHTML = '<option value="">Rebase selected…</option>' +
    state.goldenNames.map((g) => `<option>${esc(g)}</option>`).join("");
  const body = $("#golden-body");
  body.innerHTML = "";
  if (!snaps.length) {
    $("#golden-empty").innerHTML = `<div class="empty">
      <div class="big">No golden image yet</div>
      <div>FleetDeck clones every client from a snapshot of the golden zvol.<br>
      Prepare the golden Windows image, then promote its first version.</div>
      <button class="accent" id="empty-promote-cta">Promote first golden version</button>
    </div>`;
    const cta = $("#empty-promote-cta");
    if (cta) cta.addEventListener("click", promoteFlow);
    return;
  }
  $("#golden-empty").innerHTML = "";
  for (const s of snaps) {
    const on = (s.clients || []).map((c) => esc(c.name)).join(", ") || '<span class="muted">none</span>';
    const tr = el("tr");
    tr.innerHTML = `<td class="mono">${esc(s.name)}</td><td>${fmtBytes(s.used)}</td>
      <td>${on} <span class="muted">(${(s.clients || []).length})</span></td>
      <td><button data-snap="${esc(s.name)}" data-act="bulk-rebase">Rebase stragglers here</button></td>`;
    body.appendChild(tr);
  }
}

$("#golden-body").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || b.dataset.act !== "bulk-rebase") return;
  const snap = b.dataset.snap;
  try { if (!state.clients.length) state.clients = await api("GET", "/api/clients"); } catch (er) {}
  const ids = state.clients.filter((c) => c.golden_snapshot !== snap).map((c) => c.id);
  if (!ids.length) { toast("All clients already on " + snap); return; }
  const ok = await confirmModal("Rebase stragglers", `<p>Rebase ${ids.length} client(s) onto <b class="mono">${esc(snap)}</b>?</p>`, { confirmText: "Rebase" });
  if (!ok) return;
  try {
    // Don't force by default — a session-active machine is presumably in use.
    const r = await api("POST", "/api/golden/bulk-rebase", { clientIds: ids, goldenSnapshot: snap, force: false });
    const results = r.results || [];
    const stuck = results.filter((x) => !x.ok && /session/i.test(x.error || "")).map((x) => x.id);
    const fail = results.filter((x) => !x.ok && !stuck.includes(x.id)).length;
    toast(`Rebased ${results.length - fail - stuck.length} ok, ${fail} failed${stuck.length ? `, ${stuck.length} skipped (active session)` : ""}`, fail ? "err" : "ok");
    if (stuck.length) {
      const force = await confirmModal("Force rebase stuck", `<p>${stuck.length} client(s) have an active session. Force rebase them too?</p>`, { danger: true, confirmText: "Force rebase" });
      if (force) {
        const r2 = await api("POST", "/api/golden/bulk-rebase", { clientIds: stuck, goldenSnapshot: snap, force: true });
        const fail2 = (r2.results || []).filter((x) => !x.ok).length;
        toast(`Force rebased ${(r2.results || []).length - fail2} ok, ${fail2} failed`, fail2 ? "err" : "ok");
      }
    }
    loadClients(); loadGolden();
  } catch (err) { toast(err.message, "err"); }
});

async function promoteFlow() {
  const vals = await openModal({
    title: "Promote golden",
    bodyHTML: `<p>Snapshots the golden zvol as the next <span class="mono">gold-vN</span> and makes it the default for new clients/resets.</p>`,
    confirmText: "Promote",
    fields: [{ name: "label", label: "Version label (blank = auto vN+1)", placeholder: "v7" }],
  });
  if (!vals) return;
  try {
    const label = vals.label.trim();
    const r = await api("POST", "/api/golden/promote", label ? { versionLabel: label } : {});
    toast("Promoted → " + (r && r.snapshot));
    loadGolden();
  } catch (err) { toast(err.message, "err"); }
}
$("#promote").addEventListener("click", promoteFlow);

/* =========================== Reconcile tab ============================== */

async function loadReconcile() {
  let data = { trueNasOnly: [], dbOnly: [] };
  try { data = await api("GET", "/api/reconcile/scan"); }
  catch (err) { toast(err.message, "err"); }

  const tBody = $("#reconcile-truenas-body");
  tBody.innerHTML = data.trueNasOnly.length ? "" : '<tr><td colspan="3" class="muted">None</td></tr>';
  for (const t of data.trueNasOnly) {
    const tr = el("tr");
    tr.innerHTML = `<td class="mono">${esc(t.targetName)}</td><td class="mono muted">${esc(t.zvol || "—")}</td>
      <td><button class="accent" data-act="import" data-target="${esc(t.targetName)}">Import as client…</button></td>`;
    tBody.appendChild(tr);
  }

  const dBody = $("#reconcile-db-body");
  dBody.innerHTML = data.dbOnly.length ? "" : '<tr><td colspan="4" class="muted">None</td></tr>';
  for (const c of data.dbOnly) {
    const tr = el("tr");
    tr.innerHTML = `<td>${esc(c.name)}</td><td class="mono">${esc(c.mac)}</td><td class="mono muted">${esc(c.target_name)}</td>
      <td><button class="danger" data-act="remove-orphan" data-id="${c.id}" data-name="${esc(c.name)}">Remove stale row</button></td>`;
    dBody.appendChild(tr);
  }
}

$("#reconcile-scan").addEventListener("click", loadReconcile);

$("#reconcile").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.act === "import") {
    const targetName = b.dataset.target;
    const vals = await openModal({
      title: `Import target "${targetName}"`, confirmText: "Import",
      fields: [
        { name: "name", label: "Client name", placeholder: "pc-07" },
        { name: "mac", label: "MAC address", placeholder: "aa:bb:cc:dd:ee:ff" },
      ],
    });
    if (!vals || !vals.name.trim() || !vals.mac.trim()) return;
    try {
      await api("POST", "/api/reconcile/import", { name: vals.name.trim(), mac: vals.mac.trim(), targetName });
      toast(`Imported ${vals.name.trim()}`);
      loadReconcile(); loadClients();
    } catch (err) { toast(err.message, "err"); }
  } else if (b.dataset.act === "remove-orphan") {
    const name = b.dataset.name;
    const typed = await openModal({
      title: `Remove stale row: ${name}`,
      bodyHTML: `<p>Removes only the FleetDeck record — nothing on TrueNAS is touched.</p>`,
      danger: true, confirmText: "Remove", typeToConfirm: name,
    });
    if (!typed) return;
    try {
      await api("POST", "/api/reconcile/remove-orphan-client", { clientId: b.dataset.id });
      toast(`Removed stale row ${name}`);
      loadReconcile();
    } catch (err) { toast(err.message, "err"); }
  }
});

/* ============================= Setup tab ================================ */

function bfBadge(entry) {
  return entry && entry.present
    ? `<span class="tag toggle-on">present</span>`
    : `<span class="tag" style="color:var(--red);border-color:var(--red)">missing</span>`;
}

function bfSize(entry) {
  return entry && entry.present ? fmtBytes(entry.size) : "—";
}

async function loadSetup() {
  let s = null;
  try { s = await api("GET", "/api/bootfiles/status"); } catch (e) { return; }

  const install = s.install || {};
  const installLabel = install.kind === "swm"
    ? `install.swm split media (${install.swmParts} parts)`
    : install.kind ? `install.${install.kind}` : null;
  const rows = [
    ["snponly.efi", `TFTP (udp/${s.tftp.port}${s.tftp.enabled ? "" : ", disabled"}) — what DHCP points firmware at`, s.tftp.snponly],
    ["wimboot", "chains WinPE over HTTP", s.http.wimboot],
    ["media/Boot/BCD", "WinPE boot configuration", s.http.bcd],
    ["media/Boot/boot.sdi", "WinPE RAM-disk", s.http.bootSdi],
    ["media/sources/boot.wim", "WinPE image", s.http.bootWim],
    [installLabel || "media/sources/install.wim|esd|swm", "Windows install image", install.kind ? { present: true, size: null } : { present: false }],
  ];
  $("#bootfiles-body").innerHTML = rows.map(([name, purpose, entry]) => `
    <tr><td class="mono">${esc(name)}</td><td class="muted">${esc(purpose)}</td>
    <td>${bfBadge(entry)}</td><td>${entry && entry.size != null ? esc(bfSize(entry)) : "—"}</td></tr>`).join("");

  // Split-WIM media changes how the golden image must be applied (Windows
  // Setup silently can't install from .swm) — surface it loudly here since
  // it drives the generated deploy script.
  const note = $("#bf-media-note");
  if (install.kind === "swm") {
    note.innerHTML = `⚠️ <span style="color:var(--amber)">Split .swm media detected (${install.swmParts} parts).</span> Windows Setup cannot install from split images — the generated deploy script will use <span class="mono">dism /Apply-Image /SWMFile:</span> automatically.`;
  } else if (install.kind) {
    note.textContent = `Single ${installLabel} detected — the deploy script will use dism /Apply-Image directly.`;
  } else {
    note.textContent = "No install image staged yet. Copy the Windows ISO contents into media/ (use the SMB share button, then copy from any machine on the LAN).";
  }
  if (s.smb && !s.smb.supported) $("#bf-smb-share").title = "Not supported by this TrueNAS build — create the share in the TrueNAS UI";

  // Live "did DHCP work" indicators: amber pulse while waiting, green once a
  // real request has arrived. FleetDeck detects these itself — the honest
  // confirmation that the manual DHCP step was done right.
  const act = s.activity || {};
  const ind = (label, a) => {
    const seen = a && a.first;
    return `<div class="tile" style="min-width:220px${seen ? "" : ";border-color:var(--amber)"}">
      <div class="n" style="font-size:13px;color:${seen ? "var(--green)" : "var(--amber)"}">
        ${seen ? "✓ " + esc(label) + " request seen" : "… waiting for first " + esc(label) + " request"}</div>
      <div class="l">${seen ? "first " + esc(fmtTime(a.first)) + " · last " + esc(fmtTime(a.last)) : "no " + esc(label) + " boot traffic yet"}</div>
    </div>`;
  };
  $("#boot-activity").innerHTML = ind("TFTP", act.tftp) + ind("HTTP /boot", act.http);
}

/* ---- TrueNAS setup wizard ---- */

function wizardStepRow(step) {
  const icon = step.supported === false
    ? '<span class="tag">API n/a</span>'
    : step.ok
      ? '<span class="tag toggle-on">✓</span>'
      : '<span class="tag" style="color:var(--amber);border-color:var(--amber)">todo</span>';
  let action = "";
  if (step.kind === "rpc" && !step.ok && step.supported !== false) {
    action = `<button class="accent" data-wizard-apply="${esc(step.id)}">Create</button>`;
  } else if (step.id === "snponly") {
    action = `<button data-wizard-snponly-cmd>Build command</button>
      <label style="display:inline-block"><input type="file" id="snponly-upload" style="display:none">
      <button data-wizard-snponly-upload>Upload prebuilt</button></label>`;
  }
  return `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--border)">
    ${icon}
    <b style="min-width:230px">${esc(step.title)}</b>
    <span class="muted" style="flex:1">${esc(step.detail || "")}</span>
    ${action}
  </div>`;
}

async function loadWizard() {
  let s = null;
  try { s = await api("GET", "/api/setup/status"); } catch (e) { return; }
  const root = $("#wizard-steps");
  if (!s.adapterAvailable) {
    root.innerHTML = '<div class="muted">TrueNAS is unreachable — the wizard needs a live connection for its checks. It will populate once reconnected.</div>'
      + s.steps.filter((x) => x.kind === "manual").map(wizardStepRow).join("");
    return;
  }
  root.innerHTML = (s.dryRun ? '<div class="muted" style="margin-bottom:6px">DRY_RUN=1 — Create buttons show the exact would-be RPCs and execute nothing.</div>' : "")
    + s.steps.map(wizardStepRow).join("");
}

$("#wizard-steps").addEventListener("click", async (e) => {
  const applyBtn = e.target.closest("[data-wizard-apply]");
  if (applyBtn) {
    const stepId = applyBtn.dataset.wizardApply;
    try {
      // Fetch the exact plan first so the confirm modal shows real payloads.
      const preview = await api("POST", `/api/setup/apply/${stepId}`, { planOnly: true });
      if (preview.already) { toast(preview.detail); loadWizard(); return; }
      if (preview.supported === false) { toast(preview.detail, "err"); return; }
      const isGolden = stepId === "golden_zvol";
      const vals = await openModal({
        title: `Create: ${stepId}`,
        confirmText: "Create",
        bodyHTML: `<p>FleetDeck will run these TrueNAS RPCs, in order:</p>
          <pre>${esc(JSON.stringify(preview.plan, null, 2))}</pre>
          ${isGolden ? '<p>Adjust the size below if needed (the plan updates server-side).</p>' : ""}`,
        fields: isGolden ? [{ name: "sizeGib", label: "Golden zvol size (GiB)", value: "256" }] : null,
      });
      if (!vals) return;
      const body = isGolden ? { sizeGib: parseInt(vals.sizeGib, 10) || 256 } : {};
      const result = await api("POST", `/api/setup/apply/${stepId}`, body);
      if (result.dryRun) {
        await openModal({
          title: "DRY_RUN: nothing executed",
          bodyHTML: `<p>These RPCs were logged but not run:</p><pre>${esc(JSON.stringify(result.payloads, null, 2))}</pre>`,
          confirmText: "OK",
        });
      } else if (result.already) {
        toast(result.detail);
      } else {
        toast(`${stepId}: created`);
      }
      loadWizard(); loadSetup();
    } catch (err) { toast(err.message, "err"); }
    return;
  }

  if (e.target.closest("[data-wizard-snponly-cmd]")) {
    try {
      const b = await api("GET", "/api/setup/snponly-build");
      await openModal({
        title: "Build snponly.efi (run on any Docker host)",
        bodyHTML: `<p>FleetDeck can't compile this (needs a build toolchain) — copy and run this block; it embeds the chain URL <span class="mono">${esc(b.chainUrl)}</span> and drops the binary straight into the TFTP directory:</p>
          <pre id="snponly-cmd-pre" style="max-height:260px;overflow:auto">${esc(b.command)}</pre>`,
        confirmText: "Copy to clipboard",
      }).then((ok) => {
        if (ok) navigator.clipboard.writeText(b.command).then(() => toast("Build command copied"));
      });
    } catch (err) { toast(err.message, "err"); }
    return;
  }

  if (e.target.closest("[data-wizard-snponly-upload]")) {
    e.preventDefault();
    $("#snponly-upload").click();
  }
});

$("#wizard-steps").addEventListener("change", async (e) => {
  if (e.target.id !== "snponly-upload" || !e.target.files[0]) return;
  try {
    const buf = await e.target.files[0].arrayBuffer();
    const res = await fetch("/api/setup/upload-snponly", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/octet-stream" }, body: buf,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    toast(`snponly.efi uploaded (${fmtBytes(data.size)})`);
    loadWizard(); loadSetup();
  } catch (err) { toast(err.message, "err"); }
  e.target.value = "";
});

$("#diag-run").addEventListener("click", async () => {
  const root = $("#diag-results");
  root.innerHTML = '<div class="muted">Running…</div>';
  try {
    const r = await api("GET", "/api/setup/diagnostics");
    root.innerHTML = (r.checks || []).map((c) => `
      <div class="row" style="padding:4px 0">
        <span class="tag ${c.ok ? (c.warn ? "" : "toggle-on") : ""}" style="${c.ok ? (c.warn ? "color:var(--amber);border-color:var(--amber)" : "") : "color:var(--red);border-color:var(--red)"}">${c.ok ? (c.warn ? "warn" : "pass") : "fail"}</span>
        <span class="mono muted" style="min-width:110px">${esc(c.id)}</span>
        <span style="flex:1">${esc(c.detail)}</span>
      </div>`).join("");
  } catch (err) { root.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
});

$("#bf-refresh").addEventListener("click", () => { loadSetup(); loadWizard(); });

$("#bf-download-wimboot").addEventListener("click", async () => {
  const btn = $("#bf-download-wimboot");
  btn.disabled = true;
  try {
    const r = await api("POST", "/api/bootfiles/download-wimboot");
    toast(`wimboot downloaded (${fmtBytes(r.size)})`);
    loadSetup();
  } catch (err) { toast(err.message, "err"); }
  btn.disabled = false;
});

$("#bf-smb-share").addEventListener("click", async () => {
  try {
    const r = await api("POST", "/api/bootfiles/smb-share");
    if (r.dryRun) {
      await openModal({
        title: "DRY_RUN: share not created",
        bodyHTML: `<p>DRY_RUN=1 — this is the exact sharing.smb.create payload that would run:</p><pre>${esc(JSON.stringify(r.payload, null, 2))}</pre>`,
        confirmText: "OK", cancelText: "Close",
      });
    } else if (r.existing) {
      toast(`SMB share "${r.share.name}" already exists`);
    } else {
      toast("SMB share created — copy the ISO contents into its media/ folder");
    }
    loadSetup();
  } catch (err) { toast(err.message, "err"); }
});

/* ============================ Settings tab ============================== */

// Seed defaults for keys the backend reads via getSetting(db,key,default) so
// they're visible/editable even before anything has ever written a row for
// them (otherwise these tunables would be invisible until set once by hand).
const SETTINGS_DEFAULTS = {
  iqn_prefix: "iqn.2005-10.org.freenas.ctl",
  ipxe_template: "",
  golden_snapshot: "",
  nightly_reset_cron: "0 4 * * *",
  wol_enabled: "0",
  wol_broadcast: "255.255.255.255",
  pool_alert_threshold_pct: "85",
  safety_snapshot_retention_days: "3",
  // Golden Build Mode: the WinPE chain script. FleetDeck now generates and
  // serves one itself at /boot/files/winpe.ipxe — point this at
  // http://<this-host>:<port>/boot/files/winpe.ipxe (an external URL still
  // works if you keep WinPE elsewhere). Must be set before arming.
  winpe_chain_url: "",
  golden_build_default_minutes: "240",
  // TrueNAS-side path of the dataset mounted at /data (e.g.
  // /mnt/Main_pool/apps/fleetdeck) — needed to create the SMB staging share.
  bootfiles_host_path: "",
  bootfiles_smb_share_name: "fleetdeck-bootfiles",
};
async function loadSettings() {
  let s = {};
  try { s = await api("GET", "/api/settings"); } catch (e) { return; }
  const merged = { ...SETTINGS_DEFAULTS, ...s };
  const g = $("#settings-grid"); g.innerHTML = "";
  for (const k of Object.keys(merged)) {
    g.appendChild(el("label", { textContent: k }));
    const inp = el("input", { className: "mono", value: merged[k] == null ? "" : merged[k] });
    inp.dataset.key = k;
    g.appendChild(inp);
  }
}
$("#save-settings").addEventListener("click", async () => {
  const patch = {};
  for (const i of $$("#settings-grid input")) patch[i.dataset.key] = i.value;
  try { await api("PUT", "/api/settings", patch); toast("Settings saved"); }
  catch (err) { toast(err.message, "err"); }
});

$("#test-connection").addEventListener("click", async () => {
  const msg = $("#tc-msg");
  msg.textContent = "Testing…"; msg.className = "msg";
  try {
    const r = await api("POST", "/api/truenas/test-connection");
    if (r.ok) { msg.textContent = `Connected (${r.methodsResolved} methods resolved)`; msg.className = "msg ok"; }
    else { msg.textContent = "Failed: " + r.error; msg.className = "msg err"; }
  } catch (err) { msg.textContent = err.message; msg.className = "msg err"; }
});

/* ============================= Audit tab ================================ */

function eventRow(ev) {
  const tr = el("tr");
  tr.innerHTML = `<td class="mono muted">${esc((ev.ts || "").toString().replace("T", " ").slice(0, 19))}</td>
    <td><span class="tag">${esc(ev.action)}</span></td><td>${esc(ev.client_id == null ? "—" : ev.client_id)}</td>
    <td class="muted">${esc(ev.actor || "—")}</td>
    <td><button data-id="${ev.id}">details</button></td>`;
  const detail = el("tr"); detail.style.display = "none";
  detail.innerHTML = `<td colspan="5"><pre>${esc(JSON.stringify({ before: safeJson(ev.before_json), after: safeJson(ev.after_json) }, null, 2))}</pre></td>`;
  tr.querySelector("button").addEventListener("click", () => {
    detail.style.display = detail.style.display === "none" ? "" : "none";
  });
  return [tr, detail];
}

function prependEventRow(ev) {
  const body = $("#events-body");
  const [tr, detail] = eventRow(ev);
  body.insertBefore(detail, body.firstChild);
  body.insertBefore(tr, detail);
}

async function loadEvents() {
  let list = [];
  try { list = await api("GET", "/api/events"); } catch (e) { return; }
  const body = $("#events-body"); body.innerHTML = "";
  for (const ev of list) {
    const [tr, detail] = eventRow(ev);
    body.appendChild(tr); body.appendChild(detail);
  }
}

/* ========================== Command palette ============================= */

function paletteItems() {
  const nav = [
    { kind: "nav", label: "Go to Dashboard", run: () => switchView("dashboard") },
    { kind: "nav", label: "Go to Golden", run: () => switchView("golden") },
    { kind: "nav", label: "Go to Reconcile", run: () => switchView("reconcile") },
    { kind: "nav", label: "Go to Setup", run: () => switchView("setup") },
    { kind: "nav", label: "Go to Settings", run: () => switchView("settings") },
    { kind: "nav", label: "Go to Audit", run: () => switchView("events") },
  ];
  const actions = [
    { kind: "action", label: "Promote golden…", run: () => { switchView("golden"); promoteFlow(); } },
    { kind: "action", label: "Create client…", run: () => { switchView("dashboard"); $("#new-client [name=name]").focus(); } },
    { kind: "action", label: "Reset selected", run: () => { switchView("dashboard"); $("#bulk-reset").click(); } },
    { kind: "action", label: "Scan for mismatches", run: () => { switchView("reconcile"); loadReconcile(); } },
    { kind: "action", label: "Test TrueNAS connection", run: () => { switchView("settings"); $("#test-connection").click(); } },
  ];
  const clients = state.clients.map((c) => ({
    kind: "client", label: `${c.name} (${c.mac})`,
    run: () => { switchView("dashboard"); openDrawer(c.id); },
  }));
  return [...nav, ...actions, ...clients];
}

let paletteOpen = false;

function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  const root = $("#palette-root");
  const overlay = el("div", { className: "overlay" });
  const box = el("div", { className: "palette" });
  box.innerHTML = `<input placeholder="Jump to a client or run a command…" autocomplete="off" spellcheck="false"><div class="results"></div>`;
  overlay.appendChild(box);
  root.appendChild(overlay);

  const input = box.querySelector("input");
  const results = box.querySelector(".results");
  let items = [];
  let selIdx = 0;

  const close = () => {
    paletteOpen = false;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = paletteItems().filter((it) => !q || it.label.toLowerCase().includes(q)).slice(0, 12);
    selIdx = Math.min(selIdx, Math.max(0, items.length - 1));
    results.innerHTML = items.length ? items.map((it, i) =>
      `<div class="item${i === selIdx ? " sel" : ""}" data-i="${i}"><span class="kind">${esc(it.kind)}</span>${esc(it.label)}</div>`
    ).join("") : `<div class="none">No matches</div>`;
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); selIdx = Math.min(selIdx + 1, items.length - 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); render(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = items[selIdx]; if (it) { close(); it.run(); } }
  };
  document.addEventListener("keydown", onKey, true);
  input.addEventListener("input", () => { selIdx = 0; render(); });
  results.addEventListener("click", (e) => {
    const item = e.target.closest(".item");
    if (item) { const it = items[Number(item.dataset.i)]; close(); if (it) it.run(); }
  });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  render();
  input.focus();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openPalette();
  } else if (e.key === "Escape" && drawerClientId != null && !paletteOpen && !$("#modal-root").firstChild) {
    closeDrawer();
  }
});

/* =============================== Nav ==================================== */

function switchView(v) {
  for (const x of $$("#nav button")) x.classList.toggle("active", x.dataset.view === v);
  for (const x of $$("section")) x.classList.remove("active");
  $("#" + v).classList.add("active");
  $("#sidebar").classList.remove("open");
  if (v === "golden") loadGolden();
  else if (v === "reconcile") loadReconcile();
  else if (v === "setup") { loadSetup(); loadWizard(); }
  else if (v === "settings") loadSettings();
  else if (v === "events") loadEvents();
}
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) switchView(b.dataset.view);
});
$("#burger").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

/* ============================ Login / boot ============================== */

function showLogin() { $("#app").style.display = "none"; $("#login").style.display = "flex"; }
function showApp() { $("#login").style.display = "none"; $("#app").style.display = "block"; }

$("#logout").addEventListener("click", async () => {
  try { await api("POST", "/api/auth/logout"); } catch (e) {}
  if (ws) { try { ws.close(); } catch (e) {} }
  showLogin();
});
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("POST", "/api/auth/login", { password: e.target.password.value });
    e.target.reset(); $("#login-msg").textContent = ""; boot();
  } catch (err) { $("#login-msg").textContent = err.message === "unauthorized" ? "Wrong password" : err.message; }
});

let pollTimer = null;
let goldenBuildTimer = null;
let goldenBuildCountdown = null;
async function boot() {
  renderClients();          // skeletons until data lands
  renderStatTiles(null);
  try {
    const list = await api("GET", "/api/clients");
    showApp();
    state.clients = list;
    state.loadedClientsOnce = true;
    try {
      const snaps = await api("GET", "/api/golden/snapshots");
      state.goldenNames = snaps.map((s) => s.name);
      $("#bulk-rebase-pick").innerHTML = '<option value="">Rebase selected…</option>' +
        state.goldenNames.map((g) => `<option>${esc(g)}</option>`).join("");
    } catch (e) {}
    renderClients();
    renderStatTiles(await loadPoolStatus());
    renderStamp();
    loadDiscovered();
    connectWS();
    // Golden Build status is fetched globally (cheap) so the Golden-tab banner
    // and the discovered-list disabled state stay live regardless of tab, and
    // so expiry is reflected even if nobody is on the Golden tab.
    loadGoldenBuildStatus();
    if (!goldenBuildTimer) goldenBuildTimer = setInterval(loadGoldenBuildStatus, 10000);
    // 1s countdown re-render (text only) while a session is active.
    if (!goldenBuildCountdown) goldenBuildCountdown = setInterval(() => {
      if (state.goldenBuild) renderGoldenBuildBanner();
    }, 1000);
    // Polling fallback: only fetch when the live channel is down; pool usage
    // (no WS message for it) still refreshes on a slow multiple of the tick.
    let tickCount = 0;
    if (!pollTimer) pollTimer = setInterval(() => {
      // Setup tab hosts the live boot-request indicator — poll it so the
      // "waiting for first boot" tile flips green without a manual refresh.
      if ($("#setup").classList.contains("active")) { loadSetup(); return; }
      if (!$("#dashboard").classList.contains("active")) return;
      tickCount += 1;
      if (!state.wsConnected) { loadClients(); loadDiscovered(); }
      else if (tickCount % 6 === 0) loadPoolStatus().then(renderStatTiles);
    }, 10000);
  } catch (e) { /* 401 handled by api() -> showLogin */ }
}
boot();

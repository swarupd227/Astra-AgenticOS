"use strict";

const $ = (s) => document.querySelector(s);
const statusEl = $("#status"), statusText = $("#status-text");
const agentListEl = $("#agent-list");
const convEl = $("#conversation");
const inputEl = $("#input"), sendBtn = $("#send");

let agents = [], activeAgent = null, busy = false, hasMessages = false;
let projects = [], activeProjectId = null;
let threadId = null; // current conversation (server-persisted, gives follow-ups memory)

// ---------- markdown + highlight ----------
if (window.marked) {
  marked.setOptions({ breaks: false, gfm: true });
}
function renderMarkdown(text) {
  if (window.marked) { try { return marked.parse(text); } catch {} }
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre><code>${esc}</code></pre>`;
}
function highlightIn(node) {
  if (!window.hljs) return;
  node.querySelectorAll("pre code:not([data-hl])").forEach((b) => {
    try { hljs.highlightElement(b); } catch {}
    b.setAttribute("data-hl", "1");
  });
}

// ---------- theme ----------
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  $("#hljs-theme").href = t === "light" ? "vendor/hljs-light.css" : "vendor/hljs-dark.css";
  $("#theme-toggle").innerHTML = icon(t === "light" ? "moon" : "sun", 18);
  try { localStorage.setItem("sdlc-theme", t); } catch {}
  // re-highlight existing blocks against new theme
  document.querySelectorAll("pre code[data-hl]").forEach((b) => b.removeAttribute("data-hl"));
  document.querySelectorAll(".md, .step-out").forEach(highlightIn);
}
$("#theme-toggle").onclick = () =>
  setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");

// ---------- boot ----------
function applyStatus(text, cls) {
  statusText.textContent = text;
  statusEl.classList.remove("ok", "warn");
  if (cls) statusEl.classList.add(cls);
}
// Where the server actually runs — decides what "local folder" can mean.
let hostInfo = null;

// A hosted ASTRA cannot see the user's PC, so a Windows path in the folder field
// is always wrong there. Say it up front instead of after a failed submit.
function applyHostHints() {
  const hint = $("#np-local-hint");
  const pathInput = $("#np-path");
  if (!hint || !hostInfo) return;
  const posix = hostInfo.platform !== "win32";
  if (posix) pathInput.placeholder = "/home/data/repos/my-app";
  hint.innerHTML = posix
    ? (hostInfo.cloud
        ? "ASTRA is running <b>on a server</b>, so this must be a folder on that server — it cannot read <code>C:\\…</code> from your PC. For code on your machine, use <b>Git repository</b>."
        : "This must be a folder on the machine running ASTRA (Linux paths, e.g. <code>/srv/code/my-app</code>).")
    : "A folder on the machine running ASTRA, e.g. <code>C:\\src\\my-app</code>.";
  hint.hidden = false;
}

async function refreshHealth() {
  try {
    const h = await (await fetch("/api/health")).json();
    const n = h.mcpTools?.length ?? 0;
    if (h.host) hostInfo = h.host;
    if (h.activeProject) {
      $("#project-name").textContent = h.activeProject.name;
      $("#grounding-chip").innerHTML = icon("database", 14) + " Grounded in " + esc(h.activeProject.name);
    }
    // No key is the one problem the user can fix right here — make the pill a route to Settings.
    if (!h.hasApiKey) {
      applyStatus("Add your API key →", "warn");
      statusEl.classList.add("clickable");
      statusEl.title = "Click to open Settings and paste your Anthropic API key";
      statusEl.onclick = openSettings;
      return h.mcpReady;
    }
    statusEl.classList.remove("clickable");
    statusEl.title = "";
    statusEl.onclick = null;
    if (!h.mcpReady) {
      applyStatus(h.activeProject ? (h.mcpError ? "MCP error" : "indexing…") : "no project", "warn");
      return false;
    }
    applyStatus(`${h.model} · ${n} tools`, "ok");
    return true;
  } catch { applyStatus("backend unreachable", "warn"); return false; }
}

async function boot() {
  $("#brand-mark").innerHTML = icon("logo", 20);
  $("#pj-ico").innerHTML = icon("folder", 16);
  $("#pj-chev").innerHTML = icon("chevron", 15);
  $("#modal-close").innerHTML = icon("x", 16);
  $("#artifacts-btn").insertAdjacentHTML("afterbegin", icon("inbox", 18));
  $("#settings-btn").innerHTML = icon("settings", 18);
  $("#settings-close").innerHTML = icon("x", 16);
  $("#drawer-close").innerHTML = icon("x", 16);
  $("#viewer-close").innerHTML = icon("x", 16);
  $("#send").innerHTML = icon("send", 18);
  $("#nav-toggle").innerHTML = icon("menu", 20);
  $("#dz-ico").innerHTML = icon("upload", 26);
  // Clickable logo → home (UI-04); hamburger toggles the sidebar on small screens (UI-02)
  $("#brand").onclick = goHome;
  $("#nav-toggle").onclick = () => document.body.classList.toggle("nav-open");
  $("#ct-new").onclick = newConversation;
  let saved = "dark"; try { saved = localStorage.getItem("sdlc-theme") || "dark"; } catch {}
  setTheme(saved);
  $("#grounding-chip").innerHTML = icon("database", 14) + " Grounded in this codebase";

  $("#golden-btn").innerHTML = icon("book", 18);
  initProjectUI();
  initGoldenUI();
  initArtifactsUI();
  initSettingsUI();
  $("#new-chat").onclick = newConversation;
  $("#nav-backdrop").onclick = () => document.body.classList.remove("nav-open");

  applyStatus("connecting…", "warn");
  agents = await (await fetch("/api/agents")).json();
  renderAgents();
  await loadProjects();
  // Onboarding differs when hosted (no "local folder" option), so learn where the
  // server runs BEFORE the first render rather than flashing the wrong choice.
  try { hostInfo = (await (await fetch("/api/health")).json()).host || null; } catch {}
  renderWelcome();
  refreshArtifacts();

  let ok = await refreshHealth(), n = 0;
  while (!ok && n++ < 30) { await sleep(1000); ok = await refreshHealth(); }
}

// ---------- projects ----------
function initProjectUI() {
  $("#project-btn").onclick = (e) => { e.stopPropagation(); toggleProjectMenu(); };
  document.addEventListener("click", (e) => {
    if (!$("#project-switch").contains(e.target)) closeProjectMenu();
  });
  // modal wiring
  $("#modal-close").onclick = closeModal;
  $("#np-cancel").onclick = closeModal;
  $("#modal-backdrop").onclick = (e) => { if (e.target === $("#modal-backdrop")) closeModal(); };
  $("#np-create").onclick = submitNewProject;
  document.querySelectorAll("#type-seg .seg-btn").forEach((b) =>
    (b.onclick = () => {
      document.querySelectorAll("#type-seg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
      showTab(b.dataset.type);
    })
  );
  initUploadUI();
}

function showTab(type) {
  $("#field-local").hidden = type !== "local";
  $("#field-git").hidden = type !== "git";
  $("#field-upload").hidden = type !== "upload";
}

// ---------- zip upload ----------
let uploadFile = null;

// fmtSize is defined once, further down. A second copy lived here and was dead —
// function declarations hoist, so the later one had always won.

function setUploadFile(f) {
  const drop = $("#np-drop");
  if (!f) { uploadFile = null; drop.classList.remove("has-file");
    $("#dz-main").innerHTML = "Drop a <b>.zip</b> here, or click to browse";
    $("#dz-sub").textContent = "Zip your solution folder and upload it — nothing needs to be on the server.";
    return;
  }
  if (!/\.zip$/i.test(f.name)) return showModalErr("Please choose a .zip file.");
  const max = (hostInfo && hostInfo.maxUploadMb) || 300;
  if (f.size > max * 1024 * 1024)
    return showModalErr(`That zip is ${(f.size / 1048576).toFixed(0)} MB — the limit is ${max} MB.`);
  uploadFile = f;
  drop.classList.add("has-file");
  $("#dz-main").textContent = f.name;
  $("#dz-sub").textContent = fmtSize(f.size) + " — ready to upload";
  $("#np-error").hidden = true;
  // A zip is usually named after the project, so offer it as the name.
  if (!$("#np-name").value.trim()) $("#np-name").value = f.name.replace(/\.zip$/i, "");
}

function initUploadUI() {
  const drop = $("#np-drop"), input = $("#np-file");
  if (!drop) return;
  drop.onclick = () => input.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
  input.onchange = () => setUploadFile(input.files[0]);
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => setUploadFile(e.dataTransfer.files[0]));
}

// XHR, not fetch — it is the only way to get real upload progress.
function uploadZip(file, name, subPath, onProgress) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ name, subPath: subPath || "" });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/projects/upload?" + qs.toString());
    xhr.setRequestHeader("Content-Type", "application/zip");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let r = {};
      try { r = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && r.ok) resolve(r);
      else reject(new Error(r.error || `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — the connection dropped."));
    xhr.send(file);
  });
}

async function loadProjects() {
  try {
    const d = await (await fetch("/api/projects")).json();
    projects = d.projects || [];
    activeProjectId = d.activeProjectId;
    const active = projects.find((p) => p.id === activeProjectId);
    if (active) $("#project-name").textContent = active.name;
  } catch {}
}

function toggleProjectMenu() {
  const sw = $("#project-switch");
  if (sw.classList.contains("open")) return closeProjectMenu();
  renderProjectMenu();
  sw.classList.add("open");
  $("#project-menu").hidden = false;
}
function closeProjectMenu() {
  $("#project-switch").classList.remove("open");
  $("#project-menu").hidden = true;
}
function renderProjectMenu() {
  const menu = $("#project-menu");
  const items = projects.map((p) => {
    const active = p.id === activeProjectId;
    const unavailable = p.available === false;
    const sub = unavailable
      ? "source not found — cannot open"
      : (p.type === "git" ? (p.repoUrl || "git repo") : p.sourceRoot);
    const del = p.id === "nopcommerce" ? "" :
      `<button class="pm-del" data-del="${esc(p.id)}" title="Remove project">${icon("trash", 15)}</button>`;
    const check = active ? `<span class="pm-check">${icon("check", 16)}</span>` : "";
    return `<div class="pm-item ${active ? "active" : ""} ${unavailable ? "pm-unavailable" : ""}" data-id="${esc(p.id)}" ${unavailable ? 'title="This project\'s code isn\'t on this machine"' : ""}>
      <span class="pm-ico">${icon(p.type === "git" ? "git" : "folder", 15)}</span>
      <span class="pm-meta"><span class="pm-name">${esc(p.name)}</span><span class="pm-sub">${esc(sub)}</span></span>
      ${check}${del}
    </div>`;
  }).join("");
  menu.innerHTML = `<div class="pm-label">Projects</div>${items}
    <div class="pm-new" id="pm-new">${icon("plus", 16)} New project…</div>`;
  menu.querySelectorAll(".pm-item").forEach((el) =>
    (el.onclick = (e) => {
      if (e.target.closest(".pm-del")) return;
      if (el.classList.contains("pm-unavailable")) return; // can't open code that isn't here
      selectProject(el.dataset.id);
    }));
  menu.querySelectorAll(".pm-del").forEach((b) =>
    (b.onclick = (e) => { e.stopPropagation(); deleteProject(b.dataset.del); }));
  $("#pm-new").onclick = () => { closeProjectMenu(); openModal(); };
}

async function selectProject(id) {
  if (id === activeProjectId || busy) { closeProjectMenu(); return; }
  closeProjectMenu();
  const p = projects.find((x) => x.id === id);
  showBusy(`Switching to ${p ? p.name : "project"}…`, "Indexing the codebase — this can take a moment.");
  try {
    const r = await (await fetch(`/api/projects/${id}/activate`, { method: "POST" })).json();
    if (!r.ok) throw new Error(r.error || "Activation failed");
    await afterProjectChange();
  } catch (e) {
    alert("Could not switch project: " + e.message);
  } finally {
    hideBusy();
  }
}

async function deleteProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!confirm(`Remove project "${p ? p.name : id}"? (Cloned files are deleted; your source is untouched for local folders.)`)) return;
  showBusy("Removing project…", "");
  try {
    const r = await (await fetch(`/api/projects/${id}`, { method: "DELETE" })).json();
    if (!r.ok) throw new Error(r.error || "Delete failed");
    await afterProjectChange();
  } catch (e) {
    alert("Could not remove project: " + e.message);
  } finally {
    hideBusy();
  }
}

function openModal(type) {
  $("#np-name").value = ""; $("#np-path").value = ""; $("#np-repo").value = ""; $("#np-sub").value = "";
  $("#np-token").value = "";
  $("#np-error").hidden = true;
  setUploadFile(null);
  $("#np-file").value = "";
  applyHostHints();
  // Hosted users cannot reach the server's disk, so upload is the sensible default.
  if (!type) type = hostInfo && hostInfo.cloud ? "upload" : "local";
  document.querySelectorAll("#type-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
  showTab(type);
  // Offer the Golden Repository selection at creation time (hidden if the library is empty).
  loadGolden().then(renderNpGolden).catch(() => {});
  $("#modal-backdrop").hidden = false;
  $("#np-name").focus();
}
function closeModal() { $("#modal-backdrop").hidden = true; }
// Re-open after a failed submit WITHOUT wiping what was typed — retyping a repo URL
// and token on every retry is the difference between "fix it" and "give up".
function reopenModal() { $("#modal-backdrop").hidden = false; }

// One project operation at a time. Adding a project while the previous one is
// still cloning/indexing used to do nothing at all — the button stayed enabled,
// no error appeared, and the form just sat there. Silence reads as "broken".
let projectOpInFlight = false;

async function submitNewProject() {
  if (projectOpInFlight)
    return showModalErr("Still setting up the previous project — wait for it to finish, then try again.");

  const seg = document.querySelector("#type-seg .seg-btn.active");
  if (!seg) return showModalErr("Pick where the code lives (local folder, git repository, or zip).");
  const type = seg.dataset.type;
  const name = $("#np-name").value.trim();
  const sub = $("#np-sub").value.trim();
  const errEl = $("#np-error");
  const body = { name, type, subPath: sub || undefined, golden: npGoldenSelection() };
  if (!name) return showModalErr("Please give the project a name.");
  if (type === "local") { body.path = $("#np-path").value.trim(); if (!body.path) return showModalErr("Enter a folder path."); }
  else if (type === "upload") { if (!uploadFile) return showModalErr("Choose a .zip file to upload."); }
  else {
    body.repoUrl = $("#np-repo").value.trim();
    if (!body.repoUrl) return showModalErr("Enter a repository URL.");
    const tok = $("#np-token").value.trim();
    if (tok) body.token = tok;
  }

  errEl.hidden = true;
  projectOpInFlight = true;
  $("#np-create").disabled = true;
  closeModal();
  showBusy(
    type === "git" ? "Cloning repository…" : type === "upload" ? "Uploading…" : "Adding project…",
    "Then indexing the codebase — this can take a moment."
  );
  // The project either got created or it didn't. Re-opening the form on a
  // post-creation refresh failure told the user it failed when it hadn't, and a
  // retry then produced a duplicate — so the two outcomes are tracked apart.
  let created = false;
  try {
    if (type === "upload") {
      showUploadProgress(0);
      const r = await uploadZip(uploadFile, name, sub, (frac) => showUploadProgress(frac));
      hideUploadProgress();
      showBusy("Indexing…", "Reading the uploaded codebase.");
      if (!r.ok) throw new Error(r.error || "Upload failed");
      created = true;
      // The upload endpoint takes query params, so apply the knowledge selection after.
      if (body.golden?.mode === "subset" && r.project?.id) {
        try {
          await fetch(`/api/projects/${r.project.id}/golden`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body.golden),
          });
        } catch { /* project exists; selection can be fixed in the Golden drawer */ }
      }
      await afterProjectChange();
      return;
    }
    const r = await (await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (!r.ok) throw new Error(r.error || "Could not create project");
    created = true;
    await afterProjectChange();
  } catch (e) {
    if (created) {
      // Created, but a refresh step failed. Do NOT re-open the form — that invites
      // a duplicate. Reload instead, since the app's view of state is now stale.
      console.error("[project] created, but refreshing the view failed:", e);
      alert(`"${name}" was created, but the page could not refresh (${e.message}).\nReloading.`);
      location.reload();
    } else {
      reopenModal(); showModalErr(e.message);
    }
  } finally {
    projectOpInFlight = false;
    hideUploadProgress();
    $("#np-create").disabled = false;
    hideBusy();
  }
}
function showModalErr(msg) { const e = $("#np-error"); e.textContent = msg; e.hidden = false; }

// Re-sync everything after the active project changed.
async function afterProjectChange() {
  await loadProjects();
  agents = await (await fetch("/api/agents")).json(); // suggestions are project-aware
  renderAgents();
  activeAgent = null;
  threadId = null; // threads are per project
  document.querySelectorAll(".agent-card").forEach((c) => c.classList.remove("active"));
  inputEl.disabled = true; sendBtn.disabled = true; inputEl.placeholder = "Select an agent to begin…";
  hasMessages = false;
  renderWelcome();
  await refreshHealth();
  refreshArtifacts();
  // If the project dropdown is open (e.g. right after a delete), refresh it in place (PM-01).
  if ($("#project-switch").classList.contains("open")) renderProjectMenu();
}

function showBusy(title, sub) { $("#busy-title").textContent = title; $("#busy-sub").textContent = sub || ""; $("#busy-overlay").hidden = false; }
function hideBusy() { $("#busy-overlay").hidden = true; }

// A big zip over a slow link needs a real percentage, not a spinner.
function showUploadProgress(frac) {
  let bar = document.getElementById("up-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "up-bar"; bar.className = "up-bar";
    bar.innerHTML = '<div class="up-fill" id="up-fill"></div>';
    document.querySelector(".busy-card").appendChild(bar);
  }
  const pct = Math.round(frac * 100);
  document.getElementById("up-fill").style.width = pct + "%";
  $("#busy-sub").textContent = pct < 100 ? `Uploading — ${pct}%` : "Extracting on the server…";
}
function hideUploadProgress() { document.getElementById("up-bar")?.remove(); }

// ---------- settings (API key / model) ----------
function initSettingsUI() {
  $("#settings-btn").onclick = openSettings;
  $("#settings-close").onclick = closeSettings;
  $("#set-cancel").onclick = closeSettings;
  $("#settings-backdrop").onclick = (e) => { if (e.target === $("#settings-backdrop")) closeSettings(); };
  $("#set-save").onclick = saveSettings;
}
async function openSettings() {
  $("#set-error").hidden = true;
  $("#set-key").value = "";
  try {
    const s = await (await fetch("/api/settings")).json();
    $("#set-model").value = s.model || "";
    $("#set-keyhint").textContent = s.hasApiKey
      ? `A key is set (ends ${s.keyHint}). Leave blank to keep it.`
      : "No key set yet — paste one to enable the agents.";
  } catch { $("#set-keyhint").textContent = ""; }
  $("#settings-backdrop").hidden = false;
  $("#set-key").focus();
}
function closeSettings() { $("#settings-backdrop").hidden = true; }
async function saveSettings() {
  const body = {};
  const key = $("#set-key").value.trim();
  const model = $("#set-model").value.trim();
  if (key) body.apiKey = key;
  if (model) body.model = model;
  $("#set-save").disabled = true;
  try {
    const r = await (await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (!r.ok) throw new Error(r.error || "Could not save");
    closeSettings();
    await refreshHealth();
  } catch (e) {
    const el = $("#set-error"); el.textContent = e.message; el.hidden = false;
  } finally {
    $("#set-save").disabled = false;
  }
}

// ---------- sidebar ----------
function vis(id) { return AGENT_VISUAL[id] || { icon: "sparkles", hue: 220 }; }
function makeAgentCard(a) {
  const v = vis(a.id);
  const card = document.createElement("button");
  card.className = "agent-card";
  card.style.setProperty("--hue", v.hue);
  card.innerHTML = `
    <span class="agent-ico">${icon(v.icon, 18)}</span>
    <span class="agent-meta">
      <span class="agent-name">${esc(a.name)}</span>
      <span class="agent-desc">${esc(trunc(a.description, 76))}</span>
    </span>`;
  card.onclick = () => selectAgent(a.id);
  card.dataset.id = a.id;
  return card;
}

function groupByCategory() {
  const cats = (typeof CATEGORIES !== "undefined") ? CATEGORIES : [];
  const groups = cats.map((c) => ({ ...c, items: agents.filter((a) => vis(a.id).cat === c.key) }))
    .filter((g) => g.items.length);
  const known = new Set(groups.flatMap((g) => g.items.map((a) => a.id)));
  const rest = agents.filter((a) => !known.has(a.id));
  if (rest.length) groups.push({ key: "other", label: "Other", items: rest });
  return groups;
}

function renderAgents() {
  agentListEl.innerHTML = "";
  for (const g of groupByCategory()) {
    const h = document.createElement("div");
    h.className = "cat-label";
    h.textContent = g.label;
    agentListEl.appendChild(h);
    for (const a of g.items) agentListEl.appendChild(makeAgentCard(a));
  }
}

async function selectAgent(id) {
  if (busy) return;
  activeAgent = agents.find((a) => a.id === id);
  document.querySelectorAll(".agent-card").forEach((c) => c.classList.toggle("active", c.dataset.id === id));
  inputEl.disabled = false; sendBtn.disabled = false;
  inputEl.placeholder = `Ask ${activeAgent.name}…`;
  hasMessages = false;
  threadId = null;
  // Active-agent indicator in the chat header (UI-09)
  $("#ct-ico").innerHTML = icon(vis(activeAgent.id).icon, 15);
  $("#ct-name").textContent = activeAgent.name;
  $("#chat-topbar").hidden = false;
  document.body.classList.remove("nav-open"); // close mobile drawer after picking
  renderAgentIntro();
  inputEl.focus();
  // Restore this agent's most recent conversation for the active project.
  try {
    const d = await (await fetch("/api/threads?agentId=" + encodeURIComponent(id))).json();
    if (d.threads && d.threads.length) await loadThread(d.threads[0].id);
  } catch {}
}

async function loadThread(id) {
  try {
    const d = await (await fetch("/api/threads/" + encodeURIComponent(id))).json();
    if (!d.ok || !d.thread.messages.length) return;
    threadId = d.thread.id;
    hasMessages = false;
    const inner = convInner();
    for (const m of d.thread.messages) {
      if (m.role === "user") addUser(inner, m.text);
      else addRestoredAssistant(inner, m.text);
    }
    const note = document.createElement("div");
    note.className = "restored-note";
    note.textContent = "Earlier conversation restored — follow-ups continue with this context.";
    inner.insertBefore(note, inner.firstChild);
    pin();
  } catch {}
}

function addRestoredAssistant(inner, text) {
  const w = document.createElement("div");
  w.className = "msg assistant";
  w.innerHTML = `<div class="avatar">${icon(vis(activeAgent.id).icon, 16)}</div>
    <div class="body"><div class="role">${esc(activeAgent.name)}</div><div class="md"></div></div>`;
  const md = w.querySelector(".md");
  md.innerHTML = renderMarkdown(text || "");
  inner.appendChild(w);
  highlightIn(md);
}

function newConversation() {
  if (busy || !activeAgent) return;
  threadId = null;
  hasMessages = false;
  renderAgentIntro();
  inputEl.focus();
}

function goHome() {
  if (busy) return;
  activeAgent = null; threadId = null; hasMessages = false;
  document.querySelectorAll(".agent-card").forEach((c) => c.classList.remove("active"));
  inputEl.disabled = true; sendBtn.disabled = true; inputEl.placeholder = "Select an agent to begin…";
  $("#chat-topbar").hidden = true;
  document.body.classList.remove("nav-open");
  renderWelcome();
}

// ---------- welcome / intro ----------
function onboardDismissed() { try { return sessionStorage.getItem("astra-onboard") === "1"; } catch { return false; } }
function hasCustomProject() { return projects.some((p) => p.id !== "nopcommerce"); }

function renderWelcome() {
  if (!hasCustomProject() && !onboardDismissed()) return renderOnboarding();
  const cards = groupByCategory().map((g) => {
    const inner = g.items.map((a) => {
      const v = vis(a.id);
      return `<button class="welcome-card" data-id="${a.id}" style="--hue:${v.hue}">
        <span class="agent-ico">${icon(v.icon, 19)}</span>
        <span class="wc-name">${esc(a.name)}</span>
        <span class="wc-desc">${esc(trunc(a.description, 92))}</span>
      </button>`;
    }).join("");
    return `<div class="welcome-cat">${esc(g.label)}</div>${inner}`;
  }).join("");
  convEl.innerHTML = `<div class="welcome">
    <div class="welcome-badge">${icon("sparkles", 13)} Powered by Claude · grounded via MCP</div>
    <h1>Your SDLC team, <span class="grad">as agents</span></h1>
    <p class="lede">${agents.length} specialist agents across the SDLC — from requirements and design through implementation, testing, security and modernization, coordinated by an orchestrator — each driving the same MCP server VS&nbsp;Code uses, every answer grounded in the real .NET codebase. Pick one to begin.</p>
    <div class="welcome-grid">${cards}</div>
  </div>`;
  convEl.querySelectorAll(".welcome-card").forEach((c) => (c.onclick = () => selectAgent(c.dataset.id)));
}

function renderOnboarding() {
  convEl.innerHTML = `<div class="onboard">
    <div class="welcome-badge">${icon("sparkles", 13)} Welcome to ASTRA AgenticOS</div>
    <h1>Point ASTRA at your code</h1>
    <p class="lede">The agents run against a <strong>project</strong> — a codebase ASTRA indexes and grounds every answer in. Add yours to begin, or explore the bundled demo.</p>
    <div class="onboard-grid">
      <button class="onboard-card" id="ob-upload">
        <span class="oc-ico">${icon("upload", 21)}</span>
        <h3>Upload a .zip</h3>
        <p>Zip your solution folder and upload it straight from your PC — nothing to install.</p>
      </button>
      <button class="onboard-card" id="ob-git">
        <span class="oc-ico">${icon("git", 21)}</span>
        <h3>Git repository</h3>
        <p>Paste a repo URL — ASTRA clones it and indexes it. Private repos take an access token.</p>
      </button>
      ${hostInfo && hostInfo.cloud ? "" : `
      <button class="onboard-card" id="ob-local">
        <span class="oc-ico">${icon("folder", 21)}</span>
        <h3>Local folder</h3>
        <p>Point at a folder of .NET source on this machine. Optionally index just a sub-folder.</p>
      </button>`}
    </div>
    <div class="onboard-foot">… or <a id="ob-demo">explore the nopCommerce demo →</a></div>
  </div>`;
  $("#ob-upload").onclick = () => openModal("upload");
  if ($("#ob-local")) $("#ob-local").onclick = () => openModal("local");
  $("#ob-git").onclick = () => openModal("git");
  $("#ob-demo").onclick = () => { try { sessionStorage.setItem("astra-onboard", "1"); } catch {} renderWelcome(); };
}

function renderAgentIntro() {
  const a = activeAgent, v = vis(a.id);
  const tools = (a.tools || []).map((t) => `<span class="tool-badge">${esc(t)}</span>`).join("");
  const sugg = (a.suggested || []).map((s) =>
    `<button class="suggest-card" data-p="${esc(s)}">
      <span class="sc-ico">${icon("sparkles", 16)}</span>
      <span>${esc(s)}</span>
      <span class="sc-arrow">${icon("chevron", 16)}</span>
    </button>`).join("");
  convEl.innerHTML = `<div class="conv-inner"><div class="agent-intro" style="--hue:${v.hue}">
    <div class="agent-intro-head">
      <span class="agent-ico">${icon(v.icon, 22)}</span>
      <div><h2>${esc(a.name)}</h2><p>${esc(a.description)}</p></div>
    </div>
    <div class="intro-tools">${tools}</div>
    ${sugg ? `<div class="suggest-label">Try one of these</div><div class="suggest-grid">${sugg}</div>` : ""}
  </div></div>`;
  convEl.querySelectorAll(".suggest-card").forEach((c) =>
    (c.onclick = () => { inputEl.value = c.dataset.p; autoGrow(); send(); }));
}

function convInner() {
  let inner = convEl.querySelector(".conv-inner");
  if (!inner || !hasMessages) {
    convEl.innerHTML = `<div class="conv-inner"></div>`;
    inner = convEl.querySelector(".conv-inner");
    hasMessages = true;
  }
  return inner;
}

// ---------- composer ----------
$("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
function autoGrow() { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px"; }

async function send() {
  const text = inputEl.value.trim();
  if (!text || !activeAgent || busy) return;
  setBusy(true);
  inputEl.value = ""; autoGrow();

  const inner = convInner();
  addUser(inner, text);
  const asst = addAssistant(inner);

  try {
    const resp = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: activeAgent.id, message: text, threadId }),
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "thread") { threadId = ev.id; continue; }
        asst.handle(ev);
      }
    }
  } catch (err) {
    asst.error("Connection error: " + err.message);
  } finally {
    asst.finish(); setBusy(false);
    refreshArtifacts(); // an agent may have saved a new artifact
  }
}

// ---------- artifacts ----------
let artifacts = [];
function initArtifactsUI() {
  $("#artifacts-btn").onclick = openDrawer;
  $("#drawer-close").onclick = closeDrawer;
  $("#drawer-backdrop").onclick = (e) => { if (e.target === $("#drawer-backdrop")) closeDrawer(); };
  $("#viewer-close").onclick = () => ($("#viewer-backdrop").hidden = true);
  $("#viewer-backdrop").onclick = (e) => { if (e.target === $("#viewer-backdrop")) $("#viewer-backdrop").hidden = true; };
}
async function refreshArtifacts() {
  try {
    const d = await (await fetch("/api/artifacts")).json();
    artifacts = d.files || [];
  } catch { artifacts = []; }
  const badge = $("#artifacts-count");
  if (artifacts.length) { badge.textContent = artifacts.length; badge.hidden = false; }
  else badge.hidden = true;
  if (!$("#drawer-backdrop").hidden) renderArtifactsList();
}
async function openDrawer() { await refreshArtifacts(); renderArtifactsList(); $("#drawer-backdrop").hidden = false; }
function closeDrawer() { $("#drawer-backdrop").hidden = true; }
function renderArtifactsList() {
  const list = $("#artifacts-list");
  if (!artifacts.length) {
    list.innerHTML = `<div class="drawer-empty">No artifacts yet.<br/>Run an agent — generated BRDs, ADRs, reviews and tests appear here.</div>`;
    return;
  }
  list.innerHTML = artifacts.map((f) => `
    <div class="art-row" data-path="${esc(f.path)}">
      <span class="ar-ico">${icon("file", 16)}</span>
      <span class="ar-meta"><span class="ar-name">${esc(f.path)}</span><span class="ar-sub">${fmtSize(f.size)} · ${fmtTime(f.mtime)}</span></span>
      <a class="ar-dl" href="/api/artifacts/download?path=${encodeURIComponent(f.path)}" title="Download" onclick="event.stopPropagation()">${icon("download", 16)}</a>
    </div>`).join("");
  list.querySelectorAll(".art-row").forEach((r) => (r.onclick = () => openViewer(r.dataset.path)));
}
// ---------- Golden Repository (org standards / templates / skills) ----------
let goldenItems = [];        // the library
let goldenSel = null;        // active project's selection + counts
let editingId = null;        // null = creating

function initGoldenUI() {
  $("#golden-btn").onclick = openGolden;
  $("#golden-close").onclick = () => ($("#golden-backdrop").hidden = true);
  $("#golden-backdrop").onclick = (e) => { if (e.target === $("#golden-backdrop")) $("#golden-backdrop").hidden = true; };
  $("#golden-add").onclick = () => openGoldenEditor(null);

  // Bulk import — a standards pack is dozens or hundreds of files, and adding
  // them one at a time is what stops a team ever getting started.
  $("#golden-import-btn").onclick = () => $("#golden-import-file").click();
  $("#golden-import-file").onchange = async () => {
    const f = $("#golden-import-file").files[0];
    if (!f) return;
    $("#golden-import-file").value = "";
    if (!confirm(
      `Import "${f.name}"?\n\n` +
      `Every document found (.md, .txt, .docx, .pdf) becomes a Golden item as a DRAFT ` +
      `marked "reference" — nothing is published and nothing becomes mandatory. ` +
      `You publish the ones you want afterwards.`
    )) return;

    showBusy("Importing documents…", "Extracting, converting and indexing — this can take a minute.");
    try {
      const r = await (await fetch("/api/golden/import", {
        method: "POST", headers: { "Content-Type": "application/zip" }, body: f,
      })).json();
      if (!r.ok) throw new Error(r.error || "Import failed");
      await loadGolden();
      renderGoldenLibrary();
      renderGoldenSelection();
      const bits = [`Imported ${r.imported} document${r.imported === 1 ? "" : "s"} as drafts.`];
      if (r.flagged) bits.push(`⚠ ${r.flagged} contain text written as instructions to an AI — review before publishing.`);
      if (r.skipped) bits.push(`${r.skipped} skipped (empty or unreadable).`);
      if (r.overCap) bits.push(`${r.overCap} beyond the ${300} file cap were NOT imported.`);
      alert(bits.join("\n"));
    } catch (e) {
      alert("Import failed: " + e.message);
    } finally { hideBusy(); }
  };

  document.querySelectorAll(".gt-btn").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".gt-btn").forEach((x) => x.classList.toggle("active", x === b));
    const sel = b.dataset.tab === "selection";
    $("#golden-list").hidden = sel;
    $("#golden-selection").hidden = !sel;
    if (sel) renderGoldenSelection();
  }));

  $("#gold-edit-close").onclick = closeGoldenEditor;
  $("#gi-cancel").onclick = closeGoldenEditor;
  $("#gold-edit-backdrop").onclick = (e) => { if (e.target === $("#gold-edit-backdrop")) closeGoldenEditor(); };
  $("#gi-save").onclick = saveGoldenItem;
  $("#gi-file").onchange = async () => {
    const f = $("#gi-file").files[0];
    if (!f) return;
    const note = $("#gi-convert-note");
    const binary = /\.(docx|pdf|doc)$/i.test(f.name);

    if (!binary) {                                   // plain text / markdown — read it here
      $("#gi-content").value = await f.text();
      if (!$("#gi-title").value.trim()) $("#gi-title").value = f.name.replace(/\.[^.]+$/, "");
      note.hidden = true;
      return;
    }

    // Word and PDF have to be converted on the server; show progress because a
    // long policy document takes a moment and a silent pause reads as a failure.
    note.hidden = false;
    note.className = "convert-note working";
    note.textContent = `Converting ${f.name}…`;
    try {
      const r = await (await fetch(`/api/golden/convert?filename=${encodeURIComponent(f.name)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f,
      })).json();
      if (!r.ok) throw new Error(r.error || "Could not convert that file.");

      $("#gi-content").value = r.markdown;
      if (!$("#gi-title").value.trim()) $("#gi-title").value = r.suggestedTitle || f.name.replace(/\.[^.]+$/, "");

      const security = (r.warnings || []).filter((w) => w.startsWith("SECURITY"));
      const normal   = (r.warnings || []).filter((w) => !w.startsWith("SECURITY"));
      note.className = "convert-note " + (security.length ? "danger" : normal.length ? "warn" : "ok");
      note.innerHTML =
        `<b>Converted ${esc(r.kind.toUpperCase())} — ${r.stats.chars.toLocaleString()} characters, ` +
        `${r.stats.headings} heading${r.stats.headings === 1 ? "" : "s"}` +
        `${r.stats.pages ? `, ${r.stats.pages} pages` : ""}.</b> ` +
        `Check the text below before saving — this becomes what agents read as your standard.` +
        (security.length ? `<ul class="cn-list danger">${security.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "") +
        (normal.length ? `<ul class="cn-list">${normal.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "");
    } catch (e) {
      note.className = "convert-note danger";
      note.textContent = e.message;
    }
  };
  // publishing a mandatory item needs an approver — make that visible, not a surprise
  const syncApprover = () => {
    const need = $("#gi-enf").value === "mandatory" && $("#gi-status").value === "published";
    $("#gi-approver-field").style.opacity = need ? "1" : ".6";
    $("#gi-approver").placeholder = need ? "Required to publish a mandatory item" : "e.g. J. Weber (Chief Architect)";
  };
  $("#gi-enf").onchange = syncApprover;
  $("#gi-status").onchange = syncApprover;

  // New-project knowledge picker
  document.querySelectorAll("#np-gold-seg .seg-btn").forEach((b) => (b.onclick = () => {
    document.querySelectorAll("#np-gold-seg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    $("#np-gold-pick").hidden = b.dataset.gold !== "subset";
    updateNpGoldHint();
  }));
}

async function loadGolden() {
  try {
    const d = await (await fetch("/api/golden")).json();
    goldenItems = d.items || [];
  } catch { goldenItems = []; }
  try { goldenSel = await (await fetch("/api/golden-selection")).json(); } catch { goldenSel = null; }
}

async function openGolden() {
  await loadGolden();
  renderGoldenLibrary();
  renderGoldenSelection();
  $("#golden-backdrop").hidden = false;
}

function goldenChips(i) {
  const chips = [`<span class="chip kind">${esc(i.kind)}</span>`];
  if (i.enforcement === "mandatory") chips.push(`<span class="chip mandatory">mandatory</span>`);
  if (i.status !== "published") chips.push(`<span class="chip ${esc(i.status)}">${esc(i.status)}</span>`);
  return chips.join(" ");
}

function renderGoldenLibrary() {
  const list = $("#golden-list");
  if (!goldenItems.length) {
    list.innerHTML = `<div class="drawer-empty">The library is empty.<br/>Add your coding standards, BRD/ADR templates, functional specs or team playbooks —
      agents will cite them instead of guessing.</div>`;
    return;
  }
  list.innerHTML = goldenItems.map((i) => `
    <div class="gold-row">
      <span class="gr-ico">${icon(i.kind === "template" ? "file-text" : i.kind === "skill" ? "workflow" : "book", 15)}</span>
      <div>
        <span class="gr-name">${esc(i.title)}</span>
        <div class="gr-desc">${esc(i.description)}</div>
        <div class="gr-meta">
          <span class="gr-id">${esc(i.id)}@${i.version}</span> ${goldenChips(i)}
          <span>· ${esc(i.owner)}</span>
          ${i.tags.length ? `<span>· ${i.tags.map(esc).join(", ")}</span>` : ""}
        </div>
      </div>
      <div class="gr-actions">
        ${i.status === "published" ? `<button class="btn ghost sm" data-test="${esc(i.id)}">Try it</button>` : ""}
        <button class="btn ghost sm" data-edit="${esc(i.id)}">Edit</button>
        ${i.status !== "archived" ? `<button class="btn ghost sm" data-arch="${esc(i.id)}">Archive</button>` : ""}
      </div>
      <div class="gr-test" id="gt-${esc(i.id)}" hidden></div>
    </div>`).join("");
  list.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openGoldenEditor(b.dataset.edit)));
  list.querySelectorAll("[data-arch]").forEach((b) => (b.onclick = () => archiveGoldenItem(b.dataset.arch)));
  list.querySelectorAll("[data-test]").forEach((b) => (b.onclick = () => toggleGoldenTest(b.dataset.test)));
}

/**
 * "Try it" — runs a real agent and reports whether it actually opened this item.
 * Authors otherwise have no way to tell a well-written item from one the agents
 * never notice, which is the single most common way a golden library goes stale.
 */
function toggleGoldenTest(id) {
  const box = document.getElementById(`gt-${id}`);
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  const item = goldenItems.find((i) => i.id === id);
  const targets = (item?.appliesTo || []).filter((a) => a !== "all");
  const usable = agents.filter((a) => !targets.length || targets.includes(a.id));
  box.hidden = false;
  box.innerHTML = `
    <div class="gt-form">
      <select class="gt-agent">${(usable.length ? usable : agents)
        .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select>
      <input class="gt-task" type="text" placeholder="Ask something this item should answer, e.g. &quot;How should I log a failed payment?&quot;" />
      <button class="btn primary sm gt-run">Run</button>
    </div>
    <div class="gt-out set-hint">A real agent run — it uses your API key and takes up to a minute.</div>`;
  const out = box.querySelector(".gt-out");
  const run = box.querySelector(".gt-run");
  run.onclick = async () => {
    const task = box.querySelector(".gt-task").value.trim();
    if (!task) { out.textContent = "Type a question first."; return; }
    run.disabled = true;
    out.textContent = "Running…";
    try {
      const r = await (await fetch(`/api/golden/${encodeURIComponent(id)}/test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: box.querySelector(".gt-agent").value, task }),
      })).json();
      if (!r.ok) { out.textContent = r.error || "The test could not run."; return; }
      out.innerHTML = `
        <div class="gt-verdict ${r.pickedUp ? "good" : "bad"}">
          ${r.pickedUp ? "✓ Found and used" : "✗ Not used"} — ${esc(r.verdict)}
        </div>
        <div class="gt-detail">Opened: ${r.goldenRead.length ? r.goldenRead.map(esc).join(", ") : "nothing"}
          · Cited by version: ${r.citedIdVersion ? "yes" : "no"}</div>
        <details class="gt-answer"><summary>What the agent replied</summary><pre>${esc(r.answer)}</pre></details>`;
    } catch (e) {
      out.textContent = e.message || "The test could not run.";
    } finally { run.disabled = false; }
  };
}

function renderGoldenSelection() {
  const box = $("#golden-selection");
  const live = goldenItems.filter((i) => i.status !== "archived");
  if (!live.length) { box.innerHTML = `<div class="drawer-empty">Nothing in the library to select yet.</div>`; return; }
  if (!goldenSel) { box.innerHTML = `<div class="drawer-empty">No active project.</div>`; return; }

  const all = goldenSel.selection?.mode !== "subset";
  const chosen = new Set(goldenSel.selection?.itemIds || []);
  const over = goldenSel.overCap;
  box.innerHTML = `
    <div class="set-hint" style="margin-bottom:8px">
      What <b>${esc(activeProjectName())}</b>'s agents can see. ${goldenSel.selectedCount} selected${
        goldenSel.mandatoryCount ? ` · <b>${goldenSel.mandatoryCount} mandatory</b>` : ""}.
      ${over ? `<span style="color:var(--amber-c)">⚠ Over the ${goldenSel.catalogCap}-item catalog cap — narrow the selection so nothing relevant is hidden.</span>` : ""}
    </div>
    <div class="seg sm" id="gs-seg" style="margin-bottom:8px">
      <button type="button" class="seg-btn ${all ? "active" : ""}" data-gs="all">Everything</button>
      <button type="button" class="seg-btn ${all ? "" : "active"}" data-gs="subset">Selected</button>
    </div>
    <div class="gold-pick" id="gs-pick" ${all ? "hidden" : ""}>
      ${live.map((i) => `
        <label class="gp-item">
          <input type="checkbox" value="${esc(i.id)}" ${chosen.has(i.id) ? "checked" : ""} />
          <span><span class="gp-title">${esc(i.title)}</span>
          <span class="gp-sub"> — ${esc(i.id)} · ${esc(i.kind)}${i.enforcement === "mandatory" ? " · mandatory" : ""}</span></span>
        </label>`).join("")}
    </div>
    <button class="btn primary" id="gs-save" style="margin-top:10px">Save knowledge selection</button>`;

  box.querySelectorAll("#gs-seg .seg-btn").forEach((b) => (b.onclick = () => {
    box.querySelectorAll("#gs-seg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    $("#gs-pick").hidden = b.dataset.gs !== "subset";
  }));
  $("#gs-save").onclick = saveGoldenSelection;
}

function activeProjectName() {
  const p = projects.find((x) => x.id === activeProjectId);
  return p ? p.name : "this project";
}

async function saveGoldenSelection() {
  const btn = $("#gs-save");
  const mode = document.querySelector("#gs-seg .seg-btn.active")?.dataset.gs === "subset" ? "subset" : "all";
  const itemIds = [...document.querySelectorAll("#gs-pick input:checked")].map((c) => c.value);
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const r = await (await fetch(`/api/projects/${activeProjectId}/golden`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, itemIds }),
    })).json();
    if (!r.ok) throw new Error(r.error || "Could not save");
    await loadGolden();
    renderGoldenSelection();
  } catch (e) {
    btn.textContent = "Save failed — retry";
  } finally { btn.disabled = false; }
}

function openGoldenEditor(id) {
  editingId = id;
  const i = id ? goldenItems.find((x) => x.id === id) : null;
  $("#gold-edit-title").textContent = i ? `Edit ${i.id}` : "Add golden item";
  $("#gi-title").value = i?.title || "";
  $("#gi-desc").value = i?.description || "";
  $("#gi-kind").value = i?.kind || "standard";
  $("#gi-enf").value = i?.enforcement || "reference";
  $("#gi-status").value = i?.status === "archived" ? "draft" : (i?.status || "draft");
  $("#gi-owner").value = i?.owner || "";
  $("#gi-approver").value = i?.approvedBy || "";
  $("#gi-tags").value = (i?.tags || []).join(", ");
  $("#gi-aliases").value = (i?.aliases || []).join(", ");
  $("#gi-applies").value = (i?.appliesTo || ["all"]).join(", ");
  $("#gi-content").value = "";
  $("#gi-file").value = "";
  $("#gi-error").hidden = true;
  $("#gi-enf").onchange();
  $("#gold-edit-backdrop").hidden = false;
  if (id) {
    fetch(`/api/golden/${encodeURIComponent(id)}`).then((r) => r.json()).then((d) => {
      if (d.ok) $("#gi-content").value = d.content || "";
    }).catch(() => {});
  }
  $("#gi-title").focus();
}
function closeGoldenEditor() { $("#gold-edit-backdrop").hidden = true; editingId = null; }

async function saveGoldenItem() {
  const err = $("#gi-error");
  const split = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const body = {
    title: $("#gi-title").value.trim(),
    description: $("#gi-desc").value.trim(),
    kind: $("#gi-kind").value,
    enforcement: $("#gi-enf").value,
    status: $("#gi-status").value,
    owner: $("#gi-owner").value.trim() || "unassigned",
    approvedBy: $("#gi-approver").value.trim() || undefined,
    tags: split($("#gi-tags").value),
    aliases: split($("#gi-aliases").value),
    appliesTo: split($("#gi-applies").value).length ? split($("#gi-applies").value) : ["all"],
    content: $("#gi-content").value,
  };
  if (!body.title) { err.textContent = "Give the item a title."; err.hidden = false; return; }
  if (!body.content.trim()) { err.textContent = "Add some content (or load a file)."; err.hidden = false; return; }

  $("#gi-save").disabled = true;
  try {
    const url = editingId ? `/api/golden/${encodeURIComponent(editingId)}` : "/api/golden";
    const r = await (await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (!r.ok) throw new Error(r.error || "Could not save");
    closeGoldenEditor();
    await loadGolden();
    renderGoldenLibrary();
    renderGoldenSelection();
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  } finally { $("#gi-save").disabled = false; }
}

async function archiveGoldenItem(id) {
  try {
    await fetch(`/api/golden/${encodeURIComponent(id)}/archive`, { method: "POST" });
    await loadGolden();
    renderGoldenLibrary();
    renderGoldenSelection();
  } catch {}
}

// --- knowledge picker inside the New project modal ---
function renderNpGolden() {
  const live = goldenItems.filter((i) => i.status !== "archived");
  const wrap = $("#np-knowledge");
  if (!live.length) { wrap.hidden = true; return; }   // nothing in the library — don't clutter the form
  wrap.hidden = false;
  $("#np-gold-pick").innerHTML = live.map((i) => `
    <label class="gp-item">
      <input type="checkbox" value="${esc(i.id)}" />
      <span><span class="gp-title">${esc(i.title)}</span>
      <span class="gp-sub"> — ${esc(i.id)} · ${esc(i.kind)}${i.enforcement === "mandatory" ? " · mandatory" : ""}</span></span>
    </label>`).join("");
  $("#np-gold-pick").querySelectorAll("input").forEach((c) => (c.onchange = updateNpGoldHint));
  document.querySelectorAll("#np-gold-seg .seg-btn").forEach((x, idx) => x.classList.toggle("active", idx === 0));
  $("#np-gold-pick").hidden = true;
  updateNpGoldHint();
}
function updateNpGoldHint() {
  const live = goldenItems.filter((i) => i.status !== "archived");
  const subset = document.querySelector("#np-gold-seg .seg-btn.active")?.dataset.gold === "subset";
  const n = subset ? document.querySelectorAll("#np-gold-pick input:checked").length : live.length;
  $("#np-gold-hint").textContent = `${n} item(s) will be available to this project's agents.`;
}
function npGoldenSelection() {
  const subset = document.querySelector("#np-gold-seg .seg-btn.active")?.dataset.gold === "subset";
  if (!subset) return { mode: "all" };
  return { mode: "subset", itemIds: [...document.querySelectorAll("#np-gold-pick input:checked")].map((c) => c.value) };
}

const VLANGS = { cs: "csharp", json: "json", xml: "xml", ts: "typescript", js: "javascript", sql: "sql", yml: "yaml", yaml: "yaml", sh: "bash" };
async function openViewer(p) {
  $("#viewer-title").textContent = p;
  $("#viewer-download").href = "/api/artifacts/download?path=" + encodeURIComponent(p);
  const body = $("#viewer-body");
  body.innerHTML = `<div class="thinking"><span class="spin"></span> Loading…</div>`;
  $("#viewer-backdrop").hidden = false;
  try {
    const d = await (await fetch("/api/artifacts/content?path=" + encodeURIComponent(p))).json();
    if (!d.ok) throw new Error(d.error || "Could not load");
    const ext = (p.split(".").pop() || "").toLowerCase();
    if (ext === "md" || ext === "markdown") {
      body.innerHTML = `<div class="md">${renderMarkdown(d.content)}</div>`;
    } else {
      const lang = VLANGS[ext] || "";
      body.innerHTML = `<pre><code class="${lang ? "language-" + lang : ""}">${esc(d.content)}</code></pre>`;
    }
    highlightIn(body);
  } catch (e) {
    body.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}
function fmtSize(b) { return b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB"; }
function fmtTime(ms) {
  try { const d = new Date(ms); return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

// ---------- message builders ----------
function addUser(inner, text) {
  const w = document.createElement("div");
  w.className = "msg user";
  w.innerHTML = `<div class="avatar">You</div><div class="body"><div class="role">You</div><div class="bubble"></div></div>`;
  w.querySelector(".bubble").textContent = text;
  inner.appendChild(w); pin();
}

// A renderer that turns the NDJSON event stream into DOM inside `stream`.
// Used both for the top-level assistant and (recursively) for each delegation.
function makeRenderer(stream, showThinking) {
  let thinking = null;
  if (showThinking) { thinking = thinkingEl(); stream.appendChild(thinking); }
  let activity = null, stepEls = {}, mdEl = null, textBuf = "", raf = 0;

  function killThinking() { if (thinking) { thinking.remove(); thinking = null; } }
  function ensureActivity() {
    if (!activity) {
      activity = document.createElement("div");
      activity.className = "activity";
      activity.innerHTML = `<div class="activity-head"><span class="spark">${icon("wrench", 15)}</span>
        <span class="act-title">Working</span><span class="chev">${icon("chevron", 16)}</span></div>
        <div class="activity-steps"></div>`;
      activity.querySelector(".activity-head").onclick = () => activity.classList.toggle("collapsed");
      stream.appendChild(activity);
    }
    return activity;
  }
  function newTextBlock() { mdEl = document.createElement("div"); mdEl.className = "md caret"; stream.appendChild(mdEl); textBuf = ""; }
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (mdEl) mdEl.innerHTML = renderMarkdown(textBuf); pin(); });
  }
  /**
   * Paint whatever is buffered right now, cancelling any queued frame.
   *
   * Must be called before the current text block is closed. A scheduled frame
   * checks `mdEl`, so if a tool_call (or the end of the run) nulled it first,
   * the callback silently skipped the render and the answer was lost — an empty
   * bubble under "Used 1 tool". Short answers hit this almost every time,
   * because all their deltas land inside a single frame.
   */
  function flushRender() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (mdEl) { mdEl.innerHTML = renderMarkdown(textBuf); pin(); }
  }

  return {
    handle(ev) {
      switch (ev.type) {
        case "text_delta":
          killThinking();
          if (!mdEl) newTextBlock();
          textBuf += ev.text; scheduleRender();
          break;
        case "tool_call": {
          killThinking();
          if (mdEl) { flushRender(); mdEl.classList.remove("caret"); highlightIn(mdEl); mdEl = null; }
          if (ev.name === "save_artifact") { stepEls[ev.id] = addArtifact(stream, ev.input); break; }
          const steps = ensureActivity().querySelector(".activity-steps");
          const s = document.createElement("div");
          s.className = "step";
          const args = compactArgs(ev.input);
          s.innerHTML = `<div class="step-head">
            <span class="step-ico">${icon("wrench", 14)}</span>
            <span class="step-name">${esc(ev.name)}</span>
            <span class="step-args">${esc(args)}</span>
            <span class="step-state running"><span class="spin"></span> running</span>
          </div><div class="step-out"><pre></pre></div>`;
          s.querySelector(".step-head").onclick = () => s.classList.toggle("open");
          steps.appendChild(s); stepEls[ev.id] = s; pin();
          updateActTitle(activity);
          break;
        }
        case "tool_result": {
          const s = stepEls[ev.id]; if (!s) break;
          if (s.classList.contains("artifact")) break;
          s.querySelector(".step-state").outerHTML = `<span class="step-state done">${icon("check", 14)} done</span>`;
          s.querySelector(".step-out pre").textContent = ev.result;
          break;
        }
        case "text_reset":
          if (raf) { cancelAnimationFrame(raf); raf = 0; }   // don't paint into a removed node
          if (mdEl) { mdEl.remove(); mdEl = null; textBuf = ""; }
          break;
        case "notice":
          if (!thinking) { thinking = thinkingEl(); stream.appendChild(thinking); }
          thinking.lastChild.textContent = " " + ev.message;
          pin();
          break;
        case "error": this.error(ev.message); break;
      }
    },
    error(msg) {
      killThinking();
      const e = document.createElement("div"); e.className = "error-box"; e.textContent = msg; stream.appendChild(e); pin();
    },
    finish() {
      killThinking();
      if (mdEl) { flushRender(); mdEl.classList.remove("caret"); highlightIn(mdEl); addCopy(stream, mdEl); mdEl = null; }
      if (activity) { activity.classList.add("collapsed"); updateActTitle(activity, true); }
    },
  };
}

function addAssistant(inner) {
  const w = document.createElement("div");
  w.className = "msg assistant";
  w.innerHTML = `<div class="avatar">${icon(vis(activeAgent.id).icon, 16)}</div>
    <div class="body"><div class="role">${esc(activeAgent.name)}</div>
    <div class="stream"></div></div>`;
  const stream = w.querySelector(".stream");
  inner.appendChild(w); pin();

  const top = makeRenderer(stream, true);
  const delegations = {}; // delegate id -> { el, r }

  return {
    handle(ev) {
      if (ev.type === "delegate_start") {
        const card = document.createElement("div");
        card.className = "delegate";
        card.innerHTML = `<div class="delegate-head">
            <span class="dl-ico">${icon(vis(ev.agentId).icon, 15)}</span>
            <span class="dl-meta"><span class="dl-name">${esc(ev.agentName)}</span><span class="dl-task">${esc(ev.task || "")}</span></span>
            <span class="dl-state"><span class="spin"></span></span>
            <span class="dl-chev">${icon("chevron", 15)}</span>
          </div><div class="delegate-body"></div>`;
        card.querySelector(".delegate-head").onclick = () => card.classList.toggle("collapsed");
        stream.appendChild(card); pin();
        delegations[ev.id] = { el: card, r: makeRenderer(card.querySelector(".delegate-body"), true) };
        return;
      }
      if (ev.type === "delegate_end") {
        const d = delegations[ev.id];
        if (d) {
          d.r.finish();
          d.el.querySelector(".dl-state").innerHTML = icon("check", 15);
          d.el.querySelector(".dl-state").classList.add("done");
          d.el.classList.add("collapsed");
        }
        return;
      }
      if (ev.delegateId && delegations[ev.delegateId]) { delegations[ev.delegateId].r.handle(ev); return; }
      top.handle(ev);
    },
    error(msg) { top.error(msg); },
    finish() { for (const id in delegations) delegations[id].r.finish(); top.finish(); },
  };
}

function updateActTitle(activity, doneAll) {
  if (!activity) return;
  const n = activity.querySelectorAll(".step").length;
  const done = activity.querySelectorAll(".step-state.done").length;
  activity.querySelector(".act-title").textContent =
    doneAll || done === n ? `Used ${n} tool${n > 1 ? "s" : ""}` : `Working · ${n} tool${n > 1 ? "s" : ""}`;
}

const LANGS = { cs: "csharp", json: "json", xml: "xml", ts: "typescript", js: "javascript", sql: "sql", yml: "yaml", yaml: "yaml", sh: "bash", html: "xml", css: "css" };
function addArtifact(stream, input) {
  const name = String((input && (input.name || input.path || input.filename)) || "artifact.md");
  const content = (input && input.content) || "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const isMd = ext === "md" || ext === "markdown" || !content;
  const a = document.createElement("div");
  a.className = "artifact";

  let bodyHtml = "";
  if (content) {
    if (isMd) bodyHtml = `<div class="art-body"><div class="md">${renderMarkdown(content)}</div></div>`;
    else {
      const lang = LANGS[ext] || "";
      bodyHtml = `<div class="art-body"><pre><code class="${lang ? "language-" + lang : ""}">${esc(content)}</code></pre></div>`;
    }
  }
  a.innerHTML = `<div class="art-head">
      <span class="art-ico">${icon("save", 18)}</span>
      <div class="art-meta">
        <div class="art-name">${esc(name)}</div>
        <div class="art-sub"><span class="art-tag">Artifact</span> saved to artifacts/</div>
      </div>
      <span class="art-chev">${icon("chevron", 16)}</span>
    </div>${bodyHtml}`;
  if (content) a.querySelector(".art-head").onclick = () => a.classList.toggle("collapsed");
  stream.appendChild(a);
  const body = a.querySelector(".art-body");
  if (body) highlightIn(body);
  pin();
  return a;
}

function addCopy(stream, mdEl) {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.innerHTML = icon("copy", 14) + " Copy";
  btn.onclick = () => {
    navigator.clipboard?.writeText(mdEl.innerText);
    btn.innerHTML = icon("check", 14) + " Copied";
    setTimeout(() => (btn.innerHTML = icon("copy", 14) + " Copy"), 1600);
  };
  stream.appendChild(btn);
}

function thinkingEl() {
  const d = document.createElement("div");
  d.className = "thinking";
  d.innerHTML = `<span class="pulse"><i></i><i></i><i></i></span> Thinking…`;
  return d;
}

// ---------- utils ----------
function setBusy(b) { busy = b; inputEl.disabled = b || !activeAgent; sendBtn.disabled = b || !activeAgent; }
function pin() {
  const near = convEl.scrollHeight - convEl.scrollTop - convEl.clientHeight < 120;
  if (near) convEl.scrollTop = convEl.scrollHeight;
}
function compactArgs(o) {
  if (!o || typeof o !== "object") return "";
  return Object.entries(o).map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function trunc(s, n) { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n) + "…"; }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

boot();

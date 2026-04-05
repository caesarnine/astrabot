const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const APPROVALS = ["untrusted", "on-failure", "on-request", "never"];
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

const state = {
  defaults: null,
  tree: null,
  agents: [],
  jobs: [],
  runs: [],
  account: null,
  currentDocument: null,
  selectedDocumentPath: "",
  selectedAgentId: null,
  selectedJobId: null,
  selectedRunId: null,
  openTabs: [],
  documentViewMode: "split",
  rightSidebarOpen: true,
  leftSidebarOpen: true,
  dirty: false,
  isSaving: false,
  saveStateLabel: "Idle",
  searchTimer: null,
  autosaveTimer: null,
  socket: null,
};

const el = {
  accountStatus: document.querySelector("#account-status"),
  loginButton: document.querySelector("#login-button"),
  logoutButton: document.querySelector("#logout-button"),
  searchInput: document.querySelector("#search-input"),
  searchResults: document.querySelector("#search-results"),
  newNoteButton: document.querySelector("#new-note-button"),
  explorerToggleButton: document.querySelector("#explorer-toggle-button"),
  newNoteForm: document.querySelector("#new-note-form"),
  newNoteName: document.querySelector("#new-note-name"),
  newNoteParent: document.querySelector("#new-note-parent"),
  cancelNewNoteButton: document.querySelector("#cancel-new-note-button"),
  treeRoot: document.querySelector("#tree-root"),
  noteTabs: document.querySelector("#note-tabs"),
  viewEditButton: document.querySelector("#view-edit-button"),
  viewPreviewButton: document.querySelector("#view-preview-button"),
  viewSplitButton: document.querySelector("#view-split-button"),
  documentContent: document.querySelector("#document-content"),
  documentTitle: document.querySelector("#document-title"),
  documentPath: document.querySelector("#document-path"),
  editor: document.querySelector("#editor-textarea"),
  previewPane: document.querySelector("#preview-pane"),
  saveButton: document.querySelector("#save-button"),
  runOnNoteButton: document.querySelector("#run-on-note-button"),
  documentState: document.querySelector("#document-state"),
  toggleRightSidebar: document.querySelector("#toggle-right-sidebar-button"),
  toggleLeftSidebar: document.querySelector("#toggle-left-sidebar"),
  leftSidebar: document.querySelector("#left-sidebar"),
  rightSidebar: document.querySelector("#right-sidebar"),
  // Unified sidebar
  agentPicker: document.querySelector("#agent-picker"),
  newAgentButton: document.querySelector("#new-agent-button"),
  agentContext: document.querySelector("#agent-context"),
  agentFormTitle: document.querySelector("#agent-form-title"),
  agentFormSubtitle: document.querySelector("#agent-form-subtitle"),
  agentStatusIndicator: document.querySelector("#agent-status-indicator"),
  quickRunForm: document.querySelector("#quick-run-form"),
  quickRunPrompt: document.querySelector("#quick-run-prompt"),
  quickRunButton: document.querySelector("#quick-run-button"),
  runList: document.querySelector("#run-list"),
  runDetail: document.querySelector("#run-detail"),
  jobList: document.querySelector("#job-list"),
  newJobButton: document.querySelector("#new-job-button"),
  jobForm: document.querySelector("#job-form"),
  jobConfigDetails: document.querySelector("#job-config-details"),
  jobId: document.querySelector("#job-id"),
  jobName: document.querySelector("#job-name"),
  jobPrompt: document.querySelector("#job-prompt"),
  jobScheduleType: document.querySelector("#job-schedule-type"),
  jobIntervalMinutes: document.querySelector("#job-interval-minutes"),
  jobEnabled: document.querySelector("#job-enabled"),
  agentForm: document.querySelector("#agent-form"),
  agentConfigDetails: document.querySelector("#agent-config-details"),
  agentId: document.querySelector("#agent-id"),
  agentName: document.querySelector("#agent-name"),
  agentScopePath: document.querySelector("#agent-scope-path"),
  agentOutputDir: document.querySelector("#agent-output-dir"),
  agentPrompt: document.querySelector("#agent-prompt"),
  agentModel: document.querySelector("#agent-model"),
  agentEffort: document.querySelector("#agent-effort"),
  agentApproval: document.querySelector("#agent-approval"),
  agentSandbox: document.querySelector("#agent-sandbox"),
  agentEnabled: document.querySelector("#agent-enabled"),
  resetAgentButton: document.querySelector("#reset-agent-button"),
  statusNotePath: document.querySelector("#status-note-path"),
  statusWordCount: document.querySelector("#status-word-count"),
  statusSaveState: document.querySelector("#status-save-state"),
  statusAgentState: document.querySelector("#status-agent-state"),
  statusNextRun: document.querySelector("#status-next-run"),
  toast: document.querySelector("#toast"),
};

document.addEventListener("DOMContentLoaded", () => {
  populateSelect(el.agentEffort, EFFORTS);
  populateSelect(el.agentApproval, APPROVALS);
  populateSelect(el.agentSandbox, SANDBOXES);
  bindEvents();
  applyViewMode();
  bootstrap();
  connectEvents();
});

function bindEvents() {
  el.loginButton.addEventListener("click", login);
  el.logoutButton.addEventListener("click", logout);
  el.searchInput.addEventListener("input", handleSearchInput);
  el.searchInput.addEventListener("focus", handleSearchInput);
  el.newNoteButton.addEventListener("click", showNewNoteComposer);
  el.explorerToggleButton.addEventListener("click", showNewNoteComposer);
  el.newNoteForm.addEventListener("submit", submitNewNote);
  el.cancelNewNoteButton.addEventListener("click", hideNewNoteComposer);
  el.saveButton.addEventListener("click", () => saveCurrentDocument({ autosave: false }));
  el.editor.addEventListener("input", handleEditorInput);
  el.viewEditButton.addEventListener("click", () => setViewMode("edit"));
  el.viewPreviewButton.addEventListener("click", () => setViewMode("preview"));
  el.viewSplitButton.addEventListener("click", () => setViewMode("split"));
  el.noteTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-note-path]");
    if (btn) loadDocument(btn.dataset.notePath);
  });
  el.toggleRightSidebar.addEventListener("click", toggleRightSidebar);
  el.toggleLeftSidebar.addEventListener("click", toggleLeftSidebar);
  el.newAgentButton.addEventListener("click", () => {
    setRightSidebarOpen(true);
    resetAgentForm();
    el.agentConfigDetails.open = true;
  });
  el.agentForm.addEventListener("submit", saveAgent);
  el.resetAgentButton.addEventListener("click", () => resetAgentForm(state.selectedAgentId));
  el.quickRunForm.addEventListener("submit", quickRun);
  el.runOnNoteButton.addEventListener("click", runOnCurrentNote);
  el.newJobButton.addEventListener("click", () => {
    setRightSidebarOpen(true);
    resetJobForm();
    el.jobConfigDetails.open = true;
  });
  el.jobForm.addEventListener("submit", saveJob);
  el.jobScheduleType.addEventListener("change", syncJobScheduleUi);
  el.runDetail.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-note]");
    if (btn) loadDocument(btn.dataset.openNote);
  });

  document.addEventListener("click", (e) => {
    if (!el.searchResults.contains(e.target) && e.target !== el.searchInput) {
      el.searchResults.classList.add("hidden");
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrentDocument({ autosave: false });
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleLeftSidebar();
    }
    if (e.key === "Escape") {
      hideNewNoteComposer();
      el.searchResults.classList.add("hidden");
    }
  });
}

// ---- Bootstrap ----

async function bootstrap() {
  try {
    const data = await api("/api/bootstrap");
    state.defaults = data.defaults;
    state.tree = data.tree;
    state.agents = data.agents;
    state.runs = data.runs;
    state.account = data.account;

    renderAccount();
    renderTree();
    renderAgentPicker();
    resetAgentForm();
    resetJobForm();
    updateStatusBar();

    if (state.agents.length && !state.selectedAgentId) {
      await selectAgent(state.agents[0].id);
    } else {
      renderRuns(state.runs);
    }

    const initialPath = firstFilePath(data.tree);
    if (initialPath) {
      await loadDocument(initialPath, { bypassConfirm: true });
    } else {
      renderCurrentDocument();
    }
  } catch (error) {
    toast(error.message || "Failed to load Astra.");
  }
}

// ---- Auth ----

async function login() {
  try {
    const result = await api("/api/account/login", { method: "POST" });
    if (result.authUrl) window.open(result.authUrl, "_blank", "noopener,noreferrer");
    await refreshAccount();
    toast("Login started in your browser.");
  } catch (error) {
    toast(error.message || "Could not start login.");
  }
}

async function logout() {
  try {
    await api("/api/account/logout", { method: "POST" });
    await refreshAccount();
    toast("Logged out.");
  } catch (error) {
    toast(error.message || "Could not log out.");
  }
}

async function refreshAccount() {
  state.account = await api("/api/account");
  renderAccount();
}

function renderAccount() {
  if (!state.account) return;
  if (state.account.loggedIn) {
    el.accountStatus.textContent = state.account.email || "Logged in";
    el.accountStatus.className = "auth-pill";
    el.loginButton.classList.add("hidden");
    el.logoutButton.classList.remove("hidden");
  } else {
    el.accountStatus.textContent = "Not logged in";
    el.accountStatus.className = "auth-pill warning";
    el.loginButton.classList.remove("hidden");
    el.logoutButton.classList.add("hidden");
  }
}

// ---- New note ----

function showNewNoteComposer() {
  el.newNoteParent.value = preferredNewNoteParent();
  el.newNoteName.value = "";
  el.newNoteForm.classList.remove("hidden");
  el.newNoteName.focus();
}

function hideNewNoteComposer() {
  el.newNoteForm.classList.add("hidden");
}

async function submitNewNote(event) {
  event.preventDefault();
  const name = el.newNoteName.value.trim();
  if (!name) { toast("Name the note first."); return; }
  try {
    const result = await api("/api/documents", {
      method: "POST",
      body: JSON.stringify({ parent: el.newNoteParent.value, name }),
    });
    hideNewNoteComposer();
    await refreshTree();
    await loadDocument(result.path, { bypassConfirm: true });
    toast(`Created ${result.path}`);
  } catch (error) {
    toast(error.message || "Could not create note.");
  }
}

function preferredNewNoteParent() {
  if (!state.currentDocument?.path) return state.defaults?.inboxDir || "";
  const parts = state.currentDocument.path.split("/");
  parts.pop();
  return parts.join("/") || state.defaults?.inboxDir || "";
}

// ---- File tree ----

function renderTree() {
  el.treeRoot.innerHTML = "";
  if (!state.tree || !state.tree.children?.length) {
    el.treeRoot.innerHTML = '<div class="empty-state" style="padding:8px 14px;">Vault is empty.</div>';
    return;
  }
  for (const child of state.tree.children) {
    el.treeRoot.appendChild(renderTreeNode(child));
  }
}

function renderTreeNode(node) {
  if (node.kind === "dir") {
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = node.name || "Vault";
    details.appendChild(summary);
    for (const child of node.children || []) {
      details.appendChild(renderTreeNode(child));
    }
    return details;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = node.name;
  if (node.path === state.selectedDocumentPath) button.classList.add("active");
  button.addEventListener("click", () => loadDocument(node.path));
  return button;
}

// ---- Document ----

async function loadDocument(path, options = {}) {
  if (!options.bypassConfirm && !(await confirmDiscardChanges())) return;
  try {
    const doc = await api(`/api/documents/${encodePath(path)}`);
    state.currentDocument = doc;
    state.selectedDocumentPath = doc.path;
    state.dirty = false;
    state.saveStateLabel = doc.editable ? "Ready" : "Read only";
    rememberOpenTab(doc);
    renderCurrentDocument();
    renderTree();
  } catch (error) {
    toast(error.message || "Could not load document.");
  }
}

function renderCurrentDocument() {
  const doc = state.currentDocument;
  if (!doc) {
    el.documentTitle.textContent = "Welcome";
    el.documentPath.textContent = "Choose a note from the vault.";
    el.editor.value = "";
    el.previewPane.innerHTML = '<p class="preview-empty">Select a note to start writing.</p>';
    el.editor.disabled = true;
    el.saveButton.disabled = true;
    el.runOnNoteButton.disabled = true;
    setDocumentState("Idle", "muted");
    renderNoteTabs();
    updateStatusBar();
    return;
  }
  el.documentTitle.textContent = doc.title || doc.path || "Untitled";
  el.documentPath.textContent = doc.path || "/";
  el.editor.value = doc.content ?? "";
  el.editor.disabled = !doc.editable;
  el.saveButton.disabled = !doc.editable;
  el.runOnNoteButton.disabled = !state.selectedAgentId || !doc.editable;
  setDocumentState(doc.editable ? state.saveStateLabel : "Read only", doc.editable ? "success" : "muted");
  updatePreview();
  renderNoteTabs();
  updateStatusBar();
}

function rememberOpenTab(doc) {
  const existing = state.openTabs.filter((t) => t.path !== doc.path);
  existing.unshift({ path: doc.path, title: doc.title || doc.path });
  state.openTabs = existing.slice(0, 8);
}

function renderNoteTabs() {
  el.noteTabs.innerHTML = "";
  for (const tab of state.openTabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-tab";
    button.dataset.notePath = tab.path;
    if (tab.path === state.selectedDocumentPath) button.classList.add("note-tab-active");
    button.textContent = tab.title;
    el.noteTabs.appendChild(button);
  }
}

function handleEditorInput() {
  if (!state.currentDocument?.editable) return;
  state.dirty = true;
  state.saveStateLabel = "Unsaved";
  setDocumentState("Unsaved", "warning");
  updatePreview();
  updateStatusBar();
  scheduleAutosave();
}

function scheduleAutosave() {
  window.clearTimeout(state.autosaveTimer);
  if (!state.currentDocument?.editable) return;
  state.autosaveTimer = window.setTimeout(() => saveCurrentDocument({ autosave: true }), 900);
}

async function saveCurrentDocument({ autosave }) {
  if (!state.currentDocument?.editable || state.isSaving) return;
  state.isSaving = true;
  state.saveStateLabel = "Saving...";
  setDocumentState("Saving...", "warning");
  updateStatusBar();
  try {
    const result = await api(`/api/documents/${encodePath(state.currentDocument.path)}`, {
      method: "PUT",
      body: JSON.stringify({ content: el.editor.value }),
    });
    state.currentDocument = result;
    state.dirty = false;
    state.saveStateLabel = "Saved";
    rememberOpenTab(result);
    renderCurrentDocument();
    await refreshTree();
    if (!autosave) toast("Saved.");
  } catch (error) {
    state.saveStateLabel = "Save failed";
    setDocumentState("Save failed", "danger");
    toast(error.message || "Could not save.");
  } finally {
    state.isSaving = false;
    updateStatusBar();
  }
}

function setViewMode(mode) {
  state.documentViewMode = mode;
  applyViewMode();
}

function applyViewMode() {
  el.documentContent.className = `doc-content doc-content-${state.documentViewMode}`;
  el.viewEditButton.classList.toggle("view-btn-active", state.documentViewMode === "edit");
  el.viewPreviewButton.classList.toggle("view-btn-active", state.documentViewMode === "preview");
  el.viewSplitButton.classList.toggle("view-btn-active", state.documentViewMode === "split");
  el.editor.classList.toggle("hidden", state.documentViewMode === "preview");
  el.previewPane.classList.toggle("hidden", state.documentViewMode === "edit");
}

function updatePreview() {
  const text = el.editor.value || "";
  el.previewPane.innerHTML = markdownToHtml(text) || '<p class="preview-empty">Nothing to preview.</p>';
}

// ---- Search ----

function handleSearchInput() {
  window.clearTimeout(state.searchTimer);
  const query = el.searchInput.value.trim();
  if (!query) {
    el.searchResults.classList.add("hidden");
    el.searchResults.innerHTML = "";
    return;
  }
  state.searchTimer = window.setTimeout(async () => {
    try {
      const result = await api(`/api/search?q=${encodeURIComponent(query)}`);
      renderSearchResults(result.results || []);
    } catch (error) {
      toast(error.message || "Search failed.");
    }
  }, 150);
}

function renderSearchResults(results) {
  el.searchResults.innerHTML = "";
  if (!results.length) {
    el.searchResults.innerHTML = '<div class="empty-state" style="padding:8px;">No results.</div>';
    el.searchResults.classList.remove("hidden");
    return;
  }
  for (const r of results) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-result";
    btn.innerHTML = `
      <div class="card-row"><span class="card-title">${esc(r.title || r.path)}</span>
        <span class="card-meta" style="margin:0">${esc(r.path)}</span></div>
      <div class="card-meta">${highlightSnippet(r.snippet || "")}</div>`;
    btn.addEventListener("click", async () => {
      el.searchResults.classList.add("hidden");
      el.searchInput.value = "";
      await loadDocument(r.path);
    });
    el.searchResults.appendChild(btn);
  }
  el.searchResults.classList.remove("hidden");
}

// ---- Sidebar toggles ----

function setRightSidebarOpen(open) {
  state.rightSidebarOpen = open;
  el.rightSidebar.classList.toggle("right-sidebar-collapsed", !open);
}

function toggleRightSidebar() {
  setRightSidebarOpen(!state.rightSidebarOpen);
}

function toggleLeftSidebar() {
  state.leftSidebarOpen = !state.leftSidebarOpen;
  el.leftSidebar.classList.toggle("collapsed", !state.leftSidebarOpen);
}

// ===================================================================
// Agent sidebar (unified)
// ===================================================================

function renderAgentPicker() {
  el.agentPicker.innerHTML = "";
  if (!state.agents.length) {
    el.agentPicker.innerHTML = '<span class="empty-state">No agents yet.</span>';
    return;
  }
  for (const agent of state.agents) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "agent-chip";
    if (agent.id === state.selectedAgentId) chip.classList.add("agent-chip-active");

    const dotClass = agent.isRunning ? "dot-running" : agent.enabled ? "dot-ready" : "dot-off";
    chip.innerHTML = `<span class="agent-chip-dot ${dotClass}"></span>${esc(agent.name)}`;
    chip.addEventListener("click", () => selectAgent(agent.id));
    el.agentPicker.appendChild(chip);
  }
}

async function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  state.selectedJobId = null;
  state.selectedRunId = null;
  renderAgentPicker();
  await loadAgentDetails(agentId);
}

async function loadAgentDetails(agentId) {
  try {
    const result = await api(`/api/agents/${agentId}`);
    fillAgentContext(result.agent);
    fillAgentForm(result.agent);
    renderJobs(result.jobs);
    renderRuns(result.runs);
    if (result.runs.length) {
      showRunDetail(result.runs[0]);
    } else {
      clearRunDetail();
    }
  } catch (error) {
    toast(error.message || "Could not load agent.");
  }
}

function fillAgentContext(agent) {
  el.agentFormTitle.textContent = agent.name;

  const parts = [];
  if (agent.scopePath) parts.push(agent.scopePath);
  if (agent.threadId) parts.push(`Thread ${agent.threadId.slice(0, 8)}...`);
  else parts.push("No thread yet");
  el.agentFormSubtitle.textContent = parts.join(" · ");

  const dotClass = agent.isRunning ? "dot-running" : agent.enabled ? "dot-ready" : "dot-off";
  el.agentStatusIndicator.className = `agent-status-dot ${dotClass}`;

  el.quickRunButton.disabled = false;
  el.runOnNoteButton.disabled = !state.currentDocument?.editable;
  updateStatusBar();
}

function fillAgentForm(agent) {
  el.agentId.value = agent.id;
  el.agentName.value = agent.name;
  el.agentScopePath.value = agent.scopePath;
  el.agentOutputDir.value = agent.outputDir;
  el.agentPrompt.value = agent.prompt;
  el.agentModel.value = agent.model;
  el.agentEffort.value = agent.reasoningEffort;
  el.agentApproval.value = agent.approvalPolicy;
  el.agentSandbox.value = agent.sandboxMode;
  el.agentEnabled.checked = Boolean(agent.enabled);
  el.agentConfigDetails.open = false;
}

function resetAgentForm(agentId = null) {
  const agent = agentId ? state.agents.find((a) => a.id === agentId) : null;
  if (agent) {
    fillAgentContext(agent);
    fillAgentForm(agent);
    return;
  }
  state.selectedAgentId = null;
  renderAgentPicker();
  el.agentFormTitle.textContent = "No agent selected";
  el.agentFormSubtitle.textContent = "Create an agent to get started.";
  el.agentStatusIndicator.className = "agent-status-dot";
  el.agentId.value = "";
  el.agentName.value = "";
  el.agentScopePath.value = "";
  el.agentOutputDir.value = state.defaults?.inboxDir || "Inbox";
  el.agentPrompt.value = "";
  el.agentModel.value = state.defaults?.model || "";
  el.agentEffort.value = state.defaults?.reasoningEffort || "high";
  el.agentApproval.value = state.defaults?.approvalPolicy || "never";
  el.agentSandbox.value = state.defaults?.sandboxMode || "workspace-write";
  el.agentEnabled.checked = true;
  el.quickRunPrompt.value = "";
  el.quickRunButton.disabled = true;
  el.runOnNoteButton.disabled = true;
  el.agentConfigDetails.open = true;
  renderRuns(state.runs);
  renderJobs([]);
  clearRunDetail();
  updateStatusBar();
}

async function saveAgent(event) {
  event.preventDefault();
  const payload = {
    name: el.agentName.value,
    scope_path: el.agentScopePath.value,
    output_dir: el.agentOutputDir.value,
    prompt: el.agentPrompt.value,
    model: el.agentModel.value,
    reasoning_effort: el.agentEffort.value,
    approval_policy: el.agentApproval.value,
    sandbox_mode: el.agentSandbox.value,
    enabled: el.agentEnabled.checked,
  };
  try {
    let result;
    if (el.agentId.value) {
      result = await api(`/api/agents/${el.agentId.value}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      result = await api("/api/agents", { method: "POST", body: JSON.stringify(payload) });
    }
    await refreshAgents();
    await selectAgent(result.agent.id);
    toast("Agent saved.");
  } catch (error) {
    toast(error.message || "Could not save agent.");
  }
}

async function quickRun(event) {
  event.preventDefault();
  if (!state.selectedAgentId) { toast("Select an agent first."); return; }
  try {
    const result = await api(`/api/agents/${state.selectedAgentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ prompt: el.quickRunPrompt.value }),
    });
    el.quickRunPrompt.value = "";
    toast(`Run ${result.run.id} started.`);
    await refreshRunsForSelection();
    await refreshAgents();
  } catch (error) {
    toast(error.message || "Could not start run.");
  }
}

async function runOnCurrentNote() {
  if (!state.selectedAgentId) {
    setRightSidebarOpen(true);
    toast("Select an agent first.");
    return;
  }
  if (!state.currentDocument?.path) { toast("Open a note first."); return; }
  const prompt = `Review the note at \`${state.currentDocument.path}\`. Improve its clarity and structure, preserve the author's intent, and write the results back into the vault if a meaningful update is warranted.`;
  try {
    const result = await api(`/api/agents/${state.selectedAgentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    setRightSidebarOpen(true);
    toast(`Run ${result.run.id} started.`);
    await refreshRunsForSelection();
    await refreshAgents();
  } catch (error) {
    toast(error.message || "Could not start run.");
  }
}

// ---- Runs ----

function renderRuns(runs) {
  state.runs = runs;
  el.runList.innerHTML = "";
  if (!runs.length) {
    el.runList.innerHTML = '<div class="empty-state">No runs yet.</div>';
    clearRunDetail();
    updateStatusBar();
    return;
  }
  for (const run of runs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "run-card";
    if (run.id === state.selectedRunId) btn.classList.add("run-card-active");
    btn.innerHTML = `
      <div class="card-row">
        <span class="card-title">${esc(shortRunTitle(run))}</span>
        <span class="status-pill ${statusClass(run.status)}">${esc(run.status)}</span>
      </div>
      <p class="card-meta">${esc(run.trigger)} &middot; ${formatDate(run.startedAt)}</p>`;
    btn.addEventListener("click", () => showRunDetail(run));
    el.runList.appendChild(btn);
  }
  updateStatusBar();
}

function showRunDetail(run) {
  state.selectedRunId = run.id;
  renderRuns(state.runs);
  const touched = run.touchedPaths?.length
    ? `<div class="card-meta">Touched: ${esc(run.touchedPaths.join(", "))}</div>` : "";
  const outputBtn = run.outputNotePath
    ? `<button type="button" class="btn-ghost btn-sm" data-open-note="${esc(run.outputNotePath)}">Open note</button>` : "";
  const text = esc(run.finalText || run.errorText || "No summary.");
  el.runDetail.classList.remove("empty-state");
  el.runDetail.innerHTML = `
    <div class="card-row" style="margin-bottom:3px;">
      <span style="font-size:11px;color:var(--text-tertiary)">${esc(run.id)}</span>
      <span class="status-pill ${statusClass(run.status)}">${esc(run.status)}</span>
    </div>
    <div class="card-meta">${formatDate(run.startedAt)} &rarr; ${formatDate(run.finishedAt)}</div>
    ${touched}
    <div class="card-meta" style="margin-top:6px;white-space:pre-wrap;color:var(--text-secondary);">${text}</div>
    ${outputBtn ? `<div style="margin-top:6px;">${outputBtn}</div>` : ""}`;
  updateStatusBar();
}

function clearRunDetail() {
  state.selectedRunId = null;
  el.runDetail.classList.add("empty-state");
  el.runDetail.textContent = "Select a run to see details.";
}

// ---- Jobs ----

function renderJobs(jobs) {
  state.jobs = jobs;
  el.jobList.innerHTML = "";
  if (!jobs.length) {
    el.jobList.innerHTML = '<div class="empty-state">No jobs for this agent.</div>';
    resetJobForm();
    updateStatusBar();
    return;
  }
  for (const job of jobs) {
    const card = document.createElement("div");
    card.className = "job-card";
    if (job.id === state.selectedJobId) card.classList.add("job-card-active");
    card.innerHTML = `
      <div class="card-row">
        <span class="card-title">${esc(job.name)}</span>
        <span class="status-pill ${job.enabled ? "success" : "muted"}">
          ${job.scheduleType === "interval" ? `${job.intervalMinutes}m` : "Manual"}
        </span>
      </div>
      <p class="card-meta">Next: ${formatDate(job.nextRunAt)}</p>
      <div class="form-row" style="margin-top:4px;">
        <button type="button" class="btn-ghost btn-sm" data-edit-job="${job.id}">Edit</button>
        <button type="button" class="btn-primary btn-sm" data-run-job="${job.id}">Run now</button>
      </div>`;
    card.querySelector("[data-edit-job]").addEventListener("click", () => fillJobForm(job));
    card.querySelector("[data-run-job]").addEventListener("click", () => runJob(job.id));
    el.jobList.appendChild(card);
  }
  updateStatusBar();
}

function fillJobForm(job) {
  state.selectedJobId = job.id;
  el.jobId.value = job.id;
  el.jobName.value = job.name;
  el.jobPrompt.value = job.prompt;
  el.jobScheduleType.value = job.scheduleType;
  el.jobIntervalMinutes.value = job.intervalMinutes || 60;
  el.jobEnabled.checked = Boolean(job.enabled);
  el.jobConfigDetails.open = true;
  syncJobScheduleUi();
  renderJobs(state.jobs);
}

function resetJobForm() {
  state.selectedJobId = null;
  el.jobId.value = "";
  el.jobName.value = "";
  el.jobPrompt.value = "";
  el.jobScheduleType.value = "interval";
  el.jobIntervalMinutes.value = 60;
  el.jobEnabled.checked = true;
  syncJobScheduleUi();
}

function syncJobScheduleUi() {
  el.jobIntervalMinutes.disabled = el.jobScheduleType.value !== "interval";
}

async function saveJob(event) {
  event.preventDefault();
  if (!state.selectedAgentId) { toast("Select an agent first."); return; }
  const payload = {
    name: el.jobName.value,
    prompt: el.jobPrompt.value,
    schedule_type: el.jobScheduleType.value,
    interval_minutes: Number(el.jobIntervalMinutes.value || 0),
    enabled: el.jobEnabled.checked,
  };
  try {
    if (el.jobId.value) {
      await api(`/api/jobs/${el.jobId.value}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await api(`/api/agents/${state.selectedAgentId}/jobs`, { method: "POST", body: JSON.stringify(payload) });
    }
    await loadAgentDetails(state.selectedAgentId);
    resetJobForm();
    toast("Job saved.");
  } catch (error) {
    toast(error.message || "Could not save job.");
  }
}

async function runJob(jobId) {
  try {
    const result = await api(`/api/jobs/${jobId}/run`, { method: "POST" });
    toast(`Run ${result.run.id} started.`);
    await refreshRunsForSelection();
    await refreshAgents();
  } catch (error) {
    toast(error.message || "Could not start job.");
  }
}

// ---- Refreshes ----

async function refreshTree() {
  state.tree = await api("/api/tree");
  renderTree();
}

async function refreshAgents() {
  const result = await api("/api/agents");
  state.agents = result.agents;
  renderAgentPicker();
}

async function refreshRunsForSelection() {
  if (state.selectedAgentId) {
    await loadAgentDetails(state.selectedAgentId);
    return;
  }
  const result = await api("/api/runs");
  renderRuns(result.runs);
}

// ---- WebSocket ----

function connectEvents() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${window.location.host}/api/events`);
  state.socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "vault.changed") {
      await refreshTree();
      if (state.selectedDocumentPath && !state.dirty) {
        await loadDocument(state.selectedDocumentPath, { bypassConfirm: true });
      }
    }
    if (data.type === "agents.changed" || data.type === "jobs.changed") {
      await refreshAgents();
      if (state.selectedAgentId) await loadAgentDetails(state.selectedAgentId);
    }
    if (data.type === "run.queued" || data.type === "run.started" || data.type === "run.completed") {
      await refreshAgents();
      await refreshRunsForSelection();
    }
  });
  state.socket.addEventListener("close", () => setTimeout(connectEvents, 1500));
}

// ---- Status bar ----

function updateStatusBar() {
  const text = el.editor.value || "";
  el.statusWordCount.textContent = `${countWords(text)} words`;
  el.statusNotePath.textContent = state.currentDocument?.path || "No note";
  el.statusSaveState.textContent = state.saveStateLabel;

  const agent = state.agents.find((a) => a.id === state.selectedAgentId);
  el.statusAgentState.textContent = agent
    ? (agent.isRunning ? `${agent.name} running` : agent.name)
    : "No agent";

  const nextRun = nextScheduledRun();
  el.statusNextRun.textContent = nextRun ? `Next: ${formatDate(nextRun)}` : "No heartbeat";
}

function nextScheduledRun() {
  const dates = state.agents
    .map((a) => a.nextRunAt)
    .filter(Boolean)
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);
  return dates[0]?.toISOString() || null;
}

// ---- Helpers ----

async function confirmDiscardChanges() {
  if (!state.dirty) return true;
  return window.confirm("Discard unsaved changes?");
}

function setDocumentState(text, kind) {
  el.documentState.textContent = text;
  el.documentState.className = `state-pill ${kind || "muted"}`;
}

function shortRunTitle(run) {
  if (run.outputNotePath) {
    const parts = run.outputNotePath.split("/");
    return parts[parts.length - 1] || run.outputNotePath;
  }
  return run.id;
}

function formatDate(value) {
  if (!value) return "\u2014";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  if (diff >= 0 && diff < 60000) return "just now";
  if (diff >= 0 && diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff >= 0 && diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function firstFilePath(node) {
  if (!node) return null;
  for (const child of node.children || []) {
    if (child.kind === "file") return child.path;
    const nested = firstFilePath(child);
    if (nested) return nested;
  }
  return null;
}

function populateSelect(select, values) {
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  }
}

function statusClass(status) {
  if (status === "succeeded" || status === "saved") return "success";
  if (status === "failed") return "danger";
  if (status === "queued" || status === "running") return "warning";
  return "muted";
}

function countWords(text) {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function markdownToHtml(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const codeBlocks = [];
  let source = esc(normalized).replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  const lines = source.split("\n");
  const html = [];
  let para = [], list = [], quotes = [];

  const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list.length) { html.push(`<ul>${list.map(i => `<li>${inline(i)}</li>`).join("")}</ul>`); list = []; } };
  const flushQuote = () => { if (quotes.length) { html.push(`<blockquote>${quotes.map(l => `<p>${inline(l)}</p>`).join("")}</blockquote>`); quotes = []; } };

  for (const line of lines) {
    const t = line.trim();
    if (!t) { flushPara(); flushList(); flushQuote(); continue; }
    const hm = t.match(/^(#{1,6})\s+(.+)$/);
    if (hm) { flushPara(); flushList(); flushQuote(); html.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); continue; }
    const lm = t.match(/^[-*]\s+(.+)$/);
    if (lm) { flushPara(); flushQuote(); list.push(lm[1]); continue; }
    const qm = t.match(/^&gt;\s?(.+)$/);
    if (qm) { flushPara(); flushList(); quotes.push(qm[1]); continue; }
    flushList(); flushQuote(); para.push(t);
  }
  flushPara(); flushList(); flushQuote();

  let out = html.join("");
  out = out.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => codeBlocks[Number(i)] || "");
  return out;
}

function inline(text) {
  return text
    .replace(/\[\[([^\]]+)\]\]/g, '<a href="#" class="preview-link">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function encodePath(path) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function highlightSnippet(value) {
  return esc(value).replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  clearTimeout(el.toast._timer);
  el.toast._timer = setTimeout(() => el.toast.classList.add("hidden"), 3200);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let detail = "Request failed.";
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

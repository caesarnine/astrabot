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
  sidebarTab: "activity",
  rightSidebarOpen: true,
  dirty: false,
  isSaving: false,
  saveStateLabel: "Idle",
  searchTimer: null,
  autosaveTimer: null,
  socket: null,
};

const elements = {
  accountStatus: document.querySelector("#account-status"),
  loginButton: document.querySelector("#login-button"),
  logoutButton: document.querySelector("#logout-button"),
  searchInput: document.querySelector("#search-input"),
  searchResults: document.querySelector("#search-results"),
  newNoteButton: document.querySelector("#new-note-button"),
  leftNewNoteButton: document.querySelector("#left-new-note-button"),
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
  documentBreadcrumbs: document.querySelector("#document-breadcrumbs"),
  documentState: document.querySelector("#document-state"),
  currentAgentChip: document.querySelector("#current-agent-chip"),
  editor: document.querySelector("#editor-textarea"),
  previewPane: document.querySelector("#preview-pane"),
  saveButton: document.querySelector("#save-button"),
  runOnNoteButton: document.querySelector("#run-on-note-button"),
  openActivityButton: document.querySelector("#open-activity-button"),
  openAgentsButton: document.querySelector("#open-agents-button"),
  leftOpenAgentsButton: document.querySelector("#left-open-agents-button"),
  leftOpenActivityButton: document.querySelector("#left-open-activity-button"),
  toggleRightSidebarButton: document.querySelector("#toggle-right-sidebar-button"),
  rightSidebar: document.querySelector("#right-sidebar"),
  sidebarTabs: Array.from(document.querySelectorAll("[data-sidebar-tab]")),
  activityPanel: document.querySelector("#activity-panel"),
  agentsPanel: document.querySelector("#agents-panel"),
  jobsPanel: document.querySelector("#jobs-panel"),
  agentGlanceList: document.querySelector("#agent-glance-list"),
  agentList: document.querySelector("#agent-list"),
  newAgentButton: document.querySelector("#new-agent-button"),
  agentForm: document.querySelector("#agent-form"),
  agentConfigDetails: document.querySelector("#agent-config-details"),
  agentFormTitle: document.querySelector("#agent-form-title"),
  agentFormSubtitle: document.querySelector("#agent-form-subtitle"),
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
  quickRunForm: document.querySelector("#quick-run-form"),
  quickRunPrompt: document.querySelector("#quick-run-prompt"),
  quickRunButton: document.querySelector("#quick-run-button"),
  newJobButton: document.querySelector("#new-job-button"),
  jobList: document.querySelector("#job-list"),
  jobForm: document.querySelector("#job-form"),
  jobConfigDetails: document.querySelector("#job-config-details"),
  jobId: document.querySelector("#job-id"),
  jobName: document.querySelector("#job-name"),
  jobPrompt: document.querySelector("#job-prompt"),
  jobScheduleType: document.querySelector("#job-schedule-type"),
  jobIntervalMinutes: document.querySelector("#job-interval-minutes"),
  jobEnabled: document.querySelector("#job-enabled"),
  runList: document.querySelector("#run-list"),
  runDetail: document.querySelector("#run-detail"),
  statusNotePath: document.querySelector("#status-note-path"),
  statusWordCount: document.querySelector("#status-word-count"),
  statusSaveState: document.querySelector("#status-save-state"),
  statusAgentState: document.querySelector("#status-agent-state"),
  statusNextRun: document.querySelector("#status-next-run"),
  toast: document.querySelector("#toast"),
};

document.addEventListener("DOMContentLoaded", () => {
  populateSelect(elements.agentEffort, EFFORTS);
  populateSelect(elements.agentApproval, APPROVALS);
  populateSelect(elements.agentSandbox, SANDBOXES);
  bindEvents();
  applyViewMode();
  openSidebarTab("activity");
  bootstrap();
  connectEvents();
});

function bindEvents() {
  elements.loginButton.addEventListener("click", login);
  elements.logoutButton.addEventListener("click", logout);

  elements.searchInput.addEventListener("input", handleSearchInput);
  elements.searchInput.addEventListener("focus", handleSearchInput);

  elements.newNoteButton.addEventListener("click", showNewNoteComposer);
  elements.leftNewNoteButton.addEventListener("click", showNewNoteComposer);
  elements.explorerToggleButton.addEventListener("click", showNewNoteComposer);
  elements.newNoteForm.addEventListener("submit", submitNewNote);
  elements.cancelNewNoteButton.addEventListener("click", hideNewNoteComposer);

  elements.saveButton.addEventListener("click", () => saveCurrentDocument({ autosave: false }));
  elements.editor.addEventListener("input", handleEditorInput);
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  });

  elements.viewEditButton.addEventListener("click", () => setViewMode("edit"));
  elements.viewPreviewButton.addEventListener("click", () => setViewMode("preview"));
  elements.viewSplitButton.addEventListener("click", () => setViewMode("split"));

  elements.noteTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-path]");
    if (button) {
      loadDocument(button.dataset.notePath);
    }
  });

  elements.toggleRightSidebarButton.addEventListener("click", toggleRightSidebar);
  elements.openActivityButton.addEventListener("click", () => {
    setRightSidebarOpen(true);
    openSidebarTab("activity");
  });
  elements.openAgentsButton.addEventListener("click", () => {
    setRightSidebarOpen(true);
    openSidebarTab("agents");
  });
  elements.leftOpenAgentsButton.addEventListener("click", () => {
    setRightSidebarOpen(true);
    openSidebarTab("agents");
  });
  elements.leftOpenActivityButton.addEventListener("click", () => {
    setRightSidebarOpen(true);
    openSidebarTab("activity");
  });

  for (const tab of elements.sidebarTabs) {
    tab.addEventListener("click", () => openSidebarTab(tab.dataset.sidebarTab));
  }

  elements.newAgentButton.addEventListener("click", () => {
    openSidebarTab("agents");
    setRightSidebarOpen(true);
    resetAgentForm();
  });
  elements.agentForm.addEventListener("submit", saveAgent);
  elements.resetAgentButton.addEventListener("click", () => resetAgentForm(state.selectedAgentId));
  elements.quickRunForm.addEventListener("submit", quickRun);
  elements.runOnNoteButton.addEventListener("click", runOnCurrentNote);

  elements.newJobButton.addEventListener("click", () => {
    openSidebarTab("jobs");
    setRightSidebarOpen(true);
    resetJobForm();
  });
  elements.jobForm.addEventListener("submit", saveJob);
  elements.jobScheduleType.addEventListener("change", syncJobScheduleUi);

  elements.runDetail.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-note]");
    if (button) {
      loadDocument(button.dataset.openNote);
    }
  });

  document.addEventListener("click", (event) => {
    if (
      !elements.searchResults.contains(event.target) &&
      event.target !== elements.searchInput &&
      !elements.searchInput.contains(event.target)
    ) {
      elements.searchResults.classList.add("hidden");
    }
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements.searchInput.focus();
      elements.searchInput.select();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrentDocument({ autosave: false });
    }
    if (event.key === "Escape") {
      hideNewNoteComposer();
      elements.searchResults.classList.add("hidden");
    }
  });
}

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
    renderAgentLists();
    renderRuns(state.runs);
    resetAgentForm();
    resetJobForm();
    updateStatusBar();

    if (state.agents.length && !state.selectedAgentId) {
      state.selectedAgentId = state.agents[0].id;
      await loadAgentDetails(state.selectedAgentId);
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

async function login() {
  try {
    const result = await api("/api/account/login", { method: "POST" });
    if (result.authUrl) {
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
    }
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
    toast("Logged out of Codex.");
  } catch (error) {
    toast(error.message || "Could not log out.");
  }
}

async function refreshAccount() {
  state.account = await api("/api/account");
  renderAccount();
}

function renderAccount() {
  if (!state.account) {
    return;
  }

  if (state.account.loggedIn) {
    elements.accountStatus.textContent = state.account.email || "Logged in";
    elements.accountStatus.className = "status-pill success";
    elements.loginButton.classList.add("hidden");
    elements.logoutButton.classList.remove("hidden");
  } else {
    elements.accountStatus.textContent = "Not logged in";
    elements.accountStatus.className = "status-pill warning";
    elements.loginButton.classList.remove("hidden");
    elements.logoutButton.classList.add("hidden");
  }
}

function showNewNoteComposer() {
  elements.newNoteParent.value = preferredNewNoteParent();
  elements.newNoteName.value = "";
  elements.newNoteForm.classList.remove("hidden");
  elements.newNoteName.focus();
}

function hideNewNoteComposer() {
  elements.newNoteForm.classList.add("hidden");
  elements.newNoteName.value = "";
}

async function submitNewNote(event) {
  event.preventDefault();
  const name = elements.newNoteName.value.trim();
  if (!name) {
    toast("Name the note first.");
    return;
  }

  try {
    const result = await api("/api/documents", {
      method: "POST",
      body: JSON.stringify({
        parent: elements.newNoteParent.value,
        name,
      }),
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
  if (!state.currentDocument?.path) {
    return state.defaults?.inboxDir || "";
  }
  const parts = state.currentDocument.path.split("/");
  parts.pop();
  return parts.join("/") || state.defaults?.inboxDir || "";
}

function renderTree() {
  elements.treeRoot.innerHTML = "";
  if (!state.tree || !state.tree.children?.length) {
    elements.treeRoot.innerHTML = '<div class="empty-state">Your vault is empty.</div>';
    return;
  }

  for (const child of state.tree.children) {
    elements.treeRoot.appendChild(renderTreeNode(child));
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
  if (node.path === state.selectedDocumentPath) {
    button.classList.add("active");
  }
  button.addEventListener("click", () => {
    loadDocument(node.path);
  });
  return button;
}

async function loadDocument(path, options = {}) {
  if (!options.bypassConfirm && !(await confirmDiscardChanges())) {
    return;
  }

  try {
    const documentPayload = await api(`/api/documents/${encodePath(path)}`);
    state.currentDocument = documentPayload;
    state.selectedDocumentPath = documentPayload.path;
    state.dirty = false;
    state.saveStateLabel = documentPayload.editable ? "Ready" : "Read only";
    rememberOpenTab(documentPayload);
    renderCurrentDocument();
    renderTree();
  } catch (error) {
    toast(error.message || "Could not load document.");
  }
}

function renderCurrentDocument() {
  const doc = state.currentDocument;
  if (!doc) {
    elements.documentBreadcrumbs.textContent = "No document selected";
    elements.documentTitle.textContent = "Welcome";
    elements.documentPath.textContent = "Choose a note from the vault.";
    elements.editor.value = "";
    elements.previewPane.innerHTML = '<p class="preview-empty">Select a note to start writing.</p>';
    elements.editor.disabled = true;
    elements.saveButton.disabled = true;
    elements.runOnNoteButton.disabled = true;
    setDocumentState("Idle", "muted");
    renderNoteTabs();
    updateStatusBar();
    return;
  }

  elements.documentBreadcrumbs.textContent = breadcrumbText(doc.path);
  elements.documentTitle.textContent = doc.title || doc.path || "Untitled";
  elements.documentPath.textContent = doc.path || "/";
  elements.editor.value = doc.content ?? "";
  elements.editor.disabled = !doc.editable;
  elements.saveButton.disabled = !doc.editable;
  elements.runOnNoteButton.disabled = !state.selectedAgentId || !doc.editable;
  setDocumentState(doc.editable ? state.saveStateLabel : "Read only", doc.editable ? "success" : "muted");
  updatePreview();
  renderNoteTabs();
  updateStatusBar();
}

function rememberOpenTab(documentPayload) {
  const existing = state.openTabs.filter((tab) => tab.path !== documentPayload.path);
  existing.unshift({
    path: documentPayload.path,
    title: documentPayload.title || documentPayload.path,
  });
  state.openTabs = existing.slice(0, 6);
}

function renderNoteTabs() {
  elements.noteTabs.innerHTML = "";
  if (!state.openTabs.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "empty-state";
    placeholder.textContent = "No open notes";
    elements.noteTabs.appendChild(placeholder);
    return;
  }

  for (const tab of state.openTabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-tab";
    button.dataset.notePath = tab.path;
    if (tab.path === state.selectedDocumentPath) {
      button.classList.add("note-tab-active");
    }
    button.textContent = tab.title;
    elements.noteTabs.appendChild(button);
  }
}

function handleEditorInput() {
  if (!state.currentDocument || !state.currentDocument.editable) {
    return;
  }
  state.dirty = true;
  state.saveStateLabel = "Unsaved changes";
  setDocumentState("Unsaved changes", "warning");
  updatePreview();
  updateStatusBar();
  scheduleAutosave();
}

function scheduleAutosave() {
  window.clearTimeout(state.autosaveTimer);
  if (!state.currentDocument?.editable) {
    return;
  }
  state.autosaveTimer = window.setTimeout(() => {
    saveCurrentDocument({ autosave: true });
  }, 900);
}

async function saveCurrentDocument({ autosave }) {
  if (!state.currentDocument || !state.currentDocument.editable || state.isSaving) {
    return;
  }

  state.isSaving = true;
  state.saveStateLabel = autosave ? "Autosaving…" : "Saving…";
  setDocumentState(state.saveStateLabel, "warning");
  updateStatusBar();

  try {
    const result = await api(`/api/documents/${encodePath(state.currentDocument.path)}`, {
      method: "PUT",
      body: JSON.stringify({ content: elements.editor.value }),
    });
    state.currentDocument = result;
    state.dirty = false;
    state.saveStateLabel = autosave ? "Autosaved" : "Saved";
    rememberOpenTab(result);
    renderCurrentDocument();
    await refreshTree();
    if (!autosave) {
      toast("Saved note.");
    }
  } catch (error) {
    state.saveStateLabel = "Save failed";
    setDocumentState("Save failed", "danger");
    toast(error.message || "Could not save document.");
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
  elements.documentContent.className = `document-content document-content-${state.documentViewMode}`;
  elements.viewEditButton.classList.toggle("toolbar-button-active", state.documentViewMode === "edit");
  elements.viewPreviewButton.classList.toggle("toolbar-button-active", state.documentViewMode === "preview");
  elements.viewSplitButton.classList.toggle("toolbar-button-active", state.documentViewMode === "split");

  elements.editor.classList.toggle("hidden", state.documentViewMode === "preview");
  elements.previewPane.classList.toggle("hidden", state.documentViewMode === "edit");
}

function updatePreview() {
  const text = elements.editor.value || "";
  const html = markdownToHtml(text);
  elements.previewPane.innerHTML = html || '<p class="preview-empty">Nothing to preview yet.</p>';
}

async function runOnCurrentNote() {
  if (!state.selectedAgentId) {
    setRightSidebarOpen(true);
    openSidebarTab("agents");
    toast("Select an ambient agent first.");
    return;
  }
  if (!state.currentDocument?.path) {
    toast("Open a note first.");
    return;
  }

  const prompt = `Review the note at \`${state.currentDocument.path}\`. Improve its clarity and structure, preserve the author's intent, and write the results back into the vault if a meaningful update is warranted.`;
  try {
    const result = await api(`/api/agents/${state.selectedAgentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    setRightSidebarOpen(true);
    openSidebarTab("activity");
    toast(`Run ${result.run.id} started.`);
    await refreshRunsForSelection();
    await refreshAgents();
  } catch (error) {
    toast(error.message || "Could not start the note run.");
  }
}

function handleSearchInput() {
  window.clearTimeout(state.searchTimer);
  const query = elements.searchInput.value.trim();
  if (!query) {
    elements.searchResults.classList.add("hidden");
    elements.searchResults.innerHTML = "";
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
  elements.searchResults.innerHTML = "";
  if (!results.length) {
    elements.searchResults.innerHTML = '<div class="empty-state">No results found.</div>';
    elements.searchResults.classList.remove("hidden");
    return;
  }

  for (const result of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    button.innerHTML = `
      <div class="card-row">
        <p class="card-title">${escapeHtml(result.title || result.path)}</p>
        <span class="card-meta">${escapeHtml(result.path)}</span>
      </div>
      <div class="card-meta">${highlightSnippet(result.snippet || "")}</div>
    `;
    button.addEventListener("click", async () => {
      elements.searchResults.classList.add("hidden");
      elements.searchInput.value = "";
      await loadDocument(result.path);
    });
    elements.searchResults.appendChild(button);
  }
  elements.searchResults.classList.remove("hidden");
}

function renderAgentLists() {
  renderAgentGlance();
  renderAgentRoster();
  updateCurrentAgentChip();
  updateStatusBar();
}

function renderAgentGlance() {
  elements.agentGlanceList.innerHTML = "";
  if (!state.agents.length) {
    elements.agentGlanceList.innerHTML = '<div class="empty-state">No ambient agents yet.</div>';
    return;
  }

  for (const agent of state.agents) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-glance";
    if (agent.id === state.selectedAgentId) {
      button.classList.add("agent-glance-active");
    }
    button.innerHTML = `
      <div class="agent-glance-copy">
        <p class="card-title">${escapeHtml(agent.name)}</p>
        <p class="card-meta">${escapeHtml(agent.scopePath || "/")} • ${formatDate(agent.nextRunAt)}</p>
      </div>
      <span class="status-pill ${agent.isRunning ? "warning" : agent.enabled ? "success" : "muted"}">
        ${agent.isRunning ? "Running" : agent.enabled ? "Ready" : "Paused"}
      </span>
    `;
    button.addEventListener("click", async () => {
      setRightSidebarOpen(true);
      openSidebarTab("agents");
      await selectAgent(agent.id);
    });
    elements.agentGlanceList.appendChild(button);
  }
}

function renderAgentRoster() {
  elements.agentList.innerHTML = "";
  if (!state.agents.length) {
    elements.agentList.innerHTML = '<div class="empty-state">Create an agent to give the workspace an ambient helper.</div>';
    return;
  }

  for (const agent of state.agents) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-card";
    if (agent.id === state.selectedAgentId) {
      button.classList.add("agent-card-active");
    }
    button.innerHTML = `
      <div class="card-row">
        <p class="card-title">${escapeHtml(agent.name)}</p>
        <span class="status-pill ${agent.isRunning ? "warning" : agent.enabled ? "success" : "muted"}">
          ${agent.isRunning ? "Running" : agent.enabled ? "Enabled" : "Paused"}
        </span>
      </div>
      <p class="card-meta">Scope: ${escapeHtml(agent.scopePath || "/")}</p>
      <p class="card-meta">Next heartbeat: ${formatDate(agent.nextRunAt)}</p>
    `;
    button.addEventListener("click", () => selectAgent(agent.id));
    elements.agentList.appendChild(button);
  }
}

async function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  state.selectedJobId = null;
  state.selectedRunId = null;
  renderAgentLists();
  await loadAgentDetails(agentId);
}

async function loadAgentDetails(agentId) {
  try {
    const result = await api(`/api/agents/${agentId}`);
    fillAgentForm(result.agent);
    renderJobs(result.jobs);
    renderRuns(result.runs);
    if (result.runs.length) {
      showRunDetail(result.runs[0]);
    } else {
      clearRunDetail();
    }
  } catch (error) {
    toast(error.message || "Could not load agent details.");
  }
}

function fillAgentForm(agent) {
  elements.agentFormTitle.textContent = agent.name;
  elements.agentFormSubtitle.textContent = agent.threadId
    ? `Thread ${agent.threadId}`
    : "Thread will be created on first run.";
  elements.agentId.value = agent.id;
  elements.agentName.value = agent.name;
  elements.agentScopePath.value = agent.scopePath;
  elements.agentOutputDir.value = agent.outputDir;
  elements.agentPrompt.value = agent.prompt;
  elements.agentModel.value = agent.model;
  elements.agentEffort.value = agent.reasoningEffort;
  elements.agentApproval.value = agent.approvalPolicy;
  elements.agentSandbox.value = agent.sandboxMode;
  elements.agentEnabled.checked = Boolean(agent.enabled);
  elements.quickRunButton.disabled = false;
  elements.runOnNoteButton.disabled = !state.currentDocument?.editable;
  elements.agentConfigDetails.open = false;
  updateCurrentAgentChip();
  updateStatusBar();
}

function resetAgentForm(agentId = null) {
  const agent = agentId ? state.agents.find((item) => item.id === agentId) : null;
  if (agent) {
    fillAgentForm(agent);
    return;
  }

  state.selectedAgentId = null;
  renderAgentLists();
  elements.agentFormTitle.textContent = "Agent Details";
  elements.agentFormSubtitle.textContent = "Select or create an ambient agent.";
  elements.agentId.value = "";
  elements.agentName.value = "";
  elements.agentScopePath.value = "";
  elements.agentOutputDir.value = state.defaults?.inboxDir || "Inbox";
  elements.agentPrompt.value = "";
  elements.agentModel.value = state.defaults?.model || "";
  elements.agentEffort.value = state.defaults?.reasoningEffort || "high";
  elements.agentApproval.value = state.defaults?.approvalPolicy || "never";
  elements.agentSandbox.value = state.defaults?.sandboxMode || "workspace-write";
  elements.agentEnabled.checked = true;
  elements.quickRunPrompt.value = "";
  elements.quickRunButton.disabled = true;
  elements.runOnNoteButton.disabled = true;
  renderJobs([]);
  renderRuns(state.runs);
  clearRunDetail();
  elements.agentConfigDetails.open = true;
  updateCurrentAgentChip();
  updateStatusBar();
}

async function saveAgent(event) {
  event.preventDefault();
  const payload = {
    name: elements.agentName.value,
    scope_path: elements.agentScopePath.value,
    output_dir: elements.agentOutputDir.value,
    prompt: elements.agentPrompt.value,
    model: elements.agentModel.value,
    reasoning_effort: elements.agentEffort.value,
    approval_policy: elements.agentApproval.value,
    sandbox_mode: elements.agentSandbox.value,
    enabled: elements.agentEnabled.checked,
  };

  try {
    let result;
    if (elements.agentId.value) {
      result = await api(`/api/agents/${elements.agentId.value}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    } else {
      result = await api("/api/agents", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    await refreshAgents();
    await selectAgent(result.agent.id);
    openSidebarTab("agents");
    toast("Agent saved.");
  } catch (error) {
    toast(error.message || "Could not save agent.");
  }
}

async function quickRun(event) {
  event.preventDefault();
  if (!state.selectedAgentId) {
    toast("Select an agent first.");
    return;
  }

  try {
    const result = await api(`/api/agents/${state.selectedAgentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ prompt: elements.quickRunPrompt.value }),
    });
    elements.quickRunPrompt.value = "";
    openSidebarTab("activity");
    toast(`Run ${result.run.id} started.`);
    await refreshRunsForSelection();
    await refreshAgents();
  } catch (error) {
    toast(error.message || "Could not start the run.");
  }
}

function renderJobs(jobs) {
  state.jobs = jobs;
  elements.jobList.innerHTML = "";
  if (!jobs.length) {
    elements.jobList.innerHTML = '<div class="empty-state">No jobs yet for the selected agent.</div>';
    resetJobForm();
    updateStatusBar();
    return;
  }

  for (const job of jobs) {
    const card = document.createElement("div");
    card.className = "job-card";
    if (job.id === state.selectedJobId) {
      card.classList.add("job-card-active");
    }
    card.innerHTML = `
      <div class="card-row">
        <p class="card-title">${escapeHtml(job.name)}</p>
        <span class="status-pill ${job.enabled ? "success" : "muted"}">
          ${job.scheduleType === "interval" ? "Heartbeat" : "Manual"}
        </span>
      </div>
      <p class="card-meta">${job.scheduleType === "interval" ? `Every ${job.intervalMinutes} min` : "Run on demand"}</p>
      <p class="card-meta">Next run: ${formatDate(job.nextRunAt)}</p>
      <div class="inline-create-actions">
        <button type="button" class="toolbar-button" data-edit-job="${job.id}">Edit</button>
        <button type="button" class="primary-button subtle" data-run-job="${job.id}">Run</button>
      </div>
    `;
    card.querySelector("[data-edit-job]").addEventListener("click", () => fillJobForm(job));
    card.querySelector("[data-run-job]").addEventListener("click", () => runJob(job.id));
    elements.jobList.appendChild(card);
  }
  updateStatusBar();
}

function fillJobForm(job) {
  state.selectedJobId = job.id;
  elements.jobId.value = job.id;
  elements.jobName.value = job.name;
  elements.jobPrompt.value = job.prompt;
  elements.jobScheduleType.value = job.scheduleType;
  elements.jobIntervalMinutes.value = job.intervalMinutes || 60;
  elements.jobEnabled.checked = Boolean(job.enabled);
  elements.jobConfigDetails.open = true;
  syncJobScheduleUi();
  renderJobs(state.jobs);
  openSidebarTab("jobs");
}

function resetJobForm() {
  state.selectedJobId = null;
  elements.jobId.value = "";
  elements.jobName.value = "";
  elements.jobPrompt.value = "";
  elements.jobScheduleType.value = "interval";
  elements.jobIntervalMinutes.value = 60;
  elements.jobEnabled.checked = true;
  syncJobScheduleUi();
}

function syncJobScheduleUi() {
  const enabled = elements.jobScheduleType.value === "interval";
  elements.jobIntervalMinutes.disabled = !enabled;
}

async function saveJob(event) {
  event.preventDefault();
  if (!state.selectedAgentId) {
    toast("Select an agent first.");
    return;
  }

  const payload = {
    name: elements.jobName.value,
    prompt: elements.jobPrompt.value,
    schedule_type: elements.jobScheduleType.value,
    interval_minutes: Number(elements.jobIntervalMinutes.value || 0),
    enabled: elements.jobEnabled.checked,
  };

  try {
    if (elements.jobId.value) {
      await api(`/api/jobs/${elements.jobId.value}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    } else {
      await api(`/api/agents/${state.selectedAgentId}/jobs`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    await loadAgentDetails(state.selectedAgentId);
    resetJobForm();
    openSidebarTab("jobs");
    toast("Job saved.");
  } catch (error) {
    toast(error.message || "Could not save job.");
  }
}

async function runJob(jobId) {
  try {
    const result = await api(`/api/jobs/${jobId}/run`, { method: "POST" });
    openSidebarTab("activity");
    toast(`Run ${result.run.id} started.`);
    await refreshRunsForSelection();
    await refreshAgents();
  } catch (error) {
    toast(error.message || "Could not start job.");
  }
}

function renderRuns(runs) {
  state.runs = runs;
  elements.runList.innerHTML = "";
  if (!runs.length) {
    elements.runList.innerHTML = '<div class="empty-state">No runs yet.</div>';
    clearRunDetail();
    updateStatusBar();
    return;
  }

  for (const run of runs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "run-card";
    if (run.id === state.selectedRunId) {
      button.classList.add("run-card-active");
    }
    button.innerHTML = `
      <div class="card-row">
        <p class="card-title">${escapeHtml(shortRunTitle(run))}</p>
        <span class="status-pill ${statusClass(run.status)}">${escapeHtml(run.status)}</span>
      </div>
      <p class="card-meta">${escapeHtml(run.trigger)} • ${formatDate(run.startedAt)}</p>
    `;
    button.addEventListener("click", () => showRunDetail(run));
    elements.runList.appendChild(button);
  }
  updateStatusBar();
}

function showRunDetail(run) {
  state.selectedRunId = run.id;
  renderRuns(state.runs);
  const touchedPaths = run.touchedPaths?.length
    ? `<div class="card-meta">Touched: ${escapeHtml(run.touchedPaths.join(", "))}</div>`
    : `<div class="card-meta">No file changes captured.</div>`;
  const outputButton = run.outputNotePath
    ? `<button type="button" class="toolbar-button" data-open-note="${escapeHtml(run.outputNotePath)}">Open output note</button>`
    : "";
  const text = escapeHtml(run.finalText || run.errorText || "No summary captured.");
  elements.runDetail.classList.remove("empty-state");
  elements.runDetail.innerHTML = `
    <div class="card-row">
      <p class="card-title">${escapeHtml(run.id)}</p>
      <span class="status-pill ${statusClass(run.status)}">${escapeHtml(run.status)}</span>
    </div>
    <div class="card-meta">Started ${formatDate(run.startedAt)}</div>
    <div class="card-meta">Finished ${formatDate(run.finishedAt)}</div>
    ${touchedPaths}
    <div class="card-meta" style="margin-top: 10px;">${text.replace(/\n/g, "<br />")}</div>
    <div class="inline-create-actions" style="margin-top: 12px;">${outputButton}</div>
  `;
  updateStatusBar();
}

function clearRunDetail() {
  state.selectedRunId = null;
  elements.runDetail.classList.add("empty-state");
  elements.runDetail.textContent = "Choose a run to inspect the note changes and summary.";
}

function openSidebarTab(tabName) {
  state.sidebarTab = tabName;
  for (const button of elements.sidebarTabs) {
    button.classList.toggle("sidebar-tab-active", button.dataset.sidebarTab === tabName);
  }
  elements.activityPanel.classList.toggle("hidden", tabName !== "activity");
  elements.agentsPanel.classList.toggle("hidden", tabName !== "agents");
  elements.jobsPanel.classList.toggle("hidden", tabName !== "jobs");
}

function setRightSidebarOpen(open) {
  state.rightSidebarOpen = open;
  elements.rightSidebar.classList.toggle("right-sidebar-collapsed", !open);
}

function toggleRightSidebar() {
  setRightSidebarOpen(!state.rightSidebarOpen);
}

async function refreshTree() {
  state.tree = await api("/api/tree");
  renderTree();
}

async function refreshAgents() {
  const result = await api("/api/agents");
  state.agents = result.agents;
  renderAgentLists();
}

async function refreshRunsForSelection() {
  if (state.selectedAgentId) {
    await loadAgentDetails(state.selectedAgentId);
    return;
  }
  const result = await api("/api/runs");
  renderRuns(result.runs);
}

function connectEvents() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${window.location.host}/api/events`;
  state.socket = new WebSocket(url);

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
      if (state.selectedAgentId) {
        await loadAgentDetails(state.selectedAgentId);
      }
    }
    if (data.type === "run.queued" || data.type === "run.started" || data.type === "run.completed") {
      await refreshAgents();
      await refreshRunsForSelection();
    }
  });

  state.socket.addEventListener("close", () => {
    window.setTimeout(connectEvents, 1500);
  });
}

function updateCurrentAgentChip() {
  const agent = state.agents.find((item) => item.id === state.selectedAgentId);
  if (!agent) {
    elements.currentAgentChip.textContent = "No ambient agent";
    elements.currentAgentChip.className = "status-pill muted";
    return;
  }

  elements.currentAgentChip.textContent = `${agent.name} • ${agent.scopePath || "/"}`;
  elements.currentAgentChip.className = `status-pill ${agent.isRunning ? "warning" : "success"}`;
}

function updateStatusBar() {
  const text = elements.editor.value || "";
  const wordCount = countWords(text);
  const charCount = text.length;
  elements.statusWordCount.textContent = `${wordCount} words • ${charCount} chars`;
  elements.statusNotePath.textContent = state.currentDocument?.path || "No note selected";
  elements.statusSaveState.textContent = state.saveStateLabel;

  const agent = state.agents.find((item) => item.id === state.selectedAgentId);
  if (!agent) {
    elements.statusAgentState.textContent = "No agent selected";
  } else {
    elements.statusAgentState.textContent = agent.isRunning
      ? `${agent.name} is running`
      : `${agent.name} scoped to ${agent.scopePath || "/"}`;
  }

  const nextRun = nextScheduledRun();
  elements.statusNextRun.textContent = nextRun ? `Next heartbeat ${formatDate(nextRun)}` : "No heartbeat scheduled";
}

function nextScheduledRun() {
  const dates = state.agents
    .map((agent) => agent.nextRunAt)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return dates[0]?.toISOString() || null;
}

async function confirmDiscardChanges() {
  if (!state.dirty) {
    return true;
  }
  return window.confirm("Discard unsaved changes?");
}

function setDocumentState(text, kind) {
  elements.documentState.textContent = text;
  elements.documentState.className = `status-pill ${kind || "muted"}`;
}

function breadcrumbText(path) {
  if (!path) {
    return "No document selected";
  }
  return path.split("/").join(" / ");
}

function shortRunTitle(run) {
  return run.outputNotePath || run.id;
}

function formatDate(value) {
  if (!value) {
    return "Not scheduled";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function firstFilePath(node) {
  if (!node) {
    return null;
  }
  for (const child of node.children || []) {
    if (child.kind === "file") {
      return child.path;
    }
    const nested = firstFilePath(child);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function populateSelect(select, values) {
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
}

function statusClass(status) {
  if (status === "succeeded" || status === "saved" || status === "ready") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "queued" || status === "running" || status === "warning") {
    return "warning";
  }
  return "muted";
}

function countWords(text) {
  const parts = text.trim().match(/\S+/g);
  return parts ? parts.length : 0;
}

function markdownToHtml(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const codeBlocks = [];
  let source = escapeHtml(normalized).replace(/```([\s\S]*?)```/g, (_, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `__CODE_BLOCK_${index}__`;
  });

  const lines = source.split("\n");
  const html = [];
  let paragraph = [];
  let listItems = [];
  let quoteLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    html.push(`<p>${applyInlineFormatting(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listItems.length) {
      return;
    }
    html.push(`<ul>${listItems.map((item) => `<li>${applyInlineFormatting(item)}</li>`).join("")}</ul>`);
    listItems = [];
  };

  const flushQuote = () => {
    if (!quoteLines.length) {
      return;
    }
    html.push(`<blockquote>${quoteLines.map((line) => `<p>${applyInlineFormatting(line)}</p>`).join("")}</blockquote>`);
    quoteLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
    const quoteMatch = trimmed.match(/^>\s?(.+)$/);

    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const depth = headingMatch[1].length;
      html.push(`<h${depth}>${applyInlineFormatting(headingMatch[2])}</h${depth}>`);
      continue;
    }

    if (listMatch) {
      flushParagraph();
      flushQuote();
      listItems.push(listMatch[1]);
      continue;
    }

    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushQuote();

  let output = html.join("");
  output = output.replace(/__CODE_BLOCK_(\d+)__/g, (_, index) => codeBlocks[Number(index)] || "");
  return output;
}

function applyInlineFormatting(text) {
  return text
    .replace(/\[\[([^\]]+)\]\]/g, '<a href="#" class="preview-link">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function encodePath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function highlightSnippet(value) {
  return escapeHtml(value)
    .replaceAll("&lt;mark&gt;", "<mark>")
    .replaceAll("&lt;/mark&gt;", "</mark>");
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  window.clearTimeout(elements.toast._timer);
  elements.toast._timer = window.setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 3200);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    let detail = "Request failed.";
    try {
      const payload = await response.json();
      detail = payload.detail || detail;
    } catch (_error) {
      detail = response.statusText || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

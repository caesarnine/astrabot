const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const APPROVALS = ["untrusted", "on-failure", "on-request", "never"];
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

const state = {
  defaults: null,
  tree: null,
  agents: [],
  jobs: [],
  runs: [],
  selectedDocumentPath: "",
  selectedAgentId: null,
  selectedJobId: null,
  selectedRunId: null,
  currentDocument: null,
  dirty: false,
  account: null,
  searchTimer: null,
  socket: null,
};

const elements = {
  accountStatus: document.querySelector("#account-status"),
  loginButton: document.querySelector("#login-button"),
  logoutButton: document.querySelector("#logout-button"),
  searchInput: document.querySelector("#search-input"),
  searchResults: document.querySelector("#search-results"),
  treeRoot: document.querySelector("#tree-root"),
  newNoteButton: document.querySelector("#new-note-button"),
  documentTitle: document.querySelector("#document-title"),
  documentPath: document.querySelector("#document-path"),
  documentState: document.querySelector("#document-state"),
  editor: document.querySelector("#editor-textarea"),
  saveButton: document.querySelector("#save-button"),
  agentList: document.querySelector("#agent-list"),
  newAgentButton: document.querySelector("#new-agent-button"),
  agentForm: document.querySelector("#agent-form"),
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
  jobId: document.querySelector("#job-id"),
  jobName: document.querySelector("#job-name"),
  jobPrompt: document.querySelector("#job-prompt"),
  jobScheduleType: document.querySelector("#job-schedule-type"),
  jobIntervalMinutes: document.querySelector("#job-interval-minutes"),
  jobEnabled: document.querySelector("#job-enabled"),
  runList: document.querySelector("#run-list"),
  runDetail: document.querySelector("#run-detail"),
  toast: document.querySelector("#toast"),
};

document.addEventListener("DOMContentLoaded", () => {
  populateSelect(elements.agentEffort, EFFORTS);
  populateSelect(elements.agentApproval, APPROVALS);
  populateSelect(elements.agentSandbox, SANDBOXES);
  bindEvents();
  bootstrap();
  connectEvents();
});

function bindEvents() {
  elements.loginButton.addEventListener("click", login);
  elements.logoutButton.addEventListener("click", logout);
  elements.searchInput.addEventListener("input", handleSearchInput);
  elements.newNoteButton.addEventListener("click", createNote);
  elements.saveButton.addEventListener("click", saveCurrentDocument);
  elements.editor.addEventListener("input", () => {
    if (!state.currentDocument || !state.currentDocument.editable) {
      return;
    }
    state.dirty = true;
    setDocumentState("Unsaved changes", "warning");
  });
  elements.newAgentButton.addEventListener("click", () => resetAgentForm());
  elements.agentForm.addEventListener("submit", saveAgent);
  elements.resetAgentButton.addEventListener("click", () => resetAgentForm(state.selectedAgentId));
  elements.quickRunForm.addEventListener("submit", quickRun);
  elements.newJobButton.addEventListener("click", () => resetJobForm());
  elements.jobForm.addEventListener("submit", saveJob);
  elements.jobScheduleType.addEventListener("change", syncJobScheduleUi);
  elements.runDetail.addEventListener("click", (event) => {
    const target = event.target.closest("[data-open-note]");
    if (target) {
      loadDocument(target.dataset.openNote);
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrentDocument();
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
    renderAgents();
    renderRuns(state.runs);
    resetAgentForm();
    resetJobForm();

    const initialPath = firstFilePath(data.tree);
    if (initialPath) {
      await loadDocument(initialPath);
    } else {
      setDocumentState("No document selected", "muted");
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

async function loadDocument(path) {
  if (!(await confirmDiscardChanges())) {
    return;
  }
  try {
    const documentPayload = await api(`/api/documents/${encodePath(path)}`);
    state.currentDocument = documentPayload;
    state.selectedDocumentPath = documentPayload.path;
    state.dirty = false;
    elements.documentTitle.textContent = documentPayload.title;
    elements.documentPath.textContent = documentPayload.path || "/";
    elements.editor.value = documentPayload.content ?? "";
    elements.editor.disabled = !documentPayload.editable;
    elements.saveButton.disabled = !documentPayload.editable;
    setDocumentState(documentPayload.editable ? "Ready" : "Read only", documentPayload.editable ? "success" : "muted");
    renderTree();
  } catch (error) {
    toast(error.message || "Could not load document.");
  }
}

async function saveCurrentDocument() {
  if (!state.currentDocument || !state.currentDocument.editable) {
    return;
  }
  try {
    const result = await api(`/api/documents/${encodePath(state.currentDocument.path)}`, {
      method: "PUT",
      body: JSON.stringify({ content: elements.editor.value }),
    });
    state.currentDocument = result;
    state.dirty = false;
    setDocumentState("Saved", "success");
    await refreshTree();
  } catch (error) {
    toast(error.message || "Could not save document.");
  }
}

async function createNote() {
  const parent = window.prompt("Create the note in which folder?", documentParentPath());
  if (parent === null) {
    return;
  }
  const name = window.prompt("New note name", "new-note.md");
  if (!name) {
    return;
  }
  try {
    const result = await api("/api/documents", {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    });
    await refreshTree();
    await loadDocument(result.path);
    toast(`Created ${result.path}`);
  } catch (error) {
    toast(error.message || "Could not create note.");
  }
}

function documentParentPath() {
  if (!state.currentDocument?.path) {
    return "";
  }
  const parts = state.currentDocument.path.split("/");
  parts.pop();
  return parts.join("/");
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
  }, 180);
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
    button.innerHTML = `<strong>${escapeHtml(result.title || result.path)}</strong><div class="card-meta">${highlightSnippet(result.snippet || "")}</div>`;
    button.addEventListener("click", async () => {
      elements.searchResults.classList.add("hidden");
      elements.searchInput.value = "";
      await loadDocument(result.path);
    });
    elements.searchResults.appendChild(button);
  }
  elements.searchResults.classList.remove("hidden");
}

function renderAgents() {
  elements.agentList.innerHTML = "";
  if (!state.agents.length) {
    elements.agentList.innerHTML = '<div class="empty-state">No agents yet. Create one to get started.</div>';
    return;
  }

  for (const agent of state.agents) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-card";
    if (agent.id === state.selectedAgentId) {
      button.classList.add("active");
    }
    button.innerHTML = `
      <div class="card-row">
        <p class="card-title">${escapeHtml(agent.name)}</p>
        <span class="status-pill ${agent.isRunning ? "warning" : agent.enabled ? "success" : "muted"}">
          ${agent.isRunning ? "Running" : agent.enabled ? "Enabled" : "Paused"}
        </span>
      </div>
      <p class="card-meta">Scope: ${escapeHtml(agent.scopePath || "/")}</p>
      <p class="card-meta">Next run: ${formatDate(agent.nextRunAt)}</p>
    `;
    button.addEventListener("click", () => selectAgent(agent.id));
    elements.agentList.appendChild(button);
  }
}

async function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  state.selectedJobId = null;
  state.selectedRunId = null;
  renderAgents();
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
  elements.agentFormSubtitle.textContent = `Thread ${agent.threadId || "not started yet"}`;
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
}

function resetAgentForm(agentId = null) {
  const agent = agentId ? state.agents.find((item) => item.id === agentId) : null;
  if (agent) {
    fillAgentForm(agent);
    return;
  }

  state.selectedAgentId = null;
  renderAgents();
  elements.agentFormTitle.textContent = "Agent Details";
  elements.agentFormSubtitle.textContent = "Create an agent to start running workflows.";
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
  renderJobs([]);
  renderRuns(state.runs);
  clearRunDetail();
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
    toast("Agent saved.");
  } catch (error) {
    toast(error.message || "Could not save agent.");
  }
}

function renderJobs(jobs) {
  state.jobs = jobs;
  elements.jobList.innerHTML = "";
  if (!jobs.length) {
    elements.jobList.innerHTML = '<div class="empty-state">No jobs yet for this agent.</div>';
    resetJobForm();
    return;
  }

  for (const job of jobs) {
    const card = document.createElement("div");
    card.className = "job-card";
    if (job.id === state.selectedJobId) {
      card.classList.add("active");
    }
    card.innerHTML = `
      <div class="card-row">
        <p class="card-title">${escapeHtml(job.name)}</p>
        <span class="status-pill ${job.enabled ? "success" : "muted"}">${job.scheduleType === "interval" ? "Heartbeat" : "Manual"}</span>
      </div>
      <p class="card-meta">${job.scheduleType === "interval" ? `Every ${job.intervalMinutes} min` : "Run on demand"}</p>
      <p class="card-meta">Next run: ${formatDate(job.nextRunAt)}</p>
      <div class="form-actions">
        <button type="button" class="ghost-button" data-edit-job="${job.id}">Edit</button>
        <button type="button" class="primary-button" data-run-job="${job.id}">Run</button>
      </div>
    `;
    card.querySelector("[data-edit-job]").addEventListener("click", () => fillJobForm(job));
    card.querySelector("[data-run-job]").addEventListener("click", () => runJob(job.id));
    elements.jobList.appendChild(card);
  }
}

function fillJobForm(job) {
  state.selectedJobId = job.id;
  elements.jobId.value = job.id;
  elements.jobName.value = job.name;
  elements.jobPrompt.value = job.prompt;
  elements.jobScheduleType.value = job.scheduleType;
  elements.jobIntervalMinutes.value = job.intervalMinutes || 60;
  elements.jobEnabled.checked = Boolean(job.enabled);
  syncJobScheduleUi();
  renderJobs(state.jobs);
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
    toast(`Run ${result.run.id} started.`);
    await refreshRunsForSelection();
    await refreshAgents();
  } catch (error) {
    toast(error.message || "Could not start the run.");
  }
}

function renderRuns(runs) {
  elements.runList.innerHTML = "";
  state.runs = runs;
  if (!runs.length) {
    elements.runList.innerHTML = '<div class="empty-state">No runs yet.</div>';
    clearRunDetail();
    return;
  }

  for (const run of runs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "run-card";
    if (run.id === state.selectedRunId) {
      button.classList.add("active");
    }
    button.innerHTML = `
      <div class="card-row">
        <p class="card-title">${escapeHtml(run.outputNotePath || run.id)}</p>
        <span class="status-pill ${statusClass(run.status)}">${escapeHtml(run.status)}</span>
      </div>
      <p class="card-meta">${escapeHtml(run.trigger)} • ${formatDate(run.startedAt)}</p>
    `;
    button.addEventListener("click", () => showRunDetail(run));
    elements.runList.appendChild(button);
  }
}

function showRunDetail(run) {
  state.selectedRunId = run.id;
  renderRuns(state.runs);
  const touchedPaths = run.touchedPaths?.length
    ? `<div class="card-meta">Touched: ${escapeHtml(run.touchedPaths.join(", "))}</div>`
    : `<div class="card-meta">No file changes captured.</div>`;
  const outputButton = run.outputNotePath
    ? `<button type="button" class="ghost-button" data-open-note="${escapeHtml(run.outputNotePath)}">Open output note</button>`
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
    <div class="top-divider"></div>
    <p>${text.replace(/\n/g, "<br />")}</p>
    <div class="form-actions">${outputButton}</div>
  `;
}

function clearRunDetail() {
  state.selectedRunId = null;
  elements.runDetail.classList.add("empty-state");
  elements.runDetail.textContent = "Select a run to inspect the output.";
}

async function refreshTree() {
  state.tree = await api("/api/tree");
  renderTree();
}

async function refreshAgents() {
  const result = await api("/api/agents");
  state.agents = result.agents;
  renderAgents();
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
        await loadDocument(state.selectedDocumentPath);
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

function populateSelect(select, values) {
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
}

function statusClass(status) {
  if (status === "succeeded" || status === "saved") {
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

function setDocumentState(text, kind) {
  elements.documentState.textContent = text;
  elements.documentState.className = `status-pill ${kind || "muted"}`;
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

async function confirmDiscardChanges() {
  if (!state.dirty) {
    return true;
  }
  return window.confirm("Discard unsaved changes?");
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  window.clearTimeout(elements.toast._timer);
  elements.toast._timer = window.setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 3200);
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

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    let detail = "Request failed.";
    try {
      const payload = await response.json();
      detail = payload.detail || detail;
    } catch (error) {
      detail = response.statusText || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

const storageKey = "ziki-project-showcase-v2";
const seed = {
  currentProjectId: "zedu",
  projects: [{
    id: "zedu",
    name: "Zedu",
    agents: [
      { id: "gojo", name: "Gojo", role: "Contributor" },
      { id: "six-eyes", name: "Six Eyes", role: "Reviewer" },
      { id: "sukuna", name: "Sukuna", role: "Contributor" },
      { id: "nanami", name: "Nanami", role: "Triage" },
    ],
  }],
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && Array.isArray(saved.projects) && saved.projects.length) {
      saved.projects = saved.projects.filter((project) => project && typeof project.name === "string" && Array.isArray(project.agents));
      if (saved.projects.length) {
        if (!saved.projects.some((project) => project.id === saved.currentProjectId)) saved.currentProjectId = saved.projects[0].id;
        return saved;
      }
    }
  } catch {
    // Keep the default example when browser storage is unavailable or invalid.
  }
  return structuredClone(seed);
}

let state = loadState();
let toastTimer;
const tabs = [...document.querySelectorAll(".command-tab")];
const commandPanel = document.querySelector("#command-explanation");
const projectDialog = document.querySelector("#project-dialog");
const agentDialog = document.querySelector("#agent-dialog");

const commandDetails = {
  status: {
    label: "A READ-ONLY SNAPSHOT",
    title: "Start by seeing what’s there.",
    description: "Ziki reports the branch, working tree, agent files, and likely checks. It does not run project commands.",
    humanTitle: "Your time stays yours.",
    human: "Suggested checks are labeled “detected, not run”.",
    output: "$ ziki status\n  repo      ./your-project\n  branch    main\n  worktree  clean\n  checks    test  npm test  (detected, not run)",
  },
  init: {
    label: "APPROVAL BEFORE WRITING",
    title: "See the setup plan first.",
    description: "Ziki proposes a ziki.json using checks found in the project. Planning is the default and writes nothing.",
    humanTitle: "You approve before it writes.",
    human: "Applying setup requires approval. Existing files need their own confirmation.",
    output: "$ ziki init\n  ziki init (plan)\n  config    ziki.json  (new)\n  checks    test      npm test\n\n  Summary: 1 file to create.\n  No files written. Re-run with --apply.",
  },
  review: {
    label: "READ-ONLY CHANGE REVIEW",
    title: "See what changed and what remains.",
    description: "Review summarizes staged, unstaged, and untracked changes, reports limits, and checks added lines for secret-shaped patterns.",
    humanTitle: "The final decision is yours.",
    human: "Checks are never run. Secret detection is best effort, not a security guarantee.",
    output: "$ ziki review\n  summary   4 files  +5 -1\n\n  checks\n  (none configured or detected)\n\n  read-only: no files were written\n  and no project commands were run",
  },
};

function currentProject() {
  return state.projects.find((project) => project.id === state.currentProjectId) ?? state.projects[0];
}

function saveState() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    return true;
  } catch {
    showToast("Browser storage is unavailable. Your changes may not persist after refresh.");
    return false;
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}`.toUpperCase() : (parts[0]?.slice(0, 2) ?? "A").toUpperCase();
}

function roleClass(role) {
  return role.toLowerCase().replace(/[^a-z]+/g, "-");
}

function renderTeam() {
  const project = currentProject();
  const list = document.querySelector("#team-list");
  list.replaceChildren();
  list.append(createAgentRow({ id: "owner", name: "Yusuf Musa", role: "Owner", owner: true }));
  for (const agent of project.agents) list.append(createAgentRow(agent));
  document.querySelector("#agent-count").textContent = `${project.agents.length} agent${project.agents.length === 1 ? "" : "s"}`;
}

function createAgentRow(agent) {
  const row = document.createElement("div");
  row.className = "agent-row";
  const identity = document.createElement("div");
  identity.className = "agent-identity";
  const avatar = document.createElement("span");
  avatar.className = `agent-avatar${agent.owner ? " owner" : agent.role === "Reviewer" ? " reviewer" : agent.role === "Triage" ? " triage" : ""}`;
  avatar.textContent = initials(agent.name);
  const name = document.createElement("span");
  name.className = "agent-name";
  const strong = document.createElement("strong");
  strong.textContent = agent.name;
  name.append(strong);
  identity.append(avatar, name);

  const role = document.createElement("span");
  role.className = `role-chip${agent.owner ? " agent-human" : ""}`;
  role.textContent = agent.role;
  row.append(identity, role);

  if (agent.owner) {
    const ownerTag = document.createElement("span");
    ownerTag.className = "role-label";
    ownerTag.textContent = "YOU";
    row.append(ownerTag);
  } else {
    const remove = document.createElement("button");
    remove.className = "remove-agent";
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${agent.name} from this browser example`);
    remove.title = "Remove from this browser example";
    remove.textContent = "×";
    remove.addEventListener("click", () => removeAgent(agent.id));
    row.append(remove);
  }
  return row;
}

function renderProject() {
  const project = currentProject();
  document.querySelector("#project-name").textContent = project.name;
  document.querySelector("#project-title").textContent = project.name;
  document.querySelector("#terminal-project").textContent = `ziki · ${project.name.toLowerCase()}`;
  document.title = `${project.name} project · Ziki`;
  const select = document.querySelector("#project-select");
  select.replaceChildren();
  for (const item of state.projects) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    option.selected = item.id === project.id;
    select.append(option);
  }
  renderTeam();
}

function selectCommand(name, focus = false) {
  const detail = commandDetails[name];
  const tab = tabs.find((item) => item.dataset.command === name);
  if (!detail || !tab) return;
  tabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  commandPanel.setAttribute("aria-labelledby", tab.id);
  document.querySelector("#command-label").textContent = detail.label;
  document.querySelector("#command-title").textContent = detail.title;
  document.querySelector("#command-description").textContent = detail.description;
  document.querySelector("#human-title").textContent = detail.humanTitle;
  document.querySelector("#human-detail").textContent = detail.human;
  document.querySelector("#terminal-output").textContent = detail.output;
  if (focus) tab.focus();
}

function runExample(commandText) {
  const normalized = commandText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^ziki\s+(status|init|review)$/);
  if (!match) {
    document.querySelector("#terminal-output").textContent = `$ ${normalized || "(empty command)"}\n  This example supports: ziki status, ziki init, and ziki review.\n  No shell command was run.`;
    document.querySelector("#terminal-screen").scrollTop = 0;
    return;
  }
  selectCommand(match[1]);
  document.querySelector("#terminal-screen").scrollTop = 0;
  showToast(`Showing illustrative output for ziki ${match[1]}.`);
}

function removeAgent(id) {
  const project = currentProject();
  const agent = project.agents.find((item) => item.id === id);
  if (!agent) return;
  project.agents = project.agents.filter((item) => item.id !== id);
  saveState();
  renderTeam();
  showToast(`${agent.name} removed from this browser example.`);
}

document.querySelector("#project-switch").addEventListener("click", () => {
  document.querySelector("#project-error").textContent = "";
  document.querySelector("#new-project-name").value = "";
  projectDialog.showModal();
});

document.querySelector("#project-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const nameInput = document.querySelector("#new-project-name");
  const name = nameInput.value.trim();
  const error = document.querySelector("#project-error");
  if (name) {
    const duplicate = state.projects.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      state.currentProjectId = duplicate.id;
      saveState();
      renderProject();
      projectDialog.close();
      showToast(`Switched to ${duplicate.name}.`);
      return;
    }
    const project = { id: `project-${Date.now()}`, name, agents: [] };
    state.projects.push(project);
    state.currentProjectId = project.id;
    saveState();
    renderProject();
    projectDialog.close();
    showToast(`${name} added to this browser example.`);
    return;
  }
  state.currentProjectId = document.querySelector("#project-select").value;
  saveState();
  renderProject();
  projectDialog.close();
  showToast(`Switched to ${currentProject().name}.`);
});

document.querySelector("#add-agent").addEventListener("click", () => {
  document.querySelector("#agent-error").textContent = "";
  document.querySelector("#agent-name").value = "";
  document.querySelector("#agent-role").value = "Contributor";
  agentDialog.showModal();
  document.querySelector("#agent-name").focus();
});

document.querySelector("#agent-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const nameInput = document.querySelector("#agent-name");
  const name = nameInput.value.trim();
  const role = document.querySelector("#agent-role").value;
  const error = document.querySelector("#agent-error");
  if (!name) {
    error.textContent = "Enter a name for this agent.";
    nameInput.focus();
    return;
  }
  const project = currentProject();
  if (project.agents.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) {
    error.textContent = "An agent with that name is already on this project.";
    nameInput.focus();
    return;
  }
  project.agents.push({ id: `agent-${Date.now()}`, name, role });
  saveState();
  renderTeam();
  agentDialog.close();
  showToast(`${name} added to ${project.name}.`);
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectCommand(tab.dataset.command));
  tab.addEventListener("keydown", (event) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectCommand(tabs[next].dataset.command, true);
  });
});

document.querySelectorAll(".quick-link[data-command]").forEach((link) => {
  link.addEventListener("click", () => selectCommand(link.dataset.command));
});

document.querySelectorAll("[data-fill-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector("#terminal-input");
    input.value = button.dataset.fillCommand;
    input.focus();
  });
});

document.querySelector("#terminal-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#terminal-input");
  runExample(input.value);
  input.select();
});

renderProject();

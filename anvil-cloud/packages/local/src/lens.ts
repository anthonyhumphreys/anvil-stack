/**
 * Anvil Lens: the local inspection and debugging surface.
 *
 * A single self-contained HTML page served by the local runtime at
 * `GET /_anvil/lens`. It talks to the existing `/_anvil/*` JSON routes on
 * the same origin, uses no frameworks, no build step, and no external
 * assets, so it works fully offline.
 */
export const lensPageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anvil Lens</title>
<style>
:root {
  --bg: #101216;
  --panel: #171a21;
  --panel-2: #1d212b;
  --border: #2a2f3b;
  --text: #d7dae2;
  --muted: #8a90a0;
  --accent: #e8854a;
  --green: #4cc38a;
  --amber: #e5b454;
  --red: #e5645a;
  --gray: #6f7585;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
header .brand { color: var(--accent); font-weight: 700; letter-spacing: 0.04em; }
header .cell { font-weight: 600; }
header .url { color: var(--muted); margin-left: auto; }
nav {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
nav button {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  font: inherit;
  padding: 8px 12px;
  cursor: pointer;
}
nav button:hover { color: var(--text); }
nav button.active { color: var(--text); border-bottom-color: var(--accent); }
main { padding: 16px; max-width: 1100px; }
section { display: none; }
section.active { display: block; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 18px 0 8px; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
.banner {
  background: #2b1c1a;
  border: 1px solid var(--red);
  color: #f0b6b1;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
  display: none;
  white-space: pre-wrap;
}
.banner.show { display: block; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: var(--panel-2); }
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--gray);
  color: var(--gray);
}
.badge.running, .badge.starting { border-color: var(--amber); color: var(--amber); }
.badge.completed, .badge.approved { border-color: var(--green); color: var(--green); }
.badge.failed, .badge.error, .badge.crashed, .badge.rejected { border-color: var(--red); color: var(--red); }
.badge.stopped, .badge.pending { border-color: var(--gray); color: var(--gray); }
.stat-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.stat {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 14px;
  min-width: 110px;
}
.stat .n { font-size: 20px; color: var(--accent); }
.stat .l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
button.act {
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  border-radius: 4px;
  padding: 3px 10px;
  cursor: pointer;
}
button.act:hover { border-color: var(--accent); color: var(--accent); }
input, select, textarea {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  border-radius: 4px;
  padding: 4px 8px;
}
textarea { width: 100%; min-height: 56px; resize: vertical; }
form.inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  overflow: auto;
  margin: 6px 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.muted { color: var(--muted); }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.level-error { color: var(--red); }
.level-warn { color: var(--amber); }
.level-info { color: var(--text); }
.level-debug { color: var(--muted); }
.token-box { display: none; margin-top: 6px; }
.token-box.show { display: block; }
.cap { display: inline-block; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; margin: 2px; }
.kv { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 6px 12px; }
.kv div:nth-child(odd) { color: var(--muted); }
</style>
</head>
<body>
<header>
  <span class="brand">Anvil Lens</span>
  <span class="cell" id="hdr-cell">…</span>
  <span class="url" id="hdr-url"></span>
</header>
<nav id="tabs">
  <button data-tab="overview" class="active">Overview</button>
  <button data-tab="logs">Logs</button>
  <button data-tab="traces">Traces</button>
  <button data-tab="usage">Usage</button>
  <button data-tab="database">Database</button>
  <button data-tab="auth">Auth</button>
  <button data-tab="approvals">Approvals</button>
  <button data-tab="workflows">Workflows</button>
  <button data-tab="schedules">Schedules</button>
  <button data-tab="services">Services</button>
  <button data-tab="diagnostics">Diagnostics</button>
</nav>
<main>
  <div class="banner" id="banner"></div>

  <section id="tab-overview" class="active">
    <h2>Manifest summary</h2>
    <div class="stat-grid" id="overview-stats"></div>
    <h2>Capabilities</h2>
    <div class="panel" id="overview-caps"><span class="muted">Loading…</span></div>
  </section>

  <section id="tab-logs">
    <div class="toolbar">
      <label>Level
        <select id="log-level">
          <option value="">all</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </label>
      <button class="act" id="log-pause">Pause</button>
      <span class="muted" id="log-status">auto-refresh: 5s</span>
    </div>
    <div class="panel"><table id="log-table">
      <thead><tr><th>time</th><th>level</th><th>handler</th><th>message</th></tr></thead>
      <tbody></tbody>
    </table></div>
  </section>

  <section id="tab-traces">
    <div class="panel"><table id="trace-table">
      <thead><tr><th>traceId</th><th>kind</th><th>name</th><th>status</th><th>updated</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <h2 id="trace-detail-title" style="display:none">Trace detail</h2>
    <div class="panel" id="trace-detail" style="display:none"></div>
  </section>

  <section id="tab-usage">
    <h2>Totals</h2>
    <div class="panel kv" id="usage-totals"><span class="muted">Loading…</span></div>
    <h2>Budgets</h2>
    <div class="panel"><table id="usage-budgets">
      <thead><tr><th>budget</th><th>status</th><th>actual</th><th>limit</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <h2>Top consumers</h2>
    <div class="panel"><table id="usage-consumers">
      <thead><tr><th>consumer</th><th>invocations</th><th>tokens</th><th>cost</th></tr></thead>
      <tbody></tbody>
    </table></div>
  </section>

  <section id="tab-database">
    <h2>Tables</h2>
    <div class="panel kv" id="db-summary"></div>
    <div class="panel"><table id="db-tables">
      <thead><tr><th>table</th><th>rows</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <h2>Branches</h2>
    <div class="panel"><table id="db-branches">
      <thead><tr><th>branch</th><th>source</th><th>tables</th><th>expires</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <h2 id="db-rows-title" style="display:none">Rows</h2>
    <div class="panel" id="db-rows-panel" style="display:none"></div>
  </section>

  <section id="tab-auth">
    <h2>Create user</h2>
    <div class="panel">
      <form class="inline" id="auth-form">
        <input id="auth-userid" placeholder="userId" required>
        <input id="auth-email" placeholder="email (optional)">
        <input id="auth-roles" placeholder="roles, comma-separated">
        <button class="act" type="submit">Create</button>
      </form>
    </div>
    <h2>Users</h2>
    <div class="panel"><table id="auth-users">
      <thead><tr><th>userId</th><th>email</th><th>roles</th><th></th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div class="token-box panel" id="token-box">
      <div class="muted" id="token-label"></div>
      <pre id="token-value"></pre>
      <button class="act" id="token-copy">Copy token</button>
    </div>
  </section>

  <section id="tab-approvals">
    <div class="toolbar">
      <label>Status
        <select id="approval-status">
          <option value="">all</option>
          <option value="pending">pending</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
        </select>
      </label>
      <button class="act" id="approval-refresh">Refresh</button>
    </div>
    <h2>Approval requests</h2>
    <div class="panel"><table id="approval-table">
      <thead><tr><th>id</th><th>action</th><th>status</th><th>reason</th><th>requested</th><th>context</th><th>actions</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <h2>Audit</h2>
    <div class="panel"><table id="approval-audit">
      <thead><tr><th>time</th><th>event</th><th>approval</th><th>actor</th><th>reason</th></tr></thead>
      <tbody></tbody>
    </table></div>
  </section>

  <section id="tab-workflows">
    <h2>Declared workflows</h2>
    <div class="panel" id="wf-declared"><span class="muted">Loading…</span></div>
    <h2>Runs</h2>
    <div class="panel"><table id="wf-runs">
      <thead><tr><th>runId</th><th>workflow</th><th>lifecycle</th><th>progress</th><th>created</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <h2 id="wf-detail-title" style="display:none">Run detail</h2>
    <div class="panel" id="wf-detail" style="display:none"></div>
  </section>

  <section id="tab-schedules">
    <h2>Scheduled jobs</h2>
    <div class="panel"><table id="sched-table">
      <thead><tr><th>job</th><th>schedule</th><th>next</th><th>last</th><th>status</th><th>actions</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <h2>Run history</h2>
    <div class="panel"><table id="sched-runs">
      <thead><tr><th>run</th><th>job</th><th>trigger</th><th>status</th><th>started</th><th>completed</th></tr></thead>
      <tbody></tbody>
    </table></div>
  </section>

  <section id="tab-services">
    <div class="panel"><table id="svc-table">
      <thead><tr><th>service</th><th>state</th><th>restarts</th><th>actions</th></tr></thead>
      <tbody></tbody>
    </table></div>
  </section>

  <section id="tab-diagnostics">
    <h2>Trust gateway</h2>
    <div class="panel">
      <pre>anvil-cloud check --json
anvil-cloud build --json
anvil-cloud inspect --local --json
anvil-cloud logs --local --json</pre>
    </div>
    <h2>Runtime state</h2>
    <div class="panel kv" id="diag-state"></div>
    <h2>Recent errors</h2>
    <div class="panel" id="diag-errors"><span class="muted">Loading…</span></div>
    <h2>Manifest</h2>
    <div class="panel" id="diag-manifest"><span class="muted">Loading…</span></div>
  </section>
</main>
<script>
(function () {
  "use strict";

  var banner = document.getElementById("banner");

  function showError(message) {
    banner.textContent = message;
    banner.classList.add("show");
  }

  function clearError() {
    banner.classList.remove("show");
  }

  function getJson(path) {
    return fetch(path).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok && !(payload && payload.ok)) {
          var detail = payload && payload.error && payload.error.message;
          throw new Error(path + " failed: " + (detail || response.status));
        }
        return payload;
      });
    });
  }

  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!payload || payload.ok !== true) {
          var detail = payload && payload.error && payload.error.message;
          throw new Error(path + " failed: " + (detail || response.status));
        }
        return payload;
      });
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "text") {
          node.textContent = attrs[key];
        } else if (key === "class") {
          node.className = attrs[key];
        } else {
          node.setAttribute(key, attrs[key]);
        }
      });
    }
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function badge(state) {
    return el("span", { class: "badge " + String(state), text: String(state) });
  }

  function renderValue(value) {
    if (value === null || value === undefined) {
      return el("span", { class: "muted", text: String(value) });
    }
    if (typeof value === "object") {
      return el("pre", { text: JSON.stringify(value, null, 2) });
    }
    return el("span", { text: String(value) });
  }

  // Tabs
  var tabs = document.getElementById("tabs");
  tabs.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-tab]");
    if (!button) return;
    Array.prototype.forEach.call(tabs.querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b === button);
    });
    Array.prototype.forEach.call(document.querySelectorAll("main section"), function (section) {
      section.classList.toggle("active", section.id === "tab-" + button.dataset.tab);
    });
  });

  // Header + overview
  var manifestState = null;

  function loadOverview() {
    return getJson("/_anvil/inspect").then(function (payload) {
      var manifest = payload.manifest || {};
      manifestState = manifest;
      var cell = manifest.cell || {};
      document.getElementById("hdr-cell").textContent = cell.name || "unknown cell";
      document.getElementById("hdr-url").textContent = payload.runtimeUrl || "";

      var counts = [
        ["queries", (manifest.queries || []).length],
        ["mutations", (manifest.mutations || []).length],
        ["endpoints", (manifest.endpoints || []).length],
        ["jobs", (manifest.jobs || []).length],
        ["workflows", (manifest.workflows || []).length],
        ["services", (manifest.services || []).length]
      ];
      var stats = document.getElementById("overview-stats");
      stats.textContent = "";
      counts.forEach(function (pair) {
        stats.appendChild(el("div", { class: "stat" }, [
          el("div", { class: "n", text: String(pair[1]) }),
          el("div", { class: "l", text: pair[0] })
        ]));
      });

      var caps = document.getElementById("overview-caps");
      caps.textContent = "";
      var capabilities = manifest.capabilities || {};
      var names = Object.keys(capabilities);
      if (names.length === 0) {
        caps.appendChild(el("span", { class: "muted", text: "No capabilities declared." }));
      } else {
        names.forEach(function (name) {
          var value = capabilities[name];
          var label = value === true ? name : name + ": " + JSON.stringify(value);
          caps.appendChild(el("span", { class: "cap", text: label }));
        });
      }
      renderDeclaredWorkflows();
      renderDiagnostics(payload);
    });
  }

  function renderDiagnostics(payload) {
    var state = document.getElementById("diag-state");
    var manifest = payload.manifest || {};
    var database = (payload.database && payload.database.tables) || {};
    var activeBranch = (payload.database && payload.database.activeBranch) || "main";
    var tableNames = Object.keys(database);
    state.textContent = "";
    [
      ["status", payload.status || "unknown"],
      ["cell", (manifest.cell && manifest.cell.name) || "unknown"],
      ["runtime", payload.runtimeUrl || window.location.origin],
      ["current user", (payload.auth && payload.auth.currentUser) || "none"],
      ["database branch", activeBranch],
      ["usage cost", "$" + Number((((payload.usage || {}).totals || {}).estimatedCostUsd || 0)).toFixed(6)],
      ["tables", tableNames.length ? tableNames.join(", ") : "none"],
      ["recent errors", String((payload.recentErrors || []).length)],
      ["traces", String((payload.traces || []).length)]
    ].forEach(function (pair) {
      state.appendChild(el("div", { text: pair[0] }));
      state.appendChild(el("div", { text: pair[1] }));
    });

    var errors = document.getElementById("diag-errors");
    errors.textContent = "";
    var recentErrors = payload.recentErrors || [];
    if (recentErrors.length === 0) {
      errors.appendChild(el("span", { class: "muted", text: "No recent runtime errors." }));
    } else {
      errors.appendChild(el("pre", { text: JSON.stringify(recentErrors, null, 2) }));
    }

    var manifestPanel = document.getElementById("diag-manifest");
    manifestPanel.textContent = "";
    manifestPanel.appendChild(el("pre", { text: JSON.stringify(manifest, null, 2) }));
  }

  // Logs
  var logsPaused = false;

  function loadLogs() {
    return getJson("/_anvil/logs").then(function (payload) {
      var level = document.getElementById("log-level").value;
      var entries = (payload.logs || []).filter(function (entry) {
        return !level || entry.level === level;
      }).slice(-100);
      var tbody = document.querySelector("#log-table tbody");
      tbody.textContent = "";
      entries.reverse().forEach(function (entry) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: entry.timestamp || "" }),
          el("td", { class: "level-" + (entry.level || "info"), text: entry.level || "" }),
          el("td", { text: entry.handler || "" }),
          el("td", { text: entry.message || "" })
        ]));
      });
      if (entries.length === 0) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No log entries." })
        ]));
      }
    });
  }

  document.getElementById("log-level").addEventListener("change", function () {
    loadLogs().catch(function (error) { showError(error.message); });
  });
  document.getElementById("log-pause").addEventListener("click", function () {
    logsPaused = !logsPaused;
    this.textContent = logsPaused ? "Resume" : "Pause";
    document.getElementById("log-status").textContent =
      logsPaused ? "auto-refresh: paused" : "auto-refresh: 5s";
  });
  setInterval(function () {
    if (!logsPaused) {
      loadLogs().catch(function () { /* transient; keep last view */ });
    }
  }, 5000);

  // Traces
  function loadTraces() {
    return getJson("/_anvil/traces").then(function (payload) {
      var traces = payload.traces || [];
      var tbody = document.querySelector("#trace-table tbody");
      tbody.textContent = "";
      if (traces.length === 0) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No traces yet." })
        ]));
      }
      traces.slice().reverse().forEach(function (trace) {
        var row = el("tr", { class: "clickable" }, [
          el("td", { text: trace.traceId || "" }),
          el("td", { text: trace.kind || "" }),
          el("td", { text: trace.name || "" }),
          el("td", null, [badge(trace.status || "unknown")]),
          el("td", { class: "muted", text: trace.updatedAt || "" })
        ]);
        row.addEventListener("click", function () { loadTraceDetail(trace.traceId); });
        tbody.appendChild(row);
      });
    });
  }

  function loadTraceDetail(traceId) {
    getJson("/_anvil/traces/" + encodeURIComponent(traceId)).then(function (payload) {
      var trace = payload.trace || {};
      var events = trace.events || [];
      var title = document.getElementById("trace-detail-title");
      var panel = document.getElementById("trace-detail");
      title.style.display = "block";
      title.textContent = "Trace detail: " + traceId;
      panel.style.display = "block";
      panel.textContent = "";
      panel.appendChild(el("div", null, [badge(trace.status || "unknown")]));
      if (events.length === 0) {
        panel.appendChild(el("pre", { text: JSON.stringify(trace, null, 2) }));
        return;
      }
      var thead = el("thead", null, [
        el("tr", null, ["time", "type", "name", "duration", "attributes"].map(function (head) {
          return el("th", { text: head });
        }))
      ]);
      var tbody = el("tbody", null, events.map(function (event) {
        return el("tr", null, [
          el("td", { class: "muted", text: event.timestamp || "" }),
          el("td", { text: event.type || "" }),
          el("td", { text: event.name || "" }),
          el("td", { text: event.durationMs !== undefined ? String(event.durationMs) + "ms" : "-" }),
          el("td", null, [renderValue(event.attributes || null)])
        ]);
      }));
      panel.appendChild(el("table", null, [thead, tbody]));
    }).catch(function (error) { showError(error.message); });
  }

  // Usage
  function loadUsage() {
    return getJson("/_anvil/usage").then(function (payload) {
      var usage = payload.usage || {};
      var totals = usage.totals || {};
      var totalPanel = document.getElementById("usage-totals");
      totalPanel.textContent = "";
      [
        ["invocations", String(totals.invocations || 0)],
        ["tokens", String(totals.totalTokens || 0)],
        ["input tokens", String(totals.inputTokens || 0)],
        ["output tokens", String(totals.outputTokens || 0)],
        ["estimated cost", "$" + Number(totals.estimatedCostUsd || 0).toFixed(6)],
        ["sandbox runtime", String(totals.sandboxRuntimeMs || 0) + "ms"]
      ].forEach(function (pair) {
        totalPanel.appendChild(el("div", { text: pair[0] }));
        totalPanel.appendChild(el("div", { text: pair[1] }));
      });

      var budgetBody = document.querySelector("#usage-budgets tbody");
      budgetBody.textContent = "";
      (usage.budgets || []).forEach(function (budget) {
        budgetBody.appendChild(el("tr", null, [
          el("td", { text: budget.id }),
          el("td", { text: budget.status }),
          el("td", { text: "$" + Number(budget.actualUsd || 0).toFixed(6) }),
          el("td", { text: "$" + Number(budget.limitUsd || 0).toFixed(6) })
        ]));
      });
      if ((usage.budgets || []).length === 0) {
        budgetBody.appendChild(el("tr", null, [
          el("td", { class: "muted", colspan: "4", text: "No budgets configured." })
        ]));
      }

      var consumerBody = document.querySelector("#usage-consumers tbody");
      consumerBody.textContent = "";
      (usage.topConsumers || []).forEach(function (consumer) {
        var consumerTotals = consumer.totals || {};
        consumerBody.appendChild(el("tr", null, [
          el("td", { text: consumer.scope + ":" + consumer.name }),
          el("td", { text: String(consumerTotals.invocations || 0) }),
          el("td", { text: String(consumerTotals.totalTokens || 0) }),
          el("td", { text: "$" + Number(consumerTotals.estimatedCostUsd || 0).toFixed(6) })
        ]));
      });
      if ((usage.topConsumers || []).length === 0) {
        consumerBody.appendChild(el("tr", null, [
          el("td", { class: "muted", colspan: "4", text: "No usage events yet." })
        ]));
      }
    });
  }

  // Database
  function loadTables() {
    return getJson("/_anvil/db/tables").then(function (payload) {
      var tables = (payload.database && payload.database.tables) || {};
      var branches = payload.branches || [];
      var active = branches.find(function (branch) { return branch.active; });
      var summary = document.getElementById("db-summary");
      summary.textContent = "";
      [
        ["active branch", (active && active.name) || "main"],
        ["branches", String(branches.length || 1)]
      ].forEach(function (pair) {
        summary.appendChild(el("div", { text: pair[0] }));
        summary.appendChild(el("div", { text: pair[1] }));
      });

      var tbody = document.querySelector("#db-tables tbody");
      tbody.textContent = "";
      var names = Object.keys(tables);
      if (names.length === 0) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No tables with data yet." })
        ]));
      }
      names.forEach(function (name) {
        var row = el("tr", { class: "clickable" }, [
          el("td", { text: name }),
          el("td", { text: String(tables[name].rows) })
        ]);
        row.addEventListener("click", function () { loadRows(name); });
        tbody.appendChild(row);
      });

      var branchBody = document.querySelector("#db-branches tbody");
      branchBody.textContent = "";
      branches.forEach(function (branch) {
        var branchTables = Object.keys(branch.tables || {});
        branchBody.appendChild(el("tr", null, [
          el("td", { text: branch.name + (branch.active ? " (active)" : "") }),
          el("td", { text: branch.source || "main" }),
          el("td", { text: branchTables.length ? branchTables.join(", ") : "none" }),
          el("td", { text: branch.expiresAt || "never" })
        ]));
      });
    });
  }

  function loadRows(table) {
    getJson("/_anvil/db/" + encodeURIComponent(table)).then(function (payload) {
      var rows = payload.rows || [];
      var title = document.getElementById("db-rows-title");
      var panel = document.getElementById("db-rows-panel");
      title.style.display = "block";
      title.textContent = "Rows: " + table + " (" + rows.length + ")";
      panel.style.display = "block";
      panel.textContent = "";
      if (rows.length === 0) {
        panel.appendChild(el("span", { class: "muted", text: "Table is empty." }));
        return;
      }
      var columns = [];
      rows.forEach(function (row) {
        Object.keys(row).forEach(function (key) {
          if (columns.indexOf(key) === -1) columns.push(key);
        });
      });
      var thead = el("thead", null, [
        el("tr", null, columns.map(function (column) {
          return el("th", { text: column });
        }))
      ]);
      var tbody = el("tbody", null, rows.map(function (row) {
        return el("tr", null, columns.map(function (column) {
          return el("td", null, [renderValue(row[column])]);
        }));
      }));
      panel.appendChild(el("table", null, [thead, tbody]));
    }).catch(function (error) { showError(error.message); });
  }

  // Auth
  function loadUsers() {
    return getJson("/_anvil/auth/users").then(function (payload) {
      var users = payload.users || [];
      var tbody = document.querySelector("#auth-users tbody");
      tbody.textContent = "";
      if (users.length === 0) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No local users yet." })
        ]));
      }
      users.forEach(function (user) {
        var mint = el("button", { class: "act", text: "Mint token" });
        mint.addEventListener("click", function () {
          postJson("/_anvil/auth/token", { userId: user.userId }).then(function (issued) {
            document.getElementById("token-label").textContent =
              "JWT for " + user.userId + " (expires " + (issued.expiresAt || "?") + ")";
            document.getElementById("token-value").textContent = issued.token || "";
            document.getElementById("token-box").classList.add("show");
            clearError();
          }).catch(function (error) { showError(error.message); });
        });
        tbody.appendChild(el("tr", null, [
          el("td", { text: user.userId || "" }),
          el("td", { text: user.email || "-" }),
          el("td", { text: (user.roles || []).join(", ") }),
          el("td", null, [mint])
        ]));
      });
    });
  }

  document.getElementById("auth-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var body = { userId: document.getElementById("auth-userid").value.trim() };
    var email = document.getElementById("auth-email").value.trim();
    var roles = document.getElementById("auth-roles").value.trim();
    if (email) body.email = email;
    if (roles) {
      body.roles = roles.split(",").map(function (role) { return role.trim(); })
        .filter(function (role) { return role.length > 0; });
    }
    postJson("/_anvil/auth/users", body).then(function () {
      clearError();
      document.getElementById("auth-form").reset();
      return loadUsers();
    }).catch(function (error) { showError(error.message); });
  });

  document.getElementById("token-copy").addEventListener("click", function () {
    var token = document.getElementById("token-value").textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(token).catch(function () {});
    }
  });

  // Approvals
  function loadApprovals() {
    var status = document.getElementById("approval-status").value;
    var path = "/_anvil/approvals" + (status ? "?status=" + encodeURIComponent(status) : "");

    return Promise.all([
      getJson(path),
      getJson("/_anvil/approvals/audit")
    ]).then(function (results) {
      var approvals = results[0].approvals || [];
      var events = results[1].events || [];
      var tbody = document.querySelector("#approval-table tbody");
      tbody.textContent = "";
      if (approvals.length === 0) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", colspan: "7", text: "No approval requests." })
        ]));
      }
      approvals.slice().reverse().forEach(function (approval) {
        var actions = el("td", null, []);
        if (approval.status === "pending") {
          var approve = el("button", { class: "act", text: "Approve" });
          var reject = el("button", { class: "act", text: "Reject" });
          approve.addEventListener("click", function () {
            decideApproval(approval.id, "approve");
          });
          reject.addEventListener("click", function () {
            decideApproval(approval.id, "reject");
          });
          approve.style.marginRight = "6px";
          actions.appendChild(approve);
          actions.appendChild(reject);
        } else {
          actions.appendChild(el("span", { class: "muted", text: approval.decidedBy || "-" }));
        }

        tbody.appendChild(el("tr", null, [
          el("td", { text: approval.id || "" }),
          el("td", { text: approval.action || "" }),
          el("td", null, [badge(approval.status || "unknown")]),
          el("td", { text: approval.reason || approval.decisionReason || "-" }),
          el("td", { class: "muted", text: approval.requestedAt || "" }),
          el("td", null, [renderValue(approval.metadata || {})]),
          actions
        ]));
      });

      var auditBody = document.querySelector("#approval-audit tbody");
      auditBody.textContent = "";
      if (events.length === 0) {
        auditBody.appendChild(el("tr", null, [
          el("td", { class: "muted", colspan: "5", text: "No approval audit events." })
        ]));
      }
      events.slice().reverse().forEach(function (event) {
        auditBody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: event.at || "" }),
          el("td", { text: event.type || "" }),
          el("td", { text: event.approvalId || "" }),
          el("td", { text: event.actor || "-" }),
          el("td", { text: event.reason || "-" })
        ]));
      });
    });
  }

  function decideApproval(id, action) {
    var reason = window.prompt(action === "approve" ? "Approval note" : "Rejection reason") || "";

    postJson("/_anvil/approvals/" + encodeURIComponent(id) + "/" + action, {
      actor: "lens",
      reason: reason
    }).then(function () {
      clearError();
      return loadApprovals();
    }).catch(function (error) { showError(error.message); });
  }

  document.getElementById("approval-status").addEventListener("change", function () {
    loadApprovals().catch(function (error) { showError(error.message); });
  });
  document.getElementById("approval-refresh").addEventListener("click", function () {
    loadApprovals().catch(function (error) { showError(error.message); });
  });

  // Workflows
  function renderDeclaredWorkflows() {
    var container = document.getElementById("wf-declared");
    container.textContent = "";
    var declared = (manifestState && manifestState.workflows) || [];
    var names = declared.map(function (workflow) {
      return typeof workflow === "string" ? workflow : workflow.name;
    }).filter(Boolean);
    if (names.length === 0) {
      container.appendChild(el("span", { class: "muted", text: "No workflows declared." }));
      return;
    }
    names.forEach(function (name) {
      var textarea = el("textarea", { placeholder: "{} input JSON" });
      var run = el("button", { class: "act", text: "Run " + name });
      run.addEventListener("click", function () {
        var input = {};
        var raw = textarea.value.trim();
        if (raw) {
          try {
            input = JSON.parse(raw);
          } catch (parseError) {
            showError("Input for '" + name + "' must be valid JSON.");
            return;
          }
        }
        postJson("/_anvil/workflows/run/" + encodeURIComponent(name), { input: input })
          .then(function () {
            clearError();
            return loadRuns();
          })
          .catch(function (error) { showError(error.message); });
      });
      container.appendChild(el("div", { style: "margin-bottom:10px" }, [
        el("div", { text: name }),
        textarea,
        run
      ]));
    });
  }

  function loadRuns() {
    return getJson("/_anvil/workflows").then(function (payload) {
      var runs = payload.runs || [];
      var tbody = document.querySelector("#wf-runs tbody");
      tbody.textContent = "";
      if (runs.length === 0) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No workflow runs yet." })
        ]));
      }
      runs.slice().reverse().forEach(function (run) {
        var row = el("tr", { class: "clickable" }, [
          el("td", { text: run.runId || "" }),
          el("td", { text: run.workflow || "" }),
          el("td", null, [badge((run.progress && run.progress.lifecycle) || run.status || "unknown")]),
          el("td", { text: workflowProgressText(run) }),
          el("td", { class: "muted", text: run.createdAt || "" })
        ]);
        row.addEventListener("click", function () { loadRunDetail(run.runId); });
        tbody.appendChild(row);
      });
    });
  }

  function loadRunDetail(runId) {
    getJson("/_anvil/workflows/" + encodeURIComponent(runId)).then(function (payload) {
      var run = payload.run || {};
      var title = document.getElementById("wf-detail-title");
      var panel = document.getElementById("wf-detail");
      title.style.display = "block";
      title.textContent = "Run detail: " + runId;
      panel.style.display = "block";
      panel.textContent = "";
      panel.appendChild(el("div", null, [
        badge((run.progress && run.progress.lifecycle) || run.status || "unknown"),
        el("span", { class: "muted", text: " " + workflowProgressText(run) })
      ]));
      var steps = run.steps || [];
      if (steps.length === 0) {
        panel.appendChild(el("pre", { text: JSON.stringify(run, null, 2) }));
        return;
      }
      var thead = el("thead", null, [
        el("tr", null, ["step", "status", "attempts", "error"].map(function (head) {
          return el("th", { text: head });
        }))
      ]);
      var tbody = el("tbody", null, steps.map(function (step) {
        return el("tr", null, [
          el("td", { text: step.name || step.step || "" }),
          el("td", null, [badge(step.status || "unknown")]),
          el("td", { text: String(step.attempts !== undefined ? step.attempts : "-") }),
          el("td", null, [renderValue(step.error !== undefined ? step.error : null)])
        ]);
      }));
      panel.appendChild(el("table", null, [thead, tbody]));
    }).catch(function (error) { showError(error.message); });
  }

  function workflowProgressText(run) {
    var progress = run.progress || {};
    var total = progress.totalSteps !== undefined ? progress.totalSteps : (run.steps || []).length;
    var completed = progress.completedSteps !== undefined ? progress.completedSteps : 0;
    var next = progress.currentStep || progress.nextStep || "-";
    return completed + "/" + total + " steps, next " + next;
  }

  // Schedules
  function loadSchedules() {
    return getJson("/_anvil/schedules").then(function (payload) {
      var schedules = payload.schedules || [];
      var tbody = document.querySelector("#sched-table tbody");
      var runsBody = document.querySelector("#sched-runs tbody");
      tbody.textContent = "";
      runsBody.textContent = "";
      if (schedules.length === 0) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No scheduled jobs declared." })
        ]));
        runsBody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No schedule runs yet." })
        ]));
        return;
      }
      schedules.forEach(function (schedule) {
        var run = el("button", { class: "act", text: "Run" });
        run.addEventListener("click", function () { runSchedule(schedule.name); });
        tbody.appendChild(el("tr", null, [
          el("td", { text: schedule.name || "" }),
          el("td", { text: schedule.schedule || "" }),
          el("td", { class: "muted", text: schedule.nextRunAt || "-" }),
          el("td", { class: "muted", text: schedule.lastRunAt || "-" }),
          el("td", null, [badge(schedule.running ? "running" : (schedule.lastStatus || "pending"))]),
          el("td", null, [run])
        ]));
        (schedule.runs || []).forEach(function (entry) {
          runsBody.appendChild(el("tr", null, [
            el("td", { text: entry.id || "" }),
            el("td", { text: entry.job || "" }),
            el("td", { text: entry.trigger || "" }),
            el("td", null, [badge(entry.status || "unknown")]),
            el("td", { class: "muted", text: entry.startedAt || "" }),
            el("td", { class: "muted", text: entry.completedAt || "-" })
          ]));
        });
      });
      if (!runsBody.firstChild) {
        runsBody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No schedule runs yet." })
        ]));
      }
    });
  }

  function runSchedule(name) {
    postJson("/_anvil/schedules/" + encodeURIComponent(name) + "/run", { payload: {} })
      .then(function () {
        clearError();
        return loadSchedules();
      })
      .catch(function (error) { showError(error.message); });
  }

  // Services
  function loadServices() {
    return getJson("/_anvil/services").then(function (payload) {
      var services = payload.services || [];
      var tbody = document.querySelector("#svc-table tbody");
      tbody.textContent = "";
      if (services.length === 0) {
        tbody.appendChild(el("tr", null, [
          el("td", { class: "muted", text: "No services declared." })
        ]));
      }
      services.forEach(function (service) {
        var start = el("button", { class: "act", text: "Start" });
        var stop = el("button", { class: "act", text: "Stop" });
        start.addEventListener("click", function () { serviceAction(service.name, "start"); });
        stop.addEventListener("click", function () { serviceAction(service.name, "stop"); });
        var actions = el("td", null, [start, stop]);
        actions.firstChild.style.marginRight = "6px";
        tbody.appendChild(el("tr", null, [
          el("td", { text: service.name || "" }),
          el("td", null, [badge(service.state || "unknown")]),
          el("td", { text: String(service.restarts !== undefined ? service.restarts : "-") }),
          actions
        ]));
      });
    });
  }

  function serviceAction(name, action) {
    postJson("/_anvil/services/" + encodeURIComponent(name) + "/" + action, {})
      .then(function () {
        clearError();
        return loadServices();
      })
      .catch(function (error) { showError(error.message); });
  }

  // Initial load
  function refreshAll() {
    clearError();
    Promise.all([
      loadOverview(),
      loadLogs(),
      loadUsage(),
      loadTraces(),
      loadTables(),
      loadUsers(),
      loadApprovals(),
      loadRuns(),
      loadSchedules(),
      loadServices()
    ]).catch(function (error) { showError(error.message); });
  }

  refreshAll();
})();
</script>
</body>
</html>
`;

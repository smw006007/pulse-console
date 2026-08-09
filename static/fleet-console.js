(function () {
  "use strict";

  const U = window.FleetUtils;
  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  // Selection state used to live only in the `.active` class, so assistive tech had no
  // way to read which heatmap mode / activity filter / view was current. Every place that
  // marked a segmented control now goes through here, so the ARIA state cannot drift from
  // the visual state. Tabs get aria-selected + roving tabindex; toggle buttons (two
  // renderings of the same data, e.g. table/grid) get aria-pressed instead -- they are not
  // tabs and shouldn't claim to be.
  function markActive(buttons, isActive) {
    buttons.forEach((button) => {
      const on = Boolean(isActive(button));
      button.classList.toggle("active", on);
      if (button.getAttribute("role") === "tab") {
        button.setAttribute("aria-selected", on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
      } else if (button.hasAttribute("aria-pressed")) {
        button.setAttribute("aria-pressed", on ? "true" : "false");
      }
    });
  }

  const app = {
    data: { devices: [], counts: {}, total: 0, batch: { wave_size: 8, wave_delay_sec: 20 } },
    devicesById: new Map(),
    selected: new Set(),
    query: new URLSearchParams(location.search).get("q") || "",
    sortKey: "identity",
    sortDirection: "asc",
    // ?view=table|grid mirrors the existing ?q= handling, so a particular view is
    // linkable (and testable) the same way a query already is. Anything else falls
    // through to the stored preference.
    view: (function () {
      const wanted = new URLSearchParams(location.search).get("view");
      return wanted === "table" || wanted === "grid" ? wanted : (localStorage.getItem("fleet:view") || "table");
    })(),
    heatmapMode: localStorage.getItem("fleet:heatmap") || "health",
    // Map grouping. Position on the map is only useful if it is STABLE -- the old map
    // followed sort order, so a device moved every re-sort and you could never learn
    // where anything lived. Grouping + a stable sort inside each group fixes that.
    mapGroupBy: localStorage.getItem("fleet:mapGroup") || "subnet",
    mapGroups: (() => { try { return JSON.parse(localStorage.getItem("fleet:mapGroups") || "{}"); } catch (e) { return {}; } })(),
    activityFilter: "all",
    activities: [],
    connected: false,
    initialized: false,
    polling: false,
    pollTimer: null,
    drawerSerial: null,
    tableWindowStart: 0,
    tableWindowSize: 45,
    visibleDevices: [],
    lastFocused: null,
    lastSelectAnchor: null,
    density: localStorage.getItem("fleet:density") === "compact" ? "compact" : "comfortable",
    // Focus mode defaults ON: 17 status cards means the two that matter are lost among
    // fifteen green ones. Exceptions stay full-size; nominal cards fold into one line.
    focusMode: localStorage.getItem("fleet:focus") !== "0",
    kpiHidden: new Set((() => { try { return JSON.parse(localStorage.getItem("fleet:kpiHidden") || "[]"); } catch (e) { return []; } })()),
    refreshMs: Number(localStorage.getItem("fleet:refreshMs")) || 4000,
    kpiLabels: [],
    // Explicitly promoted cards, in the operator's own order. Pinned cards always render
    // as full hero cards regardless of tone, so focus mode never demotes something you
    // deliberately put up there.
    kpiPinned: (() => { try { return JSON.parse(localStorage.getItem("fleet:kpiPinned") || "[]"); } catch (e) { return []; } })(),
    // Cards explicitly dragged DOWN to the strip. Without this, dragging an exception card
    // down did nothing -- focus mode re-promotes red/amber on the very next render, so the
    // gesture silently undid itself.
    kpiDemoted: new Set((() => { try { return JSON.parse(localStorage.getItem("fleet:kpiDemoted") || "[]"); } catch (e) { return []; } })()),
    debloatReport: { variants: [], reporting: 0 },
    debloatSelected: new Set(),
    analyticsHours: 6,
    analyticsModel: null,
    analyticsSerial: null,
    historyCache: new Map(),
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[character]);
  }

  function escapeAttr(value) { return escapeHtml(value); }

  function formatTime(timestamp) {
    if (!timestamp) return "Never";
    const milliseconds = Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp);
    const delta = Date.now() - milliseconds;
    if (delta < 20_000) return "Just now";
    if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))}s ago`;
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return new Date(milliseconds).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
    return `${Math.round(n / 1e3)} KB`;
  }

  function formatMetric(value, unit, digits) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    return `${Number(value).toFixed(digits == null ? 0 : digits)}${unit || ""}`;
  }

  function displayModel(device) {
    return (device.telemetry && device.telemetry.model) || device.model || "Model unavailable";
  }

  function displayName(device) {
    if (device.alias) return device.alias;
    if (device.label && device.label !== device.serial) return device.label;
    if (device.ip) return device.ip;
    const match = String(device.serial || "").match(/^adb-([A-Za-z0-9]+)/);
    return match ? match[1] : (device.serial || "Unknown device");
  }

  function isArmed(device) {
    return device.telemetry ? Boolean(device.telemetry.armed) : Boolean(device.guardianArmed);
  }

  function displayProfile(device) {
    const profile = device.telemetry && device.telemetry.profile;
    return profile || (device.inWorkProfile ? "Work profile" : "Profile unknown");
  }

  // Guardian/Processor versions come from a periodic scan, not from telemetry, so right
  // after a console restart they read as a mix of ancient versions and blanks -- which
  // looks exactly like a fleet-wide downgrade. Stamping the value with its scan age makes
  // "this has not been re-read yet" legible instead of being mistaken for fact.
  const VERSION_STALE_MS = 15 * 60 * 1000;
  function freshChip(timestamp) {
    if (!timestamp) return '<span class="fresh-chip fresh-chip--stale" title="This device has never been version-scanned.">unscanned</span>';
    const ms = Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp);
    const stale = Date.now() - ms > VERSION_STALE_MS;
    return `<span class="fresh-chip${stale ? " fresh-chip--stale" : ""}" title="Version last scanned ${formatTime(timestamp)}${stale ? " — older than 15 minutes, so it may not reflect the device right now. Run Scan Guardian to refresh." : "."}">${escapeHtml(formatTime(timestamp))}</span>`;
  }

  function guardianState(device) {
    if (device.guardianAction) return device.guardianAction;
    if (device.telemetry && device.telemetry.guardianState) return device.telemetry.guardianState;
    if (device.guardianArmed) return "Armed · provisioned";
    return device.guardianVersion || "Not scanned";
  }

  function currentJob(device) {
    const acurast = device.acurast || {};
    const telemetry = device.telemetry || {};
    return acurast.currentJob || acurast.jobName || telemetry.currentJob || "";
  }

  function jobStatus(device) {
    const acurast = device.acurast || {};
    const telemetry = device.telemetry || {};
    return acurast.jobStatus || telemetry.jobStatus || "";
  }

  function token() { return ($("#token").value || localStorage.getItem("fleet:token") || "").trim(); }

  async function api(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fleet-Token": token() },
      body: JSON.stringify(body || {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }

  function setConnected(connected) {
    app.connected = connected;
    const pill = $("#connectionPill");
    pill.classList.toggle("offline", !connected);
    pill.innerHTML = `<i></i>${connected ? "Live" : "Disconnected"}`;
    $("#sideConnection").textContent = connected ? "Live stream active" : "Connection lost";
    $("#connectionBanner").hidden = connected;
  }

  function schedulePoll(delay) {
    clearTimeout(app.pollTimer);
    if (!$("#autoRefresh").checked) return;
    app.pollTimer = setTimeout(poll, delay == null ? 4000 : delay);
  }

  async function poll() {
    if (app.polling) return;
    app.polling = true;
    // Only the FIRST load gets a busy state. Marking every 4s auto-refresh busy would
    // leave the console permanently shimmering and mean nothing.
    const showBusy = !app.initialized;
    if (showBusy) {
      $("#kpiGrid").setAttribute("aria-busy", "true");
      $("#tableView").setAttribute("aria-busy", "true");
      const body = $("#deviceTableBody");
      if (body && !body.children.length) {
        body.innerHTML = Array.from({ length: 6 }, () => `<tr class="skeleton-row">${Array.from({ length: 13 }, () => '<td><div class="skeleton-bar"></div></td>').join("")}</tr>`).join("");
      }
    }
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error(`State request failed (${response.status})`);
      const nextData = await response.json();
      reconcileActivity(app.data.devices || [], nextData.devices || []);
      app.data = nextData;
      app.devicesById = new Map((nextData.devices || []).map((device) => [device.serial, device]));
      app.selected.forEach((serial) => { if (!app.devicesById.has(serial)) app.selected.delete(serial); });
      setConnected(true);
      $("#lastRefresh").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      renderAll();
      app.initialized = true;
    } catch (error) {
      setConnected(false);
      if (!app.initialized) renderLoadingError(error);
    } finally {
      app.polling = false;
      if (showBusy) {
        $("#kpiGrid").removeAttribute("aria-busy");
        $("#tableView").removeAttribute("aria-busy");
      }
      schedulePoll(app.refreshMs || 4000);
    }
  }

  function renderLoadingError(error) {
    $("#kpiGrid").innerHTML = Array.from({ length: 6 }, () => '<div class="kpi-card neutral"><div class="kpi-top"><span class="kpi-label">Unavailable</span></div><strong>—</strong><div class="kpi-foot"><span>Waiting for control plane</span></div></div>').join("");
    $("#emptyState").hidden = false;
    $("#emptyState").innerHTML = `<div class="empty-icon">!</div><h3>Fleet state unavailable</h3><p>${escapeHtml(error.message)}. The console will retry automatically.</p><button class="button" type="button" data-action="refresh">Retry now</button>`;
  }

  function reconcileActivity(previous, next) {
    if (!app.initialized) {
      const alerts = next.filter(isAttentionDevice).slice(0, 8);
      alerts.forEach((device) => {
        const health = U.calculateHealthScore(device);
        addActivity({
          type: health.tone === "critical" ? "critical" : "alert",
          icon: health.tone === "critical" ? "!" : "△",
          device: displayName(device),
          message: health.reasons[0] || "Device needs attention",
          timestamp: Date.now(),
          dedupe: `initial:${device.serial}`,
        }, false);
      });
      return;
    }
    const prior = new Map(previous.map((device) => [device.serial, device]));
    next.forEach((device) => {
      const old = prior.get(device.serial);
      if (!old) {
        addActivity({ type: "action", icon: "+", device: displayName(device), message: "Device added to fleet snapshot", timestamp: Date.now() });
        return;
      }
      const before = U.effectiveState(old);
      const after = U.effectiveState(device);
      if (before !== after) {
        const online = after === "device";
        addActivity({
          type: online ? "action" : after === "offline" ? "critical" : "alert",
          icon: online ? "●" : "!",
          device: displayName(device),
          message: online ? "Device came online" : `State changed to ${after}`,
          timestamp: Date.now(),
        });
      }
      if (!old.behind && device.behind) {
        addActivity({ type: "alert", icon: "↧", device: displayName(device), message: "Processor version is behind fleet", timestamp: Date.now() });
      }
      if (old.guardianAction !== device.guardianAction && device.guardianAction) {
        addActivity({ type: /^failed/i.test(device.guardianAction) ? "critical" : "action", icon: "⬡", device: displayName(device), message: `Guardian ${device.guardianAction}`, timestamp: Date.now() });
      }
    });
  }

  function addActivity(activity, render) {
    if (activity.dedupe && app.activities.some((item) => item.dedupe === activity.dedupe)) return;
    app.activities.unshift(Object.assign({ id: `${Date.now()}-${Math.random()}` }, activity));
    app.activities = app.activities.slice(0, 80);
    if (render !== false) renderActivity();
  }

  function recordAction(message, devices, type) {
    const labels = devices.slice(0, 2).map((device) => displayName(device)).join(", ");
    const suffix = devices.length > 2 ? ` +${devices.length - 2} more` : "";
    addActivity({ type: type || "action", icon: "↻", device: labels || "Fleet", message: `${message}${suffix}`, timestamp: Date.now() });
  }

  function renderAll() {
    $("#navFleetCount").textContent = app.data.total || 0;
    renderKpis();
    renderUpdatePanel();
    renderOverview();
    renderActivity();
    renderGuardian();
    renderDevices();
    renderBulkDock();
    renderDebloatProgress();
    if (app.drawerSerial) {
      const drawer = $("#deviceDrawer");
      const scrollTop = drawer.scrollTop;
      renderDrawer(app.drawerSerial);
      drawer.scrollTop = scrollTop;
    }
  }

  function fleetMetrics() {
    const devices = app.data.devices || [];
    const online = devices.filter((device) => U.effectiveState(device) === "device");
    const offline = devices.filter((device) => U.effectiveState(device) === "offline");
    const unauthorized = devices.filter((device) => U.effectiveState(device) === "unauthorized");
    const health = devices.map((device) => ({ device, result: U.calculateHealthScore(device) }));
    const knownHealth = health.filter((item) => item.result.score != null);
    const attention = health.filter((item) => item.result.score != null && item.result.score < 85).map((item) => item.device);
    const ready = devices.filter((device) => U.effectiveState(device) === "device" && isArmed(device) && !device.updateAvailable);
    const batteryDevices = devices.map((device) => ({ device, value: U.batteryValue(device) })).filter((item) => item.value != null);
    const tempDevices = devices.map((device) => ({ device, value: U.temperatureValue(device) })).filter((item) => item.value != null).sort((a, b) => b.value - a.value);
    const cpuDevices = devices.map((device) => U.cpuValue(device)).filter((value) => value != null);
    const jobs = devices.filter((device) => /running|active|assigned/i.test(jobStatus(device)) || currentJob(device));
    return {
      devices, online, offline, unauthorized, health, knownHealth, attention, ready, batteryDevices, tempDevices, cpuDevices, jobs,
      averageBattery: batteryDevices.length ? batteryDevices.reduce((sum, item) => sum + item.value, 0) / batteryDevices.length : null,
      averageCpu: cpuDevices.length ? cpuDevices.reduce((sum, value) => sum + value, 0) / cpuDevices.length : null,
    };
  }

  function kpiCard({ label, value, context, tone, icon, query, action, detail, auto }) {
    const KPI_HINTS = {
      "Online": "Phones with a live wireless-ADB transport to this console. A phone can be earning while offline here -- this measures manageability, not earning.",
      "Offline": "Phones this console cannot currently reach over ADB. They may still be computing; check Pulse for on-chain activity.",
      "Fleet readiness": "Phones that are online, armed and running a current build. Click for the per-device grant drift.",
      "Needs attention": "Phones failing a health check: temperature, battery, state, version or arming.",
      "Pulse degraded": "Processors that acurastpulse.com rates as investigate/watch, based on on-chain reliability rather than anything local.",
      "Scrape dead": "Phones whose accessibility service has been unbound long enough that Guardian's compute scrape is genuinely dead. Re-binding normally self-heals; a persistent one needs a reboot.",
      "Up but stalled": "Reports 'Running' but the heartbeat has gone stale -- the node looks alive and is earning nothing.",
      "App ANRs": "Phones where the Processor's main thread has wedged long enough for Android to raise 'App isn't responding'. Guardian dismisses the dialog so the node recovers, which is exactly why this never shows up as lost earnings.",
      "Idle hub": "Phones sitting on the wallet/hub screen with 'Open Processor to Provide Compute' showing. The node is NOT computing. Detected from the foreground user over ADB, independently of Guardian.",
      "On jobs": "Phones currently running a deployment, out of those reporting telemetry at all. A phone with no job is still online, attested and heartbeating — the network simply has not assigned it work. Assignments are sticky, so a phone that loses one waits for a new deployment rather than reclaiming the old.",
      "Average battery": "Mean charge across reporting phones. These run on AC, so a falling average points at cabling or battery health.",
      "Update compliance": "Phones on the current Processor build.",
      "Hottest device": "Highest temperature currently reported.",
      "Average CPU": "Per-core load averaged across the fleet. Normalised by core count, so 100% means fully saturated -- values above that mean the run queue is backed up.",
      "FG climbing": "Phones whose foreground-loss rate is rising, i.e. something keeps knocking the Processor off screen.",
    };
    let kpiHint = KPI_HINTS[label] ? `${KPI_HINTS[label]}${context ? "\n\n" + String(context) : ""}` : (context ? String(context) : "");
    // Auto-promoted cards were surfaced by focus mode because they went red/amber -- the
    // operator did not put them here, and they will leave on their own when the condition
    // clears. Saying so is what stops the hero row reading as "my layout reverted".
    if (auto) kpiHint += `${kpiHint ? "\n\n" : ""}Raised automatically because it needs attention. It will drop back to the strip when it clears. Drag it down to keep it out of the hero row.`;
    return `<button class="kpi-card ${tone}${auto ? " kpi-card--auto" : ""}" type="button" draggable="true" data-kpi-label="${escapeAttr(label)}" ${kpiHint ? `title="${escapeAttr(kpiHint)}"` : ""} ${query ? `data-kpi-query="${escapeAttr(query)}"` : ""} ${action ? `data-kpi-action="${escapeAttr(action)}"` : ""} ${detail ? `data-kpi-detail="${escapeAttr(detail)}"` : ""}>
      <span class="kpi-top"><span class="kpi-label">${escapeHtml(label)}</span><span class="kpi-icon"><i>${escapeHtml(icon)}</i></span></span>
      <strong>${escapeHtml(value)}</strong>
      <span class="kpi-foot"><span>${escapeHtml(context)}</span></span>
    </button>`;
  }

  function renderKpis() {
    renderScreensaverButton();
    syncApkDownloadLink();
    const m = fleetMetrics();
    const total = m.devices.length;
    // Real compute/earning state (Guardian v1.1.20+ telemetry). Phones on older builds report
    // neither field -> counted as "not reporting" rather than idle, so they never look broken.
    const computeReporting = m.devices.filter((d) => {
      const t = d.telemetry || {};
      return t.computeActive !== undefined || t.computeStatus !== undefined;
    });
    const computeActive = computeReporting.filter((d) => (d.telemetry || {}).computeActive === true);
    // up-but-stalled: says Running but the heartbeat is stale -> earning nothing (v1.1.27 `earning`)
    const stalledDevices = m.devices.filter((d) => {
      const t = d.telemetry || {};
      return t.earning === false && t.computeActive === true;
    });
    const anrDevices = m.devices.filter((d) => ((d.telemetry || {}).anrSinceBoot || 0) > 0);
    const anrTotal = anrDevices.reduce((sum, d) => sum + ((d.telemetry || {}).anrSinceBoot || 0), 0);
    const unarmedDevices = m.devices.filter(protectionOff);
    const idleHubDevices = m.devices.filter((d) => d.idleHub === true);
    const idleHubUnknown = m.devices.filter((d) => d.idleHub == null);
    const readinessData = (app.data.guardian && app.data.guardian.readiness) || {};
    const readiness = readinessData.reporting ? Math.round((readinessData.ready || 0) / readinessData.reporting * 100) : total ? Math.round((m.ready.length / total) * 100) : 0;
    const cards = [
      { label: "Online", value: m.online.length, context: total ? `${Math.round(m.online.length / total * 100)}% of fleet reachable` : "No devices configured", tone: "green", icon: "●", query: "status:online" },
      { label: "Offline", value: m.offline.length, context: m.unauthorized.length ? `+ ${m.unauthorized.length} unauthorized` : "ADB transport unavailable", tone: m.offline.length ? "red" : "neutral", icon: "○", query: "status:offline" },
      { label: "Fleet readiness", value: readinessData.reporting ? `${readinessData.ready || 0}/${readinessData.reporting}` : `${readiness}%`, context: readinessData.degraded ? `${readinessData.degraded} devices missing grants` : `${m.ready.length} online, armed and current`, tone: readiness >= 90 ? "teal" : "amber", icon: "✓", action: readinessData.reporting ? "show-readiness" : "", query: readinessData.reporting ? "" : "status:online" },
      { label: "Needs attention", value: m.attention.length, context: unarmedDevices.length ? `${unarmedDevices.length} NOT ARMED \u00b7 Guardian will not act on them` : "Health, state, power or version", tone: m.attention.length ? "amber" : "green", icon: "!", query: "health:<85" },
      { label: "Pulse degraded", value: (() => { const p = app.data.pulseHealth || {}; const n = (p.investigate || 0) + (p.watch || 0); return p.processorCount ? n : "—"; })(), context: (() => { const p = app.data.pulseHealth || {}; if (!p.processorCount) return "Pulse health unavailable"; const mine = m.devices.filter((d) => d.pulseHealth).length; return `${p.investigate || 0} investigate / ${p.watch || 0} watch · ${mine} on this console`; })(), tone: (() => { const p = app.data.pulseHealth || {}; if (!p.processorCount) return "neutral"; return (p.investigate || 0) ? "red" : (p.watch || 0) ? "amber" : "green"; })(), icon: "\u25B2", query: "pulse:degraded" },
      // A dead scrape has to be corroborated by missing data. Guardian v1.1.32 reports
      // a11yHealthy=false fleet-wide while the service is provably bound (dumpsys "Bound services")
      // and still scraping compute, so the flag alone is not trustworthy. If compute fields are
      // still arriving, the accessibility service is alive whatever the flag says.
      { label: "Scrape dead", value: m.devices.filter(scrapeDead).length, context: m.devices.filter(scrapeDead).length ? `Unbound >${A11Y_DEAD_MIN}m — re-bind is not taking; reboot these` : (m.devices.filter(scrapeFlapping).length ? `${m.devices.filter(scrapeFlapping).length} re-binding after an OTA (normal, self-heals)` : "Accessibility service bound everywhere reporting it"), tone: m.devices.filter(scrapeDead).length ? "red" : "green", icon: "\u2717", query: "a11y:dead" },
      { label: "Up but stalled", value: stalledDevices.length, context: stalledDevices.length ? "Running, but heartbeat stale — earning nothing" : "Every phone on a job has a fresh heartbeat", tone: stalledDevices.length ? "red" : "green", icon: "\u25D1", query: "stalled:true" },
      // The canary runs two instances of the SAME package: a user-0 hub (the "Open Processor
      // to Provide Compute" screen) and the work-profile Processor that actually earns.
      // Guardian's targetOnTop matches on package NAME only, so it reads true for either --
      // a node can sit on the hub while computeStatus still says "Running" (a retained value)
      // and every other card stays green. Foreground USER is the discriminator; the backend
      // samples it every 180s. idleHub===null means unreadable, which is NOT counted as healthy.
      // ANRs were invisible: a phone wedging 12x/day reads as healthy because Guardian
      // dismisses each dialog and earning never dips.
      { label: "App ANRs", value: anrDevices.length, context: anrDevices.length ? `${anrTotal} total since boot \u00b7 app main thread wedging` : "No device has ANR'd since boot", tone: anrDevices.length ? "amber" : "green", icon: "\u26A0", query: "anr:>0" },
      { label: "Idle hub", value: idleHubDevices.length, context: idleHubDevices.length ? "On the user-0 hub \u2014 NOT computing" : (idleHubUnknown.length ? `No idle nodes \u00b7 ${idleHubUnknown.length} foreground unreadable` : "No node is sitting on the idle hub"), tone: idleHubDevices.length ? "red" : "green", icon: "\u25D3", query: "idle:true" },
      { label: "On jobs", value: computeReporting.length ? `${computeActive.length}/${computeReporting.length}` : "—", context: !computeReporting.length ? "Needs Guardian v1.1.20+" : computeActive.length === computeReporting.length ? "Every reporting phone has a job" : `${computeReporting.length - computeActive.length} idle \u2014 no job assigned, not a fault`, tone: !computeReporting.length ? "neutral" : computeActive.length === computeReporting.length ? "green" : "amber", icon: "\u25B6" },
      { label: "Average battery", value: m.averageBattery == null ? "—" : `${Math.round(m.averageBattery)}%`, context: m.averageBattery == null ? "Not reported by backend" : `${m.batteryDevices.length} devices reporting`, tone: m.averageBattery != null && m.averageBattery < 35 ? "amber" : "teal", icon: "▰", query: "battery:<30" },
      { label: "Update compliance", value: total ? `${Math.round((total - (app.data.updateCount || 0)) / total * 100)}%` : "—", context: app.data.release && app.data.release.versionName ? `${app.data.updateCount || 0} need Lite ${app.data.release.versionName}` : `${app.data.behindCount || 0} behind latest observed`, tone: (app.data.updateCount || app.data.behindCount) ? "amber" : "green", icon: "↧", query: app.data.release && app.data.release.versionName ? "update:true" : "outdated:true" },
    ];
    if (m.tempDevices.length) {
      const hottest = m.tempDevices[0];
      cards.push({ label: "Hottest device", value: `${hottest.value.toFixed(1)}°C`, context: `${displayName(hottest.device)} \u00b7 ${displayModel(hottest.device)}`, tone: hottest.value >= 48 ? "red" : hottest.value >= 42 ? "amber" : "neutral", icon: "↑", action: "open-device", detail: hottest.device.serial });
    }
    if (m.averageCpu != null) cards.push({ label: "Average CPU", value: `${Math.round(m.averageCpu)}%`, context: `Per-core load · ${m.cpuDevices.length} devices reporting`, tone: m.averageCpu > 80 ? "red" : "purple", icon: "⌁", query: "cpu:>80" });
    if (m.jobs.length) cards.push({ label: "Jobs running", value: m.jobs.length, context: "Real workload state reported", tone: "purple", icon: "▶", query: "job:running" });
    const fgLoss = (app.data.guardian && app.data.guardian.fgLoss) || {};
    if (fgLoss.climbing) cards.push({ label: "FG climbing", value: fgLoss.climbing, context: fgLoss.worst ? `${fgLoss.worst.label} · ${fgLoss.worst.rate}/h` : "Foreground losses increasing", tone: "amber", icon: "↺", query: "fg:>=1" });
    const summary = app.data.metricsSummary || {};
    if (summary.throttling) cards.push({ label: "Throttling", value: summary.throttling, context: "OS thermal throttling active", tone: "red", icon: "↑", action: "open-analytics" });
    // Remember every card label so the options panel can list them, even the ones that
    // only appear conditionally (Throttling, FG climbing, Jobs running).
    cards.forEach((c) => { if (c && c.label && !app.kpiLabels.includes(c.label)) app.kpiLabels.push(c.label); });

    // A card is an EXCEPTION if its tone says something is wrong. Those always stay
    // full-size. Nominal cards (green/teal/neutral) are still real information, so focus
    // mode folds them into one summary line rather than hiding them -- the operator can
    // still read every number, it just stops competing with the things that need action.
    const isException = (c) => c.tone === "red" || c.tone === "amber";
    const chosen = cards.filter((c) => c && !app.kpiHidden.has(c.label));
    const byLabel = new Map(chosen.map((c) => [c.label, c]));
    // Pinned first, in the order the operator dragged them.
    const pinned = app.kpiPinned.map((l) => byLabel.get(l)).filter(Boolean);
    const pinnedSet = new Set(pinned.map((c) => c.label));
    const rest = chosen.filter((c) => !pinnedSet.has(c.label));
    let shown = pinned.concat(rest.filter((c) => !app.kpiDemoted.has(c.label)));
    let folded = rest.filter((c) => app.kpiDemoted.has(c.label));
    if (app.focusMode) {
      const exceptions = rest.filter((c) => isException(c) && !app.kpiDemoted.has(c.label));
      const nominal = rest.filter((c) => !isException(c) || app.kpiDemoted.has(c.label));
      exceptions.forEach((c) => { c.auto = true; });
      shown = pinned.concat(exceptions);
      folded = nominal;
      // With nothing pinned and nothing wrong the page would be empty, which reads as
      // broken rather than healthy -- keep a few informational cards as an anchor.
      if (!shown.length) { shown = nominal.slice(0, 4); folded = nominal.slice(4); }
    }
    $("#kpiGrid").innerHTML = shown.map(kpiCard).join("");

    const strip = $("#kpiNominal");
    const gridEl = $("#kpiGrid");
    if (gridEl) gridEl.classList.remove("is-drop-target");
    if (strip) strip.classList.remove("is-drop-target");
    // Keep the strip present whenever anything is pinned or demoted, so there is always a
    // place to drop a card back to. A hidden strip is an impossible drop target.
    if (folded.length || app.kpiPinned.length || app.kpiDemoted.size) {
      strip.hidden = false;
      strip.innerHTML = `<span class="kpi-nominal-tag">${app.focusMode && shown.some(isException) ? "NOMINAL" : "ALSO"}</span>` +
        folded.map((c) => `<button type="button" class="kpi-chip" draggable="true" data-kpi-label="${escapeAttr(c.label)}" ${c.query ? `data-kpi-query="${escapeAttr(c.query)}"` : ""} title="${escapeAttr(String(c.context || ""))}"><span>${escapeHtml(c.label)}</span><b>${escapeHtml(String(c.value))}</b></button>`).join("") +
        (folded.length ? "" : '<em class="kpi-nominal-empty">drag a card here to demote it</em>') +
        `<button type="button" class="kpi-chip kpi-chip--more" data-action="open-options" title="Choose which cards appear">\u2699</button>`;
    } else {
      strip.hidden = true;
      strip.innerHTML = "";
    }
  }

  function renderUpdatePanel() {
    const panel = $("#updatePanel");
    const release = app.data.release || {};
    if (!release.versionName) { panel.hidden = true; return; }
    panel.hidden = false;
    const ready = Boolean(release.ready);
    const onlineOutdated = (app.data.devices || []).filter((device) => device.updateAvailable && U.effectiveState(device) === "device");
    const selectedOutdated = onlineOutdated.filter((device) => app.selected.has(device.serial));
    const details = [release.assetName, release.sizeBytes ? formatBytes(release.sizeBytes) : "", release.publishedAt ? String(release.publishedAt).slice(0, 10) : ""].filter(Boolean).join(" · ");
    $("#updateReleaseMeta").textContent = ready ? `Verified Lite ${release.versionName}${details ? ` · ${details}` : ""}` : `${release.error || "Downloading and verifying signed release…"}`;
    $("#updateStats").innerHTML = `<div class="update-stat"><span>Current</span><strong>${Math.max(0, (app.data.total || 0) - (app.data.updateCount || 0))}</strong></div><div class="update-stat"><span>Outdated</span><strong>${app.data.updateCount || 0}</strong></div><div class="update-stat"><span>Eligible</span><strong>${onlineOutdated.length}</strong></div><div class="update-stat"><span>Verification</span><strong style="color:${ready ? "var(--green)" : "var(--amber)"}">${ready ? "Passed" : "Pending"}</strong></div>`;
    const selectedButton = $('[data-action="update-selected"]');
    const allButton = $('[data-action="update-outdated"]');
    selectedButton.disabled = !ready || !selectedOutdated.length;
    selectedButton.textContent = `Update selected${selectedOutdated.length ? ` · ${selectedOutdated.length}` : ""}`;
    allButton.disabled = !ready || !onlineOutdated.length;
    allButton.textContent = `Update all outdated${onlineOutdated.length ? ` · ${onlineOutdated.length}` : ""}`;
  }

  function isAttentionDevice(device) {
    const health = U.calculateHealthScore(device);
    return health.score != null && health.score < 85;
  }

  function heatTone(device, mode) {
    if (mode === "state") return U.deviceStateBadge(device).tone;
    if (mode === "health") return U.calculateHealthScore(device).tone;
    if (mode === "version") return device.behind ? "warning" : device.version ? "healthy" : "neutral";
    if (mode === "battery") {
      const value = U.batteryValue(device);
      return value == null ? "neutral" : value < 15 ? "critical" : value < 30 ? "warning" : "healthy";
    }
    const value = U.temperatureValue(device);
    return value == null ? "neutral" : value >= 48 ? "critical" : value >= 42 ? "warning" : "healthy";
  }

  // Tone alone buckets everything: health 91 and 100 were the same green, and in Temp mode
  // the hottest phone looked identical to the coolest. Intensity carries the actual value
  // so gradients are visible at a glance instead of needing a hover.
  function heatIntensity(device, mode) {
    let v = null, lo = 0, hi = 1;
    if (mode === "health") { const h = U.calculateHealthScore(device); v = h.score; lo = 40; hi = 100; }
    else if (mode === "temperature") { v = U.temperatureValue(device); lo = 20; hi = 50; }
    else if (mode === "battery") { v = U.batteryValue(device); lo = 0; hi = 100; }
    if (v == null || !Number.isFinite(Number(v))) return null;
    const t = (Number(v) - lo) / (hi - lo);
    return Math.max(0, Math.min(1, t));
  }

  // Which bucket a device belongs to on the map.
  function mapGroupKey(device) {
    const mode = app.mapGroupBy;
    if (mode === "none") return "";
    if (mode === "custom") {
      const g = app.mapGroups[device.serial];
      return g || "Ungrouped";
    }
    if (mode === "model") return displayModel(device) || "Unknown model";
    if (mode === "alias") {
      const name = displayName(device) || "";
      // Group by the alias' leading token, so "rack-a-01" and "rack-a-02" sit together.
      const m2 = name.match(/^([A-Za-z][A-Za-z0-9]*)/);
      return m2 ? m2[1] : (name ? name[0].toUpperCase() : "Unnamed");
    }
    const ip = U.deviceIp(device) || "";
    const m3 = ip.match(/^(\d+\.\d+\.\d+)\./);
    return m3 ? m3[1] + ".x" : "No IP";
  }

  function heatValue(device, mode) {
    if (mode === "health") {
      const health = U.calculateHealthScore(device);
      return health.score == null ? "Unknown" : `${health.score}/100`;
    }
    if (mode === "temperature") return formatMetric(U.temperatureValue(device), "°C", 1);
    if (mode === "battery") return formatMetric(U.batteryValue(device), "%");
    if (mode === "version") return device.version ? `v${device.version}${device.behind ? " · behind" : ""}` : "Not scanned";
    return U.deviceStateBadge(device).label;
  }

  function renderOverview() {
    const m = fleetMetrics();
    const total = m.devices.length;
    const healthy = m.health.filter((item) => item.result.score != null && item.result.score >= 85).length;
    const reporting = m.devices.filter((device) => device.telemetry || device.acurast).length;
    const armed = m.devices.filter(isArmed).length;
    $("#overviewStats").innerHTML = [
      ["Fleet size", total], ["Healthy", healthy], ["Telemetry", `${reporting}/${total}`], ["Guardian armed", `${armed}/${total}`],
    ].map(([label, value]) => `<div class="overview-stat"><span>${label}</span><strong>${value}</strong></div>`).join("");

    markActive($$("#heatmapModes button"), (button) => button.dataset.heatmapMode === app.heatmapMode);
    const heatmap = $("#heatmap");
    const maxCells = 420;
    if (total > maxCells) {
      const groups = new Map();
      m.devices.forEach((device) => {
        const key = app.heatmapMode === "version" ? (device.version || "Unknown") : U.effectiveState(device);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(device);
      });
      heatmap.innerHTML = Array.from(groups.entries()).map(([key, devices]) => {
        const representative = devices.slice().sort((a, b) => {
          const rank = { critical: 0, warning: 1, neutral: 2, active: 3, healthy: 4 };
          return rank[heatTone(a, app.heatmapMode)] - rank[heatTone(b, app.heatmapMode)];
        })[0];
        const stateQuery = app.heatmapMode === "version" ? `version:${key}` : `status:${key}`;
        return `<button class="heat-cell ${heatTone(representative, app.heatmapMode)}" style="grid-column:span ${Math.min(18, Math.max(2, Math.ceil(devices.length / total * 80)))}" data-group-query="${escapeAttr(stateQuery)}" title="${escapeAttr(`${key}: ${devices.length} devices`)}" aria-label="${escapeAttr(`${key}, ${devices.length} devices`)}"></button>`;
      }).join("");
      $("#heatmapNote").textContent = `${total.toLocaleString()} devices aggregated into ${groups.size} operational groups to protect render performance.`;
    } else {
      // Stable position: sort inside each group by a key that does not change with the
      // table's sort order, so a device keeps its spot on the map between renders.
      const stableKey = (d) => {
        const ip = U.deviceIp(d) || "";
        const parts = ip.split(".").map(Number);
        return parts.length === 4 && parts.every(Number.isFinite)
          ? (parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3])
          : Number.MAX_SAFE_INTEGER;
      };
      const groups = new Map();
      m.devices.forEach((device) => {
        const key = mapGroupKey(device);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(device);
      });
      groups.forEach((list) => list.sort((a, b) => stableKey(a) - stableKey(b) || String(a.serial).localeCompare(String(b.serial))));
      const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
        if (a === "Ungrouped") return 1;
        if (b === "Ungrouped") return -1;
        return String(a).localeCompare(String(b), undefined, { numeric: true });
      });

      const cell = (device) => {
        const temperature = U.temperatureValue(device);
        const battery = U.batteryValue(device);
        const health = heatValue(device, "health");
        const intensity = heatIntensity(device, app.heatmapMode);
        // Higher value = stronger for health/battery; for temperature hot should be
        // strongest, and the scale already runs cold->hot, so it maps directly.
        const alpha = intensity == null ? 1 : 0.35 + 0.65 * (app.heatmapMode === "battery" || app.heatmapMode === "health" ? (1 - intensity) : intensity);
        const badges = [];
        if (device.idleHub === true) badges.push("IDLE HUB");
        if (((device.telemetry || {}).anrSinceBoot || 0) > 0) badges.push(`${device.telemetry.anrSinceBoot} ANR`);
        if (protectionOff(device)) badges.push("NOT ARMED");
        const title = `${displayName(device)}  ·  ${U.deviceIp(device) || device.serial}
${U.deviceStateBadge(device).label} · ${displayModel(device)}
Health ${health} · Temp ${temperature == null ? "\u2014" : temperature.toFixed(1) + "\u00b0C"} · Battery ${battery == null ? "\u2014" : battery + "%"}
${device.version ? "v" + device.version : "version unknown"}${badges.length ? "\n\u26a0 " + badges.join(" · ") : ""}
Click to open \u00b7 Shift-click to select`;
        return `<button class="heat-cell ${heatTone(device, app.heatmapMode)}${app.selected.has(device.serial) ? " selected" : ""}" type="button" role="listitem" style="--heat-a:${alpha.toFixed(2)}" data-heat-serial="${escapeAttr(device.serial)}" title="${escapeAttr(title)}" aria-label="${escapeAttr(`${displayName(device)}, ${heatValue(device, app.heatmapMode)}${badges.length ? ", " + badges.join(", ") : ""}`)}"></button>`;
      };

      if (app.mapGroupBy === "none") {
        // Wrap in its own grid: .heatmap is now a flex row for packing groups, so ungrouped
        // cells dropped straight into it lose the grid that gave them size and spacing.
        heatmap.innerHTML = `<div class="heat-flat">${(groups.get("") || []).map(cell).join("")}</div>`;
      } else {
        heatmap.innerHTML = orderedKeys.map((key) => {
          const list = groups.get(key) || [];
          const sel = list.filter((d) => app.selected.has(d.serial)).length;
          // Each group is sized to its own contents and the groups pack horizontally, so a
          // one-device group no longer consumes a full-width row. Roughly square blocks
          // read better than long thin strips, hence sqrt rather than a fixed column count.
          const cols = Math.max(1, Math.min(14, Math.ceil(Math.sqrt(list.length * 1.8))));
          return `<div class="heat-group">
            <div class="heat-group-head">
              <button type="button" class="heat-group-label" data-heat-group="${escapeAttr(key)}" title="Select all ${list.length} device(s) in ${escapeAttr(key)}">${escapeHtml(String(key))}</button>
              <span class="heat-group-count">${list.length}${sel ? ` · ${sel} selected` : ""}</span>
            </div>
            <div class="heat-group-cells" style="grid-template-columns:repeat(${cols}, 13px)">${list.map(cell).join("")}</div>
          </div>`;
        }).join("");
      }
      const selCount = m.devices.filter((d) => app.selected.has(d.serial)).length;
      $("#heatmapNote").textContent = total
        ? `Every cell is a real device \u00b7 grouped by ${app.mapGroupBy} \u00b7 shade shows ${app.heatmapMode}. Click a cell to open it, shift-click to select, click a group name to select the group.${selCount ? ` ${selCount} selected.` : ""}`
        : "No devices are available in the current fleet snapshot.";
    }
    const legends = app.heatmapMode === "state"
      ? [["healthy", "Online"], ["active", "Rebooting"], ["warning", "Unauthorized"], ["neutral", "Offline"]]
      : [["healthy", "Healthy"], ["warning", "Attention"], ["critical", "Critical"], ["neutral", "Unknown"]];
    $("#heatmapLegend").innerHTML = legends.map(([tone, label]) => `<span><i style="background:var(--${tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "critical" ? "red" : tone === "active" ? "teal" : "muted"})"></i>${label}</span>`).join("");
  }

  function renderActivity() {
    const list = app.activities.filter((item) => app.activityFilter === "all" || item.type === app.activityFilter || (app.activityFilter === "alert" && item.type === "critical"));
    $("#activityCount").textContent = app.activities.length;
    markActive($$("[data-activity-filter]"), (button) => button.dataset.activityFilter === app.activityFilter);
    $("#activityFeed").innerHTML = list.length ? list.map((item) => `<div class="activity-item ${escapeAttr(item.type)}">
      <div class="activity-icon">${escapeHtml(item.icon || "•")}</div>
      <div class="activity-copy"><strong>${escapeHtml(item.device || "Fleet")}</strong><span>${escapeHtml(item.message)}</span></div>
      <time class="activity-time" datetime="${new Date(item.timestamp).toISOString()}">${formatTime(item.timestamp)}</time>
    </div>`).join("") : '<div class="activity-empty">No matching current-session activity.<br>Events appear here when real state changes or actions run.</div>';
  }

  function renderGuardian() {
    const guardian = app.data.guardian || {};
    const job = guardian.job || {};
    const panel = $("#guardianPanel");
    panel.dataset.enabled = guardian.enabled ? "true" : "false";
    const installButtons = $$('[data-action^="guardian-install"]');
    installButtons.forEach((button) => {
      button.disabled = !guardian.enabled || Boolean(job.active);
      button.title = !guardian.enabled ? "Guardian OTA is not configured on the backend" : job.active ? "An installation is already running" : "";
    });
    $$('[data-action^="provision-"]').forEach((button) => {
      button.disabled = !guardian.enabled;
      button.title = guardian.enabled ? "" : "Guardian OTA is not configured on the backend";
    });
    const keeper = guardian.keepLite || {};
    const keepButton = $("#keepLiteButton");
    markActive([keepButton], () => Boolean(keeper.enabled));
    keepButton.textContent = `Keep Lite · ${keeper.enabled ? "ON" : "off"}`;
    keepButton.title = keeper.enabled
      ? `Fallback sweep every ${Math.round((keeper.interval || 300) / 60)} minutes · acted on ${keeper.acted || 0}/${keeper.checked || 0} last sweep`
      : "Guardian v1.1.8+ self-enforces foreground state; this console keeper is a redundant fallback.";
    if (job.total) {
      const percent = Math.round((job.done || 0) / job.total * 100);
      $("#guardianProgress").innerHTML = `<div class="progress-meta"><span>${job.active ? "Installing" : "Completed"} ${escapeHtml(job.tag || "release")} · ${job.done || 0}/${job.total}</span><span>${job.ok || 0} succeeded · ${job.failed || 0} failed</span></div><div class="progress-track"><i style="width:${percent}%"></i></div>`;
    } else {
      $("#guardianProgress").innerHTML = guardian.enabled ? "" : '<div class="progress-meta"><span>Guardian OTA is not configured. Add the repository and read-only token in devices.json.</span></div>';
    }
  }

  function filteredDevices() {
    const matching = (app.data.devices || []).filter((device) => U.matchesFilter(device, app.query));
    return U.sortDevices(matching, app.sortKey, app.sortDirection);
  }

  function renderDevices(resetWindow) {
    if (resetWindow) app.tableWindowStart = 0;
    app.visibleDevices = filteredDevices();
    const total = app.data.devices.length;
    const visible = app.visibleDevices.length;
    $("#visibleCount").textContent = `${visible.toLocaleString()} device${visible === 1 ? "" : "s"}`;
    $("#listSummary").textContent = `Showing ${visible.toLocaleString()} of ${total.toLocaleString()} devices`;
    $("#fleetSearch").value = app.query;
    renderFilterChips();
    renderViewSwitcher();

    const empty = $("#emptyState");
    if (!total) {
      empty.hidden = false;
      empty.innerHTML = '<div class="empty-icon">⌖</div><h3>No devices in this fleet</h3><p>Enable Wireless debugging, pair each phone once, then discover via mDNS or import the configured device list.</p><div class="button-row" style="justify-content:center"><button class="button primary" type="button" data-action="discover">Discover devices</button><button class="button" type="button" data-open-dialog="importDlg">Import list</button></div>';
      $("#tableView").hidden = true;
      $("#cardView").hidden = true;
      return;
    }
    if (!visible) {
      empty.hidden = false;
      empty.innerHTML = `<div class="empty-icon">⌕</div><h3>No devices match this view</h3><p>Try removing a filter or use a broader fleet query.</p><button class="button" type="button" data-action="clear-filters">Clear filters</button>`;
      $("#tableView").hidden = true;
      $("#cardView").hidden = true;
      return;
    }
    empty.hidden = true;
    if (app.view === "table") renderTable(); else renderCards();
  }

  function renderViewSwitcher() {
    markActive($$("[data-view]"), (button) => button.dataset.view === app.view);
    $("#tableView").hidden = app.view !== "table";
    $("#cardView").hidden = app.view !== "grid";
  }

  function healthMarkup(health, large) {
    const score = health.score == null ? 0 : health.score;
    const shown = health.score == null ? "?" : health.score;
    return `<div class="health-ring ${escapeAttr(health.tone)}" style="--score:${score}" title="${escapeAttr(health.reasons.join(" · "))}"><b>${shown}</b></div>${large ? "" : `<div class="health-copy"><strong>${escapeHtml(health.label)}</strong><span>${health.confidence === "limited" ? "Limited inputs" : health.confidence === "unknown" ? "No metrics" : "Live inputs"}</span></div>`}`;
  }

  function statusMarkup(device) {
    const badge = U.deviceStateBadge(device);
    return `<span class="status-badge ${badge.tone}"><i>${badge.icon}</i>${escapeHtml(badge.label)}</span>`;
  }

  function batteryMarkup(device) {
    const battery = U.batteryValue(device);
    if (battery == null) return '<span class="metric-value">—</span><span class="metric-sub">Not reported</span>';
    const charging = U.isCharging(device);
    const tone = battery < 15 ? "critical" : battery < 30 ? "low" : "";
    return `<span class="metric-value">${battery}%${charging ? " ⚡" : ""}</span><div class="battery-meter"><i class="${tone}" style="width:${Math.max(2, Math.min(100, battery))}%"></i></div>`;
  }

  function tempMarkup(device) {
    const temperature = U.temperatureValue(device);
    if (temperature == null) return '<span class="metric-value">—</span><span class="metric-sub">Not reported</span>';
    const tone = temperature >= 48 ? "hot" : temperature >= 42 ? "warm" : "";
    return `<span class="metric-value ${tone}">${temperature.toFixed(1)}°C</span><span class="metric-sub">${temperature >= 48 ? "Critical" : temperature >= 42 ? "Elevated" : "Normal"}</span>`;
  }

  function renderTable() {
    const shell = $("#tableView");
    shell.hidden = false;
    $("#cardView").hidden = true;
    const rowHeight = 58;
    const start = Math.max(0, Math.min(app.visibleDevices.length - 1, Math.floor(shell.scrollTop / rowHeight) - 8));
    const end = Math.min(app.visibleDevices.length, start + app.tableWindowSize);
    app.tableWindowStart = start;
    const before = start * rowHeight;
    const after = Math.max(0, (app.visibleDevices.length - end) * rowHeight);
    const rows = app.visibleDevices.slice(start, end).map(deviceRow).join("");
    $("#deviceTableBody").innerHTML = `${before ? `<tr aria-hidden="true"><td colspan="12" style="height:${before}px;padding:0;border:0"></td></tr>` : ""}${rows}${after ? `<tr aria-hidden="true"><td colspan="12" style="height:${after}px;padding:0;border:0"></td></tr>` : ""}`;
    const visibleSerials = app.visibleDevices.map((device) => device.serial);
    const checked = visibleSerials.length && visibleSerials.every((serial) => app.selected.has(serial));
    $("#selectVisible").checked = checked;
    $("#selectVisible").indeterminate = !checked && visibleSerials.some((serial) => app.selected.has(serial));
  }

  function deviceRow(device) {
    const serial = escapeAttr(device.serial);
    const health = U.calculateHealthScore(device);
    const state = U.deviceStateBadge(device);
    const ip = U.deviceIp(device);
    const lastSeen = U.effectiveState(device) === "device" ? "Now" : formatTime(device.last_seen);
    const online = U.effectiveState(device) === "device";
    const rowTone = health.tone === "critical" ? "critical" : health.tone === "warning" ? "warning" : "";
    const gState = guardianState(device);
    const name = displayName(device);
    return `<tr class="${app.selected.has(device.serial) ? "selected " : ""}${rowTone}" data-row-serial="${serial}" tabindex="0" aria-label="Open ${escapeAttr(name)} details">
      <td class="select-col"><input type="checkbox" data-select-serial="${serial}" ${app.selected.has(device.serial) ? "checked" : ""} aria-label="Select ${escapeAttr(name)}"></td>
      <td class="identity-col"><div class="device-identity"><span class="device-avatar"><i class="${state.tone}"></i></span><div class="identity-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(device.ip || device.serial)}</span></div></div></td>
      <td>${statusMarkup(device)}</td>
      <td class="health-cell"><div class="health-score">${healthMarkup(health)}</div></td>
      <td><div class="cell-stack"><strong class="mono">${escapeHtml(ip || "—")}</strong><span>${ip ? "Wireless ADB" : "Host unresolved"}</span></div></td>
      <td><div class="cell-stack"><strong>${escapeHtml(displayModel(device))}</strong><span>${escapeHtml(displayProfile(device))}</span></div></td>
      <td>${tempMarkup(device)}</td>
      <td>${batteryMarkup(device)}</td>
      <td><div class="cell-stack"><strong>${escapeHtml(gState)}</strong><span>${isArmed(device) ? "Armed" : device.telemetry ? "Not armed" : "No live telemetry"}${device.fgRate >= 1 ? ` · FG ${device.fgRate}/h` : ""}</span></div></td>
      <td><div class="version-cell"><strong>${device.version ? `v${escapeHtml(device.version)}` : "—"}</strong><span class="mini-tag ${device.updateAvailable ? "update" : device.behind ? "warning" : ""}">${device.updateAvailable ? `Update → ${escapeHtml((app.data.release || {}).versionName || "ready")}` : device.behind ? "Behind observed" : device.version ? "Current" : "Not scanned"}</span></div></td>
      <td><div class="cell-stack"><strong>${escapeHtml(lastSeen)}</strong><span>${device.versionCheckedAt ? `Version scan ${formatTime(device.versionCheckedAt)}` : "No version scan"}</span></div></td>
      <td>${computeBadge(device)}${idleHubBadge(device) ? "<br>" + idleHubBadge(device) : ""}${anrBadge(device) ? "<br>" + anrBadge(device) : ""}${protectionOff(device) ? '<br><span class="anr-badge unarmed-badge" title="Guardian is not armed on this device: the controller gate is shut, so it will detect problems and never act.">\u26A0 not armed</span>' : ""}${foregroundPill(device, false) ? "<br>" + foregroundPill(device, false) : ""}${pulseHealthBadge(device) ? "<br>" + pulseHealthBadge(device) : ""}</td><td class="actions-col"><div class="quick-actions">${device.updateAvailable ? `<button type="button" data-device-action="update" data-serial="${serial}" ${online ? "" : "disabled"} aria-label="Update ${escapeAttr(name)}" title="Update Lite">⇧</button>` : ""}<button type="button" data-device-action="screenshot" data-serial="${serial}" ${online ? "" : "disabled"} aria-label="Screenshot ${escapeAttr(name)}" title="Screenshot">▣</button><button type="button" data-device-action="live" data-serial="${serial}" ${online ? "" : "disabled"} aria-label="Live screen ${escapeAttr(name)}" title="${app.data.wsScrcpyUrl ? "Live screen" : "Copy scrcpy command"}">◉</button><button type="button" data-device-action="locate" data-serial="${serial}" ${online ? "" : "disabled"} aria-label="Locate ${escapeAttr(name)}" title="Locate (beacon)">📍</button>${device.address ? `<button type="button" data-device-action="pulse" data-serial="${serial}" aria-label="Open ${escapeAttr(name)} on Pulse" title="View this processor on acurastpulse.com">↗</button>` : ""}<button type="button" data-device-action="more" data-serial="${serial}" aria-label="Open ${escapeAttr(name)} details" title="Device details">•••</button></div></td>
    </tr>`;
  }

  function renderCards() {
    $("#tableView").hidden = true;
    const grid = $("#cardView");
    grid.hidden = false;
    const limit = 160;
    grid.innerHTML = app.visibleDevices.slice(0, limit).map(deviceCard).join("") + (app.visibleDevices.length > limit ? `<div class="device-card"><div class="empty-state" style="border:0;padding:35px 12px"><h3>Compact view capped at ${limit}</h3><p>Use the virtualized operations table to work with all ${app.visibleDevices.length.toLocaleString()} matching devices.</p><button class="button" data-view="table">Open operations table</button></div></div>` : "");
  }

  function deviceCard(device) {
    const serial = escapeAttr(device.serial);
    const health = U.calculateHealthScore(device);
    const online = U.effectiveState(device) === "device";
    const name = displayName(device);
    return `<article class="device-card ${app.selected.has(device.serial) ? "selected" : ""}" data-row-serial="${serial}" tabindex="0">
      <div class="card-head"><input type="checkbox" data-select-serial="${serial}" ${app.selected.has(device.serial) ? "checked" : ""} aria-label="Select ${escapeAttr(name)}"><div class="card-title"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(U.deviceIp(device) || device.serial)}</span></div><div class="health-score">${healthMarkup(health, true)}</div></div>
      <div class="card-metrics"><div class="card-metric" title="${U.cpuRawLoad(device) == null ? "CPU load unavailable" : `Per-core load. Raw summed load ${U.cpuRawLoad(device)}% across ${U.cpuCores(device) || "?"} cores.`}"><span>CPU</span><strong>${formatMetric(U.cpuValue(device), "%")}</strong></div><div class="card-metric"><span>Temp</span><strong>${formatMetric(U.temperatureValue(device), "°", 1)}</strong></div><div class="card-metric"><span>Battery</span><strong>${formatMetric(U.batteryValue(device), "%")}${U.isCharging(device) ? " ⚡" : ""}</strong></div></div>
      <div class="card-details"><div class="card-detail"><span>State</span><b>${U.deviceStateBadge(device).label}</b></div><div class="card-detail"><span>Guardian</span><b>${escapeHtml(guardianState(device))}${device.fgRate >= 1 ? ` · FG ${device.fgRate}/h` : ""}</b></div><div class="card-detail"><span>Version</span><b>${device.version ? `v${escapeHtml(device.version)}${device.updateAvailable ? " · update ready" : device.behind ? " · behind" : ""}` : "Not scanned"}</b></div><div class="card-detail card-detail--compute"><span>Compute</span><b>${computeBadge(device)} ${idleHubBadge(device)} ${anrBadge(device)} ${foregroundPill(device, false)}${pulseHealthBadge(device) ? " " + pulseHealthBadge(device) : ""}${device.address ? ` · <a href="https://www.acurastpulse.com/processors/${encodeURIComponent(device.address)}" target="_blank" rel="noopener" class="pulse-link">Pulse ↗</a>` : ""}</b></div></div>
      <div class="card-actions"><button class="button" data-device-action="wake" data-serial="${serial}" ${online ? "" : "disabled"}>Wake</button>${device.updateAvailable ? `<button class="button primary" data-device-action="update" data-serial="${serial}" ${online ? "" : "disabled"}>Update</button>` : `<button class="button" data-device-action="screenshot" data-serial="${serial}" ${online ? "" : "disabled"}>Screen</button>`}<button class="button" data-device-action="more" data-serial="${serial}">Details</button></div>
    </article>`;
  }

  function renderFilterChips() {
    const tokens = U.parseFilterQuery(app.query);
    $("#filterCount").textContent = tokens.filter((token) => token.type === "field").length;
    $("#filterChips").innerHTML = tokens.map((token, index) => `<button class="filter-chip" type="button" data-remove-filter="${index}">${escapeHtml(token.raw || token.value)} <i>×</i></button>`).join("");
    const url = new URL(location.href);
    if (app.query) url.searchParams.set("q", app.query); else url.searchParams.delete("q");
    history.replaceState(null, "", url);
  }

  // Compact density trades the second line in each cell for ~35% more rows on screen,
  // which matters at 76 devices. Persisted, because it is a workstation preference.
  function setDensity(mode) {
    app.density = mode === "compact" ? "compact" : "comfortable";
    try { localStorage.setItem("fleet:density", app.density); } catch (error) { /* private mode */ }
    document.body.classList.toggle("is-compact", app.density === "compact");
    const button = $('[data-action="toggle-density"]');
    if (button) {
      button.setAttribute("aria-pressed", app.density === "compact" ? "true" : "false");
      button.title = app.density === "compact" ? "Comfortable rows" : "Compact rows";
    }
  }

  // ---------------------------------------------------------------- saved filter presets
  // Chips are labelled with the query itself rather than asking for a name: the query IS
  // the recognisable label ("stalled:true"), and skipping the naming step avoids adding a
  // prompt dialog to a codebase that deliberately has none.
  const PRESET_KEY = "fleet:presets";

  function loadPresets() {
    try {
      const raw = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((item) => item && typeof item.query === "string") : [];
    } catch (error) { return []; }
  }

  function savePresets(presets) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets.slice(0, 12))); }
    catch (error) { toast("Could not save", "Browser storage is unavailable.", "error"); }
  }

  function renderPresets() {
    const host = $("#savedPresets");
    if (!host) return;
    const presets = loadPresets();
    host.innerHTML = presets.length
      ? presets.map((preset, index) => {
          const label = preset.query.length > 24 ? preset.query.slice(0, 23) + "…" : preset.query;
          return `<span class="saved-preset"><button type="button" data-preset="${escapeAttr(preset.query)}" title="${escapeAttr(preset.query)}">${escapeHtml(label)}</button><button type="button" class="preset-remove" data-preset-remove="${index}" aria-label="Remove saved filter ${escapeAttr(preset.query)}">×</button></span>`;
        }).join("")
      : '<em class="saved-empty">None yet</em>';
  }

  function saveCurrentPreset() {
    const query = String(app.query || "").trim();
    if (!query) { toast("Nothing to save", "Type or pick a filter first, then save it.", "error"); return; }
    const presets = loadPresets();
    if (presets.some((preset) => preset.query === query)) { toast("Already saved", "That filter is already in your saved list.", "error"); return; }
    presets.unshift({ query });
    savePresets(presets);
    renderPresets();
    toast("Filter saved", query);
  }

  function setQuery(query) {
    app.query = String(query || "").trim();
    app.tableWindowStart = 0;
    $("#tableView").scrollTop = 0;
    renderDevices(true);
  }

  function appendQuery(fragment) {
    const tokens = U.tokenizeQuery(app.query);
    if (!tokens.includes(fragment)) tokens.push(fragment);
    setQuery(tokens.join(" "));
  }

  function removeFilter(index) {
    const tokens = U.tokenizeQuery(app.query);
    tokens.splice(index, 1);
    setQuery(tokens.join(" "));
  }

  function renderBulkDock() {
    const devices = Array.from(app.selected).map((serial) => app.devicesById.get(serial)).filter(Boolean);
    const dock = $("#bulkDock");
    dock.hidden = devices.length === 0;
    if (!devices.length) return;
    $("#selectedCount").textContent = devices.length;
    $$('[data-bulk-action]').forEach((button) => {
      const eligibility = U.actionEligibility(button.dataset.bulkAction, devices);
      button.disabled = eligibility.disabled;
      button.title = eligibility.reason;
      const small = $("small", button);
      if (small) small.textContent = `${eligibility.eligible}/${eligibility.total}`;
    });
  }

  function toggleSelection(serial, force) {
    if (!app.devicesById.has(serial)) return;
    const shouldSelect = force == null ? !app.selected.has(serial) : force;
    if (shouldSelect) app.selected.add(serial); else app.selected.delete(serial);
    renderOverview();
    renderDevices();
    renderBulkDock();
  }

  function openDrawer(serial, focusSource) {
    if (!app.devicesById.has(serial)) return;
    app.drawerSerial = serial;
    app.lastFocused = focusSource || document.activeElement;
    renderDrawer(serial);
    $("#drawerScrim").hidden = false;
    const drawer = $("#deviceDrawer");
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => $("[data-close-drawer]", drawer)?.focus());
  }

  function closeDrawer() {
    app.drawerSerial = null;
    $("#drawerScrim").hidden = true;
    const drawer = $("#deviceDrawer");
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    if (app.lastFocused && document.contains(app.lastFocused)) app.lastFocused.focus();
  }

  function renderDrawer(serial) {
    const device = app.devicesById.get(serial);
    if (!device) return closeDrawer();
    const health = U.calculateHealthScore(device);
    const telemetry = device.telemetry || {};
    const arm = telemetry.arm || {};
    const metrics = device.metrics || {};
    const batteryMetrics = metrics.battery || {};
    const cpuMetrics = metrics.cpu || {};
    const wifiMetrics = metrics.wifi || {};
    const online = U.effectiveState(device) === "device";
    const battery = U.batteryValue(device);
    const temperature = U.temperatureValue(device);
    const cpu = U.cpuValue(device);
    const name = displayName(device);
    const activities = app.activities.filter((item) => item.device && (item.device.includes(name) || item.device.includes(device.serial))).slice(0, 5);
    const fgText = telemetry.foregroundLostCount == null ? "Not reported" : `${telemetry.foregroundLostCount} lifetime · ${telemetry.foregroundLostSinceBoot == null ? "—" : telemetry.foregroundLostSinceBoot} since boot${device.fgRate == null ? "" : ` · ${device.fgRate}/h`}`;
    $("#drawerContent").innerHTML = `<header class="drawer-header"><div><span class="eyebrow">DEVICE DETAILS</span><h2 id="drawerTitle">${escapeHtml(name)}</h2><p>${escapeHtml(device.ip || device.serial)}</p></div><button class="icon-button" type="button" data-close-drawer aria-label="Close device details">×</button></header>
      <section class="drawer-section"><div class="drawer-section-heading"><h3>Overview</h3>${statusMarkup(device)}</div><div class="drawer-overview"><div class="drawer-health">${healthMarkup(health, true)}<span>${escapeHtml(health.label)} health</span></div><div class="drawer-kv"><div title="The phone's IP on the farm LAN. This is how the console reaches it over wireless ADB."><span>Host<i class="hint-dot" aria-hidden="true">?</i></span><strong>${escapeHtml(U.deviceIp(device) || "Unresolved")}</strong></div><div title="Marketing model name. Note one model can span carrier SKUs with different firmware and different bloat."><span>Model<i class="hint-dot" aria-hidden="true">?</i></span><strong>${escapeHtml(displayModel(device))}</strong></div><div title="Whether the Processor is running in an Android work profile. It is the work-profile copy that earns."><span>Profile<i class="hint-dot" aria-hidden="true">?</i></span><strong>${escapeHtml(displayProfile(device))}</strong></div><div title="When this console last had contact. 'Now' means the transport is live."><span>Last seen<i class="hint-dot" aria-hidden="true">?</i></span><strong>${escapeHtml(formatTime(device.last_seen))}</strong></div><div title="Installed Acurast Processor (Lite) build."><span>Processor version<i class="hint-dot" aria-hidden="true">?</i></span><strong>${device.version ? `v${escapeHtml(device.version)}` : "Not scanned"}</strong></div><div title="Installed Guardian build. Read from a periodic scan, not live telemetry, so it lags briefly after an update -- the freshness stamp beside it shows when it was last read."><span>Guardian version<i class="hint-dot" aria-hidden="true">?</i></span><strong>${escapeHtml(device.guardianVersion || "Not scanned")}${freshChip(device.versionCheckedAt)}</strong></div></div></div><p class="health-reasons">${escapeHtml(health.reasons.join(" · "))}${health.confidence === "limited" ? " · Score uses limited backend inputs." : ""}</p></section>
      <section class="drawer-section"><div class="drawer-section-heading"><h3>Live metrics</h3><span class="mini-tag">${device.metrics ? "ADB probe live" : device.telemetry ? "Guardian live" : device.acurast ? "Acurast live" : "Unavailable"}</span></div><div class="drawer-metrics"><div class="drawer-metric" title="${U.cpuRawLoad(device) == null ? "CPU load unavailable" : `Per-core load. Raw summed load ${U.cpuRawLoad(device)}% across ${U.cpuCores(device) || "?"} cores.`}"><span>CPU load</span><strong>${formatMetric(cpu, "%")}${U.cpuCores(device) ? ` <em class="metric-sub">of ${U.cpuCores(device)} cores</em>` : ""}</strong></div><div class="drawer-metric" title="CPU/battery temperature. Sustained highs throttle compute and shorten battery life; the fleet map's Temp mode ranks by this."><span>CPU temp<i class="hint-dot" aria-hidden="true">?</i></span><strong>${formatMetric(temperature, "°C", 1)}</strong></div><div class="drawer-metric" title="Charge level. These phones run permanently on AC, so anything not near 100% while charging suggests a bad cable, port or battery."><span>Battery<i class="hint-dot" aria-hidden="true">?</i></span><strong>${formatMetric(battery, "%")}${batteryMetrics.charging ? " ⚡" : ""}</strong></div><div class="drawer-metric" title="Current max CPU clock. A figure well below the chip's rating usually means thermal or power throttling."><span>CPU frequency<i class="hint-dot" aria-hidden="true">?</i></span><strong>${formatMetric(cpuMetrics.maxFreqMhz, " MHz")}</strong></div><div class="drawer-metric" title="Signal strength in dBm. Closer to zero is stronger; below about -75 dBm is where ADB and check-ins start dropping."><span>Wi-Fi<i class="hint-dot" aria-hidden="true">?</i></span><strong>${wifiMetrics.rssi == null ? "—" : `${wifiMetrics.rssi} dBm`}</strong></div><div class="drawer-metric" title="Available memory. These are 2-4GB devices, so low free RAM is when Android starts killing the Processor in the background."><span>RAM free<i class="hint-dot" aria-hidden="true">?</i></span><strong>${formatBytes(telemetry.ramAvailBytes)}${telemetry.ramTotalBytes ? ` <em class="metric-sub">of ${formatBytes(telemetry.ramTotalBytes)}</em>` : ""}</strong></div><div class="drawer-metric" title="Free space. Deployments download and execute code locally, so a full disk stops the node earning even though everything looks healthy."><span>Storage free<i class="hint-dot" aria-hidden="true">?</i></span><strong>${formatBytes(telemetry.storageFreeBytes)}${telemetry.storageTotalBytes ? ` <em class="metric-sub">of ${formatBytes(telemetry.storageTotalBytes)}</em>` : ""}</strong></div><div class="drawer-metric" title="Time since last boot. Very long uptimes are normal here, but a short one means the phone rebooted -- planned or otherwise."><span>Uptime<i class="hint-dot" aria-hidden="true">?</i></span><strong>${formatUptime(telemetry.uptimeMs)}</strong></div></div></section>
      <section class="drawer-section"><div class="drawer-section-heading"><h3>Device state</h3>${foregroundPill(device, true)}</div><div class="state-grid">${stateItem("Lite on top", telemetry.targetOnTop === undefined ? "Not reported" : telemetry.targetOnTop === null ? "Unknown — a11y signal stale" : telemetry.targetOnTop ? "Yes" : `No — ${telemetry.topPackage || "another app"}`)}${stateItem("Screen", metrics.wake || telemetry.screenState || "Not reported")}${stateItem("Guardian", telemetry.guardianState || device.guardianVersion || "Not scanned")}${stateItem("Fleet armed", isArmed(device) ? "Armed" : device.telemetry || device.guardianArmed === false ? "Not armed" : "Not reported")}${stateItem("ADB", U.deviceStateBadge(device).label)}${stateItem("WD keep-alive", arm.wdKeepAlive == null ? "Not reported" : arm.wdKeepAlive ? "Enabled" : "Disabled")}${stateItem("Processor", metrics.proc ? metrics.proc.alive ? `Running · PID ${metrics.proc.pid || "?"}` : "Not running" : "Not reported")}${stateItem("Work profile", device.inWorkProfile ? "Detected" : "Not detected")}${stateItem("Update", device.updateAvailable ? `Ready → ${(app.data.release || {}).versionName || "latest"}` : device.behind ? "Behind observed" : device.version ? "Current" : "Not scanned")}${stateItem("FG losses", fgText)}${stateItem("ANRs", telemetry.anrSinceBoot == null ? "Not reported" : telemetry.anrSinceBoot === 0 ? "None since boot" : `${telemetry.anrSinceBoot} since boot${telemetry.lastAnrTs ? ` \u00b7 last ${formatTime(telemetry.lastAnrTs / 1000)}` : ""}`)}${stateItem("Protection", (() => { const a = telemetry.arm || {}; const on = a.protectionEnabled ?? a.protectionRunning; return on == null ? "Not reported" : on ? "Armed \u00b7 Guardian will act" : "NOT ARMED \u2014 Guardian will not act"; })())}${stateItem("A11y events", telemetry.a11yEventsAlive == null ? "Not reported" : telemetry.a11yEventsAlive ? "Flowing" : "Bound but silent \u2014 zombie binding")}${stateItem("Provide-compute button", telemetry.provideComputeVisible == null ? "Not reported" : telemetry.provideComputeVisible ? "VISIBLE \u2014 node is idle" : "Not shown")}${stateItem("Telemetry", telemetry.telemetryDriver ? `${escapeHtml(telemetry.telemetryDriver)}${telemetry.sinceLastPushSec != null ? ` \u00b7 last push ${telemetry.sinceLastPushSec}s` : ""}` : "Not reported")}${stateItem("Android", telemetry.androidRelease ? `${escapeHtml(String(telemetry.androidRelease))}${telemetry.securityPatch ? ` \u00b7 patch ${escapeHtml(String(telemetry.securityPatch))}` : ""}` : "Not reported")}</div></section>
      <section class="drawer-section"><div class="drawer-section-heading"><h3>Current workload</h3></div>${device.address ? `<div class="button-row"><a class="button" href="https://www.acurastpulse.com/processors/${encodeURIComponent(device.address)}" target="_blank" rel="noopener">View workload on Pulse ↗</a></div>` : `<div class="drawer-empty">No processor address captured yet — workload &amp; earning appear on Pulse once this phone reports its address.</div>`}</section>
      <section class="drawer-section"><div class="drawer-section-heading"><h3>History · 24 hours</h3><button class="button" type="button" data-action="open-device-analytics" data-serial="${escapeAttr(serial)}">Full analytics</button></div><div id="drawerHistory" class="drawer-chart"><div class="loading-orbit"></div></div></section>
      <section class="drawer-section"><div class="drawer-section-heading"><h3>Operations</h3><div class="button-row"><button class="button" data-device-action="rename" data-serial="${escapeAttr(serial)}">Rename</button>${device.address ? `<button class="button" data-device-action="pulse" data-serial="${escapeAttr(serial)}">Pulse ↗</button>` : ""}</div></div>
      <div class="drawer-action-group"><span class="drawer-action-label">Diagnostics</span><div class="drawer-actions"><button class="button" data-device-action="screenshot" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Screenshot</button><button class="button" data-device-action="live" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Live screen</button><button class="button" data-device-action="logcat" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Logcat</button><button class="button" data-device-action="shell-one" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Shell</button></div></div>
      <div class="drawer-action-group"><span class="drawer-action-label">Control</span><div class="drawer-actions"><button class="button" data-device-action="wake" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Wake</button><button class="button" data-device-action="open_acurast" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Open Acurast</button><button class="button" data-device-action="provision" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Provision</button>${device.updateAvailable ? `<button class="button primary" data-device-action="update" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Update Lite</button>` : ""}<button class="button" data-device-action="reset-fg" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Reset FG</button><button class="button" data-device-action="locate" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>📍 Locate</button><button class="button" data-device-action="locate-stop" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Stop</button></div></div>
      <div class="drawer-action-group"><span class="drawer-action-label">Maintenance</span><div class="drawer-actions"><button class="button" data-device-action="pause-15" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"} title="Pause Guardian recovery for 15 minutes so you can use the phone">⏸ Pause 15m</button><button class="button" data-device-action="pause-60" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"} title="Pause Guardian recovery for an hour">⏸ Pause 60m</button><button class="button" data-device-action="resume" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"} title="End the maintenance window now">▶ Resume</button></div></div>
      <div class="drawer-danger" role="group" aria-label="Destructive operations"><span class="drawer-danger-label">Danger zone</span>
        <div class="drawer-danger-row"><div><strong>Reboot device</strong><small>Disconnects wireless ADB and stops earning until Guardian restores connectivity.</small></div><button class="button danger" data-device-action="reboot" data-serial="${escapeAttr(serial)}" ${online ? "" : "disabled"}>Reboot</button></div>
        <div class="drawer-danger-row"><div><strong>Forget device</strong><small>Removes it from the fleet and drops its ADB transport. Requires typing FORGET.</small></div><button class="button danger" data-device-action="forget" data-serial="${escapeAttr(serial)}">Forget</button></div>
      </div></section>
      <section class="drawer-section"><div class="drawer-section-heading"><h3>Current-session history</h3></div>${activities.length ? activities.map((item) => `<div class="activity-item ${item.type}"><div class="activity-icon">${escapeHtml(item.icon)}</div><div class="activity-copy"><strong>${escapeHtml(item.message)}</strong><span>${formatTime(item.timestamp)}</span></div></div>`).join("") : '<div class="drawer-empty">No current-session activity has been recorded for this device. The backend does not expose persistent event history.</div>'}</section>`;
    renderDrawerHistory(serial);
  }

  // Every state row carries a hint. These fields are Guardian/Android internals -- "FG
  // losses", "WD keep-alive", "A11y events" mean nothing to someone who did not build them,
  // and an unexplained field is a field nobody acts on.
  const STATE_HINTS = {
    "Lite on top": "Whether the earning Processor instance is the foreground app right now. It must be foregrounded to compute. Reported by Guardian's accessibility service; 'Unknown' means that signal is stale, which is not the same as 'no'.",
    "Screen": "Display state as last seen. The screen is normally off or covered by Guardian's black screensaver overlay while the phone earns -- that is expected, not a fault.",
    "Guardian": "Guardian's own state machine: TARGET_FOREGROUND means it believes the Processor is up; RECOVERING means it is actively pushing it back to the front.",
    "Fleet armed": "Whether Guardian has been provisioned with its permissions and fleet-mode protection. An unarmed phone still reports telemetry but Guardian will not act on it.",
    "ADB": "The wireless-debugging transport state as this console sees it. 'device' means we can reach it; offline means the transport dropped.",
    "WD keep-alive": "Guardian re-asserting Wireless Debugging on boot. Without it these phones drop off ADB after every reboot and cannot be managed remotely.",
    "Processor": "Whether the Acurast Processor process is alive, and its PID. Separate from whether it is foregrounded or earning.",
    "Work profile": "Whether the phone has an Android work profile. The earning Processor runs inside it; a second copy of the same app runs in the personal profile as the wallet/hub UI.",
    "Update": "Whether a newer Processor (Lite) build is available for this device.",
    "FG losses": "How many times the Processor has been knocked out of the foreground -- by a dialog, the launcher, or a crash. Guardian pushes it back automatically, so a rising count means interruptions, not an outage.",
    "ANRs": "Android 'App Not Responding' events: the app's main thread blocked long enough for the system to raise a dialog. Guardian dismisses it so the node recovers, which is why ANRs never show up as lost earnings -- each one is still lost compute.",
    "Protection": "Whether Guardian's controller gate is actually open. This is the flag that decides if Guardian acts. A phone can look armed and still have this shut, in which case it detects problems and silently does nothing.",
    "A11y events": "Whether Guardian's accessibility service is actually receiving events. It can be bound and registered while delivering nothing ('zombie binding') -- that state looks healthy everywhere else and breaks every scrape.",
    "Provide-compute button": "Whether the wallet/hub screen is showing 'Open Processor to Provide Compute'. If visible, this node is idle and not computing regardless of what the status word says.",
    "Telemetry": "How Guardian schedules its telemetry pushes and how long since the last one. 'fgsLoop+exactAlarm' is the freeze-resistant path; a push age far above the interval means the process was frozen or wedged.",
    "Android": "OS release and security patch level. Old patch levels are common on these budget devices and can matter for attestation.",
  };

  function stateItem(label, value) {
    const hint = STATE_HINTS[label];
    return `<div class="state-item"${hint ? ` title="${escapeAttr(hint)}"` : ""}><span>${escapeHtml(label)}${hint ? '<i class="hint-dot" aria-hidden="true">?</i>' : ""}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  // `action` is optional: { label, onClick }. A toast that reports a batch result is the
  // one moment the operator wants to inspect it, and a 5.5s window was previously both
  // uninspectable and unpausable -- reading a long device list meant missing it entirely.
  function toast(title, message, tone, action) {
    const region = $("#toastRegion");
    const element = document.createElement("div");
    element.className = `toast ${tone || ""}`;
    element.innerHTML = `<i>${tone === "error" ? "!" : "✓"}</i><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>${action && action.label ? `<button class="toast-action" type="button">${escapeHtml(action.label)}</button>` : ""}</div><button class="toast-dismiss" type="button" aria-label="Dismiss">×</button>`;
    $(".toast-dismiss", element).addEventListener("click", () => element.remove());
    if (action && action.label) {
      $(".toast-action", element).addEventListener("click", () => {
        element.remove();
        try { action.onClick(); } catch (error) { console.error(error); }
      });
    }
    region.appendChild(element);

    // Hovering (or focusing something inside) holds the toast open, so it cannot expire
    // out from under someone who is mid-read or reaching for the action.
    let timer = null;
    const start = () => { timer = setTimeout(() => element.remove(), 5500); };
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    element.addEventListener("mouseenter", stop);
    element.addEventListener("mouseleave", start);
    element.addEventListener("focusin", stop);
    element.addEventListener("focusout", start);
    start();
  }

  // This used to snapshot/restore textContent, which DESTROYED the child <span> icon and
  // <b> label nodes and put back a bare text node. Two consequences, both permanent for
  // the session once a button had been used: every affected button lost its icon, and the
  // collapsed sidebar could no longer hide its label (the rule targets `.sidebar-section b`,
  // and there was no longer a <b>), so "Discovery"/"Versions" spilled outside the 68px rail.
  //
  // Now: snapshot innerHTML and restore it verbatim; while busy, retarget only the <b> so
  // the icon and the collapse-hiding structure both survive.
  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (button.dataset.busyHtml === undefined) button.dataset.busyHtml = button.innerHTML;
      button.disabled = true;
      const labelNode = button.querySelector("b");
      if (labelNode) labelNode.textContent = label || "Working…";
      else button.textContent = label || "Working…";
    } else {
      button.disabled = false;
      if (button.dataset.busyHtml !== undefined) {
        button.innerHTML = button.dataset.busyHtml;
        delete button.dataset.busyHtml;
      }
    }
  }

  function confirmAction({ title, body, phrase, actionLabel, danger }) {
    return new Promise((resolve) => {
      const dialog = $("#confirmDlg");
      $("#confirmTitle").textContent = title;
      $("#confirmBody").textContent = body;
      $("#confirmGo").textContent = actionLabel || "Confirm";
      $("#confirmGo").className = `button ${danger === false ? "primary" : "danger"}`;
      const wrap = $("#confirmPhraseWrap");
      const input = $("#confirmPhrase");
      wrap.hidden = !phrase;
      input.value = "";
      $("#confirmPhraseLabel").textContent = phrase || "";
      $("#confirmGo").disabled = Boolean(phrase);
      input.oninput = () => { $("#confirmGo").disabled = input.value.trim().toUpperCase() !== phrase.toUpperCase(); };
      dialog.addEventListener("close", function onClose() {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue === "default");
      });
      dialog.showModal();
      requestAnimationFrame(() => (phrase ? input : $("#confirmGo")).focus());
    });
  }

  async function runBulkAction(action) {
    const devices = Array.from(app.selected).map((serial) => app.devicesById.get(serial)).filter(Boolean);
    const eligibility = U.actionEligibility(action, devices);
    const serials = eligibility.serials;
    if (!serials.length) return toast("No eligible devices", eligibility.reason, "error");
    if (action === "wake" || action === "logcat" || action === "open_acurast") return runRemoteAction(action, serials, action === "wake" ? "Wake screen" : action === "logcat" ? "Logcat" : "Open Acurast");
    if (action === "screenshot") return screenshotWall(serials);
    if (action === "shell") {
      $("#shellCommand").value = "";
      $("#shellDlg").showModal();
      return;
    }
    if (action === "provision") return provisionDevices(serials, serials.length > 3);
    if (action === "update") return confirmUpdate(serials);
    if (action === "reboot") {
      const batch = app.data.batch || { wave_size: 8, wave_delay_sec: 20 };
      const confirmed = await confirmAction({ title: `Reboot ${serials.length} device${serials.length === 1 ? "" : "s"}?`, body: `Eligible devices will reboot in waves of ${batch.wave_size}, ${batch.wave_delay_sec} seconds apart. They will disconnect and then return through wireless ADB.`, phrase: "REBOOT", actionLabel: "Reboot devices" });
      if (!confirmed) return;
      try {
        const result = await api("/api/reboot-batch", { serials, wave_size: batch.wave_size, wave_delay_sec: batch.wave_delay_sec });
        recordAction("Bulk reboot queued", devices);
        toast("Reboot queued", `${result.queued || serials.length} devices will reboot in waves.`);
        app.selected.clear();
        await poll();
      } catch (error) { toast("Reboot failed", error.message, "error"); }
    }
  }

  async function runRemoteAction(action, serials, title, command) {
    const devices = serials.map((serial) => app.devicesById.get(serial)).filter(Boolean);
    try {
      const result = await api("/api/action", { serials, action, command: command || "" });
      showResults(title, result.results || []);
      const failed = (result.results || []).filter((item) => !item.ok).length;
      recordAction(`${title} completed${failed ? ` with ${failed} failure${failed === 1 ? "" : "s"}` : ""}`, devices, failed ? "alert" : "action");
    } catch (error) { toast(`${title} failed`, error.message, "error"); }
  }

  function showResults(title, results) {
    $("#resultsTitle").textContent = title;
    $("#resultsBody").innerHTML = results.length ? results.map((result) => `<article class="result-item ${result.ok ? "" : "failed"}"><header><strong>${escapeHtml(result.serial)}</strong><span>${result.ok ? "Completed" : "Failed"}</span></header><pre>${escapeHtml(result.output || "(no output)")}</pre></article>`).join("") : '<div class="drawer-empty">The backend returned no per-device results.</div>';
    $("#resultsDlg").showModal();
  }

  async function screenshot(serial) {
    const device = app.devicesById.get(serial);
    if (!device) return;
    $("#screenTitle").textContent = `Screen · ${displayName(device)}`;
    $("#screenBody").innerHTML = '<div class="loading-orbit"></div>';
    $("#screenRefresh").onclick = () => screenshot(serial);
    if (!$("#screenDlg").open) $("#screenDlg").showModal();
    try {
      const result = await api("/api/screenshot", { serial });
      if (!result.ok || !result.png) throw new Error(result.message || "Capture failed");
      $("#screenBody").innerHTML = `<img src="data:image/png;base64,${result.png}" alt="Screenshot from ${escapeAttr(displayName(device))}">`;
      recordAction("Screenshot completed", [device]);
    } catch (error) {
      $("#screenBody").innerHTML = `<div class="drawer-empty">${escapeHtml(error.message)}</div>`;
      toast("Screenshot failed", error.message, "error");
    }
  }

  // Compute/earning state from Guardian v1.1.20+ telemetry (computeStatus + computeActive).
  // Older Guardian builds omit both -> fall back to "unknown" rather than implying idle.
  // Any Guardian OTA unbinds the accessibility service fleet-wide (package replace), so a11yHealthy
// goes false on every phone for a few minutes and then recovers on its own. Absence of compute data
// is NOT a usable corroboration -- computeActive is the last known value, which survives the outage.
// What separates a real fault from the normal post-OTA flap is DURATION: Android re-binds within
// minutes, so anything still false after A11Y_DEAD_MIN needs a look (the phone is enabled-but-unbound,
// which the secure-settings self-heal cannot fix because the setting is already correct).
// GATE: v1.1.32 reports a11yHealthy=false on every phone even when dumpsys shows the service in
// "Bound services" and it is receiving events, so the flag is currently stuck-false and cannot be
// alerted on. Set A11Y_TRUSTED=true once Guardian ships a build where the flag returns to true.
const A11Y_TRUSTED = true;   // v1.1.33+: flag validated against dumpsys, true at rest fleet-wide
const A11Y_DEAD_MIN = 15;
function scrapeDead(device) {
  if (!A11Y_TRUSTED) return false;
  if ((device.telemetry || {}).a11yHealthy !== false) return false;
  return (device.a11yFalseMin ?? 0) >= A11Y_DEAD_MIN;
}
function scrapeFlapping(device) {
  return (device.telemetry || {}).a11yHealthy === false && !scrapeDead(device);
}

// Guardian v1.1.35+ reports whether Lite is actually the foreground app, and v1.1.36 made
// it event-driven. Deliberately TRI-state: `targetOnTop === null` means the accessibility
// signal is stale, and that must render as "unknown" rather than as a confident false --
// a wrong-but-confident foreground reading is exactly the failure this field exists to end.
// `topPackage` is only present when something OTHER than Lite holds top, i.e. the thief.
function foregroundPill(device, withPackage) {
  const t = device.telemetry || {};
  if (t.targetOnTop === undefined) return "";
  if (t.targetOnTop === null) {
    return '<span class="fg-pill fg-pill--unknown" title="Accessibility signal is stale, so the foreground state cannot be confirmed. This is not the same as Lite being buried.">◌ unknown</span>';
  }
  if (t.targetOnTop === true) {
    return '<span class="fg-pill fg-pill--on" title="Lite is the foreground app right now.">● Lite on top</span>';
  }
  const thief = t.topPackage ? String(t.topPackage) : "another app";
  const shortThief = thief.length > 26 ? "…" + thief.slice(-25) : thief;
  return `<span class="fg-pill fg-pill--off" title="Lite is not on top. ${escapeAttr(thief)} currently holds the foreground; Guardian reclaims it automatically.">▲ ${withPackage ? escapeHtml(shortThief) : "not on top"}</span>`;
}

// A node sitting on the user-0 hub is NOT computing, no matter what computeStatus says --
// that field is retained across scrape failures, so it can read "Running" indefinitely.
// Rendered only for the true case: this is an exception badge, not a status for every row.
function idleHubBadge(device) {
  if (device.idleHub !== true) return "";
  return '<span class="idle-hub-badge" title="The user-0 Acurast hub is foregrounded instead of the work-profile Processor, so this node is not computing. Someone has to start compute (the &quot;Open Processor to Provide Compute&quot; button), or Guardian has to foreground the work-profile instance.">\u25D3 idle hub</span>';
}

// Guardian counts ANRs but nothing rendered them, so a phone whose app wedges repeatedly
// looked identical to a healthy one -- Guardian dismisses the dialog, the node self-heals,
// and the earning count never dips. Surfaced as an exception badge only.
function anrBadge(device) {
  const n = (device.telemetry || {}).anrSinceBoot;
  if (!n) return "";
  return `<span class="anr-badge" title="${n} ANR${n === 1 ? "" : "s"} since boot. The app's main thread wedged long enough for Android to raise 'isn't responding'. Guardian dismisses the dialog so the node recovers, but each one is lost compute.">\u26A0 ${n} ANR</span>`;
}

// Armed on paper vs the controller's gate actually being open. These disagreed on a real
// phone: telemetry said armed while the gate was shut, so Guardian detected problems and
// silently never acted. protectionEnabled is the controller's own flag (v1.1.42+).
function protectionOff(device) {
  const arm = (device.telemetry || {}).arm || {};
  const on = arm.protectionEnabled ?? arm.protectionRunning;
  return on === false;
}

function formatUptime(ms) {
  const h = Number(ms || 0) / 3600000;
  if (!Number.isFinite(h) || h <= 0) return "—";
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function computeBadge(device) {
    const t = device.telemetry || {};
    const status = t.computeStatus;
    const active = t.computeActive;
    if (status === undefined && active === undefined) {
      // Absent compute fields have two very different causes, and before v1.1.31 they were
      // indistinguishable. a11yHealthy is an independent 20s liveness beat from the accessibility
      // service, so it does not depend on Lite rendering:
      //   a11yHealthy === false -> the a11y service was unbound by the OEM, the scrape is genuinely
      //                            dead. Guardian self-heals by re-binding; if it can't, reboot.
      //   a11yHealthy !== false -> the screensaver is simply hiding Lite. Expected, not a fault.
      // Undefined means the service has never connected on that phone, so we stay quiet.
      if (t.a11yHealthy === false) {
        return '<span class="compute-dead" title="Accessibility service is not alive — the Lite scrape is dead, so compute state is unknown. Guardian re-binds it automatically; if this persists, reboot the phone.">\u2717 scrape dead</span>';
      }
      return '<span class="muted-cell" title="Compute state hidden while the screensaver covers Lite. Accessibility service is alive, so this is expected, not a fault.">\u2014</span>';
    }
    const earning = t.earning;            // v1.1.27+: Running AND heartbeat < 15min
    const hbAge = t.heartbeatAgeMin;
    // "up but stalled": Lite still says Running, but the heartbeat has gone quiet, so the phone
    // earns nothing while looking healthy. This is the case computeActive alone cannot see.
    const stalled = earning === false && active === true;
    const cls = stalled ? "compute-stalled" : active === true ? "compute-on" : "compute-off";
    const dot = stalled ? "\u25D1" : active === true ? "\u25CF" : "\u25CB";
    // "NoDeployments" is the chain's word for "nothing assigned right now" — an ordinary state, not
    // a fault, so it must not read like one. A phone with no job is still Active and heartbeating.
    const noJob = status === "NoDeployments" || active === false;
    const label = stalled ? "Stalled" : active === true ? "On job" : noJob ? "No job" : (status ? String(status) : "Inactive");
    const bits = [status ? `Compute status: ${status}` : "Compute status unknown"];
    if (earning !== undefined) bits.push(`earning: ${earning}`);
    if (hbAge !== undefined && hbAge !== null) bits.push(`heartbeat ${hbAge}m ago`);
    if (stalled) bits.push("UP BUT STALLED \u2014 Running with a stale heartbeat, earning nothing");
    const hb = (hbAge !== undefined && hbAge !== null) ? ` <span class="hb-age">\u2661${hbAge}m</span>` : "";
    return `<span class="${cls}" title="${escapeAttr(bits.join(" \u00b7 "))}">${dot} ${escapeHtml(label)}</span>${hb}`;
  }

  // Pulse fleet-health verdict for this phone (acurastpulse.com benchmark-health, joined by
  // on-chain address). Pulse only returns non-healthy processors, so absence == healthy/unknown.
  function pulseHealthBadge(device) {
    const p = device.pulseHealth;
    if (!p || !p.status) return "";
    const bad = p.status === "investigate";
    const cls = bad ? "pulse-bad" : "pulse-watch";
    const risk = p.risk == null ? "" : ` ${p.risk}`;
    const tip = `Pulse fleet health: ${p.status}${p.risk == null ? "" : ` · risk ${p.risk}`}` +
                (p.lowConfidence ? " · low confidence" : "");
    return `<button type="button" class="${cls} pulse-chip" data-action="filter-pulse" data-pulse="${escapeAttr(p.status)}" title="${escapeAttr(tip + " — click to filter")}">${bad ? "\u25B2" : "\u25B3"} ${escapeHtml(p.status)}${escapeHtml(risk)}</button>`;
  }

  async function screenshotWall(serials) {
    const pageSize = Math.min(app.data.maxWall || 24, 12);
    const total = serials.length;
    const spinner = '<div class="loading-orbit"></div>';
    const tile = (serial, inner) => `<article class="wall-tile" data-wall-serial="${escapeAttr(serial)}"><header>${escapeHtml((app.devicesById.get(serial) || {}).label || serial)}</header>${inner}</article>`;
    $("#wallTitle").textContent = `Screenshot wall · 0 / ${total}`;
    $("#wallBody").innerHTML = serials.map((serial) => tile(serial, spinner)).join("") || '<div class="drawer-empty">No devices selected.</div>';
    $("#wallDlg").showModal();
    let done = 0;
    for (let i = 0; i < serials.length; i += pageSize) {
      const page = serials.slice(i, i + pageSize);
      let results;
      try {
        const result = await api("/api/screenshot-batch", { serials: page });
        results = result.results || page.map((serial) => ({ serial, ok: false }));
      } catch (error) {
        results = page.map((serial) => ({ serial, ok: false, message: error.message }));
      }
      for (const item of results) {
        const el = $("#wallBody").querySelector(`[data-wall-serial="${CSS.escape(item.serial)}"]`);
        if (!el) continue;
        const label = (app.devicesById.get(item.serial) || {}).label || item.serial;
        const body = item.ok
          ? `<img src="data:image/png;base64,${item.png}" data-enlarge-screen="${escapeAttr(item.serial)}" alt="Screenshot from ${escapeAttr(item.serial)}">`
          : '<div class="wall-error">Capture failed</div>';
        const live = app.data.wsScrcpyUrl ? `<footer class="wall-actions"><button type="button" class="button" data-device-action="live" data-serial="${escapeAttr(item.serial)}" title="Live screen">◉ Live</button></footer>` : "";
        el.innerHTML = `<header>${escapeHtml(label)}</header>${body}${live}`;
      }
      done += page.length;
      $("#wallTitle").textContent = done < total ? `Screenshot wall · ${done} / ${total}` : `Screenshot wall · ${total}`;
    }
    recordAction("Screenshot wall completed", serials.map((serial) => app.devicesById.get(serial)).filter(Boolean));
  }

  async function rebootOne(serial) {
    const device = app.devicesById.get(serial);
    if (!device) return;
    const confirmed = await confirmAction({ title: `Reboot ${displayName(device)}?`, body: "The device will disconnect from wireless ADB and should return after Guardian restores connectivity.", actionLabel: "Reboot device" });
    if (!confirmed) return;
    try {
      const result = await api("/api/reboot", { serial });
      if (!result.ok) throw new Error(result.message || "Backend rejected reboot");
      recordAction("Reboot initiated", [device]);
      toast("Reboot initiated", `${displayName(device)} will reconnect automatically.`);
      await poll();
    } catch (error) { toast("Reboot failed", error.message, "error"); }
  }

  async function liveScreen(serial) {
    const device = app.devicesById.get(serial);
    if (!device) return;
    if (app.data.wsScrcpyUrl) {
      // Pre-start the scrcpy server before opening the viewer. On loaded phones the JVM takes
      // >3s to bind 8886 and the viewer raced it, which is why live view worked on some phones
      // and not others. ws-scrcpy finds the running server via `ps` and reuses it.
      const url = `${app.data.wsScrcpyUrl.replace(/\/$/, "")}/#!autostream=${encodeURIComponent(serial)}`;
      // Open the window FIRST, synchronously inside the click handler. Awaiting the pre-warm
      // before opening meant nothing happened on screen for the whole pre-warm (measured: 3s on a
      // cold phone, up to the 12s cap on a loaded one), which read as "live view is super slow".
      // Opening from inside the user gesture also keeps popup blockers happy -- a window.open that
      // happens after an await is no longer gesture-attributed in some browsers.
      const win = window.open("about:blank", "live_" + serial.replace(/[^a-z0-9]/gi, ""), "popup,width=460,height=920,menubar=no,toolbar=no,location=no,status=no");
      if (win) {
        win.focus();
        try {
          win.document.write(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(displayName(device) || serial)} — starting…</title>` +
            `<style>html,body{height:100%;margin:0;background:#0b0f17;color:#94a3b8;` +
            `font:500 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center}` +
            `.b{width:34px;height:34px;border:2px solid #1e293b;border-top-color:#2dd4bf;border-radius:50%;` +
            `animation:s .8s linear infinite;margin:0 auto 14px}@keyframes s{to{transform:rotate(360deg)}}` +
            `small{color:#475569;display:block;margin-top:6px}</style>` +
            `<div style="text-align:center"><div class="b"></div>` +
            `<div>starting stream on ${escapeHtml(displayName(device) || serial)}</div>` +
            `<small>waking the scrcpy server…</small></div>`);
          win.document.close();
        } catch (_) { /* about:blank write can fail under strict popup policies; harmless */ }
      }
      // Pre-warm runs while the placeholder is already on screen, so the perceived wait is the
      // spinner rather than a dead click. ws-scrcpy discovers the running server via `ps`.
      let prepOk = true, prepMsg = "";
      try {
        const prep = await api("/api/live/prep", { serial });
        prepOk = !!prep.ok; prepMsg = prep.message || "";
      } catch (error) {
        prepOk = false; prepMsg = error.message;
      }
      if (!prepOk) toast("Live screen slow to start", prepMsg || "Opening anyway", "error");
      if (win && !win.closed) {
        // replace() so the placeholder does not become a back-history entry
        win.location.replace(url);
      } else if (!win) {
        // popup blocked: fall back to the direct open so the feature still works
        const w2 = window.open(url, "live_" + serial.replace(/[^a-z0-9]/gi, ""), "popup,width=460,height=920");
        if (w2) w2.focus();
      }
      recordAction("Live screen opened", [device]);
    } else {
      const command = `scrcpy -s ${serial}`;
      navigator.clipboard.writeText(command).then(() => toast("scrcpy command copied", command)).catch(() => toast("Live screen unavailable", `Run: ${command}`, "error"));
    }
  }

  async function handleDeviceAction(action, serial) {
    const device = app.devicesById.get(serial);
    if (!device) return;
    if (action === "more") return openDrawer(serial, document.activeElement);
    if (action === "screenshot") return screenshot(serial);
    if (action === "live") return liveScreen(serial);
    if (action === "reboot") return rebootOne(serial);
    if (action === "update") return updateOne(serial);
    if (action === "provision") return provisionDevices([serial], false);
    if (action === "reset-fg") return resetForegroundLosses([serial], false);
    if (action === "pause-15") return pauseDevice(serial, 15);
    if (action === "pause-60") return pauseDevice(serial, 60);
    if (action === "resume") return resumeDevice(serial);
    if (action === "locate") return locateDevice(serial);
    if (action === "locate-stop") return stopLocateDevice(serial);
    if (action === "rename") return openRename(serial);
    if (action === "forget") return forgetDevice(serial);
    if (action === "pulse") return openPulse(serial);
    if (action === "wake" || action === "logcat" || action === "open_acurast") return runRemoteAction(action, [serial], action === "wake" ? "Wake screen" : action === "logcat" ? "Logcat" : "Open Acurast");
    if (action === "shell-one") {
      if (!app.selected.has(serial)) app.selected.add(serial);
      renderBulkDock();
      $("#shellCommand").value = "";
      $("#shellDlg").showModal();
    }
  }

  async function discover(button) {
    setBusy(button, true, "Discovering…");
    try {
      await api("/api/discover");
      addActivity({ type: "action", icon: "⌖", device: "Fleet", message: "mDNS discovery completed", timestamp: Date.now() });
      toast("Discovery complete", "The fleet snapshot has been refreshed.");
      await poll();
    } catch (error) { toast("Discovery failed", error.message, "error"); }
    finally { setBusy(button, false); }
  }

  async function scanVersions(button) {
    setBusy(button, true, "Scanning…");
    try {
      const result = await api("/api/scan-versions");
      addActivity({ type: "action", icon: "↧", device: "Fleet", message: `Version scan completed on ${result.scanned || 0} devices`, timestamp: Date.now() });
      toast("Version scan complete", `${result.scanned || 0} online devices scanned.`);
      await poll();
    } catch (error) { toast("Version scan failed", error.message, "error"); }
    finally { setBusy(button, false); }
  }

  async function guardianReleases(button) {
    setBusy(button, true, "Loading…");
    try {
      const result = await api("/api/guardian/releases", { force: true });
      if (!result.ok) throw new Error(result.message || "Release lookup failed");
      const select = $("#guardianRelease");
      select.innerHTML = '<option value="latest">latest (newest)</option>' + (result.releases || []).map((release) => `<option value="${escapeAttr(release.tag)}">${escapeHtml(release.tag)}${release.prerelease ? " · pre-release" : ""}${release.apkSize ? ` · ${(release.apkSize / 1048576).toFixed(1)} MB` : ""}</option>`).join("");
      toast("Releases refreshed", `${(result.releases || []).length} signed releases available.`);
    } catch (error) { toast("Release lookup failed", error.message, "error"); }
    finally { setBusy(button, false); }
  }

  async function guardianScan(button) {
    setBusy(button, true, "Scanning…");
    try {
      const result = await api("/api/guardian/scan");
      recordAction("Guardian version scan completed", (app.data.devices || []).filter((device) => U.effectiveState(device) === "device"));
      toast("Guardian scan complete", `${result.scanned || 0} online devices scanned.`);
      await poll();
    } catch (error) { toast("Guardian scan failed", error.message, "error"); }
    finally { setBusy(button, false); }
  }

  async function guardianInstall(which) {
    const devices = which === "online"
      ? (app.data.devices || []).filter((device) => U.effectiveState(device) === "device")
      : Array.from(app.selected).map((serial) => app.devicesById.get(serial)).filter((device) => device && U.effectiveState(device) === "device");
    if (!devices.length) return toast("No eligible devices", "Select at least one online device.", "error");
    const tag = $("#guardianRelease").value || "latest";
    const confirmed = await confirmAction({ title: `Install Guardian ${tag}?`, body: `The signed APK will be downloaded and SHA-256 verified once, then installed to ${devices.length} device${devices.length === 1 ? "" : "s"} in backend-controlled waves.`, actionLabel: "Start install", danger: false });
    if (!confirmed) return;
    try {
      const result = await api("/api/guardian/install", { serials: devices.map((device) => device.serial), tag });
      if (!result.ok) throw new Error(result.message || "Install did not start");
      recordAction(`Guardian ${result.tag || tag} install queued`, devices);
      toast("Guardian install queued", `${result.queued || devices.length} devices · SHA ${(result.sha256 || "").slice(0, 12) || "verified by backend"}`);
      await poll();
    } catch (error) { toast("Guardian install failed", error.message, "error"); }
  }

  function onlineSerials(which) {
    if (which === "online") return (app.data.devices || []).filter((device) => U.effectiveState(device) === "device").map((device) => device.serial);
    return Array.from(app.selected).filter((serial) => {
      const device = app.devicesById.get(serial);
      return device && U.effectiveState(device) === "device";
    });
  }

  async function provisionDevices(serials, requirePhrase) {
    if (!serials.length) return toast("No eligible devices", "Provisioning requires an online device.", "error");
    const confirmed = await confirmAction({
      title: `Provision ${serials.length} device${serials.length === 1 ? "" : "s"}?`,
      body: "Grants WRITE_SECURE_SETTINGS, notifications, usage access, overlay, and battery exemptions, then arms Guardian in fleet mode.",
      phrase: requirePhrase || serials.length > 3 ? "ARM" : "",
      actionLabel: "Grant and arm",
      danger: false,
    });
    if (!confirmed) return;
    const devices = serials.map((serial) => app.devicesById.get(serial)).filter(Boolean);
    try {
      const result = await api("/api/guardian/provision", { serials });
      if (!result.ok) throw new Error(result.message || "Provisioning failed");
      const rows = (result.results || []).map((item) => ({ serial: item.serial, ok: item.ok, output: item.armed || "No arm result" }));
      showResults("Provision · grant and arm", rows);
      const ok = rows.filter((item) => item.ok).length;
      recordAction(`Provision completed · ${ok}/${serials.length} armed`, devices, ok === serials.length ? "action" : "alert");
      toast("Provision completed", `${ok} of ${serials.length} devices confirmed armed.`, ok === serials.length ? "" : "error");
      await poll();
    } catch (error) { toast("Provision failed", error.message, "error"); }
  }

  async function resetForegroundLosses(serials, fleetWide) {
    if (!serials.length) return toast("No eligible devices", "No online phones are available.", "error");
    const confirmed = await confirmAction({ title: `Reset foreground-loss counters?`, body: `Reset lifetime and since-boot counters on ${serials.length} device${serials.length === 1 ? "" : "s"}.`, actionLabel: "Reset counters", danger: false });
    if (!confirmed) return;
    try {
      const result = await api("/api/guardian/reset-fg", { serials });
      if (!result.ok) throw new Error(result.message || "Reset failed");
      // This is a partial-success surface: "12 of 76" gave no way to see WHICH 64 missed.
      toast(
        "FG counters reset",
        `${result.reset || 0} of ${result.total || serials.length} devices reset.`,
        (result.reset || 0) < (result.total || serials.length) ? "error" : "",
        Array.isArray(result.results) && result.results.length
          ? { label: "View results", onClick: () => showResults("Reset FG losses", result.results) }
          : null
      );
      recordAction("Foreground-loss counters reset", serials.map((serial) => app.devicesById.get(serial)).filter(Boolean));
      await poll();
      if (!fleetWide && serials.length === 1 && app.drawerSerial === serials[0]) renderDrawer(serials[0]);
    } catch (error) { toast("FG reset failed", error.message, "error"); }
  }

  async function locateDevice(serial) {
    const device = app.devicesById.get(serial);
    try {
      const result = await api("/api/guardian/locate", { serials: [serial], seconds: 120 });
      if (!result.ok) throw new Error(result.message || "Locate failed");
      toast("\uD83D\uDCCD Locating", `${device ? displayName(device) : serial} \u2014 beacon on for 120s (alarm + red overlay). Tap Stop to silence.`);
      recordAction("Locate beacon started", [device].filter(Boolean));
    } catch (error) { toast("Locate failed", error.message, "error"); }
  }

  async function stopLocateDevice(serial) {
    const device = app.devicesById.get(serial);
    try {
      const result = await api("/api/guardian/locate", { serials: [serial], stop: true });
      if (!result.ok) throw new Error(result.message || "Stop failed");
      toast("Locate stopped", `${device ? displayName(device) : serial} beacon silenced.`);
      recordAction("Locate beacon stopped", [device].filter(Boolean));
    } catch (error) { toast("Stop failed", error.message, "error"); }
  }

  // Guardian v1.1.46+ only; older builds ignore the broadcast and the result reports ok:false,
  // which is why the toast names the phone rather than claiming a fleet-wide success.
  async function pauseDevice(serial, minutes) {
    const device = app.devicesById.get(serial);
    try {
      const result = await api("/api/guardian/maintenance", { serials: [serial], enter: true, minutes });
      if (!result.ok) throw new Error(result.message || "Pause failed");
      if (!result.applied) throw new Error("Guardian did not confirm — is this phone on v1.1.46+?");
      toast("Maintenance on", `${device ? displayName(device) : serial} paused for ${minutes} min. Recovery will not fight you.`);
      recordAction(`Maintenance ${minutes}m`, [device].filter(Boolean));
      await poll();
    } catch (error) { toast("Pause failed", error.message, "error"); }
  }

  async function resumeDevice(serial) {
    const device = app.devicesById.get(serial);
    try {
      const result = await api("/api/guardian/maintenance", { serials: [serial], enter: false });
      if (!result.ok) throw new Error(result.message || "Resume failed");
      if (!result.applied) throw new Error("Guardian did not confirm — is this phone on v1.1.46+?");
      toast("Protection resumed", `${device ? displayName(device) : serial} is protecting again.`);
      recordAction("Maintenance ended", [device].filter(Boolean));
      await poll();
    } catch (error) { toast("Resume failed", error.message, "error"); }
  }

  async function toggleScreensaver() {
    const btn = $("#screensaverButton");
    const current = Boolean(app.data.guardian && app.data.guardian.screensaver && app.data.guardian.screensaver.enabled);
    const next = !current;
    if (btn) { btn.disabled = true; btn.textContent = next ? "Screensaver · turning on…" : "Screensaver · turning off…"; }
    try {
      const result = await api("/api/guardian/screensaver", { enabled: next });
      if (!result.ok) throw new Error(result.message || "Screensaver toggle failed");
      toast(next ? "Screensaver on" : "Screensaver off",
            `${result.applied || 0} of ${result.total || 0} phones acknowledged.`);
      recordAction(next ? "Black screensaver enabled" : "Black screensaver disabled", []);
      await poll();
    } catch (error) {
      toast("Screensaver toggle failed", error.message, "error");
    } finally {
      if (btn) btn.disabled = false;
      renderScreensaverButton();
    }
  }

  // Keep the APK download link pointed at whichever release is selected in the dropdown, so
  // "Download APK" and "Install selected" always hand out the same build.
  function syncApkDownloadLink() {
    const link = $("#apkDownload");
    const sel = $("#guardianRelease");
    if (!link) return;
    const tag = (sel && sel.value) || "latest";
    link.href = `/guardian.apk?tag=${encodeURIComponent(tag)}`;
    link.textContent = `\u2B07 Download APK${tag && tag !== "latest" ? ` (${tag})` : ""}`;
  }

  function renderScreensaverButton() {
    const btn = $("#screensaverButton");
    if (!btn) return;
    const ss = (app.data.guardian && app.data.guardian.screensaver) || {};
    const on = Boolean(ss.enabled);
    btn.textContent = `Screensaver · ${on ? "on" : "off"}`;
    btn.classList.toggle("primary", on);
  }

  async function toggleKeepLite() {
    const current = Boolean(app.data.guardian && app.data.guardian.keepLite && app.data.guardian.keepLite.enabled);
    try {
      const result = await api("/api/guardian/keep-lite", { enabled: !current });
      if (!result.ok) throw new Error(result.message || "Keep-Lite update failed");
      const state = result.keepLite || {};
      toast("Keep-Lite updated", state.enabled ? `Fallback enabled · every ${Math.round((state.interval || 300) / 60)} minutes.` : "Fallback disabled; Guardian remains the foreground authority.");
      await poll();
    } catch (error) { toast("Keep-Lite failed", error.message, "error"); }
  }

  function showReadiness() {
    const readiness = (app.data.guardian && app.data.guardian.readiness) || {};
    const body = $("#readinessBody");
    if (!readiness.reporting) {
      body.innerHTML = '<div class="drawer-empty">No Guardian arm telemetry has been reported yet.</div>';
    } else {
      const missing = Object.entries(readiness.missingByFlag || {}).sort((a, b) => b[1] - a[1]);
      body.innerHTML = `<div class="readiness-summary"><div><span>Reporting</span><strong>${readiness.reporting}</strong></div><div><span>Fully armed</span><strong style="color:var(--green)">${readiness.ready || 0}</strong></div><div><span>Degraded</span><strong style="color:${readiness.degraded ? "var(--amber)" : "var(--green)"}">${readiness.degraded || 0}</strong></div></div>
        ${missing.length ? `<div class="analytics-heading">Missing grant totals</div><div class="filter-chips" style="padding:0;border:0;background:none">${missing.map(([flag, count]) => `<span class="filter-chip">${escapeHtml(flag)} · ${count}</span>`).join("")}</div>` : ""}
        <div class="analytics-heading">Affected devices</div>${(readiness.degradedDevices || []).length ? readiness.degradedDevices.map((device) => `<div class="readiness-device"><strong>${escapeHtml(displayName(device))}</strong><span>${escapeHtml((device.missing || []).join(", "))}</span></div>`).join("") : '<div class="drawer-empty">All reporting devices are fully armed.</div>'}`;
    }
    $("#readinessDlg").showModal();
  }

  async function checkUpdates(button) {
    setBusy(button, true, "Checking…");
    try {
      const result = await api("/api/update-check", {});
      if (result.ok === false) throw new Error(result.message || "Release check failed");
      toast("Update check started", "Release metadata and signing verification are refreshing.");
      setTimeout(poll, 1500);
    } catch (error) { toast("Update check failed", error.message, "error"); }
    finally { setTimeout(() => setBusy(button, false), 2400); }
  }

  async function confirmUpdate(serials) {
    const release = app.data.release || {};
    if (!release.ready) return toast("Update not ready", "Run Check now and wait for signature verification.", "error");
    const eligible = serials.map((serial) => app.devicesById.get(serial)).filter((device) => device && device.updateAvailable && U.effectiveState(device) === "device");
    if (!eligible.length) return toast("No eligible devices", "Select one or more online outdated devices.", "error");
    const batch = app.data.updateBatch || { wave_size: 4, wave_delay_sec: 15 };
    const confirmed = await confirmAction({ title: `Update ${eligible.length} device${eligible.length === 1 ? "" : "s"} → ${release.versionName}?`, body: `Installs ${release.assetName || "the verified Lite APK"} in waves of ${batch.wave_size}, ${batch.wave_delay_sec} seconds apart. Each processor briefly restarts and self-recovers.`, phrase: "UPDATE", actionLabel: "Push update", danger: false });
    if (!confirmed) return;
    try {
      const result = await api("/api/update-batch", { serials: eligible.map((device) => device.serial), wave_size: batch.wave_size, wave_delay_sec: batch.wave_delay_sec });
      if (result.ok === false) throw new Error(result.message || "Update did not start");
      recordAction(`Lite ${release.versionName} update queued`, eligible);
      toast("Update queued", `${eligible.length} devices will update in controlled waves.`);
      app.selected.clear();
      await poll();
    } catch (error) { toast("Update failed", error.message, "error"); }
  }

  async function updateOne(serial) {
    const device = app.devicesById.get(serial);
    const release = app.data.release || {};
    if (!device || !device.updateAvailable) return;
    if (!release.ready) return toast("Update not ready", "The signed release has not finished verification.", "error");
    const confirmed = await confirmAction({ title: `Update ${displayName(device)} → ${release.versionName}?`, body: "The verified Lite APK will be installed with adb install -r. The processor restarts and self-recovers.", actionLabel: "Update device", danger: false });
    if (!confirmed) return;
    try {
      const result = await api("/api/update", { serial });
      if (result.ok === false) throw new Error(result.message || "Update failed");
      if (result.result) showResults(`Update → ${release.versionName}`, [result.result]);
      recordAction(`Lite ${release.versionName} update started`, [device]);
      await poll();
    } catch (error) { toast("Update failed", error.message, "error"); }
  }

  function openRename(serial) {
    const device = app.devicesById.get(serial);
    if (!device) return;
    $("#renameSerial").value = serial;
    $("#renameAlias").value = device.alias || "";
    $("#renameDlg").showModal();
    requestAnimationFrame(() => $("#renameAlias").focus());
  }

  async function forgetDevice(serial) {
    const device = app.devicesById.get(serial);
    if (!device) return;
    const confirmed = await confirmAction({ title: `Forget ${displayName(device)}?`, body: "Removes it from the fleet and drops its ADB transport. A still-online mDNS device may appear again on the next scan.", phrase: "FORGET", actionLabel: "Forget device" });
    if (!confirmed) return;
    try {
      const result = await api("/api/forget", { serial });
      if (result.ok === false) throw new Error(result.message || "Forget failed");
      app.selected.delete(serial);
      closeDrawer();
      toast("Device forgotten", displayName(device));
      await poll();
    } catch (error) { toast("Forget failed", error.message, "error"); }
  }

  function openPulse(serial) {
    const device = app.devicesById.get(serial);
    if (!device || !device.address) return;
    window.open(`https://www.acurastpulse.com/processors/${encodeURIComponent(device.address)}`, "_blank", "noopener");
  }

  async function openOnboard() {
    $("#pairingHost").value = "";
    $("#pairingCode").value = "";
    $("#onboardLog").textContent = "";
    $("#onboardLog").hidden = true;
    $("#onboardDlg").showModal();
    await loadPairingDevices();
  }

  async function loadPairingDevices(button) {
    setBusy(button, true, "Scanning…");
    const list = $("#pairingList");
    list.innerHTML = '<div class="drawer-empty">Scanning for pairing-mode phones…</div>';
    try {
      const result = await api("/api/pairing-devices", {});
      if (result.ok === false) throw new Error(result.message || "Pairing scan failed");
      const devices = result.devices || [];
      list.innerHTML = devices.length ? devices.map((device) => `<button class="pairing-item" type="button" data-pairing-host="${escapeAttr(device.host)}"><i></i><div><strong>${escapeHtml(device.ip || device.host)}</strong><span>${escapeHtml(device.model || device.label || device.serial || "Pairing-mode device")}</span></div><span>${escapeHtml(device.host)}</span></button>`).join("") : '<div class="drawer-empty">None detected. On the phone, leave “Pair device with pairing code” open and refresh.</div>';
    } catch (error) {
      list.innerHTML = `<div class="drawer-empty">${escapeHtml(error.message)}</div>`;
    } finally { setBusy(button, false); }
  }

  function onboardLog(message) {
    const log = $("#onboardLog");
    log.hidden = false;
    log.textContent += `${message}\n`;
    log.scrollTop = log.scrollHeight;
  }

  async function runOnboarding() {
    const host = $("#pairingHost").value.trim();
    const code = $("#pairingCode").value.trim();
    const full = $("#onboardFull").checked;
    if (!host || !/^\d{6}$/.test(code)) return toast("Pairing details required", "Enter the IP:port and six-digit code shown on the phone.", "error");
    const button = $("#onboardSubmit");
    setBusy(button, true, "Onboarding…");
    $("#onboardLog").textContent = "";
    const before = new Set((app.data.devices || []).filter((device) => U.effectiveState(device) === "device").map((device) => device.serial));
    try {
      onboardLog(`Pairing ${host}…`);
      const paired = await api("/api/pair", { host, code });
      if (!paired.ok) throw new Error(paired.message || "Pairing failed");
      onboardLog(`✓ ${paired.message || "Paired"}`);
      if (!full) {
        onboardLog("Waiting for mDNS discovery. Install and provision it from the Guardian workflow after it appears.");
        await poll();
        return;
      }
      onboardLog("Waiting for the new mDNS transport…");
      let serial = null;
      for (let attempt = 0; attempt < 24 && $("#onboardDlg").open; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await poll();
        const fresh = (app.data.devices || []).find((device) => U.effectiveState(device) === "device" && !before.has(device.serial));
        if (fresh) { serial = fresh.serial; onboardLog(`✓ Connected · ${displayName(fresh)}`); break; }
      }
      if (!serial) { onboardLog("⚠ The phone did not appear within 60 seconds. Check the fleet table, then install and provision manually."); return; }
      const tag = $("#guardianRelease").value || "latest";
      onboardLog(`Installing Guardian ${tag} · verifying SHA-256 and signing certificate…`);
      const install = await api("/api/guardian/install", { serials: [serial], tag });
      if (!install.ok) throw new Error(install.message || "Guardian install did not start");
      for (let attempt = 0; attempt < 30 && $("#onboardDlg").open; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await poll();
        if (!(app.data.guardian && app.data.guardian.job && app.data.guardian.job.active)) break;
      }
      onboardLog("✓ Guardian installed. Granting permissions and arming…");
      const provisioned = await api("/api/guardian/provision", { serials: [serial] });
      const result = (provisioned.results || [])[0] || {};
      if (!result.ok) throw new Error(result.armed || "Provisioning did not confirm armed state");
      onboardLog(`✓ ${result.armed}`);
      onboardLog("✓ Onboarding complete. Wireless ADB and Processor recovery are armed.");
      recordAction("Phone onboarded and armed", [app.devicesById.get(serial)].filter(Boolean));
      toast("Phone onboarded", result.armed || "Guardian confirmed armed.");
      await poll();
    } catch (error) {
      onboardLog(`✗ ${error.message}`);
      toast("Onboarding stopped", error.message, "error");
    } finally { setBusy(button, false); }
  }

  async function openDebloat() {
    app.debloatSelected.clear();
    $("#debloatProgress").textContent = "";
    $("#debloatDlg").showModal();
    await loadDebloatReport();
  }

  async function loadDebloatReport(button) {
    setBusy(button, true, "Loading…");
    $("#debloatStatus").textContent = "Loading package inventory…";
    try {
      const result = await api("/api/debloat/report", {});
      if (!result.ok) throw new Error(result.message || "Inventory request failed");
      app.debloatReport = result;
      $("#debloatStatus").innerHTML = result.reporting
        ? `${result.reporting} phones reporting · ${(result.variants || []).length} hardware variants. Firmware-specific packages require a per-build rollout; protected packages remain locked.`
        : "No package inventory yet. Guardian v1.1.7+ reports it on the next throttled telemetry tick.";
      renderDebloatReport();
    } catch (error) {
      $("#debloatStatus").textContent = `Report error · ${error.message}`;
      $("#debloatReport").innerHTML = '<div class="drawer-empty">Package inventory unavailable.</div>';
    } finally { setBusy(button, false); }
  }

  // One definition of "currently shown", shared by the renderer and the select-all
  // buttons -- if they drifted, Select all would tick packages the operator cannot see.
  function debloatKeepFn(view) {
    return (item) => {
      if (!item.guardable) return false;          // never select guard-protected packages
      if (view === "all") return true;
      if (view === "candidates") return item.goodCandidate;
      return item.goodCandidate && item.universal;   // "safe"
    };
  }

  function debloatSelectAllShown(select) {
    const view = ($("#debloatView") && $("#debloatView").value) || "safe";
    const keep = debloatKeepFn(view);
    let n = 0;
    (app.debloatReport.variants || []).forEach((v) => (v.packages || []).forEach((p) => {
      if (!keep(p)) return;
      if (select) app.debloatSelected.add(p.pkg); else app.debloatSelected.delete(p.pkg);
      n += 1;
    }));
    renderDebloatReport();
    if (select) {
      const partial = [];
      (app.debloatReport.variants || []).forEach((v) => (v.packages || []).forEach((p) => {
        if (keep(p) && !p.universal && app.debloatSelected.has(p.pkg)) partial.push(p.pkg);
      }));
      toast("Selected", `${app.debloatSelected.size} package(s) across all variants${partial.length ? ` · ${partial.length} are not on every phone in their variant` : ""}`,
            partial.length ? "error" : "");
    }
    return n;
  }

  function renderDebloatReport() {
    // The backend already computes the answer: `goodCandidate && universal` is the set that
    // is safe to wave across a whole variant. Showing all ~3,950 rows and expecting the
    // operator to rediscover that was the usability problem -- the signal existed, it just
    // was not reachable from the UI.
    const view = ($("#debloatView") && $("#debloatView").value) || "safe";
    const variants = app.debloatReport.variants || [];
    const showBlocked = view === "all";
    $("#debloatSelectedCount").textContent = `${app.debloatSelected.size} selected`;
    if (!variants.length) {
      $("#debloatReport").innerHTML = '<div class="drawer-empty" style="margin:25px">Nothing to show yet.</div>';
      return;
    }
    const keep = debloatKeepFn(view);

    $("#debloatReport").innerHTML = variants.map((variant, variantIndex) => {
      const all = variant.packages || [];
      const packages = all.filter((p) => keep(p) || (showBlocked && !p.guardable));
      const blocked = all.filter((p) => !p.guardable).length;
      const phones = variant.phones || 0;
      const partial = packages.filter((p) => !p.universal).length;
      const buildText = (variant.builds || []).map((build) => `${build.build} · ${build.phones}`).join(" · ");
      return `<section class="debloat-variant">
        <header class="variant-header">
          <strong>${escapeHtml(variant.model || "Unknown model")}${variant.codename ? ` · ${escapeHtml(variant.codename)}` : ""}</strong>
          <span>${phones} phone${phones === 1 ? "" : "s"} · showing ${packages.length} of ${all.length}${blocked ? ` · ${blocked} guard-protected` : ""}</span>
          <button class="button" type="button" data-debloat-variant="${variantIndex}">Select these ${packages.length}</button>
        </header>
        ${variant.multiBuild ? `<div class="build-warning">${(variant.builds || []).length} firmware builds on this variant · ${escapeHtml(buildText)}. A package missing from any build is firmware-specific — check its coverage badge before waving it.</div>` : ""}
        ${partial ? `<div class="build-warning build-warning--soft">${partial} of the packages shown are not on every phone in this variant.</div>` : ""}
        ${packages.map((item) => {
          const checked = app.debloatSelected.has(item.pkg);
          const cov = `${item.installs || 0}/${phones}`;
          const covTitle = item.byBuild
            ? "Per firmware build:\n" + Object.entries(item.byBuild).map(([b, n]) => `${b}: ${n}`).join("\n")
            : "";
          const badges = `<span class="package-badges"><i>${item.system ? "system" : "3rd-party"}</i>${item.updatable ? "<i>updatable</i>" : ""}${item.goodCandidate ? '<i class="candidate">candidate</i>' : ""}</span>`;
          if (!item.guardable) {
            return `<div class="package-row blocked" title="${escapeAttr(item.reason || "Protected by guard")}"><span>\u{1F512}</span><code>${escapeHtml(item.pkg)}</code>${badges}<small>${escapeHtml(item.reason || "Protected")}</small></div>`;
          }
          return `<label class="package-row"><input type="checkbox" data-debloat-package="${escapeAttr(item.pkg)}" ${checked ? "checked" : ""}><code>${escapeHtml(item.pkg)}</code>${badges}<small class="cov ${item.universal ? "cov-full" : "cov-partial"}" title="${escapeAttr(covTitle)}">${cov}${item.universal ? "" : " partial"}</small></label>`;
        }).join("") || '<div class="drawer-empty" style="margin:14px">Nothing matches this view for this variant.</div>'}
      </section>`;
    }).join("");
  }

  function debloatTargets() {
    if ($("#debloatTarget").value === "selected") return Array.from(app.selected).filter((serial) => {
      const device = app.devicesById.get(serial);
      return device && U.effectiveState(device) === "device";
    });
    return (app.data.devices || []).filter((device) => U.effectiveState(device) === "device").map((device) => device.serial);
  }

  async function previewDebloat() {
    const packages = Array.from(app.debloatSelected);
    if (!packages.length) return toast("No packages selected", "Select at least one guardable package.", "error");
    try {
      const result = await api("/api/debloat/preview", { serials: debloatTargets(), packages });
      if (!result.ok) throw new Error(result.message || "Preview failed");
      showResults("Debloat guard preview", (result.preview || []).map((item) => ({ serial: item.pkg, ok: item.allowed, output: item.allowed ? "Allowed by backend guard" : item.reason || "Blocked" })));
    } catch (error) { toast("Debloat preview failed", error.message, "error"); }
  }

  async function applyDebloat() {
    const packages = Array.from(app.debloatSelected);
    const serials = debloatTargets();
    const method = $("#debloatMethod").value;
    if (!packages.length) return toast("No packages selected", "Select at least one guardable package.", "error");
    if (!serials.length) return toast("No target devices", "Choose online or selected devices.", "error");
    // Spell out the blast radius, and call out partial-coverage packages by name -- those
    // are the firmware-specific ones that are unsafe to wave across a whole variant.
    // Bloat differs per variant -- that is why the report groups by codename. Firing one
    // variant's list at the whole fleet is mostly no-ops on the other models, which is how
    // a run ends up looking half-failed. Warn before it happens.
    const variantsOf = new Map();          // variant -> serials
    const pkgVariants = new Set();
    (app.debloatReport.variants || []).forEach((v) => {
      variantsOf.set(v.codename || v.model, new Set(v.serials || []));
      (v.packages || []).forEach((p) => { if (app.debloatSelected.has(p.pkg)) pkgVariants.add(v.codename || v.model); });
    });
    const covered = new Set();
    pkgVariants.forEach((k) => (variantsOf.get(k) || new Set()).forEach((sn) => covered.add(sn)));
    const offVariant = serials.filter((sn) => !covered.has(sn)).length;

    const partials = [];
    (app.debloatReport.variants || []).forEach((v) => (v.packages || []).forEach((p) => {
      if (app.debloatSelected.has(p.pkg) && !p.universal) partials.push(`${p.pkg} (${p.installs || 0}/${v.phones || 0})`);
    }));
    const confirmed = await confirmAction({
      title: `${method === "disable" ? "Disable" : "Uninstall"} ${packages.length} package${packages.length === 1 ? "" : "s"} on ${serials.length} phone${serials.length === 1 ? "" : "s"}?`,
      body: `${packages.length} \u00d7 ${serials.length} = up to ${packages.length * serials.length} operations, user 0 only. The backend guard refuses protected packages and records every change so Restore can undo it.`
        + (offVariant ? `\n\n${offVariant} of the ${serials.length} targeted phones are NOT in the variant(s) these packages came from (${Array.from(pkgVariants).join(", ") || "unknown"}). Those phones will mostly skip -- the packages simply are not on that model. Use "Select these N" on a variant, or set Target to Selected devices, to aim precisely.` : "")
        + (partials.length ? `\n\nWARNING: ${partials.length} selected package(s) are NOT on every phone in their variant, so this is firmware-specific:\n` + partials.slice(0, 8).join("\n") + (partials.length > 8 ? `\n...and ${partials.length - 8} more` : "") : ""),
      phrase: "DEBLOAT", actionLabel: "Apply debloat" });
    if (!confirmed) return;
    try {
      const result = await api("/api/debloat/apply", { serials, packages, method });
      if (!result.ok) throw new Error(result.message || "Debloat did not start");
      $("#debloatProgress").textContent = `Queued ${result.queued || serials.length} phones · ${result.packages || packages.length} packages · ${method}${result.blocked && result.blocked.length ? ` · ${result.blocked.length} blocked` : ""}`;
      recordAction(`Debloat ${method} queued`, serials.map((serial) => app.devicesById.get(serial)).filter(Boolean));
      await poll();
    } catch (error) { toast("Debloat failed", error.message, "error"); }
  }

  async function restoreDebloat() {
    const serials = debloatTargets();
    if (!serials.length) return toast("No target devices", "Choose online or selected devices.", "error");
    const confirmed = await confirmAction({ title: "Restore recorded packages?", body: `Re-enables or reinstalls every package recorded by the console on ${serials.length} devices.`, actionLabel: "Restore packages", danger: false });
    if (!confirmed) return;
    try {
      const result = await api("/api/debloat/restore", { serials });
      if (!result.ok) throw new Error(result.message || "Restore did not start");
      $("#debloatProgress").textContent = `Restore queued · ${result.queued || serials.length} phones`;
      recordAction("Debloat restore queued", serials.map((serial) => app.devicesById.get(serial)).filter(Boolean));
      await poll();
    } catch (error) { toast("Restore failed", error.message, "error"); }
  }

  function renderDebloatProgress() {
    const job = (app.data.debloat && app.data.debloat.job) || {};
    const element = $("#debloatProgress");
    if (!element || !job.total) return;
    // "Package not installed on this model" is a skip, not a failure. Counting it as a
    // failure made a clean run read as half-broken and taught the operator to ignore the
    // failure column -- which is exactly when it stops being useful.
    const bits = [`${job.done || 0}/${job.total} phones`, `${job.ok || 0} applied`];
    if (job.skipped) bits.push(`${job.skipped} skipped (not on that model)`);
    if (job.failed) bits.push(`${job.failed} failed`);
    if (job.blocked) bits.push(`${job.blocked} blocked by guard`);
    element.textContent = `${job.active ? "Running" : "Completed"} · ${job.op || "debloat"} · ${bits.join(" · ")}`;
  }

  const ANALYTICS_RANGES = [6, 24, 72, 168];
  const CHART_COLORS = ["#22d3bb", "#67a8ff", "#f2bb55", "#a98bff", "#ff8c69", "#54d89a"];

  function temperatureColor(value) {
    if (value == null) return "#71838d";
    if (value < 38) return "#54d89a";
    if (value < 48) return "#f2bb55";
    if (value < 58) return "#ff9f63";
    return "#ff716a";
  }

  async function fetchHistory(hours) {
    const key = String(hours || 6);
    const cached = app.historyCache.get(key);
    if (cached && Date.now() - cached.timestamp < 30_000) return cached.data;
    const response = await fetch(`/api/thermal-history?hours=${encodeURIComponent(key)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`History request failed (${response.status})`);
    const data = await response.json();
    app.historyCache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  function historyRows(values, fields) {
    return (values || []).map((row) => Object.fromEntries((fields || []).map((field, index) => [field, row[index]])));
  }

  function chartSvg(series, field, unit, height) {
    const width = 920;
    const h = height || 230;
    const padding = { left: 42, right: 105, top: 15, bottom: 25 };
    const points = series.flatMap((item) => item.rows.filter((row) => row.ts != null && row[field] != null).map((row) => ({ ts: Number(row.ts), value: Number(row[field]) })));
    if (points.length < 2) return '<div class="drawer-empty">Trend builds after two probe cycles.</div>';
    const minTime = Math.min(...points.map((point) => point.ts));
    const maxTime = Math.max(...points.map((point) => point.ts));
    let minValue = Math.min(...points.map((point) => point.value));
    let maxValue = Math.max(...points.map((point) => point.value));
    if (field === "level") { minValue = 0; maxValue = 100; }
    if (maxValue - minValue < 5) { minValue -= 2.5; maxValue += 2.5; }
    const x = (value) => padding.left + (value - minTime) / Math.max(1, maxTime - minTime) * (width - padding.left - padding.right);
    const y = (value) => padding.top + (1 - (value - minValue) / (maxValue - minValue)) * (h - padding.top - padding.bottom);
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = minValue + (maxValue - minValue) * index / 4;
      const gy = y(value);
      return `<line x1="${padding.left}" y1="${gy}" x2="${width - padding.right}" y2="${gy}" stroke="rgba(129,174,198,.09)"/><text x="${padding.left - 7}" y="${gy + 3}" text-anchor="end" fill="#71838d" font-size="9">${Math.round(value)}${unit}</text>`;
    }).join("");
    const lines = series.slice(0, 6).map((item, index) => {
      const values = item.rows.filter((row) => row.ts != null && row[field] != null);
      if (values.length < 2) return "";
      const color = CHART_COLORS[index % CHART_COLORS.length];
      const polyline = values.map((row) => `${x(Number(row.ts)).toFixed(1)},${y(Number(row[field])).toFixed(1)}`).join(" ");
      const last = values[values.length - 1];
      return `<polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${x(Number(last.ts))}" cy="${y(Number(last[field]))}" r="3" fill="${color}"/><text x="${width - padding.right + 8}" y="${y(Number(last[field])) + 3}" fill="${color}" font-size="9">${escapeHtml(item.label).slice(0, 17)} · ${Math.round(Number(last[field]))}${unit}</text>`;
    }).join("");
    return `<div class="chart-card"><svg viewBox="0 0 ${width} ${h}" role="img" aria-label="${escapeAttr(field)} trend chart">${grid}${lines}<text x="${padding.left}" y="${h - 5}" fill="#71838d" font-size="9">${new Date(minTime * 1000).toLocaleString()}</text><text x="${width - padding.right}" y="${h - 5}" text-anchor="end" fill="#71838d" font-size="9">now</text></svg><div class="chart-legend">${series.slice(0, 6).map((item, index) => `<span><i style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></i>${escapeHtml(item.label)}</span>`).join("")}</div></div>`;
  }

  async function openAnalytics(model, hours) {
    app.analyticsModel = typeof model === "string" && model ? model : null;
    app.analyticsSerial = null;
    app.analyticsHours = hours || app.analyticsHours || 6;
    const dialog = $("#analyticsDlg");
    if (!dialog.open) dialog.showModal();
    $("#analyticsTitle").textContent = app.analyticsModel ? `Fleet analytics · ${app.analyticsModel}` : "Fleet analytics";
    markActive($$('[data-analytics-hours]'), (button) => Number(button.dataset.analyticsHours) === app.analyticsHours);
    $("#analyticsBody").innerHTML = '<div class="loading-orbit"></div>';
    try {
      const history = await fetchHistory(app.analyticsHours);
      renderAnalytics(history);
    } catch (error) {
      $("#analyticsBody").innerHTML = `<div class="drawer-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  function renderAnalytics(history) {
    const fields = history.fields || [];
    const matchesModel = (serial) => {
      if (app.analyticsSerial) return serial === app.analyticsSerial;
      if (!app.analyticsModel) return true;
      const device = app.devicesById.get(serial);
      return device && displayModel(device).toLowerCase() === app.analyticsModel.toLowerCase();
    };
    const series = Object.entries(history.history || {}).filter(([serial]) => matchesModel(serial)).map(([serial, rows]) => ({
      serial,
      label: displayName(app.devicesById.get(serial) || { serial }),
      rows: historyRows(rows, fields),
    })).filter((item) => item.rows.length >= 2).sort((a, b) => Number((b.rows.at(-1) || {}).cpuTemp || 0) - Number((a.rows.at(-1) || {}).cpuTemp || 0));
    const live = (app.data.devices || []).filter((device) => !app.analyticsModel || displayModel(device).toLowerCase() === app.analyticsModel.toLowerCase()).map((device) => ({ device, value: U.temperatureValue(device) })).filter((item) => item.value != null).sort((a, b) => b.value - a.value);
    const average = live.length ? live.reduce((sum, item) => sum + item.value, 0) / live.length : null;
    const throttling = (app.data.devices || []).filter((device) => device.metrics && device.metrics.throttle && device.metrics.throttle.level > 0).length;
    $("#analyticsBody").innerHTML = `<div class="analytics-summary"><div><span>Reporting</span><strong>${live.length}</strong></div><div><span>Average temp</span><strong>${formatMetric(average, "°C", 1)}</strong></div><div><span>Hottest</span><strong style="color:${temperatureColor(live[0] && live[0].value)}">${live[0] ? `${live[0].value.toFixed(1)}°C` : "—"}</strong></div><div><span>Throttling</span><strong style="color:${throttling ? "var(--red)" : "var(--green)"}">${throttling}</strong></div></div>
      <div class="analytics-heading">Live CPU heatmap · select a device for history</div><div class="thermal-map">${live.map((item) => `<button class="thermal-tile" type="button" data-analytics-serial="${escapeAttr(item.device.serial)}" style="background:${temperatureColor(item.value)}"><strong>${escapeHtml(displayName(item.device))}</strong><span>${item.value.toFixed(1)}°</span></button>`).join("") || '<div class="drawer-empty">No live thermal probes are reporting.</div>'}</div>
      <div class="analytics-heading">CPU temperature · hottest six devices</div>${chartSvg(series, "cpuTemp", "°", 240)}
      <div class="analytics-heading">CPU load · same devices</div>${chartSvg(series, "loadPct", "%", 190)}
      <div class="analytics-heading">Battery level · same devices</div>${chartSvg(series, "level", "%", 190)}
      <p class="panel-note" style="margin-top:12px">${history.pollSeconds || 45}s probe cadence · ${history.retentionDays || 7}-day retention · real backend history only</p>`;
  }

  async function renderDrawerHistory(serial) {
    const container = $("#drawerHistory");
    if (!container) return;
    try {
      const history = await fetchHistory(24);
      if (app.drawerSerial !== serial || !$("#drawerHistory")) return;
      const rows = historyRows((history.history || {})[serial], history.fields || []);
      const device = app.devicesById.get(serial);
      $("#drawerHistory").innerHTML = chartSvg([{ serial, label: displayName(device || { serial }), rows }], "cpuTemp", "°", 170);
    } catch (error) {
      if ($("#drawerHistory")) $("#drawerHistory").innerHTML = `<div class="drawer-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
  }

  const debouncedSearch = debounce((value) => setQuery(value), 180);

  // ---------------------------------------------------------------- command palette
  // 76 devices x 16 per-device actions is far too much to enumerate, so the palette is
  // two-tier: global commands always, plus per-device entries only for devices matching
  // the query (capped). Global commands dispatch by clicking the REAL control rather than
  // re-implementing its handler -- that keeps spinner/disabled state and, critically, means
  // destructive actions still pass through their existing confirmAction gate.
  const PALETTE_COMMANDS = [
    { label: "Refresh fleet", hint: "Poll the control plane now", action: "refresh" },
    { label: "Discover devices", hint: "mDNS scan for wireless-debugging phones", action: "discover" },
    { label: "Scan versions", hint: "Read installed Processor versions", action: "scan-versions" },
    { label: "Scan Guardian", hint: "Read installed Guardian versions", action: "guardian-scan" },
    { label: "Install Guardian on selected", hint: "Waved rollout to the current selection", action: "guardian-install-selected" },
    { label: "Install Guardian on all online", hint: "Waved rollout, whole fleet", action: "guardian-install-online" },
    { label: "Provision selected", hint: "Grants, WD recovery, fleet-mode arm", action: "provision-selected" },
    { label: "Provision all online", hint: "Grants, WD recovery, fleet-mode arm", action: "provision-online" },
    { label: "Onboard a phone", hint: "Pair a new device over wireless ADB", action: "open-onboard" },
    { label: "Fleet debloat", hint: "Reversible, user 0 only", action: "open-debloat" },
    { label: "Fleet analytics", hint: "Thermal and battery history", action: "open-analytics" },
    { label: "Readiness details", hint: "Guardian grant drift", action: "show-readiness" },
    { label: "Reset FG losses (fleet)", hint: "Clear foreground-loss counters", action: "reset-fg-fleet" },
    { label: "Toggle screensaver", hint: "Black screen with bouncing dot", action: "toggle-screensaver" },
    { label: "Check for Lite update", hint: "Re-read the release feed", action: "update-check" },
  ];
  const PALETTE_DEVICE_ACTIONS = [
    { verb: "Open details", action: "more" },
    { verb: "Screenshot", action: "screenshot", needsOnline: true },
    { verb: "Live screen", action: "live", needsOnline: true },
    { verb: "Logcat", action: "logcat", needsOnline: true },
    { verb: "Locate", action: "locate", needsOnline: true },
    { verb: "Pause 15m (maintenance)", action: "pause-15", needsOnline: true },
    { verb: "Resume protection", action: "resume", needsOnline: true },
    { verb: "Reboot", action: "reboot", needsOnline: true, danger: true },
  ];
  let paletteRows = [];
  let paletteIndex = 0;

  function paletteMatch(haystack, needle) {
    if (!needle) return true;
    return String(haystack || "").toLowerCase().includes(needle);
  }

  function buildPaletteRows(rawQuery) {
    const query = String(rawQuery || "").trim().toLowerCase();
    const rows = [];
    const devices = app.visibleDevices && app.visibleDevices.length ? app.visibleDevices : Array.from(app.devicesById.values());
    const matchedDevices = query
      ? devices.filter((device) => paletteMatch(displayName(device), query) || paletteMatch(U.deviceIp(device), query) || paletteMatch(displayModel(device), query)).slice(0, 6)
      : devices.slice(0, 5);

    matchedDevices.forEach((device) => {
      const serial = device.serial;
      const online = U.effectiveState(device) === "device";
      PALETTE_DEVICE_ACTIONS.forEach((entry) => {
        if (entry.needsOnline && !online) return;
        if (entry.action !== "more" && !query) return;   // unqueried list stays short
        rows.push({
          kind: "device",
          serial,
          action: entry.action,
          danger: Boolean(entry.danger),
          title: `${entry.verb} · ${displayName(device)}`,
          hint: `${online ? "Online" : "Offline"}${U.deviceIp(device) ? " · " + U.deviceIp(device) : ""}`,
        });
      });
    });

    PALETTE_COMMANDS.forEach((command) => {
      if (query && !paletteMatch(command.label + " " + command.hint, query)) return;
      rows.push({ kind: "command", action: command.action, title: command.label, hint: command.hint });
    });

    return rows.slice(0, 40);
  }

  function renderPalette() {
    const list = $("#paletteList");
    if (!paletteRows.length) {
      list.innerHTML = '<div class="palette-empty">Nothing matches that. Try a device name, an IP, or a command.</div>';
      $("#paletteCount").textContent = "";
      return;
    }
    if (paletteIndex >= paletteRows.length) paletteIndex = paletteRows.length - 1;
    if (paletteIndex < 0) paletteIndex = 0;
    list.innerHTML = paletteRows.map((row, index) => `
      <div class="palette-row${index === paletteIndex ? " is-active" : ""}${row.danger ? " is-danger" : ""}" role="option" id="paletteRow${index}" aria-selected="${index === paletteIndex}" data-palette-index="${index}">
        <span class="palette-kind">${row.kind === "device" ? "DEVICE" : "FLEET"}</span>
        <span class="palette-title">${escapeHtml(row.title)}</span>
        <span class="palette-hint">${escapeHtml(row.hint || "")}</span>
      </div>`).join("");
    $("#paletteCount").textContent = `${paletteRows.length} result${paletteRows.length === 1 ? "" : "s"}`;
    const active = $(`#paletteRow${paletteIndex}`);
    if (active) active.scrollIntoView({ block: "nearest" });
    $("#paletteInput").setAttribute("aria-activedescendant", active ? active.id : "");
  }

  function runPaletteRow(row) {
    if (!row) return;
    $("#paletteDlg").close();
    if (row.kind === "device") {
      handleDeviceAction(row.action, row.serial);
      return;
    }
    // Several of these controls live inside the Guardian panel, which is hidden by
    // default -- running an install from the palette would otherwise bury its own
    // progress readout. Reveal the panel first so the job is watchable.
    if (/^(guardian-|provision-)/.test(row.action)) {
      const opener = $('[data-open-panel="guardian"]');
      if (opener && $("#guardianPanel") && $("#guardianPanel").hidden) opener.click();
    }
    // Click the real control so its own handler, button state and confirms all apply.
    const target = $(`[data-action="${row.action}"]`);
    if (target) target.click();
    else toast("Unavailable", "That command is not available in this view.", "error");
  }

  function openPalette() {
    const dialog = $("#paletteDlg");
    if (dialog.open) return;
    const input = $("#paletteInput");
    input.value = "";
    paletteIndex = 0;
    paletteRows = buildPaletteRows("");
    renderPalette();
    dialog.showModal();
    input.focus();
  }

  function bindPalette() {
    // Label the hint for the actual platform rather than showing Mac notation to the
    // Windows machine that drives this fleet.
    const hint = $("#paletteHint");
    if (hint && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "")) hint.textContent = "⌘K";

    const input = $("#paletteInput");
    input.addEventListener("input", () => { paletteIndex = 0; paletteRows = buildPaletteRows(input.value); renderPalette(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); paletteIndex += 1; renderPalette(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); paletteIndex -= 1; renderPalette(); }
      else if (event.key === "Enter") { event.preventDefault(); runPaletteRow(paletteRows[paletteIndex]); }
    });
    $("#paletteList").addEventListener("click", (event) => {
      const row = event.target.closest("[data-palette-index]");
      if (row) runPaletteRow(paletteRows[Number(row.dataset.paletteIndex)]);
    });
  }

  // ---------------------------------------------------------------- console options
  // ---- Server settings (devices.json on the host, not browser state) ---------------------
  // Secrets are never sent to the browser: the API reports only isSet. A blank secret field
  // therefore means "leave it alone", NOT "erase it" -- otherwise merely opening this dialog
  // and hitting Save would wipe the operator's GitHub PAT.
  async function openSetup() {
    const dlg = $("#setupDlg");
    if (!dlg) return;
    $("#setupMsg").textContent = "";
    $("#setupBody").innerHTML = '<div class="drawer-empty">Loading\u2026</div>';
    dlg.showModal();
    if (!token()) {
      $("#setupBody").innerHTML = '<div class="drawer-empty">Enter the fleet token in the header first \u2014 server settings are token-gated.</div>';
      return;
    }
    try {
      const r = await fetch("/api/setup", { headers: { "X-Fleet-Token": token() } });
      if (r.status === 403) throw new Error("Token rejected");
      const d = await r.json();
      renderSetup(d.fields || [], d.groups || []);
    } catch (e) {
      $("#setupBody").innerHTML = `<div class="drawer-empty">Could not load settings \u2014 ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  function renderSetup(fields, groups) {
    app.setupFields = fields;
    if (groups && groups.length) app.setupGroups = groups;
    const gs = app.setupGroups || [{ key: null, title: "", blurb: "" }];
    const done = fields.filter((f) => f.required).every((f) => String(f.value || "").trim());
    const intro = `<div class="setup-intro">
      <strong>New here?</strong> Only step 1 is required &mdash; fill it in and press Save, and the console
      can talk to your phones. Everything else adds optional features and can be done later.
      Fields left blank fall back to the default shown beneath them.
      ${done ? '' : '<span class="setup-todo">Step 1 is blank &mdash; fill it in before you arm any new phones. Phones already provisioned keep reporting.</span>'}
    </div>`;

    const sections = gs.map((g) => {
      const mine = fields.filter((f) => (f.group || null) === g.key);
      if (!mine.length) return "";
      const rows = mine.map((f) => {
        const id = "set_" + f.path.replace(/\W/g, "_");
        const badge = f.required
          ? '<span class="setup-req">required</span>'
          : '<span class="setup-opt">optional</span>';
        // Only worth showing when it differs from what is in the box -- otherwise every row
        // repeats itself and the panel reads as twice as dense as it is.
        const cur = String(f.value == null ? "" : f.value).trim();
        const dft = String(f.default == null ? "" : f.default).trim();
        const def = (dft && dft !== cur)
          ? `<span class="setup-default">Default if blank: <code>${escapeHtml(dft)}</code></span>`
          : "";
        if (f.kind === "secret") {
          return `<div class="setup-row">
            <label for="${id}"><strong>${escapeHtml(f.label)}</strong>${badge}
              <span class="setup-chip ${f.isSet ? "is-set" : ""}">${f.isSet ? "saved" : "not set"}</span></label>
            <span class="setup-hint">${escapeHtml(f.hint || "")}</span>
            <input id="${id}" data-setup-path="${escapeAttr(f.path)}" type="password" autocomplete="new-password"
                   placeholder="${f.isSet ? "leave blank to keep what is saved" : "paste the value here"}">
            ${f.isSet ? `<label class="setup-clear"><input type="checkbox" data-setup-clear="${escapeAttr(f.path)}"> remove this secret</label>` : ""}
          </div>`;
        }
        if (f.kind === "bool") {
          const on = f.value === true || String(f.value).toLowerCase() === "true" || String(f.value) === "1";
          return `<div class="setup-row setup-row--bool">
            <label class="setup-toggle" for="${id}">
              <input id="${id}" data-setup-path="${escapeAttr(f.path)}" data-setup-bool="1" type="checkbox" ${on ? "checked" : ""}>
              <span><strong>${escapeHtml(f.label)}</strong>${badge}</span>
            </label>
            <span class="setup-hint">${escapeHtml(f.hint || "")}</span>
          </div>`;
        }
        return `<div class="setup-row${f.kind === "int" ? " setup-row--num" : ""}">
          <label for="${id}"><strong>${escapeHtml(f.label)}</strong>${badge}</label>
          <span class="setup-hint">${escapeHtml(f.hint || "")}</span>
          <input id="${id}" data-setup-path="${escapeAttr(f.path)}" type="${f.kind === "int" ? "number" : "text"}"
                 placeholder="${escapeAttr(f.placeholder || "")}"
                 value="${escapeAttr(String(f.value == null ? "" : f.value))}">
          ${def}
        </div>`;
      }).join("");
      // Advanced collapses: nobody running a stock processor should have to scroll past it,
      // and an open section of things you must not touch reads as "this is complicated".
      if (g.key === "advanced") {
        return `<details class="setup-group setup-group--advanced">
          <summary><span>${escapeHtml(g.title || "")}</span><em>most people can skip this</em></summary>
          ${g.blurb ? `<p class="setup-blurb">${escapeHtml(g.blurb)}</p>` : ""}
          ${rows}
        </details>`;
      }
      return `<section class="setup-group">
        <h3>${escapeHtml(g.title || "")}</h3>
        ${g.blurb ? `<p class="setup-blurb">${escapeHtml(g.blurb)}</p>` : ""}
        ${rows}
      </section>`;
    }).join("");

    $("#setupBody").innerHTML = intro + sections;
  }

  async function saveSetup() {
    const msg = $("#setupMsg");
    const values = {}, clear = [];
    $$("#setupBody [data-setup-path]").forEach((el) => {
      values[el.dataset.setupPath] = el.dataset.setupBool ? (el.checked ? "true" : "false") : el.value;
    });
    $$("#setupBody [data-setup-clear]").forEach((el) => { if (el.checked) clear.push(el.dataset.setupClear); });
    // A ticked "clear" wins over whatever is in the box, so the two can never fight.
    clear.forEach((p) => delete values[p]);
    msg.textContent = "Saving\u2026";
    try {
      const r = await api("/api/setup", { values, clear });
      if (!r.ok) throw new Error(r.message || "save failed");
      renderSetup(r.fields || [], r.groups || []);
      const n = (r.changed || []).length;
      msg.textContent = n ? `Saved \u2014 ${n} setting(s) applied` : "No changes";
      toast("Server settings saved", n ? `${(r.changed || []).join(", ")} \u00b7 applied without a restart.` : "Nothing was different.");
      await poll();
    } catch (e) {
      msg.textContent = "";
      toast("Save failed", e.message || String(e), "error");
    }
  }

  function persistOptions() {
    try {
      localStorage.setItem("fleet:focus", app.focusMode ? "1" : "0");
      localStorage.setItem("fleet:kpiHidden", JSON.stringify(Array.from(app.kpiHidden)));
      localStorage.setItem("fleet:refreshMs", String(app.refreshMs));
    } catch (e) { /* private mode */ }
  }

  function renderOptionCards() {
    const host = $("#optCardList");
    if (!host) return;
    const labels = app.kpiLabels.slice().sort();
    // The panel has to describe the same state the drag gesture produces, otherwise a
    // pinned card looks identical to an unpinned one and "Hide all" silently fights the
    // layout the operator dragged into place.
    host.innerHTML = labels.length
      ? labels.map((label) => {
          const isPinned = app.kpiPinned.includes(label);
          return `<div class="opt-card-row${isPinned ? " is-pinned" : ""}">
            <label><input type="checkbox" data-kpi-toggle="${escapeAttr(label)}" ${app.kpiHidden.has(label) ? "" : "checked"}> <span>${escapeHtml(label)}</span></label>
            <button type="button" class="opt-pin" data-kpi-pin="${escapeAttr(label)}" title="${isPinned ? "Pinned to the hero row - click to unpin" : "Pin to the hero row (always full-size, never folded away)"}" aria-pressed="${isPinned}">${isPinned ? "\u2605 pinned" : "\u2606 pin"}</button>
          </div>`;
        }).join("")
      : '<em class="opt-note-inline">Cards appear here once the first fleet snapshot loads.</em>';
  }

  function openOptions() {
    $("#optFocusMode").checked = app.focusMode;
    $("#optAutoRefresh").checked = $("#autoRefresh") ? $("#autoRefresh").checked : true;
    $("#optRefreshMs").value = String(app.refreshMs);
    $("#optCompact").checked = app.density === "compact";
    $("#optReduceMotion").checked = $("#reduceMotion") ? $("#reduceMotion").checked : false;
    $("#optDefaultView").value = app.view;
    renderOptionCards();
    $("#optionsDlg").showModal();
  }

  // ---------------------------------------------------------------- card drag & drop
  // Direct manipulation for what the options checkboxes also do: drag a nominal chip up
  // into the hero grid to promote it, drag a hero card down to the strip to demote it,
  // and drop a card onto another to reorder. The checkboxes stay as the keyboard-
  // accessible equivalent -- HTML5 drag is pointer-only and must not be the sole route.
  let dragLabel = null;

  function persistPinned() {
    try {
      localStorage.setItem("fleet:kpiPinned", JSON.stringify(app.kpiPinned));
      // Demotions must persist too. This line was missing, so dragging a card down to the
      // strip looked right until the next reload put it straight back in the hero row.
      localStorage.setItem("fleet:kpiDemoted", JSON.stringify(Array.from(app.kpiDemoted)));
    } catch (e) { /* private mode */ }
  }

  function pinCard(label, beforeLabel) {
    if (!label) return;
    app.kpiPinned = app.kpiPinned.filter((l) => l !== label);
    const at = beforeLabel ? app.kpiPinned.indexOf(beforeLabel) : -1;
    if (at >= 0) app.kpiPinned.splice(at, 0, label); else app.kpiPinned.push(label);
    app.kpiHidden.delete(label);   // promoting something hidden should reveal it
    app.kpiDemoted.delete(label);  // and un-demote it
    persistPinned(); persistOptions(); renderAll();
  }

  function unpinCard(label) {
    if (!label) return;
    app.kpiPinned = app.kpiPinned.filter((l) => l !== label);
    // Explicitly demote, so an exception card stays down instead of being re-promoted.
    app.kpiDemoted.add(label);
    persistPinned(); renderAll();
  }

  function clearDropTargets() {
    $$(".is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
    $$(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
    dragLabel = null;
  }

  // ---------------------------------------------------------------- fleet map grouping
  function persistMapGroups() {
    try {
      localStorage.setItem("fleet:mapGroup", app.mapGroupBy);
      localStorage.setItem("fleet:mapGroups", JSON.stringify(app.mapGroups));
    } catch (e) { /* private mode */ }
  }

  function renderMapGroupList() {
    const host = $("#mapGroupList");
    if (!host) return;
    const counts = {};
    Object.values(app.mapGroups).forEach((g) => { if (g) counts[g] = (counts[g] || 0) + 1; });
    const names = Object.keys(counts).sort();
    host.innerHTML = names.length
      ? names.map((n) => `<div class="opt-card-row"><span>${escapeHtml(n)} <em class="opt-note-inline">${counts[n]} device${counts[n] === 1 ? "" : "s"}</em></span><button class="button" type="button" data-map-group-del="${escapeAttr(n)}">Remove</button></div>`).join("")
      : '<em class="opt-note-inline">No custom groups yet. Select devices, name a group, and assign.</em>';
  }

  function bindMapGrouping() {
    const sel = $("#mapGroupBy");
    if (sel) {
      sel.value = app.mapGroupBy;
      sel.addEventListener("change", (e) => { app.mapGroupBy = e.target.value; persistMapGroups(); renderAll(); });
    }
    const dlg = $("#mapGroupsDlg");
    if (!dlg) return;
    dlg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action], [data-map-group-del]");
      if (!btn) return;
      if (btn.dataset.mapGroupDel) {
        const name = btn.dataset.mapGroupDel;
        Object.keys(app.mapGroups).forEach((k) => { if (app.mapGroups[k] === name) delete app.mapGroups[k]; });
        persistMapGroups(); renderMapGroupList(); renderAll(); return;
      }
      const a = btn.dataset.action;
      if (a === "map-group-assign") {
        const name = ($("#mapGroupName").value || "").trim();
        if (!name) { toast("Name required", "Give the group a name first.", "error"); return; }
        if (!app.selected.size) { toast("Nothing selected", "Select devices in the table or shift-click them on the map.", "error"); return; }
        app.selected.forEach((serial) => { app.mapGroups[serial] = name; });
        app.mapGroupBy = "custom"; if ($("#mapGroupBy")) $("#mapGroupBy").value = "custom";
        persistMapGroups(); renderMapGroupList(); renderAll();
        toast("Group assigned", `${app.selected.size} device(s) -> ${name}`);
      }
      if (a === "map-group-clear-sel") {
        app.selected.forEach((serial) => { delete app.mapGroups[serial]; });
        persistMapGroups(); renderMapGroupList(); renderAll();
      }
      if (a === "map-groups-reset") { app.mapGroups = {}; persistMapGroups(); renderMapGroupList(); renderAll(); }
    });
  }

  function bindCardDnd() {
    const grid = $("#kpiGrid");
    const strip = $("#kpiNominal");
    if (!grid || !strip) return;

    // Belt and braces: a drop re-renders the grid, so the element that would have fired
    // `dragend` is gone by the time it would fire. Listen at window level for every way a
    // drag can end, and clear unconditionally.
    ["dragend", "drop", "dragexit", "mouseup", "blur"].forEach((evt) =>
      window.addEventListener(evt, clearDropTargets, true));

    document.addEventListener("dragstart", (e) => {
      const el = e.target.closest("[data-kpi-label]");
      if (!el) return;
      dragLabel = el.dataset.kpiLabel;
      el.classList.add("is-dragging");
      try { e.dataTransfer.setData("text/plain", dragLabel); e.dataTransfer.effectAllowed = "move"; } catch (err) { /* older browsers */ }
    });
    document.addEventListener("dragend", (e) => {
      const el = e.target.closest("[data-kpi-label]");
      if (el) el.classList.remove("is-dragging");
      grid.classList.remove("is-drop-target"); strip.classList.remove("is-drop-target");
      dragLabel = null;
    });

    [grid, strip].forEach((zone) => {
      zone.addEventListener("dragover", (e) => {
        if (!dragLabel) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "move"; } catch (err) { /* noop */ }
        zone.classList.add("is-drop-target");
      });
      zone.addEventListener("dragleave", (e) => {
        if (!zone.contains(e.relatedTarget)) zone.classList.remove("is-drop-target");
      });
    });

    grid.addEventListener("drop", (e) => {
      e.preventDefault();
      clearDropTargets();
      const label = dragLabel || (e.dataTransfer && e.dataTransfer.getData("text/plain"));
      if (!label) return;
      const over = e.target.closest("[data-kpi-label]");
      pinCard(label, over && over.dataset.kpiLabel !== label ? over.dataset.kpiLabel : null);
    });

    strip.addEventListener("drop", (e) => {
      e.preventDefault();
      clearDropTargets();
      const label = dragLabel || (e.dataTransfer && e.dataTransfer.getData("text/plain"));
      unpinCard(label);
    });

    // A drag ends in a click on some browsers; swallow it so demoting a card does not
    // also fire its filter query.
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-kpi-label]");
      if (el && el.classList.contains("is-dragging")) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  function bindOptions() {
    const dlg = $("#optionsDlg");
    if (!dlg) return;
    $("#optFocusMode").addEventListener("change", (e) => { app.focusMode = e.target.checked; persistOptions(); renderAll(); });
    $("#optRefreshMs").addEventListener("change", (e) => { app.refreshMs = Number(e.target.value) || 4000; persistOptions(); });
    $("#optCompact").addEventListener("change", (e) => setDensity(e.target.checked ? "compact" : "comfortable"));
    $("#optDefaultView").addEventListener("change", (e) => {
      const v = /^(table|grid)$/.test(e.target.value) ? e.target.value : "table";
      app.view = v;
      try { localStorage.setItem("fleet:view", v); } catch (err) { /* private mode */ }
      renderDevices();
    });
    $("#optAutoRefresh").addEventListener("change", (e) => { const a = $("#autoRefresh"); if (a) { a.checked = e.target.checked; a.dispatchEvent(new Event("change", { bubbles: true })); } });
    $("#optReduceMotion").addEventListener("change", (e) => { const r = $("#reduceMotion"); if (r) { r.checked = e.target.checked; r.dispatchEvent(new Event("change", { bubbles: true })); } });
    dlg.addEventListener("change", (e) => {
      const t = e.target.closest("[data-kpi-toggle]");
      if (!t) return;
      const label = t.dataset.kpiToggle;
      if (t.checked) app.kpiHidden.delete(label); else app.kpiHidden.add(label);
      persistOptions(); renderAll();
    });
    dlg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-action], [data-kpi-pin]");
      if (!b) return;
      const a = b.dataset.action;
      if (b.dataset.kpiPin) {
        const label = b.dataset.kpiPin;
        if (app.kpiPinned.includes(label)) unpinCard(label); else pinCard(label, null);
        renderOptionCards();
        return;
      }
      if (a === "opt-cards-all") { app.kpiHidden.clear(); persistOptions(); renderOptionCards(); renderAll(); }
      if (a === "opt-cards-none") {
        // Keep pinned cards visible -- hiding something the operator deliberately pinned
        // would look like the pin silently failed.
        app.kpiLabels.forEach((l) => { if (!app.kpiPinned.includes(l)) app.kpiHidden.add(l); });
        persistOptions(); renderOptionCards(); renderAll();
        if (app.kpiPinned.length) toast("Pinned cards kept", `${app.kpiPinned.length} pinned card(s) stay visible.`);
      }
      if (a === "open-setup") { dlg.close(); openSetup(); return; }
      if (a === "opt-reset") {
        app.kpiHidden.clear(); app.kpiPinned = []; app.kpiDemoted.clear(); persistPinned(); app.focusMode = true; app.refreshMs = 4000;
        setDensity("comfortable"); persistOptions(); openOptions(); renderAll();
      }
    });
  }

  function bindEvents() {
  // Hover pre-warm for live view. Starting the scrcpy server is idempotent (ws-scrcpy discovers a
  // running server via `ps` and reuses it), so kicking it when the pointer lands on the Live button
  // turns the click from a 3s cold start into a ~0.1s reuse. Fire-and-forget: failures are silent
  // because the click path re-runs the same pre-warm and reports properly there.
  const LIVE_PREWARMED = new Map();          // serial -> ts of last pre-warm
  const LIVE_PREWARM_TTL = 180000;           // don't re-poke the same phone more often than this
  function prewarmLive(serial) {
    if (!serial || !app.data.wsScrcpyUrl) return;
    const last = LIVE_PREWARMED.get(serial) || 0;
    if (Date.now() - last < LIVE_PREWARM_TTL) return;
    LIVE_PREWARMED.set(serial, Date.now());
    api("/api/live/prep", { serial }).catch(() => LIVE_PREWARMED.delete(serial));
  }
  document.addEventListener("pointerenter", (event) => {
    const t = event.target;
    if (!(t instanceof Element)) return;
    const btn = t.closest('[data-device-action="live"]');
    if (btn && !btn.disabled) prewarmLive(btn.dataset.serial);
  }, true);

    document.addEventListener("click", async (event) => {
      const openDialog = event.target.closest("[data-open-dialog]");
      if (openDialog) return document.getElementById(openDialog.dataset.openDialog)?.showModal();

      const view = event.target.closest("[data-view]");
      if (view) {
        app.view = view.dataset.view;
        localStorage.setItem("fleet:view", app.view);
        renderDevices();
        return;
      }

      const heatMode = event.target.closest("[data-heatmap-mode]");
      if (heatMode) {
        app.heatmapMode = heatMode.dataset.heatmapMode;
        localStorage.setItem("fleet:heatmap", app.heatmapMode);
        renderOverview();
        return;
      }

      const activityFilter = event.target.closest("[data-activity-filter]");
      if (activityFilter) { app.activityFilter = activityFilter.dataset.activityFilter; renderActivity(); return; }

      const kpi = event.target.closest("[data-kpi-query], [data-kpi-action]");
      if (kpi) {
        if (kpi.dataset.kpiQuery) { setQuery(kpi.dataset.kpiQuery); $("#device-region").scrollIntoView({ behavior: "smooth" }); }
        if (kpi.dataset.kpiAction === "open-device") openDrawer(kpi.dataset.kpiDetail, kpi);
        if (kpi.dataset.kpiAction === "show-readiness") showReadiness();
        if (kpi.dataset.kpiAction === "open-analytics") await openAnalytics();
        return;
      }

      const pairingDevice = event.target.closest("[data-pairing-host]");
      if (pairingDevice) {
        $("#pairingHost").value = pairingDevice.dataset.pairingHost;
        $("#pairingCode").focus();
        return;
      }

      const variantButton = event.target.closest("[data-debloat-variant]");
      if (variantButton) {
        const variant = (app.debloatReport.variants || [])[Number(variantButton.dataset.debloatVariant)];
        if (!variant) return;
        app.selected.clear();
        (variant.serials || []).forEach((serial) => app.selected.add(serial));
        $("#debloatTarget").value = "selected";
        // Also tick the packages currently in view for this variant -- the button used to
        // only retarget the phones, leaving the operator to check ~30 boxes by hand.
        const view = ($("#debloatView") && $("#debloatView").value) || "safe";
        (variant.packages || []).forEach((p) => {
          if (!p.guardable) return;
          const inView = view === "all" ? true : view === "candidates" ? p.goodCandidate : (p.goodCandidate && p.universal);
          if (inView) app.debloatSelected.add(p.pkg);
        });
        $("#debloatProgress").textContent = `Targeting ${(variant.serials || []).length} phone${(variant.serials || []).length === 1 ? "" : "s"} in ${variant.codename || variant.model || "this variant"}.`;
        renderAll();
        return;
      }

      const analyticsRange = event.target.closest("[data-analytics-hours]");
      if (analyticsRange) {
        app.analyticsHours = Number(analyticsRange.dataset.analyticsHours) || 6;
        if (app.analyticsSerial) {
          markActive($$('[data-analytics-hours]'), (button) => Number(button.dataset.analyticsHours) === app.analyticsHours);
          $("#analyticsBody").innerHTML = '<div class="loading-orbit"></div>';
          try { renderAnalytics(await fetchHistory(app.analyticsHours)); }
          catch (error) { $("#analyticsBody").innerHTML = `<div class="drawer-empty">${escapeHtml(error.message)}</div>`; }
        } else {
          await openAnalytics(app.analyticsModel, app.analyticsHours);
        }
        return;
      }

      const analyticsDevice = event.target.closest("[data-analytics-serial]");
      if (analyticsDevice) {
        const serial = analyticsDevice.dataset.analyticsSerial;
        app.analyticsSerial = serial;
        app.analyticsModel = null;
        $("#analyticsTitle").textContent = `Device analytics · ${displayName(app.devicesById.get(serial) || { serial })}`;
        $("#analyticsBody").innerHTML = '<div class="loading-orbit"></div>';
        try { renderAnalytics(await fetchHistory(app.analyticsHours)); }
        catch (error) { $("#analyticsBody").innerHTML = `<div class="drawer-empty">${escapeHtml(error.message)}</div>`; }
        return;
      }

      const presetRemove = event.target.closest("[data-preset-remove]");
      if (presetRemove) {
        const presets = loadPresets();
        presets.splice(Number(presetRemove.dataset.presetRemove), 1);
        savePresets(presets);
        renderPresets();
        return;
      }
      const preset = event.target.closest("[data-preset]");
      if (preset) { setQuery(preset.dataset.preset); $("#fleetSearch").value = preset.dataset.preset; return; }

      const quickFilter = event.target.closest("[data-query]");
      if (quickFilter) { appendQuery(quickFilter.dataset.query); return; }

      const removeFilterButton = event.target.closest("[data-remove-filter]");
      if (removeFilterButton) { removeFilter(Number(removeFilterButton.dataset.removeFilter)); return; }

      const heatCell = event.target.closest("[data-heat-serial]");
      if (heatCell) {
        if (event.shiftKey) toggleSelection(heatCell.dataset.heatSerial); else openDrawer(heatCell.dataset.heatSerial, heatCell);
        return;
      }
      const heatGroupLabel = event.target.closest("[data-heat-group]");
      if (heatGroupLabel) {
        const key = heatGroupLabel.dataset.heatGroup;
        const inGroup = (app.visibleDevices || []).filter((d) => mapGroupKey(d) === key);
        const allSelected = inGroup.length && inGroup.every((d) => app.selected.has(d.serial));
        inGroup.forEach((d) => toggleSelection(d.serial, !allSelected));
        return;
        return;
      }
      const heatGroup = event.target.closest("[data-group-query]");
      if (heatGroup) { setQuery(heatGroup.dataset.groupQuery); $("#device-region").scrollIntoView({ behavior: "smooth" }); return; }

      const deviceAction = event.target.closest("[data-device-action]");
      if (deviceAction) { event.stopPropagation(); await handleDeviceAction(deviceAction.dataset.deviceAction, deviceAction.dataset.serial); return; }

      const row = event.target.closest("[data-row-serial]");
      if (row && !event.target.closest("input,button,a")) { openDrawer(row.dataset.rowSerial, row); return; }

      const bulk = event.target.closest("[data-bulk-action]");
      if (bulk) { await runBulkAction(bulk.dataset.bulkAction); return; }

      const closeDrawerButton = event.target.closest("[data-close-drawer]");
      if (closeDrawerButton || event.target.id === "drawerScrim") { closeDrawer(); return; }

      const panelOpen = event.target.closest("[data-open-panel]");
      if (panelOpen) { $("#guardianPanel").hidden = false; $("#guardianPanel").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      const panelClose = event.target.closest("[data-close-panel]");
      if (panelClose) { $("#guardianPanel").hidden = true; return; }

      const enlarged = event.target.closest("[data-enlarge-screen]");
      if (enlarged) {
        const device = app.devicesById.get(enlarged.dataset.enlargeScreen);
        $("#screenTitle").textContent = `Screen · ${device ? displayName(device) : enlarged.dataset.enlargeScreen}`;
        $("#screenBody").innerHTML = `<img src="${enlarged.src}" alt="Enlarged screenshot">`;
        $("#screenRefresh").onclick = () => screenshot(enlarged.dataset.enlargeScreen);
        $("#screenDlg").showModal();
        return;
      }

      const actionButton = event.target.closest("[data-action]");
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === "open-options") return openOptions();
      if (action === "debloat-select-all") { debloatSelectAllShown(true); return; }
      if (action === "debloat-select-none") { debloatSelectAllShown(false); return; }
      if (action === "open-map-groups") { renderMapGroupList(); return $("#mapGroupsDlg").showModal(); }
      if (action === "open-palette") return openPalette();
      if (action === "open-shortcuts") return $("#shortcutsDlg").showModal();
      if (action === "refresh") return poll();
      if (action === "filter-pulse") { setQuery(`pulse:${actionButton.dataset.pulse || "degraded"}`); return; }
      if (action === "toggle-screensaver") return toggleScreensaver();
      if (action === "discover") return discover(actionButton);
      if (action === "scan-versions") return scanVersions(actionButton);
      if (action === "guardian-releases") return guardianReleases(actionButton);
      if (action === "guardian-scan") return guardianScan(actionButton);
      if (action === "guardian-install-selected") return guardianInstall("selected");
      if (action === "guardian-install-online") return guardianInstall("online");
      if (action === "provision-selected") return provisionDevices(onlineSerials("selected"));
      if (action === "provision-online") return provisionDevices(onlineSerials("online"), true);
      if (action === "open-onboard") return openOnboard();
      if (action === "pairing-refresh") return loadPairingDevices(actionButton);
      if (action === "open-debloat") return openDebloat();
      if (action === "debloat-refresh") return loadDebloatReport(actionButton);
      if (action === "debloat-preview") return previewDebloat();
      if (action === "debloat-apply") return applyDebloat();
      if (action === "debloat-restore") return restoreDebloat();
      if (action === "show-readiness") return showReadiness();
      if (action === "toggle-keep-lite") return toggleKeepLite();
      if (action === "reset-fg-fleet") return resetForegroundLosses(onlineSerials("online"), true);
      if (action === "update-check") return checkUpdates(actionButton);
      if (action === "update-selected") return confirmUpdate(Array.from(app.selected));
      if (action === "update-outdated") return confirmUpdate((app.data.devices || []).filter((device) => device.updateAvailable).map((device) => device.serial));
      if (action === "open-analytics") return openAnalytics();
      if (action === "open-device-analytics") {
        const serial = actionButton.dataset.serial;
        app.analyticsSerial = serial;
        app.analyticsModel = null;
        app.analyticsHours = 24;
        const dialog = $("#analyticsDlg");
        if (!dialog.open) dialog.showModal();
        $("#analyticsTitle").textContent = `Device analytics · ${displayName(app.devicesById.get(serial) || { serial })}`;
        markActive($$('[data-analytics-hours]'), (button) => Number(button.dataset.analyticsHours) === app.analyticsHours);
        $("#analyticsBody").innerHTML = '<div class="loading-orbit"></div>';
        try { renderAnalytics(await fetchHistory(app.analyticsHours)); }
        catch (error) { $("#analyticsBody").innerHTML = `<div class="drawer-empty">${escapeHtml(error.message)}</div>`; }
        return;
      }
      if (action === "clear-selection") { app.selected.clear(); renderAll(); return; }
      if (action === "clear-filters") return setQuery("");
      if (action === "save-preset") return saveCurrentPreset();
      if (action === "toggle-density") return setDensity(app.density === "compact" ? "comfortable" : "compact");
      if (action === "toggle-filter-builder") { $("#filterBuilder").hidden = !$("#filterBuilder").hidden; return; }
      if (action === "toggle-settings") { $("#settingsPopover").hidden = !$("#settingsPopover").hidden; return; }
      if (action === "setup-close") { const d = $("#setupDlg"); if (d && d.open) d.close(); return; }
      if (action === "setup-save") { saveSetup(); return; }
      if (action === "toggle-sidebar") { document.body.classList.toggle("sidebar-collapsed"); localStorage.setItem("fleet:sidebar", document.body.classList.contains("sidebar-collapsed") ? "collapsed" : "open"); return; }
      if (action === "columns") {
        document.body.classList.toggle("compact-columns");
        localStorage.setItem("fleet:compactColumns", document.body.classList.contains("compact-columns") ? "true" : "false");
        toast("Column preset updated", document.body.classList.contains("compact-columns") ? "Secondary model, temperature, and Guardian columns are hidden." : "All operations columns are visible.");
      }
    });

    document.addEventListener("change", (event) => {
      const select = event.target.closest("[data-select-serial]");
      if (select) {
        event.stopPropagation();
        const serial = select.dataset.selectSerial;
        // Shift-click selects the run between the last checkbox touched and this one, in
        // the order currently shown. Selecting 30 of 76 phones one checkbox at a time was
        // the only way to build a partial wave before this.
        if (event.shiftKey && app.lastSelectAnchor && app.lastSelectAnchor !== serial) {
          const order = (app.visibleDevices || []).map((device) => device.serial);
          const from = order.indexOf(app.lastSelectAnchor);
          const to = order.indexOf(serial);
          if (from !== -1 && to !== -1) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            order.slice(lo, hi + 1).forEach((each) => toggleSelection(each, select.checked));
            app.lastSelectAnchor = serial;
            return;
          }
        }
        app.lastSelectAnchor = serial;
        toggleSelection(serial, select.checked);
        return;
      }
      if (event.target.id === "selectVisible") {
        app.visibleDevices.forEach((device) => event.target.checked ? app.selected.add(device.serial) : app.selected.delete(device.serial));
        renderAll();
      }
      if (event.target.id === "sortSelect") {
        const [key, direction] = event.target.value.split(":");
        app.sortKey = key; app.sortDirection = direction;
        renderDevices(true);
      }
      if (event.target.id === "autoRefresh") schedulePoll(0);
      if (event.target.id === "reduceMotion") document.body.classList.toggle("reduce-motion", event.target.checked);
      if (event.target.id === "debloatView") renderDebloatReport();
      const debloatPackage = event.target.closest("[data-debloat-package]");
      if (debloatPackage) {
        if (debloatPackage.checked) app.debloatSelected.add(debloatPackage.dataset.debloatPackage);
        else app.debloatSelected.delete(debloatPackage.dataset.debloatPackage);
        $("#debloatSelectedCount").textContent = `${app.debloatSelected.size} selected`;
      }
    });

    $("#fleetSearch").addEventListener("input", (event) => debouncedSearch(event.target.value));
    $("#fleetSearch").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); setQuery(event.target.value); } });

    $("#tableView").addEventListener("scroll", debounce(() => { if (app.view === "table") renderTable(); }, 25));

    $(".device-table thead").addEventListener("click", (event) => {
      const header = event.target.closest("[data-sort]");
      if (!header) return;
      const key = header.dataset.sort;
      app.sortDirection = app.sortKey === key && app.sortDirection === "asc" ? "desc" : "asc";
      app.sortKey = key;
      $("#sortSelect").value = `${app.sortKey}:${app.sortDirection}`;
      renderDevices(true);
    });

    $("#importForm").addEventListener("submit", async (event) => {
      if (event.submitter && event.submitter.value === "cancel") return;
      event.preventDefault();
      const csv = $("#importCsv").value;
      if (!csv.trim()) return;
      const replace = $("#importReplace").checked;
      if (replace) {
        const confirmed = await confirmAction({ title: "Replace configured fleet?", body: "This will replace the current configured device list with the imported entries. Live mDNS devices may still appear.", phrase: "REPLACE", actionLabel: "Replace and import" });
        if (!confirmed) return;
      }
      try {
        const result = await api("/api/import", { csv, replace });
        $("#importDlg").close();
        addActivity({ type: "action", icon: "+", device: "Fleet", message: `${result.imported || 0} devices imported`, timestamp: Date.now() });
        toast("Import complete", `${result.imported || 0} entries processed · ${result.total || 0} configured.`);
        await poll();
      } catch (error) { toast("Import failed", error.message, "error"); }
    });

    $("#shellForm").addEventListener("submit", async (event) => {
      if (event.submitter && event.submitter.value === "cancel") return;
      event.preventDefault();
      const command = $("#shellCommand").value.trim();
      if (!command) return;
      const devices = Array.from(app.selected).map((serial) => app.devicesById.get(serial)).filter(Boolean);
      const serials = U.actionEligibility("shell", devices).serials;
      if (!serials.length) return toast("No eligible devices", "Select at least one online device.", "error");
      $("#shellDlg").close();
      await runRemoteAction("shell", serials, `Shell · ${command}`, command);
    });

    $("#onboardForm").addEventListener("submit", async (event) => {
      if (event.submitter && event.submitter.value === "cancel") return;
      event.preventDefault();
      await runOnboarding();
    });

    $("#renameForm").addEventListener("submit", async (event) => {
      if (event.submitter && event.submitter.value === "cancel") return;
      event.preventDefault();
      const serial = $("#renameSerial").value;
      const alias = $("#renameAlias").value.trim();
      const device = app.devicesById.get(serial);
      if (!device) return;
      try {
        const result = await api("/api/rename", { serial, alias });
        if (result.ok === false) throw new Error(result.message || "Rename failed");
        $("#renameDlg").close();
        toast("Device renamed", alias || "Backend label restored.");
        await poll();
        if (app.drawerSerial === serial) renderDrawer(serial);
      } catch (error) { toast("Rename failed", error.message, "error"); }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && app.drawerSerial) closeDrawer();

      const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || "");
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) { event.preventDefault(); openPalette(); return; }
      if (event.key === "?" && !typing) { event.preventDefault(); $("#shortcutsDlg").showModal(); return; }

      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); $("#fleetSearch").focus(); }
      if ((event.key === "Enter" || event.key === " ") && document.activeElement && document.activeElement.matches("[data-row-serial]")) { event.preventDefault(); openDrawer(document.activeElement.dataset.rowSerial, document.activeElement); }

      // Roving tabindex: with aria-selected in place, a tablist is expected to move
      // between tabs with arrows rather than Tab. Activation stays on click/Enter, which
      // the existing delegated handlers already cover.
      const tab = document.activeElement && document.activeElement.closest('[role="tab"]');
      if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        const list = tab.closest('[role="tablist"]');
        if (!list) return;
        const tabs = $$('[role="tab"]', list).filter((t) => !t.disabled);
        const index = tabs.indexOf(tab);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
          : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
          : (index + 1) % tabs.length;
        tabs[next].focus();
        tabs[next].click();
      }
    });
  }

  function initializePreferences() {
    if (!/^(table|grid)$/.test(app.view)) app.view = "table";
    if (localStorage.getItem("fleet:sidebar") === "collapsed") document.body.classList.add("sidebar-collapsed");
    if (localStorage.getItem("fleet:compactColumns") === "true") document.body.classList.add("compact-columns");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) $("#reduceMotion").checked = true;
    $("#fleetSearch").value = app.query;
    try { const st = localStorage.getItem("fleet:token"); if (st) $("#token").value = st; } catch (e) {}
    $("#token").addEventListener("input", () => { try { localStorage.setItem("fleet:token", $("#token").value.trim()); } catch (e) {} });
  }

  initializePreferences();
  bindEvents();
  bindPalette();
  bindOptions();
  bindCardDnd();
  bindMapGrouping();
  setDensity(app.density);
  renderPresets();
  poll();
})();

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FleetUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HEALTH_THRESHOLDS = Object.freeze({
    temperatureWarning: 42,
    temperatureCritical: 48,
    batteryLow: 30,
    batteryCritical: 15,
    foregroundLossRateWarning: 1,
    heartbeatStaleMs: 10 * 60 * 1000,
  });

  function effectiveState(device) {
    return device && (device.action === "rebooting" || device.action === "updating")
      ? device.action : (device && device.state) || "offline";
  }

  function deviceIp(device) {
    if (!device) return "";
    if (device.ip) return device.ip;
    if (device.wifiIp) return device.wifiIp;
    const serial = device.serial || "";
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(serial)) return serial.split(":")[0];
    return (device.telemetry && device.telemetry.ip) || "";
  }

  function batteryValue(device) {
    const telemetry = device && device.telemetry;
    const acurast = device && device.acurast;
    const metricsBattery = device && device.metrics && device.metrics.battery;
    const value = metricsBattery && metricsBattery.level != null ? metricsBattery.level
      : telemetry && telemetry.batteryPercent != null
      ? telemetry.batteryPercent
      : acurast && acurast.batteryLevel != null ? acurast.batteryLevel : null;
    return value == null || Number.isNaN(Number(value)) ? null : Number(value);
  }

  function temperatureValue(device) {
    const liveCpu = device && device.temps && device.temps.cpu;
    if (liveCpu != null && Number.isFinite(Number(liveCpu))) return Number(liveCpu);
    const temperatures = device && device.acurast && device.acurast.temperatures;
    const candidates = temperatures ? [temperatures.battery, temperatures.cpu, temperatures.device] : [];
    const numeric = candidates.map(Number).filter(Number.isFinite);
    if (numeric.length) return Math.max.apply(null, numeric);
    const thermal = device && device.telemetry && device.telemetry.thermal;
    const match = typeof thermal === "string" ? thermal.match(/-?\d+(?:\.\d+)?/) : null;
    return match ? Number(match[0]) : null;
  }

  // The device reports CPU load SUMMED ACROSS CORES (top-style), so an 8-core phone can
  // report 480. Printing that raw as "%" made the fleet KPI read "Average CPU 220%" and
  // made the >80 red threshold fire on 64 of 76 devices, so neither the number nor the
  // colour carried any signal. cpuValue() is therefore normalised to percent-of-capacity
  // (raw / cores) -- one meaning shared by the cards, the sort and the `cpu:` filter.
  //
  // Deliberately NOT clamped to 100: a load figure legitimately exceeds capacity when the
  // run queue backs up, and clamping would hide exactly the devices worth looking at.
  // cpuRawLoad() keeps the unnormalised number for tooltips.
  function cpuRawLoad(device) {
    const telemetry = device && device.telemetry;
    const acurast = device && device.acurast;
    const liveCpu = device && device.metrics && device.metrics.cpu && device.metrics.cpu.loadPct;
    const raw = liveCpu ?? (telemetry && (telemetry.cpuPercent ?? telemetry.cpuUsage))
      ?? (acurast && (acurast.cpuPercent ?? acurast.cpuUsage));
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function cpuCores(device) {
    const cores = Number((device && device.telemetry && device.telemetry.cpuCores) || 0);
    return Number.isFinite(cores) && cores > 0 ? cores : null;
  }

  function cpuValue(device) {
    const raw = cpuRawLoad(device);
    if (raw == null) return null;
    const cores = cpuCores(device);
    return cores ? Math.round((raw / cores) * 10) / 10 : raw;
  }

  function isCharging(device) {
    const telemetry = device && device.telemetry;
    const acurast = device && device.acurast;
    const metricsBattery = device && device.metrics && device.metrics.battery;
    if (metricsBattery && metricsBattery.charging != null) return Boolean(metricsBattery.charging);
    if (telemetry && telemetry.charging != null) return Boolean(telemetry.charging);
    if (acurast && acurast.isCharging != null) return Boolean(acurast.isCharging);
    return null;
  }

  function calculateHealthScore(device, thresholds) {
    const t = Object.assign({}, HEALTH_THRESHOLDS, thresholds || {});
    if (!device || !device.state) {
      return { score: null, label: "Unknown", tone: "neutral", reasons: ["Device state unavailable"], confidence: "unknown" };
    }

    let score = 100;
    let observed = 1;
    const reasons = [];
    const state = effectiveState(device);
    if (state === "offline") {
      score -= 70;
      reasons.push("Offline −70");
    } else if (state === "unauthorized") {
      score -= 35;
      reasons.push("ADB unauthorized −35");
    } else if (state === "rebooting") {
      score -= 10;
      reasons.push("Reboot in progress −10");
    }

    const temperature = temperatureValue(device);
    if (temperature != null) {
      observed += 1;
      if (temperature >= t.temperatureCritical) {
        score -= 30;
        reasons.push(`Critical temperature (${temperature.toFixed(1)}°C) −30`);
      } else if (temperature >= t.temperatureWarning) {
        score -= 15;
        reasons.push(`High temperature (${temperature.toFixed(1)}°C) −15`);
      }
    }

    const battery = batteryValue(device);
    const charging = isCharging(device);
    if (battery != null) {
      observed += 1;
      if (battery < t.batteryCritical && charging === false) {
        score -= 20;
        reasons.push(`Critical battery (${battery}%) −20`);
      } else if (battery < t.batteryLow && charging === false) {
        score -= 15;
        reasons.push(`Low battery (${battery}%) −15`);
      }
    }

    const telemetry = device.telemetry;
    if (telemetry) {
      observed += 1;
      if (telemetry.armed === false) {
        score -= 10;
        reasons.push("Guardian not fully armed −10");
      }
      if (telemetry.guardianState && /offline|failed|stopped|error/i.test(telemetry.guardianState)) {
        score -= 10;
        reasons.push("Guardian unavailable −10");
      }
      const sampleTime = Number(telemetry.recv_ts || 0) * 1000;
      if (sampleTime && Date.now() - sampleTime > t.heartbeatStaleMs) {
        score -= 10;
        reasons.push("Stale Guardian heartbeat −10");
      }
    }
    if (!telemetry && device.guardianArmed === false) {
      observed += 1;
      score -= 10;
      reasons.push("Guardian not provisioned −10");
    }

    if (device.behind) {
      observed += 1;
      score -= 8;
      reasons.push("Processor version behind fleet −8");
    }
    if (device.guardianAction && /^failed/i.test(device.guardianAction)) {
      observed += 1;
      score -= 5;
      reasons.push("Recent Guardian action failed −5");
    }

    const metrics = device.metrics || {};
    if (metrics.proc && metrics.proc.alive === false) {
      observed += 1;
      score -= 20;
      reasons.push("Processor not running −20");
    }
    if (metrics.throttle && Number(metrics.throttle.level) > 0) {
      observed += 1;
      score -= 15;
      reasons.push(`Thermal throttling (${metrics.throttle.name || "active"}) −15`);
    }
    if (Number(device.fgRate) >= t.foregroundLossRateWarning) {
      observed += 1;
      score -= 5;
      reasons.push(`Foreground losses climbing (${device.fgRate}/h) −5`);
    }

    if (state === "device" && observed < 2) {
      return { score: null, label: "Unknown", tone: "neutral", reasons: ["Not enough live health inputs"], confidence: "unknown" };
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const tone = score >= 85 ? "healthy" : score >= 65 ? "warning" : "critical";
    const label = score >= 85 ? "Healthy" : score >= 65 ? "Attention" : "Critical";
    if (!reasons.length) reasons.push("All available health checks passed");
    return { score, label, tone, reasons, confidence: observed >= 4 ? "high" : "limited" };
  }

  function tokenizeQuery(query) {
    const tokens = [];
    String(query || "").replace(/(?:[^\s"]+|"[^"]*")+/g, function (token) {
      tokens.push(token);
      return token;
    });
    return tokens;
  }

  function parseFilterQuery(query) {
    return tokenizeQuery(query).map(function (token) {
      const match = token.match(/^([a-zA-Z][\w-]*):(>=|<=|>|<|=)?(.+)$/);
      if (!match) return { type: "text", value: token.replace(/^"|"$/g, "") };
      return {
        type: "field",
        field: match[1].toLowerCase(),
        operator: match[2] || "=",
        value: match[3].replace(/^"|"$/g, ""),
        raw: token,
      };
    });
  }

  function compareNumeric(actual, operator, expected) {
    if (actual == null || !Number.isFinite(Number(actual)) || !Number.isFinite(Number(expected))) return false;
    const a = Number(actual);
    const e = Number(expected);
    if (operator === ">") return a > e;
    if (operator === ">=") return a >= e;
    if (operator === "<") return a < e;
    if (operator === "<=") return a <= e;
    return a === e;
  }

  function wildcardMatch(actual, expected) {
    const escaped = String(expected).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(String(actual || ""));
  }

  function booleanValue(value) {
    return /^(true|yes|1|on)$/i.test(String(value));
  }

  function fieldMatches(device, token) {
    const value = token.value;
    switch (token.field) {
      // Pulse fleet-health verdict (acurastpulse.com benchmark-health), joined by on-chain address.
      // `pulse:degraded` = anything Pulse flagged; `pulse:investigate` / `pulse:watch` are exact.
      // Pulse only returns non-healthy processors, so `pulse:healthy` means "not flagged".
      // v1.1.27 `earning`: Running AND fresh heartbeat. stalled = Running but heartbeat gone quiet.
      // v1.1.31 a11yHealthy: independent liveness beat from the accessibility service.
      case "a11y": {
        const v = (device.telemetry || {}).a11yHealthy;
        const want = String(value || "dead").toLowerCase();
        // Corroborate: a false flag with compute still arriving is a Guardian bug, not a dead scrape.
        // Sustained false = real fault. Brief false = the normal post-OTA re-bind, not actionable.
        const mins = device.a11yFalseMin ?? 0;
        if (want === "dead" || want === "false") return v === false && mins >= 15;
        if (want === "rebinding" || want === "flap") return v === false && mins < 15;
        if (want === "flag") return v === false;
        if (want === "ok" || want === "true" || want === "alive") return v === true;
        return false;
      }
      case "stalled": {
        const t = device.telemetry || {};
        const isStalled = t.earning === false && t.computeActive === true;
        const want = String(value || "true").toLowerCase();
        return (want === "true" || want === "yes") ? isStalled : !isStalled;
      }
      case "earning": {
        const t = device.telemetry || {};
        const want = String(value || "true").toLowerCase();
        return (want === "true" || want === "yes") ? t.earning === true : t.earning === false;
      }
      case "pulse": {
        const status = (device.pulseHealth && device.pulseHealth.status) || "";
        const want = String(value || "").toLowerCase();
        if (want === "degraded" || want === "any") return Boolean(status);
        if (want === "healthy" || want === "ok" || want === "none") return !status;
        return status.toLowerCase() === want;
      }
      case "status": {
        const wanted = value.toLowerCase() === "online" ? "device" : value.toLowerCase();
        return effectiveState(device).toLowerCase() === wanted;
      }
      case "cpu": return compareNumeric(cpuValue(device), token.operator, value);
      case "temp":
      case "temperature": return compareNumeric(temperatureValue(device), token.operator, value);
      case "battery": return compareNumeric(batteryValue(device), token.operator, value);
      case "version": return wildcardMatch(device.version || "", value);
      // idle:true -> the user-0 hub is foregrounded instead of the work-profile Processor,
      // so this node is NOT computing however green its other fields look. `idleHub` is
      // null when the foreground could not be read, and null must never match either
      // polarity -- an unreadable device is not evidence of health.
      case "idle": return device.idleHub != null && Boolean(device.idleHub) === booleanValue(value);
      // anr:>0 -- the app has been ANR-ing (main thread wedged long enough for Android to
      // raise "isn't responding"). Guardian dismisses the dialog so the node self-heals and
      // the earning count never notices, which is exactly why this needs to be queryable.
      case "anr": return compareNumeric((device.telemetry && device.telemetry.anrSinceBoot) ?? null, token.operator, value);
      // protection:false -- armed on paper but the controller's gate is shut, so Guardian
      // detects problems and never acts on them. Silent by construction; surfaced here.
      case "protection": {
        const arm = (device.telemetry && device.telemetry.arm) || {};
        const on = arm.protectionEnabled ?? arm.protectionRunning;
        return on != null && Boolean(on) === booleanValue(value);
      }
      case "outdated": return Boolean(device.behind) === booleanValue(value);
      case "update": return Boolean(device.updateAvailable) === booleanValue(value);
      case "profile": return String((device.telemetry && device.telemetry.profile) || (device.inWorkProfile ? "work profile" : "personal")).toLowerCase().includes(value.toLowerCase());
      case "model": return String((device.telemetry && device.telemetry.model) || device.model || "").toLowerCase().includes(value.toLowerCase());
      case "guardian": return String((device.telemetry && device.telemetry.guardianState) || device.guardianVersion || "unknown").toLowerCase().includes(value.toLowerCase());
      case "screen": return String((device.telemetry && device.telemetry.screenState) || "unknown").toLowerCase() === value.toLowerCase();
      case "armed": {
        const armed = device.telemetry && device.telemetry.armed != null ? device.telemetry.armed : device.guardianArmed;
        return armed != null && Boolean(armed) === booleanValue(value);
      }
      case "job": return String((device.acurast && (device.acurast.jobStatus || device.acurast.currentJob)) || "").toLowerCase().includes(value.toLowerCase());
      case "fg": return compareNumeric(device.fgRate, token.operator, value);
      case "ip": return wildcardMatch(deviceIp(device), value);
      case "id": return wildcardMatch(device.serial || "", value);
      case "health": {
        const health = calculateHealthScore(device);
        return health.score != null && compareNumeric(health.score, token.operator, value);
      }
      default: return false;
    }
  }

  function matchesFilter(device, queryOrTokens) {
    const tokens = Array.isArray(queryOrTokens) ? queryOrTokens : parseFilterQuery(queryOrTokens);
    const searchable = [
      device.alias, device.label, device.serial, deviceIp(device), device.model, device.version, device.address,
      device.telemetry && device.telemetry.model,
      device.telemetry && device.telemetry.profile,
    ].filter(Boolean).join(" ").toLowerCase();
    return tokens.every(function (token) {
      return token.type === "text"
        ? searchable.includes(token.value.toLowerCase())
        : fieldMatches(device, token);
    });
  }

  function sortDevices(devices, key, direction) {
    const dir = direction === "desc" ? -1 : 1;
    const getters = {
      identity: function (d) { return (d.alias || d.label || d.serial || "").toLowerCase(); },
      status: function (d) { return effectiveState(d); },
      health: function (d) { const h = calculateHealthScore(d); return h.score == null ? -1 : h.score; },
      ip: deviceIp,
      model: function (d) { return ((d.telemetry && d.telemetry.model) || d.model || "").toLowerCase(); },
      cpu: function (d) { return cpuValue(d) ?? -1; },
      temp: function (d) { return temperatureValue(d) ?? -1; },
      battery: function (d) { return batteryValue(d) ?? -1; },
      version: function (d) { return Number(d.versionCode || 0); },
      lastSeen: function (d) { return Number(d.last_seen || 0); },
    };
    const get = getters[key] || getters.identity;
    return devices.slice().sort(function (a, b) {
      const av = get(a); const bv = get(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
  }

  function actionEligibility(action, devices) {
    const selected = Array.isArray(devices) ? devices : [];
    const online = selected.filter(function (d) { return effectiveState(d) === "device"; });
    const rules = {
      wake: online,
      screenshot: online,
      logcat: online,
      shell: online,
      reboot: online,
      guardian: online,
      provision: online,
      open_acurast: online,
      update: online.filter(function (d) { return Boolean(d.updateAvailable); }),
    };
    const eligible = rules[action] || [];
    return {
      total: selected.length,
      eligible: eligible.length,
      disabled: eligible.length === 0,
      serials: eligible.map(function (d) { return d.serial; }),
      reason: eligible.length ? `${eligible.length} of ${selected.length} eligible` : "Requires an online, authorized device",
    };
  }

  function deviceStateBadge(device) {
    const state = effectiveState(device);
    const map = {
      device: { label: "Online", tone: "healthy", icon: "●" },
      offline: { label: "Offline", tone: "neutral", icon: "○" },
      unauthorized: { label: "Unauthorized", tone: "warning", icon: "!" },
      rebooting: { label: "Rebooting", tone: "active", icon: "↻" },
      updating: { label: "Updating", tone: "active", icon: "⇧" },
    };
    return map[state] || { label: state || "Unknown", tone: "neutral", icon: "?" };
  }

  return {
    HEALTH_THRESHOLDS,
    effectiveState,
    deviceIp,
    batteryValue,
    temperatureValue,
    cpuValue,
    cpuRawLoad,
    cpuCores,
    isCharging,
    calculateHealthScore,
    tokenizeQuery,
    parseFilterQuery,
    matchesFilter,
    sortDevices,
    actionEligibility,
    deviceStateBadge,
  };
});

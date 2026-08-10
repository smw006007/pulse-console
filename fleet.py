#!/usr/bin/env python3
"""
Acurast Fleet Console — a tiny, self-hosted dashboard to reboot Acurast Processor Lite phones
over wireless ADB. Stdlib only (no pip installs).

It gives you: a live device grid, per-device Reboot, and staggered "Reboot selected/all" (in waves,
so 130 phones don't all drop Wi-Fi/ADB at once), plus a background auto-reconnect loop that survives
the reboots via mDNS discovery.

HONEST LIMITS (see README):
  * `adb reboot` only reaches a device whose wireless ADB is still responsive. A truly hung phone
    won't be reachable — for those you need power control (smart plug / powered USB hub), not ADB.
  * On stock Android, classic `adb tcpip` mode does NOT survive reboot. Use Android 11+ *Wireless
    debugging* (paired once) and leave it enabled; this console rediscovers devices via mDNS.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "devices.json")

# The Acurast Processor Lite package we audit. This is the ONLY app id the console will
# ever push an update to (see the verification gate in download_and_verify()).
# Defaults reproduce the canary fleet exactly. All three are rebound from the "processor"
# block in devices.json immediately after load_config(), so a self-hoster can point the console
# at a different Acurast processor variant without editing source.
TARGET_PKG_DEFAULT = "com.acurast.attested.executor.sbs.canary"
LITE_MATCH_DEFAULT = "com.acurast.attested.executor"
PROCESSOR_EXCLUDE_DEFAULT = "com.acurast.attested.executor.staging"
TARGET_PKG = TARGET_PKG_DEFAULT          # rebound below, after the config is read
FLAG_MANAGED_PROFILE = 0x20  # UserInfo flag bit for a work profile

# --- OTA / auto-update ------------------------------------------------------------------
# The fleet runs Processor LITE (canary channel). Its GitHub release artifact is
# processor-lite-<ver>.apk (NOT processor-<ver>-canary.apk, which is the Core/staging app,
# a different package signed with a different key). We verify BOTH the package id and the
# signing certificate of any downloaded APK before it can be pushed — so a wrong or tampered
# artifact can never reach a phone. (Cert proven 2026-07-22 against the live fleet.)
APK_CACHE_DIR = os.path.join(HERE, "apk-cache")
LITE_ASSET_RE = re.compile(r"^processor-lite-(\d+\.\d+\.\d+)\.apk$")
# v2 (0x7109871a) / v3 (0xf05368c0) APK Signing Block ids.
_SIG_V2, _SIG_V3 = 0x7109871A, 0xF05368C0

# Latest verified release available to push. `path` is only set once cert+package pass.
RELEASE = {
    "checkedAt": 0, "versionName": "", "assetName": "", "url": "", "publishedAt": "",
    "path": "", "certOk": False, "packageOk": False, "ready": False, "error": "",
    "sizeBytes": 0, "certHashes": [],
}
RELEASE_LOCK = threading.Lock()

DEFAULT_CONFIG = {
    "adb_path": "",                 # leave blank to auto-detect (PATH / ANDROID_HOME)
    "bind": "127.0.0.1",            # 0.0.0.0 to expose on LAN (then SET a token!)
    "port": 8787,
    "token": "",                    # optional shared secret required for reboot actions
    "poll_seconds": 6,              # how often to refresh adb state + reconnect
    "thermal_poll_seconds": 45,     # how often to probe device metrics over adb (read-only)
    "metrics_retention_days": 7,    # how long the SQLite metrics history is kept (auto-pruned hourly)
    "mdns_autoconnect": True,       # auto-discover + connect Android 11+ wireless-debugging devices
    "batch": {"wave_size": 8, "wave_delay_sec": 20},
    "ws_scrcpy_url": "",            # e.g. http://<console-host>:8000 → per-device "Live" buttons appear
    # Optional: your Acurast processor-management-backend, to pull address + health per processor.
    "acurast_backend": {
        "base_url": "",             # e.g. http://<backend-host>:3010  (serves /processor/api/...)
        "api_key": "",              # optional; leave "" for an unauthenticated tailnet backend
        "manager_address": "",      # your manager/owner address → auto-lists the whole fleet
        "poll_seconds": 60,
    },
    # Shared secret for the signed Guardian command channel (readb/locate). Lives in devices.json
    # ONLY -- never in source, so this tree can be published. Blank = channel inert.
    "guardian_command_secret": "",
    # Which Acurast processor this console manages. Blank = the canary defaults above.
    "processor": {
        "package": "",          # e.g. com.acurast.attested.executor.sbs.canary
        "family_match": "",     # prefix that identifies the processor family (canary or core)
        "exclude_match": "",    # sibling app id that must NOT be mistaken for it
    },
    # Acurast Pulse fleet health (acurastpulse.com). Pulls per-processor benchmark health so the
    # console can show WHICH physical phone is degraded, joined by on-chain address.
    "pulse_health": {
        "base_url": "https://www.acurastpulse.com",
        "manager_id": "",           # your Acurast manager id; blank disables the Pulse join
        "poll_seconds": 300,
    },
    # Guardian OTA: pull signed Guardian release APKs from the (private) GitHub repo and install.
    "guardian_update": {
        "repo": "",                 # e.g. youruser/acurast-guardian
        "github_token": "",         # fine-grained PAT, Contents:Read-only — tailnet-only, never commit
        "package": "com.acurast.guardian",
        "cache_dir": "guardian-apks",
        "batch": {"wave_size": 6, "wave_delay_sec": 15},
        "reassert_overlay_on_reconnect": True,  # re-grant overlay appop after reboot (N159V wipes it)
        "telemetry_url": "",        # this console's reachable URL, passed to arm (e.g. http://<host>:8787/api/telemetry)
    },
    # Auto-update: watch Acurast releases for a newer LITE build, verify it, and let you push it.
    "updates": {
        "enabled": True,
        "repo": "Acurast/acurast-processor-update",
        "package": TARGET_PKG_DEFAULT,  # downloaded APK must declare this app id
        "expected_cert_sha256": "ea21af13f3b724c662f3da05247acc5a68a45331a90220f0d90a6024d7fa8f36",
        "include_prereleases": False,   # rc/canary tags are skipped unless True
        "auto_download": True,          # fetch+verify newest automatically; NEVER auto-installs
        "poll_minutes": 60,
        "wave_size": 4,                 # push in small waves (each install streams ~190MB over Wi-Fi)
        "wave_delay_sec": 15,
    },
    # Optional explicit device list. `address` is the Acurast processor address (the manual bridge).
    "devices": [
        # {"label": "acurast-01", "host": "192.168.1.101:5555", "address": "0x…"}
    ],
}


def _deep_merge(base, over):
    """Recursive merge so a PARTIAL nested block in devices.json keeps the rest of the defaults.
    The old shallow cfg.update() replaced a whole block, silently dropping every default the
    operator did not restate. Harmless while every value was hardcoded; wrong now that the
    defaults are the self-host story."""
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = _deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_config():
    cfg = _deep_merge(DEFAULT_CONFIG, {})   # deep copy of the defaults
    if os.path.exists(CONFIG_PATH):
        try:
            # utf-8-sig tolerates a BOM (Notepad / PowerShell Set-Content add one).
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg = _deep_merge(cfg, json.load(f))
        except Exception as e:  # noqa: BLE001
            print(f"[warn] could not read devices.json: {e}")
    return cfg


def find_adb(cfg):
    if cfg.get("adb_path") and os.path.exists(cfg["adb_path"]):
        return cfg["adb_path"]
    env = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if env:
        for name in ("adb.exe", "adb"):
            p = os.path.join(env, "platform-tools", name)
            if os.path.exists(p):
                return p
    found = shutil.which("adb")
    if found:
        return found
    raise SystemExit("adb not found. Set 'adb_path' in devices.json or add it to PATH.")


CFG = load_config()

# Processor identity, resolved from config with the canary defaults as fallback. An existing
# devices.json with no "processor" block resolves to exactly the previous hardcoded values.
_PROC_CFG = CFG.get("processor") or {}
TARGET_PKG = (_PROC_CFG.get("package") or TARGET_PKG_DEFAULT).strip()
LITE_MATCH = (_PROC_CFG.get("family_match") or LITE_MATCH_DEFAULT).strip()
PROCESSOR_EXCLUDE_MATCH = (_PROC_CFG.get("exclude_match") or PROCESSOR_EXCLUDE_DEFAULT).strip()

ADB = find_adb(CFG)
LABELS = {d["host"]: d.get("label", d["host"]) for d in CFG.get("devices", []) if "host" in d}
ADDR = {d["host"]: d.get("address", "") for d in CFG.get("devices", []) if "host" in d}

# The known-good Acurast signing key for Processor Lite. An APK must match this to be pushable.
EXPECTED_CERT = (CFG.get("updates", {}).get("expected_cert_sha256")
                 or "ea21af13f3b724c662f3da05247acc5a68a45331a90220f0d90a6024d7fa8f36").strip().lower()

# Acurast processor status pulled from your backend, keyed by processor address.
ACURAST = {}
ACURAST_TTL = 900  # seconds a backend sample stays "fresh"

# serial -> {serial,label,state,model,last_seen,action,version,...}
STATE = {}
STATE_LOCK = threading.Lock()

# Persisted per-device facts (address, armed, guardian version) so a console restart doesn't reset
# them — otherwise the "armed" count drops on every restart until each phone re-posts telemetry.
DEVICE_STATE_PATH = os.path.join(HERE, "device_state.json")
DEVICE_STATE = {}
DEVICE_STATE_LOCK = threading.Lock()


def load_device_state():
    global DEVICE_STATE
    try:
        with open(DEVICE_STATE_PATH, "r", encoding="utf-8") as f:
            DEVICE_STATE = json.load(f)
    except Exception:  # noqa: BLE001
        DEVICE_STATE = {}


def remember_device(serial, **facts):
    """Record & persist facts about a device (address / guardianArmed / guardianVersion)."""
    with DEVICE_STATE_LOCK:
        d = DEVICE_STATE.setdefault(serial, {})
        d.update({k: v for k, v in facts.items() if v is not None})
        try:
            with open(DEVICE_STATE_PATH, "w", encoding="utf-8") as f:
                json.dump(DEVICE_STATE, f)
        except Exception as e:  # noqa: BLE001
            print(f"[device-state] {e}")


load_device_state()

# Guardian health telemetry, keyed by the device's reported Wi-Fi IP. Merged into cards by IP.
TELEMETRY = {}
TELEMETRY_TTL = 600  # seconds a telemetry sample stays "fresh"
GUARDIAN_SCAN_INTERVAL = 1800  # how often to re-read each phone's installed Guardian version
SERIAL_IP = {}  # guid serial -> device Wi-Fi IP (from mDNS) so telemetry (keyed by IP) attaches

# --- Guardian readb command channel (v1.1.12+); see READB-COMMAND-CHANNEL.md -------------------
# Console detects a "stranded" phone (posting telemetry but NOT visible on the adb bus) and returns a
# SIGNED readb command in the telemetry HTTP response. Guardian v1.1.12 verifies HMAC + verb-allowlist
# ({readb}) + ts(+/-600s) + nonce + uuid-binding, then toggles adb_wifi_enabled off->on to re-announce
# mDNS so our auto-connect re-grabs it. GATED OFF by default: no command is sent to ANY phone until an
# operator-present validation on one N152DL (deliberately strand it, confirm result=OK + WD ends ON).
GUARDIAN_COMMAND_SECRET = (CFG.get("guardian_command_secret") or "").strip()  # devices.json only
READB_ENABLED = False       # master switch. FLIP TO True ONLY after operator-present validation.
READB_TEST_UUIDS = set()    # while READB_ENABLED is False, ONLY these device uuids get readb (1-phone test)
READB_MIN_INTERVAL = 180    # s; don't re-send readb to the same phone within this window (let it reconnect)
_READB_LAST = {}            # uuid -> last-send ts
_READB_LOCK = threading.Lock()


def sign_cmd(verb, device_uuid):
    """HMAC-SHA256 over 'verb|uuid|ts|nonce' -> lowercase hex, per READB-COMMAND-CHANNEL.md."""
    ts = int(time.time())
    nonce = secrets.token_hex(8)
    sig = hmac.new(GUARDIAN_COMMAND_SECRET.encode(),
                   f"{verb}|{device_uuid}|{ts}|{nonce}".encode(),
                   hashlib.sha256).hexdigest()
    return {"verb": verb, "ts": ts, "nonce": nonce, "sig": sig}


def _adb_visible_ips():
    """Wi-Fi IPs currently reachable via a live adb transport (device-state serials -> SERIAL_IP)."""
    with STATE_LOCK:
        return {SERIAL_IP.get(s) for s, d in STATE.items()
                if d.get("state") == "device" and SERIAL_IP.get(s)}


def readb_command_for(uuid, ip):
    """[] unless this phone is stranded (telemetry arriving but no adb transport) AND gated in.
    Rate-limited per uuid. Callers must still wrap in try/except so ingest never breaks."""
    if not GUARDIAN_COMMAND_SECRET or not uuid:
        return []
    if not (READB_ENABLED or uuid in READB_TEST_UUIDS):
        return []                                   # gated off -> zero commands, zero STATE_LOCK
    if ip and ip in _adb_visible_ips():
        return []                                   # we can see it on adb -> not stranded
    now = time.time()
    with _READB_LOCK:
        if now - _READB_LAST.get(uuid, 0) < READB_MIN_INTERVAL:
            return []
        _READB_LAST[uuid] = now
    return [sign_cmd("readb", uuid)]

# The Guardian `packages` inventory rides only the throttled (~30 min) telemetry push; the frequent
# health pushes DON'T carry it, and each push replaces TELEMETRY[ip] wholesale. So we (a) carry the
# last-known packages forward across packages-less pushes, and (b) persist them to disk keyed by
# serial so the debloat report survives console restarts (bloat sets are effectively static).
PACKAGES_TTL = 3600         # keep an in-memory inventory ~1h (well past the 30-min push interval)
PKGCACHE_TTL = 3 * 86400    # persisted inventory good for 3 days (bloat is static)
PKGCACHE_PATH = os.path.join(HERE, "packages_cache.json")
PKGCACHE = {}               # serial -> {"packages":[...], "ts":epoch}
PKGCACHE_LOCK = threading.Lock()
try:
    with open(PKGCACHE_PATH, "r", encoding="utf-8") as _pf:
        PKGCACHE = json.load(_pf)
except Exception:  # noqa: BLE001
    PKGCACHE = {}


def save_pkgcache(serial, packages, ts):
    with PKGCACHE_LOCK:
        PKGCACHE[serial] = {"packages": packages, "ts": ts}
        try:
            with open(PKGCACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(PKGCACHE, f)
        except Exception as e:  # noqa: BLE001
            print(f"[pkgcache] {e}")


# Foreground-loss rate: Guardian (v1.1.10+) reports cumulative `foregroundLostCount` +
# `foregroundLostSinceBoot`. The useful fleet signal is the RATE — diff the cumulative count between
# samples over their time delta → losses/hour. Keep a short rolling (ts,count) history per phone IP.
FG_HIST = {}  # ip -> [(ts, cumulativeCount), ...]
FG_HIST_LOCK = threading.Lock()
FG_RATE_WINDOW = 3600  # compute the rate over up to ~1h of recent samples

# NOTE: there is deliberately NO "auto-open Acurast on reconnect" here. The processor runs in the
# work profile (user 11) and `adb shell am start --user 11` fails with SecurityException ("Shell does
# not have permission to access user 11"). The box structurally cannot foreground it. Processor
# recovery is done ON-DEVICE by Acurast Guardian via LauncherApps (which can cross into user 11).


def adb(args, timeout=20):
    try:
        r = subprocess.run(
            [ADB, *args], capture_output=True, text=True, timeout=timeout,
        )
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def adb_bytes(args, timeout=25):
    """adb with raw binary stdout (for screencap)."""
    try:
        r = subprocess.run([ADB, *args], capture_output=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:  # noqa: BLE001
        return 1, b"", str(e).encode()


_ADB_STATES = ("device", "offline", "unauthorized", "authorizing", "recovery",
               "sideload", "bootloader", "host")


def _dedupe_base(serial):
    """Collapse an mDNS name-collision copy ('name (2)._adb-tls-connect._tcp') to its
    canonical base ('name._adb-tls-connect._tcp'). Android sometimes registers the wireless-
    debugging service twice; adb auto-connects both → two transports for one physical phone."""
    return re.sub(r"\s*\(\d+\)(\._adb-tls-connect\._tcp)$", r"\1", serial)


def refresh_devices():
    _, out, _ = adb(["devices", "-l"])
    now = time.time()
    parsed = []
    for line in out.splitlines()[1:]:
        if not line.strip():
            continue
        toks = line.split()
        # A serial can contain spaces (mDNS instance names) → serial is everything before the
        # state token; splitting on the state keyword avoids truncating a "(2)" serial mid-way.
        idx = next((i for i, t in enumerate(toks) if t in _ADB_STATES), None)
        if not idx:  # None, or state at index 0 (no serial) → skip
            continue
        serial = " ".join(toks[:idx])
        state = toks[idx]
        model = ""
        for p in toks[idx + 1:]:
            if p.startswith("model:"):
                model = p.split(":", 1)[1]
        parsed.append((serial, state, model))

    # One card per phone: prefer the canonical (suffix-less) serial; drop "(N)" mDNS shadows.
    bases = {}
    for serial, _state, _model in parsed:
        base = _dedupe_base(serial)
        if base not in bases or serial == base:
            bases[base] = serial
    canonical = set(bases.values())
    live = {s: (st, m) for (s, st, m) in parsed if s in canonical}

    # Drop duplicate adb TRANSPORTS for the same phone: an mDNS "(N)" shadow whose clean twin is
    # also connected. The console dedupes its own cards, but ws-scrcpy reads adb directly and treats
    # the shadow as a second device -> it starts a SECOND scrcpy server on the same handset -> port
    # 8886 collides ("java.net.BindException: Address already in use") and live view breaks fleet-wide.
    # Only disconnect when the clean twin is present, so a phone connected solely via a shadow stays.
    _all = {sv for (sv, _st, _m) in parsed}
    _dups = [sv for sv in _all if _dedupe_base(sv) != sv and _dedupe_base(sv) in _all]
    if _dups:
        def _drop_dup_transports(items):
            for sv in items:
                adb(["disconnect", sv], timeout=6)
            print(f"[dedupe] disconnected {len(items)} duplicate adb transport(s)")
        threading.Thread(target=_drop_dup_transports, args=(_dups,), daemon=True).start()

    with STATE_LOCK:
        def blank(serial, label):
            saved = DEVICE_STATE.get(serial, {})
            return {
                "serial": serial, "label": label, "state": "offline", "model": "",
                "last_seen": 0, "action": "", "version": "", "versionCode": 0,
                "inWorkProfile": False, "versionCheckedAt": 0,
                "address": saved.get("address") or ADDR.get(serial, ""),
                "guardianArmed": saved.get("guardianArmed", False),
                "guardianVersion": saved.get("guardianVersion", ""),
                "alias": saved.get("alias", ""),
                "codename": saved.get("codename", ""),
                "buildId": saved.get("buildId", ""),
            }
        # Ensure configured devices always show, even when offline.
        for host, label in LABELS.items():
            STATE.setdefault(host, blank(host, label))
        newly_online = []
        for serial, (state, model) in live.items():
            d = STATE.setdefault(serial, blank(serial, LABELS.get(serial, serial)))
            prev = d.get("state")
            d["state"] = state
            if model:
                d["model"] = model
            d["last_seen"] = now
            if state == "device":
                LAST_ONLINE[serial] = now
            if state == "device" and prev != "device":
                newly_online.append(serial)  # offline→online transition (e.g. post-reboot)
                if d.get("action") == "rebooting":
                    d["action"] = ""  # came back online
        # Clear a stale "rebooting" flag: the device is live again and enough time has passed
        # that this can't be the pre-reboot poll. Covers the fast-reboot case the transition check
        # above misses (phone down and back between two polls, so prev was never "offline").
        for _s, _d in STATE.items():
            if _d.get("action") == "rebooting" and _s in live and live[_s][0] == "device":
                if now - (_d.get("actionTs") or 0) > 120:
                    _d["action"] = ""
                    _d.pop("actionTs", None)

        # Mark configured-but-not-live as offline.
        for serial, d in STATE.items():
            if serial not in live and d["action"] != "rebooting":
                d["state"] = "offline"
        # Auto-sweep stale (N) mDNS shadow cards whose CLEAN twin is currently online — leftover
        # ghosts after churn (the real phone reports under the clean serial). _dedupe_base(s)!=s
        # means s is an (N) copy; only drop it when its clean base is a live transport, so we never
        # remove a phone whose only card happens to be a shadow.
        # Drop any offline card whose physical phone IS live under some other serial form.
        # Symmetric on purpose: the phone may be live under the clean serial while an "(N)" shadow
        # card lingers, OR live under the shadow while the CLEAN card lingers (seen with 2 phones
        # whose adb transport moved to "(2)" — telemetry stayed fresh, but the clean card sat
        # offline forever because the old rule only swept in one direction).
        _live_bases = {_dedupe_base(sv) for sv in live}
        for _s in [x for x in list(STATE)
                   if x not in live and _dedupe_base(x) in _live_bases]:
            STATE.pop(_s, None)
        # Also sweep stale "ip:port" ghost cards left by a manual `adb connect <ip:port>` once the
        # same phone is back on a stable guid serial. Keyed on the IP: if an offline ip:port card
        # shares its IP with a live guid transport, the guid card is the real one.
        _live_ips = {SERIAL_IP.get(sv) for sv in live if SERIAL_IP.get(sv)}
        for _s in [x for x in list(STATE)
                   if x not in live and re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", x)
                   and x.split(":")[0] in _live_ips]:
            STATE.pop(_s, None)

    # After a reboot the N159V wipes the SYSTEM_ALERT_WINDOW appop, which BAL-blocks Guardian's
    # on-screen recovery. Re-assert it (backgrounded) whenever a device comes back online.
    if (newly_online and GUARDIAN_REPO
            and CFG.get("guardian_update", {}).get("reassert_overlay_on_reconnect", True)):
        threading.Thread(target=reassert_guardian_overlay, args=(newly_online,), daemon=True).start()
    if newly_online:  # read each newly-connected phone's processor address (for the Pulse link)
        threading.Thread(target=scan_addresses, args=(newly_online,), daemon=True).start()
        threading.Thread(target=scan_variants, args=(newly_online,), daemon=True).start()


def connect(host, timeout=6):
    code, out, err = adb(["connect", host], timeout=timeout)
    return code == 0 and "connected" in (out + err).lower(), (out or err)


def pair_device(host, code):
    """One-time Wireless-Debugging pairing for a new phone. Users frequently paste the CONNECT port
    (from the main WD screen) instead of the PAIRING port (from the 'Pair device with pairing code'
    dialog) — pairing to the connect port fails with 'protocol fault … Success'. So we auto-resolve
    the real _adb-tls-pairing port from mDNS by IP, meaning either port (or just the IP) works."""
    ip = host.split(":")[0].strip()
    pair_host, resolved = host, None
    _, mout, _ = adb(["mdns", "services"], timeout=10)
    for line in mout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and "_adb-tls-pairing._tcp" in parts[1] and parts[2].startswith(ip + ":"):
            resolved = parts[2]
            break
    if resolved:
        pair_host = resolved
    rc, out, err = adb(["pair", pair_host, code], timeout=20)
    ok = "Successfully paired" in (out + " " + err)
    msg = (out or err).strip()
    if ok and resolved and resolved != host:
        msg += f"  (auto-resolved pairing port :{resolved.split(':')[1]})"
    elif not ok and not resolved:
        msg += ("  — no pairing service found for this IP. On the phone, open "
                "'Pair device with pairing code' again and enter the IP + code it shows.")
    return ok, msg


def discover_pairing():
    """List phones currently in Wireless-Debugging pairing mode (advertising _adb-tls-pairing).
    We get IP + adb serial pre-pairing; the friendly model only exists once a phone is connected,
    so we backfill model/label from STATE when the serial is already known."""
    _, out, _ = adb(["mdns", "services"], timeout=10)
    seen = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and "_adb-tls-pairing._tcp" in parts[1] and ":" in parts[2]:
            serial = parts[0]                        # adb-<HWID>-<key>
            ip, _, port = parts[2].partition(":")
            connect_serial = serial + "._adb-tls-connect._tcp"
            with STATE_LOCK:
                d = STATE.get(connect_serial, {})
                model, label = d.get("model", ""), d.get("label", "")
            seen[parts[2]] = {"serial": serial, "ip": ip, "port": port,
                              "host": parts[2], "model": model, "label": label}
    return list(seen.values())


def discover_mdns():
    """Poke adb's mDNS so it discovers wireless-debugging phones. We deliberately do NOT
    `adb connect <ip:port>` here: the adb server, run with ADB_MDNS_AUTO_CONNECT=_adb-tls-connect,
    auto-connects each phone under its STABLE guid serial (adb-<HWID>-<pairkey>._adb-tls-connect._tcp)
    which survives reboots. Connecting the ip:port too would list every phone twice (the ip:port
    changes on each WD restart). (Verified on the live fleet — do not regress this.)"""
    _, out, _ = adb(["mdns", "services"], timeout=12)
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and "_adb-tls-connect._tcp" in parts[1]:
            serial = parts[0] + "." + parts[1]  # full adb transport serial form
            ip = parts[2].split(":")[0]
            if ip:
                SERIAL_IP[serial] = ip


def parse_csv(text):
    """Tolerant CSV/host-list parser → [{label, host}]. Accepts 'label,host', bare hosts, or IPs.
    Missing ports default to :5555. A header row (label/host/ip) is skipped."""
    out = []
    for i, raw in enumerate(text.splitlines()):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",") if p.strip() != ""]
        if not parts:
            continue
        if i == 0 and parts[0][0:1].isalpha() and parts[0].lower() in ("label", "name") \
                and not any(ch.isdigit() for ch in parts[0]):
            continue  # header row
        address = ""
        if len(parts) == 1:
            host = parts[0]
            label = host
        else:
            label, host = parts[0], parts[1]
            if len(parts) >= 3:
                address = parts[2]
        if not host:
            continue
        # Bare IP/hostname → default the adb port. But NOT for mDNS guid serials
        # (adb-<HWID>-<key>._adb-tls-connect._tcp) — those are the console's device key verbatim.
        if ":" not in host and "._tcp" not in host:
            host = host + ":5555"
        entry = {"label": label, "host": host}
        if address:
            entry["address"] = address
        out.append(entry)
    return out


def apply_devices(new_devices, replace):
    """Merge or replace the configured device list and persist devices.json."""
    global LABELS, ADDR
    with STATE_LOCK:
        if replace:
            CFG["devices"] = list(new_devices)
        else:
            merged = {d["host"]: d for d in CFG.get("devices", []) if "host" in d}
            for d in new_devices:
                # Preserve a prior address if the new import row omits it.
                if not d.get("address") and merged.get(d["host"], {}).get("address"):
                    d["address"] = merged[d["host"]]["address"]
                merged[d["host"]] = d
            CFG["devices"] = list(merged.values())
        LABELS = {d["host"]: d.get("label", d["host"]) for d in CFG["devices"] if "host" in d}
        ADDR = {d["host"]: d.get("address", "") for d in CFG["devices"] if "host" in d}
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(CFG, f, indent=2)
        except Exception as e:  # noqa: BLE001
            print(f"[import] could not write devices.json: {e}")
    return len(CFG["devices"])


def forget_device(serial):
    """Remove a device from live state + config and drop its adb transport. For clearing
    stale/bad cards. A still-advertising device may be re-discovered on the next poll."""
    global LABELS, ADDR
    with STATE_LOCK:
        STATE.pop(serial, None)
        CFG["devices"] = [d for d in CFG.get("devices", []) if d.get("host") != serial]
        LABELS = {d["host"]: d.get("label", d["host"]) for d in CFG["devices"] if "host" in d}
        ADDR = {d["host"]: d.get("address", "") for d in CFG["devices"] if "host" in d}
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(CFG, f, indent=2)
        except Exception as e:  # noqa: BLE001
            print(f"[forget] could not write devices.json: {e}")
    adb(["disconnect", serial], timeout=6)  # best-effort; no-op for offline serials
    return True


def managed_user_ids(serial):
    """Work-profile user ids on a device (by MANAGED_PROFILE flag or name)."""
    _, out, _ = adb(["-s", serial, "shell", "pm", "list", "users"], timeout=12)
    ids = []
    for line in out.splitlines():
        m = re.search(r"UserInfo\{(\d+):([^:]*):([0-9a-fA-F]+)\}", line)
        if not m:
            continue
        uid, name, flags = int(m.group(1)), m.group(2), m.group(3)
        managed = ("work" in name.lower() or "managed" in name.lower())
        try:
            managed = managed or bool(int(flags, 16) & FLAG_MANAGED_PROFILE)
        except ValueError:
            pass
        if uid != 0 and managed:
            ids.append(uid)
    return ids


def read_version(serial):
    """Return {versionName, versionCode, usersInstalled:[...]} for the target, or None."""
    code, out, _ = adb(["-s", serial, "shell", "dumpsys", "package", TARGET_PKG], timeout=20)
    if code != 0 or "versionName" not in out:
        return None
    vname, vcode, users = "", 0, []
    for raw in out.splitlines():
        line = raw.strip()
        if line.startswith("versionName=") and not vname:
            vname = line.split("=", 1)[1].strip()
        if line.startswith("versionCode=") and vcode == 0:
            try:
                vcode = int(line.split("=", 1)[1].split()[0])
            except ValueError:
                pass
        m = re.match(r"User (\d+):", line)
        if m and "installed=true" in line:
            users.append(int(m.group(1)))
    return {"versionName": vname, "versionCode": vcode, "usersInstalled": users}


def scan_version(serial):
    info = read_version(serial)
    now = time.time()
    with STATE_LOCK:
        d = STATE.get(serial)
        if not d:
            return
        d["versionCheckedAt"] = now
        if info is None:
            d["version"] = "not installed"
            d["versionCode"] = 0
            d["inWorkProfile"] = False
            return
        d["version"] = info["versionName"] or "?"
        d["versionCode"] = info["versionCode"]
    managed = managed_user_ids(serial)
    with STATE_LOCK:
        d = STATE.get(serial)
        if d:
            d["inWorkProfile"] = any(u in (info["usersInstalled"]) for u in managed)


def scan_versions(serials):
    if not serials:
        return
    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(scan_version, serials))


# The Acurast processor logs its own on-chain address as ManagementApi "deviceAddress": "5…".
# Reading it per phone gives us the processor address → the Pulse link + backend health enrichment
# for every device (previously only the one hardcoded in devices.json).
_ADDR_RE = re.compile(r'"deviceAddress"\s*:\s*"(5[A-HJ-NP-Za-km-z1-9]{46,48})"')


def read_processor_address(serial):
    code, out, _ = adb(["-s", serial, "logcat", "-d", "-t", "3000"], timeout=20)
    if code != 0:
        return None
    found = None
    for m in _ADDR_RE.finditer(out):
        found = m.group(1)   # last (most recent) wins
    return found


def scan_address(serial):
    with STATE_LOCK:
        d = STATE.get(serial)
        if not d or d.get("address"):   # already known (configured or previously read)
            return
    addr = read_processor_address(serial)
    if addr:
        with STATE_LOCK:
            d = STATE.get(serial)
            if d and not d.get("address"):
                d["address"] = addr
                print(f"[addr] {serial[:26]} → {addr}")
        remember_device(serial, address=addr)


def scan_addresses(serials):
    with STATE_LOCK:
        todo = [s for s in serials if STATE.get(s) and not STATE[s].get("address")]
    if not todo:
        return
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(scan_address, todo))


# Hardware/firmware variant. The friendly model ("moto g pure") is NOT a safe debloat grouping key:
# one model can span carrier/firmware SKUs with different bloat sets. We key the debloat report on the
# codename (ro.product.device) and surface the build spread + per-package coverage so firmware-specific
# packages are visible, never blindly waved. Props are static until an OTA → read once, then persist.
_VARIANT_CMD = "getprop ro.product.device; echo '|'; getprop ro.build.id; echo '|'; getprop ro.product.model"


def scan_variant(serial):
    with STATE_LOCK:
        d = STATE.get(serial)
        if not d or d.get("codename"):   # already known / persisted
            return
    code, out, _ = adb(["-s", serial, "shell", _VARIANT_CMD], timeout=15)
    if code != 0 or not out:
        return
    parts = [p.strip() for p in out.split("|")]
    codename = parts[0] if len(parts) > 0 else ""
    build_id = parts[1] if len(parts) > 1 else ""
    model = (parts[2] if len(parts) > 2 else "").replace(" ", "_")
    if not codename and not build_id:
        return
    with STATE_LOCK:
        d = STATE.get(serial)
        if d:
            d["codename"] = codename
            d["buildId"] = build_id
            if model and not d.get("model"):
                d["model"] = model
    remember_device(serial, codename=codename, buildId=build_id)
    print(f"[variant] {serial[:26]} → {codename} / {build_id}")


def scan_variants(serials):
    with STATE_LOCK:
        todo = [s for s in serials if STATE.get(s) and not STATE[s].get("codename")]
    if not todo:
        return
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(scan_variant, todo))


# --- device probe: thermal + battery + cpu + wifi + screen + processor, in ONE adb shell call ---
# All reads are read-only, shell-uid (no root). Kernel thermal + /proc are direct; battery/wifi/power
# come from dumpsys (battery sysfs is SELinux-blocked on this vendor; dumpsys works for shell).
HIST_FIELDS = ["ts", "cpuTemp", "gpu", "batTemp", "level", "rssi", "loadPct", "freqMhz", "throttle"]

# Persistent metrics store (SQLite, WAL) — survives restarts and holds the retention window
# (default 7 days). One connection guarded by a lock; write rate is ~fleet/45s (trivial).
DB_PATH = os.path.join(HERE, "metrics.db")
DB_LOCK = threading.Lock()
_DB = None


def _db():
    global _DB
    if _DB is None:
        _DB = sqlite3.connect(DB_PATH, check_same_thread=False)
        _DB.execute("PRAGMA journal_mode=WAL")
        _DB.execute("PRAGMA synchronous=NORMAL")
        _DB.execute(
            "CREATE TABLE IF NOT EXISTS samples("
            "serial TEXT NOT NULL, ts INTEGER NOT NULL, cpuTemp REAL, gpu REAL, batTemp REAL, "
            "level INTEGER, rssi INTEGER, loadPct INTEGER, freqMhz INTEGER, throttle INTEGER)")
        _DB.execute("CREATE INDEX IF NOT EXISTS idx_samples_serial_ts ON samples(serial, ts)")
        _DB.commit()
    return _DB


def record_sample(serial, sample):  # sample = HIST_FIELDS values in order
    with DB_LOCK:
        _db().execute(
            "INSERT INTO samples(serial,ts,cpuTemp,gpu,batTemp,level,rssi,loadPct,freqMhz,throttle)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)", [serial] + sample)
        _db().commit()


def prune_samples():
    days = max(1, int(CFG.get("metrics_retention_days", 7)))
    cutoff = int(time.time()) - days * 86400
    with DB_LOCK:
        _db().execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
        _db().commit()


def query_history(hours):
    cutoff = int(time.time()) - int(hours * 3600)
    with DB_LOCK:
        cur = _db().execute(
            "SELECT serial,ts,cpuTemp,gpu,batTemp,level,rssi,loadPct,freqMhz,throttle "
            "FROM samples WHERE ts >= ? ORDER BY serial, ts", (cutoff,))
        rows = cur.fetchall()
    hist = {}
    for r in rows:
        hist.setdefault(r[0], []).append(list(r[1:]))
    return hist

_PROBE_CMD = (
    "echo @T; for z in /sys/class/thermal/thermal_zone*; do echo \"$(cat $z/type)=$(cat $z/temp)\"; done; "
    "echo @BAT; dumpsys battery; "
    "echo \"@LOAD=$(cat /proc/loadavg 2>/dev/null)\"; "
    "echo \"@UP=$(cat /proc/uptime 2>/dev/null)\"; "
    "echo \"@NPROC=$(nproc 2>/dev/null)\"; "
    "echo \"@GOV=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null)\"; "
    "echo @FREQ; for c in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do cat $c 2>/dev/null; done; "
    "echo @WIFI; dumpsys wifi 2>/dev/null | grep -m1 'mWifiInfo SSID:'; "
    "echo \"@WAKE=$(dumpsys power 2>/dev/null | grep -m1 mWakefulness=)\"; "
    "echo \"@THROT=$(dumpsys thermalservice 2>/dev/null | grep -m1 'Thermal Status:')\"; "
    "echo \"@PROC=$(pidof " + TARGET_PKG + " 2>/dev/null)\""
)
_THROTTLE_NAMES = {0: "NONE", 1: "LIGHT", 2: "MODERATE", 3: "SEVERE", 4: "CRITICAL",
                   5: "EMERGENCY", 6: "SHUTDOWN"}
_BATT_STATUS = {1: "unknown", 2: "charging", 3: "discharging", 4: "not-charging", 5: "full"}
_BATT_HEALTH = {1: "unknown", 2: "good", 3: "overheat", 4: "dead", 5: "over-voltage", 6: "failure", 7: "cold"}


def _thermal_from_zones(zones):
    if not zones:
        return None
    cpu_zones = [c for n, c in zones.items() if "cpu" in n.lower()]
    hot = max(zones, key=zones.get)
    return {"cpu": max(cpu_zones) if cpu_zones else None, "gpu": zones.get("gpu"),
            "battery": zones.get("battery"), "hottest": {"zone": hot, "c": zones[hot]},
            "checkedAt": time.time()}


def _parse_probe(out):
    """Parse the compound probe output into (temps, metrics)."""
    sec, zones, batt, freqs, wifi_line, kv = None, {}, {}, [], "", {}
    for raw in out.splitlines():
        line = raw.rstrip()
        s = line.strip()
        if s.startswith("@"):
            head = s[1:].split("=", 1)[0]
            if head in ("LOAD", "UP", "NPROC", "GOV", "WAKE", "PROC", "THROT"):
                kv[head] = s.split("=", 1)[1] if "=" in s else ""
                sec = None
            else:
                sec = head  # T / BAT / FREQ / WIFI
            continue
        if sec == "T":
            name, eq, val = s.partition("=")
            try:
                c = int(val.strip()) / 1000.0
            except ValueError:
                continue
            if name and -10 <= c <= 150:
                zones[name] = round(c, 1)
        elif sec == "BAT":
            k, eq, v = s.partition(":")
            if eq:
                batt[k.strip()] = v.strip()
        elif sec == "FREQ":
            if s.isdigit():
                freqs.append(int(s))
        elif sec == "WIFI":
            if "mWifiInfo" in s:
                wifi_line = s

    def bi(key):
        try:
            return int(batt.get(key, ""))
        except ValueError:
            return None
    status = bi("status")
    plugged = ("usb" if batt.get("USB powered") == "true"
               else "ac" if batt.get("AC powered") == "true"
               else "wireless" if batt.get("Wireless powered") == "true" else None)
    volt = bi("voltage")
    temp = bi("temperature")
    battery = {
        "level": bi("level"), "status": _BATT_STATUS.get(status, str(status)),
        "charging": status in (2, 5) or bool(plugged and status != 3),
        "plugged": plugged, "health": _BATT_HEALTH.get(bi("health"), None),
        "tempC": round(temp / 10.0, 1) if temp is not None else None,
        "voltageV": round(volt / 1000.0, 2) if volt is not None else None,
        "chargeCounter": bi("Charge counter"), "maxChargeMa":
            (bi("Max charging current") // 1000 if bi("Max charging current") else None),
    }
    load1 = None
    try:
        load1 = float(kv.get("LOAD", "").split()[0])
    except (ValueError, IndexError):
        pass
    try:
        nproc = int(kv.get("NPROC", "") or 0)
    except ValueError:
        nproc = 0
    freq_mhz = sorted({round(f / 1000) for f in freqs}) if freqs else []
    wm = re.search(r"mWakefulness=(\w+)", kv.get("WAKE", ""))
    tm = re.search(r"Thermal Status:\s*(\d+)", kv.get("THROT", ""))
    throttle_lvl = int(tm.group(1)) if tm else None
    proc_pid = (kv.get("PROC", "") or "").strip().split()
    wifi = {}
    if wifi_line:
        for key, rx in (("rssi", r"RSSI:\s*(-?\d+)"), ("linkMbps", r"Link speed:\s*(\d+)"),
                        ("freqMhz", r"Frequency:\s*(\d+)"), ("ssid", r'SSID:\s*"([^"]*)"')):
            m = re.search(rx, wifi_line)
            if m:
                wifi[key] = m.group(1) if key == "ssid" else int(m.group(1))
        if wifi.get("freqMhz"):
            wifi["band"] = "5G" if wifi["freqMhz"] >= 4900 else ("6G" if wifi["freqMhz"] >= 5925 else "2.4G")
    try:
        uptime = int(float(kv.get("UP", "").split()[0]))
    except (ValueError, IndexError):
        uptime = None
    metrics = {
        "battery": battery,
        "cpu": {"load1": load1, "loadPct": round(load1 / nproc * 100) if (load1 and nproc) else None,
                "nproc": nproc or None, "freqMhz": freq_mhz,
                "maxFreqMhz": max(freq_mhz) if freq_mhz else None, "governor": kv.get("GOV") or None},
        "wifi": wifi or None,
        "wake": wm.group(1) if wm else None,
        "throttle": ({"level": throttle_lvl, "name": _THROTTLE_NAMES.get(throttle_lvl, str(throttle_lvl))}
                     if throttle_lvl is not None else None),
        "proc": {"alive": bool(proc_pid), "pid": int(proc_pid[0]) if proc_pid else None},
        "uptimeSec": uptime,
        "checkedAt": time.time(),
    }
    return _thermal_from_zones(zones), metrics


def probe_device(serial):
    code, out, _ = adb(["-s", serial, "shell", _PROBE_CMD], timeout=25)
    if code != 0 or "@BAT" not in out:
        return
    temps, metrics = _parse_probe(out)
    with STATE_LOCK:
        d = STATE.get(serial)
        if d is None:
            return
        d["temps"] = temps
        d["metrics"] = metrics
    # Record a history sample for EVERY probed phone. Many OEMs (Motorola/Nokia) SELinux-block the
    # kernel thermal zones, so cpuTemp is None there — but we still have battery temp (dumpsys),
    # CPU load, battery level and RSSI, all worth charting. Fall back to the dumpsys battery temp.
    batt = metrics.get("battery") or {}
    cpu = metrics.get("cpu") or {}
    bat_temp = (temps or {}).get("battery")
    if bat_temp is None:
        bat_temp = batt.get("tempC")
    rssi = (metrics.get("wifi") or {}).get("rssi")
    thr = (metrics.get("throttle") or {}).get("level")
    sample = [int(time.time()), (temps or {}).get("cpu"), (temps or {}).get("gpu"), bat_temp,
              batt.get("level"), rssi, cpu.get("loadPct"), cpu.get("maxFreqMhz"), thr]
    if any(v is not None for v in sample[1:]):  # skip only if we truly captured nothing
        try:
            record_sample(serial, sample)
        except Exception as e:  # noqa: BLE001
            print(f"[metrics-db] {e}")


def probe_devices(serials):
    if not serials:
        return
    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(probe_device, serials))


PULSE_HEALTH = {}          # processorId (SS58) -> {overallStatus, riskScore, worstDeltaRatio, ...}
PULSE_HEALTH_SUMMARY = {}  # {healthy, watch, investigate, processorCount, fetchedAt}
PULSE_LOCK = threading.Lock()


def fetch_pulse_health():
    """Pull per-processor health from Pulse (/api/managers/<id>/benchmark-health).

    NOTE: the site sits behind Cloudflare, which 403s the default urllib User-Agent — a UA header is
    REQUIRED. Statuses are healthy | watch | investigate; we keep the non-healthy ones and join them
    onto device cards by on-chain address so a degraded processor maps to a physical handset."""
    cfg = CFG.get("pulse_health", {}) or {}
    base = (cfg.get("base_url") or "").strip().rstrip("/")
    mgr = str(cfg.get("manager_id") or "").strip()
    if not base or not mgr:
        return
    url = f"{base}/api/managers/{urllib.parse.quote(mgr)}/benchmark-health?limit=500"
    req = urllib.request.Request(url, headers={"User-Agent": "AcurastFleetConsole/1.0",
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    items = data.get("items") or []
    idx = {}
    for it in items:
        pid = it.get("processorId")
        if pid:
            idx[pid] = {"status": it.get("overallStatus"), "risk": it.get("riskScore"),
                        "worstDelta": it.get("worstDeltaRatio"),
                        "lowConfidence": bool(it.get("lowConfidence"))}
    summary = dict(data.get("summary") or {})
    summary["fetchedAt"] = time.time()
    with PULSE_LOCK:
        PULSE_HEALTH.clear()
        PULSE_HEALTH.update(idx)
        PULSE_HEALTH_SUMMARY.clear()
        PULSE_HEALTH_SUMMARY.update(summary)


def pulse_health_loop():
    time.sleep(10)
    while True:
        try:
            fetch_pulse_health()
        except Exception as e:  # noqa: BLE001
            print(f"[pulse-health] {e}")
        # Re-read each pass: captured once, a Setup save would not reach this loop until restart.
        time.sleep(max(60, int((CFG.get("pulse_health", {}) or {}).get("poll_seconds", 300))))


def thermal_loop():
    interval = max(15, int(CFG.get("thermal_poll_seconds", 45)))
    try:
        _db()
        prune_samples()
    except Exception as e:  # noqa: BLE001
        print(f"[metrics-db] init: {e}")
    last_prune = time.time()
    time.sleep(8)  # let the first adb poll connect devices
    while True:
        try:
            with STATE_LOCK:
                online = [s for s, d in STATE.items() if d.get("state") == "device"]
            probe_devices(online)
            if time.time() - last_prune > 3600:  # trim beyond the retention window hourly
                prune_samples()
                last_prune = time.time()
        except Exception as e:  # noqa: BLE001
            print(f"[probe] {e}")
        time.sleep(interval)


def _http_get_json(url, headers, timeout=15):
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _index_by_address(payload):
    """Index a backend response by 'address'. The real Acurast mgmt backend returns
    {"processorStatuses": {addr: {...}}}; we also handle list / {data:[...]} / {statuses:[...]} /
    {addr:{...}}. (Verified against the live :3010 backend — do not regress this.)"""
    items = []
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        inner = None
        for key in ("processorStatuses", "data", "statuses"):
            if key in payload:
                inner = payload[key]
                break
        container = inner if inner is not None else payload
        if isinstance(container, list):
            items = container
        elif isinstance(container, dict):
            for k, v in container.items():
                if isinstance(v, dict):
                    v.setdefault("address", k)
                    items.append(v)
    out = {}
    for it in items:
        if isinstance(it, dict) and it.get("address"):
            out[it["address"]] = it
    return out


def _acurast_headers():
    key = (CFG.get("acurast_backend", {}).get("api_key") or "").strip()
    h = {"Accept": "application/json"}
    if key:
        h["X-Api-Key"] = key  # only sent if configured; the tailnet backend is unauthenticated
    return h


def fetch_manager_processors(base, manager):
    """List all processor addresses under a manager/owner address (auto-fleet discovery)."""
    url = f"{base}/processor/api/manager/{urllib.parse.quote(manager)}/processors"
    try:
        data = _http_get_json(url, _acurast_headers())
    except Exception as e:  # noqa: BLE001
        print(f"[acurast-manager] {e}")
        return []
    out = []
    items = data if isinstance(data, list) else (data.get("data") or data.get("processors") or [])
    for it in items:
        if isinstance(it, str):
            out.append(it)
        elif isinstance(it, dict):
            a = it.get("address") or it.get("processor") or it.get("processorAddress")
            if a:
                out.append(a)
    return out


MANAGER_ADDRS = []                    # cached manager processor address list
MANAGER_ADDRS_LOCK = threading.Lock()


def resolve_partial_address(partial):
    """v1.1.15: Lite shows a truncated 'prefix<ellipsis>suffix' address on its main screen; Guardian's
    a11y service scrapes it into telemetry as processorAddressPartial (no cross-user read needed).
    Resolve it to the full on-chain address against the manager's processor list. Returns the full
    address ONLY on a UNIQUE match; ambiguous/none -> None so the caller keeps the logcat fallback."""
    if not partial:
        return None
    p = str(partial).strip()
    ell = chr(0x2026)                 # Lite uses the single-glyph ... (U+2026); also accept literal ...
    sep = ell if ell in p else ("..." if "..." in p else None)
    if not sep:
        return None
    bits = p.split(sep)
    if len(bits) != 2:
        return None
    pre, suf = bits[0].strip(), bits[1].strip()
    if not pre or not suf:
        return None
    with MANAGER_ADDRS_LOCK:
        cand = [a for a in MANAGER_ADDRS if a.startswith(pre) and a.endswith(suf)]
    return cand[0] if len(cand) == 1 else None


def fetch_acurast_status(base, addresses):
    if not addresses:
        return
    joined = ",".join(addresses)
    url = f"{base}/processor/api/status/bulk?addresses={urllib.parse.quote(joined)}"
    try:
        data = _http_get_json(url, _acurast_headers())
    except Exception as e:  # noqa: BLE001
        print(f"[acurast] {e}")
        return
    indexed = _index_by_address(data)
    now = time.time()
    with STATE_LOCK:
        for addr, status in indexed.items():
            status["_recv"] = now
            ACURAST[addr] = status


def acurast_loop():
    be = CFG.get("acurast_backend", {})
    base = (be.get("base_url") or "").strip().rstrip("/")
    if not base:
        return  # not configured
    interval = max(20, int(be.get("poll_seconds", 60)))
    manager = (be.get("manager_address") or "").strip()
    while True:
        try:
            addrs = {a for a in ADDR.values() if a}
            if manager:
                _mgr = fetch_manager_processors(base, manager)
                if _mgr:
                    with MANAGER_ADDRS_LOCK:
                        MANAGER_ADDRS[:] = _mgr
                addrs |= set(_mgr)
            addrs = sorted(addrs)
            for i in range(0, len(addrs), 100):  # chunk to keep query strings sane
                fetch_acurast_status(base, addrs[i:i + 100])
        except Exception as e:  # noqa: BLE001
            print(f"[acurast-loop] {e}")
        time.sleep(interval)


def version_loop():
    last_guardian = 0.0
    while True:
        time.sleep(90)
        try:
            with STATE_LOCK:
                online = [s for s, d in STATE.items() if d.get("state") == "device"]
            scan_versions(online)
            scan_addresses(online)  # read each processor's on-chain address from logcat
            # guardianVersion is otherwise only written on arm/provision or a manual
            # /api/guardian/scan, so a phone updated out-of-band reports its old build forever.
            if time.time() - last_guardian >= GUARDIAN_SCAN_INTERVAL:
                scan_guardians(online)
                last_guardian = time.time()
        except Exception as e:  # noqa: BLE001
            print(f"[version] {e}")


def reboot(serial, force=False):
    # A phone in a maintenance window has had recovery paused deliberately by an operator. Rebooting
    # into that window costs them the rest of it: Guardian restores the window on boot, stays
    # correctly paused, and therefore never launches Lite, so the phone does not earn until expiry
    # (measured 2026-08-08 on v1.1.45). Windows stay sacred unless the caller says otherwise —
    # send EXIT_MAINTENANCE first, or pass force=True, when the reboot genuinely must win.
    if not force and _in_maintenance(serial):
        return False, "skipped: phone is in maintenance mode (exit maintenance first, or pass force)"
    with STATE_LOCK:
        if serial in STATE:
            STATE[serial]["action"] = "rebooting"
            STATE[serial]["actionTs"] = time.time()
    code, out, err = adb(["-s", serial, "reboot"], timeout=20)
    return code == 0, (out or err)


def reboot_batch(serials, wave_size, wave_delay, force=False):
    # Pre-filter so the caller gets immediate feedback about what will not be rebooted; each phone is
    # re-checked at reboot time too, so one that enters maintenance mid-batch is still protected.
    skipped = [] if force else [s for s in serials if _in_maintenance(s)]
    targets = [s for s in serials if s not in skipped]
    if skipped:
        print(f"[reboot] skipped {len(skipped)} phone(s) in maintenance mode: "
              f"{[s[4:18] for s in skipped]}")

    def worker():
        for i in range(0, len(targets), wave_size):
            wave = targets[i:i + wave_size]
            for s in wave:
                reboot(s, force=force)
            if i + wave_size < len(targets):
                time.sleep(max(1, wave_delay))
    threading.Thread(target=worker, daemon=True).start()
    return skipped


def poll_loop():
    """Refresh state first (one fast `adb devices` call) so the UI is always current, then attempt
    reconnects in PARALLEL — otherwise 130 offline devices would serialize for many minutes."""
    while True:
        try:
            refresh_devices()
            with STATE_LOCK:
                need = [h for h in LABELS if STATE.get(h, {}).get("state") != "device"]
            if need:
                with ThreadPoolExecutor(max_workers=24) as ex:
                    list(ex.map(lambda h: connect(h, timeout=6), need))
            if CFG.get("mdns_autoconnect", True):
                discover_mdns()
            if need:
                refresh_devices()  # pick up anything that just connected
        except Exception as e:  # noqa: BLE001
            print(f"[poll] {e}")
        time.sleep(max(3, int(CFG.get("poll_seconds", 6))))


# ---------------------------------------------------------------- remote control

def _capture_png(serial):
    code, out, _ = adb_bytes(["-s", serial, "exec-out", "screencap", "-p"], timeout=25)
    if code == 0 and out[:8] == b"\x89PNG\r\n\x1a\n":
        return out
    return None


# Empirical split on this fleet (720x1440 and 720x1600 panels): a screensaver frame lands at
# 15-22 KB, a rendered Lite screen at 85-102 KB. 45 KB sits clear of both, and the cost of being
# wrong either way is one extra capture.
SCREENSAVER_BLANK_MAX_BYTES = 45_000


def screenshot_png(serial):
    """Silent screenshot via adb (shell uid — no MediaProjection consent needed). Returns PNG bytes.

    Guardian's black screensaver (v1.1.21+) covers the screen while Lite is foreground, so with it
    enabled every capture came back ~99% black and the wall looked like it was failing. When the
    fleet screensaver is on we briefly drop the overlay for this phone, capture, then restore it —
    deterministic, and safer than injecting a "tap to peek" that could land on Lite's UI."""
    with SCREENSAVER_LOCK:
        peek = bool(SCREENSAVER.get("enabled"))

    if not peek:
        # The flag says no overlay — but trust the frame, not the flag. A screensaver frame is
        # near-black and compresses to a fraction of a real UI capture, so a suspiciously small
        # PNG means the overlay is up regardless of what the console believes.
        png = _capture_png(serial)
        if not png or len(png) >= SCREENSAVER_BLANK_MAX_BYTES:
            return png
        print(f"[screenshot] {serial[4:18]} looks like a screensaver frame "
              f"({len(png)} B) — dropping the overlay and retrying")

    screensaver_one(serial, False)
    try:
        time.sleep(0.4)          # let the overlay tear down before grabbing the frame
        return _capture_png(serial)
    finally:
        screensaver_one(serial, True)   # always restore, even if the capture blew up


def run_device_action(serial, action, command):
    """Run one remote action on a device. Returns {serial, ok, output}."""
    if action == "wake":
        code, out, err = adb(["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"])
    elif action == "open_acurast":
        # NOT POSSIBLE FROM THE BOX. The processor is in the work profile (user 11) and
        # `am start --user 11` fails with SecurityException ("Shell does not have permission to
        # access user 11"). Foregrounding the processor is done ON-DEVICE by Acurast Guardian via
        # LauncherApps. This action is kept only to return a clear explanation if invoked.
        code, out, err = (1, "",
                          "Cannot foreground the processor from the box: shell can't access the "
                          "work profile (user 11). Guardian handles this on-device via LauncherApps.")
    elif action == "logcat":
        code, out, err = adb(["-s", serial, "logcat", "-d", "-t", "300"], timeout=20)
    elif action == "shell":
        # The full command string is parsed by the device shell (preserves quotes/pipes).
        code, out, err = adb(["-s", serial, "shell", command or ""], timeout=25)
    else:
        code, out, err = (1, "", "unknown action")
    text = (out or err or "")
    if len(text) > 4000:
        text = text[:4000] + "\n…(truncated)"
    return {"serial": serial, "ok": code == 0, "output": text}


def run_action_bulk(serials, action, command):
    if not serials:
        return []
    with ThreadPoolExecutor(max_workers=16) as ex:
        return list(ex.map(lambda s: run_device_action(s, action, command), serials))


SCRCPY_JAR = "/data/local/tmp/scrcpy-server.jar"
SCRCPY_CMD = (f"CLASSPATH={SCRCPY_JAR} nohup app_process / com.genymobile.scrcpy.Server "
              "1.19-ws7 web ERROR 8886 true 2>&1 > /dev/null")
SCRCPY_PORT_HEX = ":22B6"   # 8886, as it appears in /proc/net/tcp
# ws-scrcpy pushes this itself only on a device it has already streamed, so freshly-onboarded phones
# arrive without it and live view fails outright ("Aborted"). Push it at provision time instead —
# this has silently broken live view on two separate batches of new phones.
SCRCPY_JAR_SRC = os.path.expanduser(
    "~/ws-scrcpy/dist/vendor/Genymobile/scrcpy/scrcpy-server.jar")


def ensure_scrcpy_jar(serial):
    """Push the scrcpy server jar if the phone doesn't have it. Best-effort: never fails provisioning."""
    try:
        if not os.path.isfile(SCRCPY_JAR_SRC):
            return False
        _, out, _ = adb(["-s", serial, "shell", f"ls {SCRCPY_JAR} 2>/dev/null | wc -l"], timeout=12)
        if (out or "").strip().isdigit() and int(out.strip()) > 0:
            return False                      # already there
        code, _, _ = adb(["-s", serial, "push", SCRCPY_JAR_SRC, SCRCPY_JAR], timeout=45)
        if code == 0:
            adb(["-s", serial, "shell", f"chmod 644 {SCRCPY_JAR}"], timeout=12)
            print(f"[scrcpy] pushed server jar to {serial[:26]}")
            return True
    except Exception as e:  # noqa: BLE001
        print(f"[scrcpy] jar push skipped for {serial[:26]}: {e}")
    return False


def live_prep(serial, wait_s=12):
    """Pre-start the scrcpy server so the viewer never races it.

    These phones run load 14-17 and swap, so the JVM (`app_process`) can take >3s to bind 8886.
    ws-scrcpy's client tries to connect before that and the websocket upgrade fails — which is why
    live view worked on some phones and not others, varying per attempt. ws-scrcpy discovers servers
    with `ps -A | grep <name>` regardless of who started them, so starting it here is reused, not
    duplicated (a second start would collide on 8886)."""
    def running():
        _, out, _ = adb(["-s", serial, "shell",
                         "ps -A -o ARGS | grep com.genymobile.scrcpy | grep -v grep | wc -l"], timeout=12)
        return (out or "").strip().isdigit() and int(out.strip()) > 0

    def listening():
        # the server binds IPv6 on these phones, so tcp6 must be checked too (tcp4 alone reads 0)
        _, out, _ = adb(["-s", serial, "shell",
                         f"cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep -ci {SCRCPY_PORT_HEX}"], timeout=12)
        return (out or "").strip().isdigit() and int(out.strip()) > 0

    already = running()
    if not already:
        # blocks while the server runs -> fire and forget; we poll for the listening socket below
        threading.Thread(target=lambda: adb(["-s", serial, "shell", SCRCPY_CMD], timeout=wait_s + 20),
                         daemon=True).start()
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if listening():
            return {"serial": serial, "ok": True, "reused": already, "waited": round(time.time() - (deadline - wait_s), 1)}
        time.sleep(0.5)
    return {"serial": serial, "ok": False, "reused": already,
            "message": f"scrcpy server did not bind 8886 within {wait_s}s"}


MAX_WALL = 24  # cap concurrent screenshots per wall request (payload + box load)


def screenshot_batch(serials):
    """Capture screenshots for up to MAX_WALL devices in parallel → [{serial, ok, png(base64)}]."""
    serials = serials[:MAX_WALL]

    def cap(s):
        png = screenshot_png(s)
        return {"serial": s, "ok": bool(png),
                "png": base64.b64encode(png).decode() if png else None}

    with ThreadPoolExecutor(max_workers=6) as ex:
        return list(ex.map(cap, serials))


# ---------------------------------------------------------------- OTA / auto-update

def _semver_tuple(v):
    nums = re.findall(r"\d+", v or "")
    nums = [int(x) for x in nums[:3]]
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def _u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def _u64(b, o):
    return struct.unpack_from("<Q", b, o)[0]


def _len_prefixed_seq(buf):
    """Yield the uint32-length-prefixed elements inside a uint32-length-prefixed sequence."""
    total = _u32(buf, 0)
    o, end = 4, 4 + total
    while o < end:
        ln = _u32(buf, o)
        o += 4
        yield buf[o:o + ln]
        o += ln


def _certs_from_signers(value):
    """Extract the DER signer certificates from a v2/v3 signing block value."""
    certs = []
    for signer in _len_prefixed_seq(value):
        sd_len = _u32(signer, 0)
        signed_data = signer[4:4 + sd_len]
        o = 0
        dg_len = _u32(signed_data, o)      # skip the digests sequence
        o += 4 + dg_len
        certs_len = _u32(signed_data, o)   # the certificates sequence
        certs_block = signed_data[o:o + 4 + certs_len]
        for cert in _len_prefixed_seq(certs_block):
            certs.append(cert)
        break  # first signer is enough (matches apksigner --print-certs)
    return certs


def apk_cert_hashes(path):
    """SHA-256 of each signer cert (== `apksigner --print-certs` value). Stdlib only:
    parses the APK Signing Block (v2 id 0x7109871a / v3 0xf05368c0). Returns [] if unsigned/unreadable."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception:  # noqa: BLE001
        return []
    i = data.rfind(b"\x50\x4b\x05\x06")  # End Of Central Directory record
    if i < 0:
        return []
    cd = _u32(data, i + 16)               # central-directory offset
    if data[cd - 16:cd] != b"APK Sig Block 42":
        return []
    size2 = _u64(data, cd - 24)
    o, end = (cd - size2 - 8) + 8, cd - 24
    out = []
    while o < end:
        plen = _u64(data, o)
        o += 8
        pid = _u32(data, o)
        val = data[o + 4:o + plen]
        o += plen
        if pid in (_SIG_V2, _SIG_V3):
            for c in _certs_from_signers(val):
                out.append(hashlib.sha256(c).hexdigest())
    return out


def apk_package(path):
    """Best-effort app id from AndroidManifest.xml (binary AXML). We only need to confirm it is
    the lite package and NOT the Core/staging package — the cert check is the hard gate."""
    try:
        with zipfile.ZipFile(path) as z:
            axml = z.read("AndroidManifest.xml")
    except Exception:  # noqa: BLE001
        return ""
    text = axml.decode("utf-16-le", "ignore")  # AXML string pool is UTF-16LE
    if TARGET_PKG in text and PROCESSOR_EXCLUDE_MATCH not in text:
        return TARGET_PKG
    m = re.findall(r"com\.acurast\.attested\.executor\.[a-z0-9.]+", text)
    return m[0] if m else ""


def download_and_verify(url, asset_name):
    """Download the release APK (cached) and verify package id + signing cert. Only a file that
    passes BOTH is ever returned as installable. Returns (path, cert_ok, pkg_ok, cert_hashes)."""
    os.makedirs(APK_CACHE_DIR, exist_ok=True)
    path = os.path.join(APK_CACHE_DIR, asset_name)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        tmp = path + ".part"
        req = urllib.request.Request(
            url, headers={"Accept": "application/octet-stream", "User-Agent": "acurast-fleet-console"})
        with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(tmp, path)
    hashes = apk_cert_hashes(path)
    cert_ok = EXPECTED_CERT in hashes
    pkg_ok = (apk_package(path) == TARGET_PKG)
    return path, cert_ok, pkg_ok, hashes


def check_release():
    """Find the newest processor-lite-<ver>.apk across releases, download+verify it, and record it."""
    ucfg = CFG.get("updates", {})
    if not ucfg.get("enabled", True):
        return
    repo = ucfg.get("repo", "Acurast/acurast-processor-update")
    incl_pre = bool(ucfg.get("include_prereleases", False))
    url = f"https://api.github.com/repos/{repo}/releases?per_page=30"
    try:
        rels = _http_get_json(
            url, {"Accept": "application/vnd.github+json", "User-Agent": "acurast-fleet-console"}, timeout=25)
    except Exception as e:  # noqa: BLE001
        with RELEASE_LOCK:
            RELEASE["error"] = f"release check failed: {e}"
            RELEASE["checkedAt"] = time.time()
        return
    best = None
    for r in (rels if isinstance(rels, list) else []):
        if r.get("prerelease") and not incl_pre:
            continue
        for a in r.get("assets", []):
            m = LITE_ASSET_RE.match(a.get("name", ""))
            if not m:
                continue
            vt = _semver_tuple(m.group(1))
            if best is None or vt > best[0]:
                best = (vt, m.group(1), a.get("name"), a.get("browser_download_url"), r.get("published_at", ""))
    if not best:
        with RELEASE_LOCK:
            RELEASE["error"] = "no processor-lite asset found in releases"
            RELEASE["checkedAt"] = time.time()
        return
    _vt, ver, name, dl, pub = best
    with RELEASE_LOCK:
        cached = (RELEASE.get("versionName") == ver and RELEASE.get("ready")
                  and RELEASE.get("path") and os.path.exists(RELEASE["path"]))
    if cached:
        with RELEASE_LOCK:
            RELEASE["checkedAt"] = time.time()
            RELEASE["error"] = ""
        return
    path, cert_ok, pkg_ok, hashes, err = "", False, False, [], ""
    try:
        if ucfg.get("auto_download", True):
            path, cert_ok, pkg_ok, hashes = download_and_verify(dl, name)
    except Exception as e:  # noqa: BLE001
        err = f"download/verify failed: {e}"
    ready = bool(path and cert_ok and pkg_ok)
    if path and not ready and not err:
        err = f"verification failed (cert_ok={cert_ok}, package_ok={pkg_ok}) — NOT offered"
        print(f"[update] {name}: {err}")
    with RELEASE_LOCK:
        RELEASE.update({
            "checkedAt": time.time(), "versionName": ver, "assetName": name, "url": dl,
            "publishedAt": pub, "path": path if ready else "", "certOk": cert_ok, "packageOk": pkg_ok,
            "ready": ready, "error": err, "certHashes": hashes,
            "sizeBytes": (os.path.getsize(path) if path and os.path.exists(path) else 0),
        })
    if ready:
        print(f"[update] verified {name} ({ver}) ready to push")


def release_loop():
    if not CFG.get("updates", {}).get("enabled", True):
        return
    while True:
        mins = max(10, int(CFG.get("updates", {}).get("poll_minutes", 60)))
        try:
            check_release()
        except Exception as e:  # noqa: BLE001
            print(f"[release-loop] {e}")
        time.sleep(mins * 60)


def update_device(serial, allow_downgrade=False):
    """adb install -r the verified lite APK on one device, then re-read its version.
    pm enforces the signature match on its side too — a mismatched device install fails cleanly."""
    with RELEASE_LOCK:
        path, ready, ver = RELEASE.get("path"), RELEASE.get("ready"), RELEASE.get("versionName")
    if not (ready and path and os.path.exists(path)):
        return {"serial": serial, "ok": False, "output": "no verified update package is ready"}
    with STATE_LOCK:
        if serial in STATE:
            STATE[serial]["action"] = "updating"
    args = ["-s", serial, "install", "-r"] + (["-d"] if allow_downgrade else []) + [path]
    code, out, err = adb(args, timeout=300)
    blob = f"{out}\n{err}".strip()
    ok = code == 0 and "Success" in blob
    try:
        scan_version(serial)
    except Exception:  # noqa: BLE001
        pass
    with STATE_LOCK:
        if serial in STATE and STATE[serial].get("action") == "updating":
            STATE[serial]["action"] = ""
    return {"serial": serial, "ok": ok, "output": (f"updated → {ver}" if ok else (blob[:400] or "install failed"))}


def update_batch(serials, wave_size, wave_delay, allow_downgrade=False):
    def worker():
        for i in range(0, len(serials), wave_size):
            wave = serials[i:i + wave_size]
            with ThreadPoolExecutor(max_workers=min(len(wave), 6)) as ex:
                list(ex.map(lambda s: update_device(s, allow_downgrade), wave))
            if i + wave_size < len(serials):
                time.sleep(max(1, wave_delay))
    threading.Thread(target=worker, daemon=True).start()


# ---------------------------------------------------------------- Guardian OTA
# Pull signed Guardian release APKs from the (private) GitHub repo, SHA-256-verify, install in waves.
# NOTE: release package is com.acurast.guardian; the build currently on phones is the .debug build
# (a DIFFERENT package) — they coexist. First release installs alongside; then uninstall .debug.
GUARDIAN_CFG = CFG.get("guardian_update", {}) or {}
GUARDIAN_REPO = (GUARDIAN_CFG.get("repo") or "").strip()
GUARDIAN_PKG = (GUARDIAN_CFG.get("package") or "com.acurast.guardian").strip()
GUARDIAN_TOKEN = (GUARDIAN_CFG.get("github_token") or "").strip()
GUARDIAN_CACHE = os.path.join(HERE, GUARDIAN_CFG.get("cache_dir") or "guardian-apks")
GUARDIAN_BATCH = GUARDIAN_CFG.get("batch", {"wave_size": 6, "wave_delay_sec": 15})
# Expected signing cert of the Guardian release (from the CI pipeline). Verified in addition to SHA-256.
GUARDIAN_CERT = "98bf4ca2f18246c2df06f9e3a11ae636af4f02a2d92fc0f1c71bd56ede82691b"

# --- Setup panel: runtime-editable config ------------------------------------------------
# ONLY these paths are web-editable. bind/port/token/devices are deliberately excluded: a
# browser that can rewrite them could lock the operator out of their own console.
SETUP_GROUPS = [
    {"key": "connect", "title": "1. Connect your phones to this console",
     "blurb": "The one setting a new install actually needs. Phones use this URL to report in, "
              "and it is handed to each phone when you arm it. Use an address the phones can reach "
              "on your network — not localhost."},
    {"key": "updates", "title": "2. Guardian updates (optional)",
     "blurb": "Lets the console pull signed Guardian builds and push them to phones. Skip this and "
              "everything else still works; you just install Guardian by hand."},
    {"key": "processor", "title": "3. Processor updates",
     "blurb": "The console checks Acurast's release page hourly, downloads the newest Processor "
              "build and verifies its signature. It NEVER installs on its own — pushing to phones "
              "is always a button you press. Defaults are correct for a standard fleet."},
    {"key": "commands", "title": "4. Command channel (optional)",
     "blurb": "A shared secret lets the console send signed commands to a phone that has fallen off "
              "USB/Wi-Fi debugging. Leave blank and the channel stays switched off."},
    {"key": "pulse", "title": "5. Fleet health from Pulse (optional)",
     "blurb": "Joins on-chain reliability data to your phones so the console can show which physical "
              "device is degraded. Needs your Acurast manager id."},
    {"key": "remote", "title": "6. Remote screen (optional)",
     "blurb": "Watch and control a phone's screen from the browser. This needs ws-scrcpy — a separate "
              "open-source program you install and run yourself. It is NOT bundled with this console; "
              "the console only links to it. Leave blank if you have not set it up."},
    {"key": "advanced", "title": "7. Advanced — processor identity",
     "blurb": "Only change these if you run a different Acurast processor build. The defaults match "
              "the standard canary processor and are correct for almost everyone."},
]

# ONLY these paths are web-editable. bind/port/token/devices are deliberately excluded: a
# browser that can rewrite them could lock the operator out of their own console.
SETUP_SCHEMA = [
    {"path": "guardian_update.telemetry_url", "label": "This console's address", "kind": "text",
     "group": "connect", "required": True, "placeholder": "http://192.168.1.50:8787/api/telemetry",
     "hint": "Where phones send their status. Needed before you arm a NEW phone; phones you have "
             "already provisioned keep reporting without it. Must be reachable FROM the phones, "
             "so use this machine's LAN or VPN address, not 127.0.0.1."},

    {"path": "guardian_update.repo", "label": "Guardian release repo", "kind": "text",
     "group": "updates", "placeholder": "owner/repository",
     "hint": "GitHub repo holding signed Guardian release APKs."},
    {"path": "guardian_update.github_token", "label": "GitHub access token", "kind": "secret",
     "group": "updates",
     "hint": "Only needed if the repo is private. A fine-grained token with Contents: Read-only is "
             "enough. Stored on the console host and never shown in this browser again."},
    {"path": "guardian_update.package", "label": "Guardian app id", "kind": "text",
     "group": "updates", "default": "com.acurast.guardian",
     "hint": "Change only if you run a rebranded Guardian build."},

    {"path": "updates.auto_download", "label": "Download new builds automatically", "kind": "bool",
     "group": "processor", "default": "on",
     "hint": "Fetch and verify each new Processor release as it appears so it is ready to push. "
             "Turning this off means you press Check now yourself. Either way, nothing installs "
             "on a phone until you choose to push it."},
    {"path": "updates.repo", "label": "Processor release repo", "kind": "text",
     "group": "processor", "default": "Acurast/acurast-processor-update",
     "hint": "Acurast's public release page. No access token needed."},
    {"path": "updates.poll_minutes", "label": "Check every (minutes)", "kind": "int",
     "group": "processor", "default": "60", "hint": "Minimum 10."},
    {"path": "updates.expected_cert_sha256", "label": "Required signing key", "kind": "text",
     "group": "processor", "default": "ea21af13f3b724c662f3da05247acc5a68a45331a90220f0d90a6024d7fa8f36",
     "hint": "An APK is refused unless it is signed with this key. This is what stops a tampered "
             "build reaching your phones — only change it if you deliberately run a differently "
             "signed Processor, and get it wrong and updates will simply stop."},
    {"path": "guardian_command_secret", "label": "Command secret", "kind": "secret",
     "group": "commands",
     "hint": "Any long random string. Put the SAME value in the Guardian app when you provision it. "
             "If the two do not match, commands are ignored."},

    {"path": "pulse_health.manager_id", "label": "Your Acurast manager id", "kind": "text",
     "group": "pulse", "placeholder": "e.g. 868",
     "hint": "Found on your Acurast manager page. Leave blank to turn Pulse health off."},
    {"path": "pulse_health.base_url", "label": "Pulse site", "kind": "text",
     "group": "pulse", "default": "https://www.acurastpulse.com",
     "hint": "Only change this if you self-host Pulse."},
    {"path": "pulse_health.poll_seconds", "label": "Refresh every (seconds)", "kind": "int",
     "group": "pulse", "default": "300", "hint": "Minimum 60."},

    {"path": "ws_scrcpy_url", "label": "ws-scrcpy address", "kind": "text",
     "group": "remote", "placeholder": "http://192.168.1.50:8000",
     "hint": "Where your ws-scrcpy is listening (its default port is 8000). Blank hides the Live "
             "buttons. SECURITY: ws-scrcpy has no login of its own — anyone who can reach that port "
             "gets full control of every phone. Keep it on localhost or a VPN, or firewall the port."},

    {"path": "processor.package", "label": "Processor app id", "kind": "text",
     "group": "advanced", "default": TARGET_PKG_DEFAULT,
     "hint": "The Acurast processor this console manages and updates."},
    {"path": "processor.family_match", "label": "Processor id prefix", "kind": "text",
     "group": "advanced", "default": LITE_MATCH_DEFAULT,
     "hint": "Used to recognise the processor on screen, whichever build is installed."},
    {"path": "processor.exclude_match", "label": "Ignore this app id", "kind": "text",
     "group": "advanced", "default": PROCESSOR_EXCLUDE_DEFAULT,
     "hint": "A similarly-named build that must never be mistaken for your processor."},
]
SETUP_PATHS = {f["path"] for f in SETUP_SCHEMA}
SECRET_PATHS = {f["path"] for f in SETUP_SCHEMA if f["kind"] == "secret"}


def _dig(d, path):
    cur = d
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _plant(d, path, value):
    parts = path.split("."); cur = d
    for p in parts[:-1]:
        if not isinstance(cur.get(p), dict):
            cur[p] = {}
        cur = cur[p]
    cur[parts[-1]] = value


def _prune(d, path):
    parts = path.split("."); cur = d
    for p in parts[:-1]:
        cur = cur.get(p)
        if not isinstance(cur, dict):
            return
    cur.pop(parts[-1], None)


def reload_runtime_config():
    """Re-read devices.json and rebind every global derived from it, so a Setup save takes
    effect without a restart (a restart drops the telemetry cache for ~2 minutes)."""
    global CFG, _PROC_CFG, TARGET_PKG, LITE_MATCH, PROCESSOR_EXCLUDE_MATCH
    global LABELS, ADDR, EXPECTED_CERT, GUARDIAN_COMMAND_SECRET
    global GUARDIAN_CFG, GUARDIAN_REPO, GUARDIAN_PKG, GUARDIAN_TOKEN, GUARDIAN_CACHE, GUARDIAN_BATCH
    CFG = load_config()
    _PROC_CFG = CFG.get("processor") or {}
    TARGET_PKG = (_PROC_CFG.get("package") or TARGET_PKG_DEFAULT).strip()
    LITE_MATCH = (_PROC_CFG.get("family_match") or LITE_MATCH_DEFAULT).strip()
    PROCESSOR_EXCLUDE_MATCH = (_PROC_CFG.get("exclude_match") or PROCESSOR_EXCLUDE_DEFAULT).strip()
    LABELS = {d["host"]: d.get("label", d["host"]) for d in CFG.get("devices", []) if "host" in d}
    ADDR = {d["host"]: d.get("address", "") for d in CFG.get("devices", []) if "host" in d}
    EXPECTED_CERT = (CFG.get("updates", {}).get("expected_cert_sha256")
                     or "ea21af13f3b724c662f3da05247acc5a68a45331a90220f0d90a6024d7fa8f36").strip().lower()
    GUARDIAN_COMMAND_SECRET = (CFG.get("guardian_command_secret") or "").strip()
    GUARDIAN_CFG = CFG.get("guardian_update", {}) or {}
    GUARDIAN_REPO = (GUARDIAN_CFG.get("repo") or "").strip()
    GUARDIAN_PKG = (GUARDIAN_CFG.get("package") or "com.acurast.guardian").strip()
    GUARDIAN_TOKEN = (GUARDIAN_CFG.get("github_token") or "").strip()
    GUARDIAN_CACHE = os.path.join(HERE, GUARDIAN_CFG.get("cache_dir") or "guardian-apks")
    GUARDIAN_BATCH = GUARDIAN_CFG.get("batch", {"wave_size": 6, "wave_delay_sec": 15})


def setup_snapshot():
    """Current values for the Setup panel. Secrets report set/not-set and NEVER their value:
    anyone holding the fleet token could otherwise read the PAT straight out of the UI."""
    out = []
    for f in SETUP_SCHEMA:
        row = dict(f)
        val = _dig(CFG, f["path"])
        if f["kind"] == "secret":
            row["isSet"] = bool(str(val or "").strip())
            row["value"] = ""
        else:
            row["value"] = "" if val is None else val
        out.append(row)
    return out


def setup_groups():
    return SETUP_GROUPS


def apply_setup(values, clears):
    """Write changes into devices.json (the raw file, so it stays minimal) and hot-reload."""
    raw = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
            raw = json.load(f)
    by_path = {f["path"]: f for f in SETUP_SCHEMA}
    changed = []
    for path, val in (values or {}).items():
        if path not in SETUP_PATHS:
            continue                                   # allowlist: ignore anything unexpected
        fld = by_path[path]
        if fld["kind"] == "secret" and not str(val or "").strip():
            continue                                   # blank secret = leave as-is, not "erase"
        if fld["kind"] == "bool":
            val = str(val).strip().lower() in ("1", "true", "on", "yes")
        elif fld["kind"] == "int":
            try:
                val = int(str(val).strip())
            except (TypeError, ValueError):
                continue
        else:
            val = str(val or "").strip()
        _plant(raw, path, val)
        changed.append(path)
    for path in (clears or []):
        if path in SETUP_PATHS:
            _prune(raw, path)
            changed.append(path + " (cleared)")
    if changed:
        try:
            shutil.copy(CONFIG_PATH, CONFIG_PATH + ".bak-setup")
        except Exception:  # noqa: BLE001
            pass
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2)
        os.replace(tmp, CONFIG_PATH)                   # atomic: never a half-written config
        reload_runtime_config()
    return changed


_gh_cache = {"ts": 0.0, "releases": []}
_gh_lock = threading.Lock()


def _gh_headers(accept="application/vnd.github+json"):
    h = {"Accept": accept, "User-Agent": "acurast-fleet-console",
         "X-GitHub-Api-Version": "2022-11-28"}
    if GUARDIAN_TOKEN:
        h["Authorization"] = f"Bearer {GUARDIAN_TOKEN}"
    return h


def github_releases(force=False):
    """List releases (newest first) carrying an .apk asset. Cached 60s. Uses the API asset URL
    (not browser_download_url) so it works on a PRIVATE repo with the PAT."""
    with _gh_lock:
        if not force and _gh_cache["releases"] and (time.time() - _gh_cache["ts"] < 60):
            return list(_gh_cache["releases"])
    if not GUARDIAN_REPO:
        raise RuntimeError("guardian_update.repo not set in devices.json")
    url = f"https://api.github.com/repos/{GUARDIAN_REPO}/releases?per_page=30"
    req = urllib.request.Request(url, headers=_gh_headers(), method="GET")
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    rels = []
    for rel in data:
        apk = sums = None
        for a in rel.get("assets", []):
            n = a.get("name", "")
            if n.endswith(".apk"):
                apk = a
            elif n == "SHA256SUMS.txt":
                sums = a
        if not apk:
            continue
        rels.append({
            "tag": rel.get("tag_name", ""), "name": rel.get("name", ""),
            "published": rel.get("published_at", ""), "prerelease": bool(rel.get("prerelease")),
            "apkName": apk["name"], "apkUrl": apk["url"], "apkSize": apk.get("size", 0),
            "sumsUrl": sums["url"] if sums else "",
        })
    with _gh_lock:
        _gh_cache["releases"] = rels
        _gh_cache["ts"] = time.time()
    return list(rels)


def _gh_download(api_url, dest):
    req = urllib.request.Request(api_url, headers=_gh_headers("application/octet-stream"), method="GET")
    with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_release_apk(tag):
    """Download + SHA-256-verify (and signing-cert-verify) the APK for `tag` ('' / 'latest' → newest).
    Cached by filename. Returns (apk_path, release_meta). Raises on any mismatch."""
    rels = github_releases()
    if not rels:
        raise RuntimeError("no releases with an APK asset found")
    rel = rels[0] if tag in ("", "latest") else next((r for r in rels if r["tag"] == tag), None)
    if not rel:
        raise RuntimeError(f"tag {tag} not found")
    os.makedirs(GUARDIAN_CACHE, exist_ok=True)
    apk_path = os.path.join(GUARDIAN_CACHE, rel["apkName"])

    want = ""
    if rel["sumsUrl"]:
        try:
            sums_path = os.path.join(GUARDIAN_CACHE, f"{rel['tag']}-SHA256SUMS.txt")
            _gh_download(rel["sumsUrl"], sums_path)
            with open(sums_path, "r", encoding="utf-8") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) == 2 and parts[1].lstrip("*") == rel["apkName"]:
                        want = parts[0].lower()
        except Exception as e:  # noqa: BLE001
            print(f"[guardian] SHA256SUMS fetch failed: {e}")

    if not (os.path.exists(apk_path) and want and _sha256(apk_path) == want):
        _gh_download(rel["apkUrl"], apk_path)
        got = _sha256(apk_path)
        if want and got != want:
            os.remove(apk_path)
            raise RuntimeError(f"sha256 mismatch for {rel['apkName']}: got {got[:12]}…, want {want[:12]}…")
        want = got
    rel["sha256"] = want or _sha256(apk_path)
    # Signing-cert gate (same rigor as the processor-lite OTA): refuse a wrong-key APK.
    certs = apk_cert_hashes(apk_path)
    if certs and GUARDIAN_CERT not in certs:
        os.remove(apk_path)
        raise RuntimeError(f"signing cert mismatch: {certs[0][:16]}… != expected {GUARDIAN_CERT[:16]}…")
    rel["certOk"] = bool(certs) and GUARDIAN_CERT in certs
    return apk_path, rel


def read_guardian_version(serial):
    code, out, _ = adb(["-s", serial, "shell", "dumpsys", "package", GUARDIAN_PKG], timeout=15)
    if code != 0 or "versionName" not in out:
        return None
    vname, vcode = "", 0
    for raw in out.splitlines():
        line = raw.strip()
        if line.startswith("versionName=") and not vname:
            vname = line.split("=", 1)[1].strip()
        if line.startswith("versionCode=") and vcode == 0:
            try:
                vcode = int(line.split("=", 1)[1].split()[0])
            except ValueError:
                pass
    return {"versionName": vname, "versionCode": vcode}


def scan_guardian(serial):
    info = read_guardian_version(serial)
    with STATE_LOCK:
        d = STATE.get(serial)
        if not d:
            return
        if info is None:
            d["guardianVersion"] = "not installed"
            d["guardianVersionCode"] = 0
        else:
            d["guardianVersion"] = info["versionName"] or "?"
            d["guardianVersionCode"] = info["versionCode"]
    if info is not None:
        remember_device(serial, guardianVersion=info["versionName"] or "?")


def scan_guardians(serials):
    if not serials:
        return
    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(scan_guardian, serials))


def reassert_guardian_overlay(serials):
    """Re-assert the SYSTEM_ALERT_WINDOW appop for the Guardian package on reconnected devices.
    The N159V wipes this appop on every reboot; without it Guardian's on-device recovery is
    BAL-blocked on screen-on phones (see the acceptance-test findings). Best-effort, backgrounded."""
    def one(s):
        adb(["-s", s, "shell", "appops", "set", "--user", "0", GUARDIAN_PKG,
             "SYSTEM_ALERT_WINDOW", "allow"], timeout=12)
    try:
        with ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(one, serials))
        print(f"[guardian] re-asserted overlay appop on {len(serials)} reconnected device(s)")
    except Exception as e:  # noqa: BLE001
        print(f"[guardian] overlay reassert failed: {e}")


# Guardian's classes and intent actions live under com.acurast.guardian whatever the app is
# installed as: this fleet installs it as com.acurast.guardian, the public Pulse Guardian build
# as com.acurast.pulse.guardian. Only the install id varies (guardian_update.package) — address
# components as <installed pkg>/<class pkg>.Class so both work.
GUARDIAN_CLASS_PKG = "com.acurast.guardian"

GUARDIAN_ARM_ACTION = "com.acurast.guardian.action.ENABLE_PROTECTION"
GUARDIAN_RESET_FG_ACTION = "com.acurast.guardian.action.RESET_FG_LOSSES"  # v1.1.10+
GUARDIAN_LOCATE_ACTION = "com.acurast.guardian.action.LOCATE"            # v1.1.13+ find-my-phone
GUARDIAN_LOCATE_STOP_ACTION = "com.acurast.guardian.action.LOCATE_STOP"
# v1.1.46+. Older builds simply ignore the broadcast, so a mixed fleet degrades to "no effect"
# rather than erroring — the per-device result carries the truth either way.
GUARDIAN_MAINT_ENTER_ACTION = "com.acurast.guardian.action.ENTER_MAINTENANCE"
GUARDIAN_MAINT_EXIT_ACTION = "com.acurast.guardian.action.EXIT_MAINTENANCE"
GUARDIAN_HEARTBEAT_ACTION = "com.acurast.guardian.action.HEARTBEAT"  # forces an immediate telemetry push
GUARDIAN_SCREENSAVER_ON_ACTION = "com.acurast.guardian.action.SCREENSAVER_ON"    # v1.1.21+
GUARDIAN_SCREENSAVER_OFF_ACTION = "com.acurast.guardian.action.SCREENSAVER_OFF"
SCREENSAVER = {"enabled": False, "on": 0, "off": 0, "ts": 0}   # last fleet-wide intent
SCREENSAVER_LOCK = threading.Lock()
SCREENSAVER_PATH = os.path.join(HERE, "screensaver.json")


def load_screensaver():
    """Restore the fleet screensaver intent across restarts. Without this the in-memory flag resets
    to False while the phones still have the overlay on, and screenshot auto-peek stops firing —
    every capture silently comes back black."""
    try:
        with open(SCREENSAVER_PATH, "r", encoding="utf-8") as f:
            SCREENSAVER["enabled"] = bool(json.load(f).get("enabled"))
    except Exception:
        pass


def save_screensaver():
    try:
        with open(SCREENSAVER_PATH, "w", encoding="utf-8") as f:
            json.dump({"enabled": bool(SCREENSAVER.get("enabled"))}, f)
    except Exception as e:  # noqa: BLE001
        print(f"[screensaver] could not persist state: {e}")


load_screensaver()   # restore fleet intent at import (globals defined above)




def reset_fg_one(serial):
    """Fire the guarded RESET_FG_LOSSES broadcast → Guardian zeroes both foreground-loss counters."""
    args = ["-s", serial, "shell", "am", "broadcast", "--user", "0", "-f", "0x00000020",
            "-n", f"{GUARDIAN_PKG}/{GUARDIAN_CLASS_PKG}.core.receiver.ProvisioningReceiver", "-a", GUARDIAN_RESET_FG_ACTION]
    _, out, err = adb(args, timeout=15)
    ok = "fg_losses_reset" in (out + " " + err)
    with STATE_LOCK:
        ip = SERIAL_IP.get(serial)
    if ip:  # clear local rate history so the card reflects the reset immediately
        with FG_HIST_LOCK:
            FG_HIST.pop(ip, None)
    return {"serial": serial, "ok": ok, "output": (out + " " + err).strip()[:120]}


def reset_fg_losses(serials):
    with ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(reset_fg_one, serials))


def locate_one(serial, seconds=120, label=""):
    """Fire the LOCATE beacon (red overlay + alarm + vibrate) so the operator can find the handset.
    Draws over everything incl. the processor without disturbing the node (needs SYSTEM_ALERT_WINDOW,
    already granted fleet-wide). Label is sanitized for the on-device shell."""
    lbl = re.sub(r"[^A-Za-z0-9._-]", "-", (label or serial))[:32]
    args = ["-s", serial, "shell", "am", "broadcast", "--user", "0", "-f", "0x00000020",
            "-n", f"{GUARDIAN_PKG}/{GUARDIAN_CLASS_PKG}.core.receiver.ProvisioningReceiver", "-a", GUARDIAN_LOCATE_ACTION,
            "--ei", "seconds", str(max(1, int(seconds))), "--es", "label", lbl]
    _, out, err = adb(args, timeout=15)
    return {"serial": serial, "ok": "locating" in (out + " " + err), "output": (out + " " + err).strip()[:120]}


def screensaver_one(serial, enabled):
    """Toggle Guardian's black screensaver (v1.1.21+). Blacks the screen with a bouncing green dot
    while Lite is foreground; needs SYSTEM_ALERT_WINDOW (provision already grants it). The LOCATE
    beacon still draws on top, so find-my-phone keeps working with this on."""
    act = GUARDIAN_SCREENSAVER_ON_ACTION if enabled else GUARDIAN_SCREENSAVER_OFF_ACTION
    args = ["-s", serial, "shell", "am", "broadcast", "--user", "0", "-f", "0x00000020",
            "-n", f"{GUARDIAN_PKG}/{GUARDIAN_CLASS_PKG}.core.receiver.ProvisioningReceiver", "-a", act]
    _, out, err = adb(args, timeout=15)
    blob = out + " " + err
    want = "screensaver_on" if enabled else "screensaver_off"
    return {"serial": serial, "ok": want in blob, "output": blob.strip()[:120]}


def locate_stop_one(serial):
    args = ["-s", serial, "shell", "am", "broadcast", "--user", "0", "-f", "0x00000020",
            "-n", f"{GUARDIAN_PKG}/{GUARDIAN_CLASS_PKG}.core.receiver.ProvisioningReceiver", "-a", GUARDIAN_LOCATE_STOP_ACTION]
    _, out, err = adb(args, timeout=15)
    return {"serial": serial, "ok": "locate_stopped" in (out + " " + err), "output": (out + " " + err).strip()[:120]}


def maintenance_one(serial, enter, minutes):
    """Enter or leave a maintenance window on one phone.

    Guardian answers with data="maintenance_on;min=N" / "maintenance_off"; a build without the
    feature answers nothing useful, which is what `ok` reflects."""
    action = GUARDIAN_MAINT_ENTER_ACTION if enter else GUARDIAN_MAINT_EXIT_ACTION
    args = ["-s", serial, "shell", "am", "broadcast", "--user", "0", "-f", "0x00000020",
            "-n", f"{GUARDIAN_PKG}/{GUARDIAN_CLASS_PKG}.core.receiver.ProvisioningReceiver", "-a", action]
    if enter:
        args += ["--ei", "minutes", str(minutes)]
    _, out, err = adb(args, timeout=15)
    text = (out + " " + err).strip()
    ok = ("maintenance_on" in text) if enter else ("maintenance_off" in text)
    return {"serial": serial, "ok": ok, "output": text[-120:]}


def provision_guardian(serial, telemetry_url, friendly_name):
    """Grant every permission Guardian needs (WSS first) then arm it — the whole hands-on-adb
    provisioning step in one call. Returns the arm result string (e.g. 'armed;fleetMode=true;wd=OK')."""
    pkg = GUARDIAN_PKG
    sh = lambda *a: adb(["-s", serial, "shell", *a], timeout=15)
    sh("pm", "grant", pkg, "android.permission.WRITE_SECURE_SETTINGS")  # first → wd=OK on arm
    sh("pm", "grant", pkg, "android.permission.POST_NOTIFICATIONS")
    sh("appops", "set", pkg, "android:get_usage_stats", "allow")
    sh("appops", "set", pkg, "SYSTEM_ALERT_WINDOW", "allow")
    sh("dumpsys", "deviceidle", "whitelist", "+" + pkg)
    sh("settings", "put", "global", "adb_allowed_connection_time", "0")  # adb auth never expires (best-effort)
    # Enable Guardian's WD-auth accessibility service (auto-accepts the Moto "allow WD?" prompt on
    # reboot). Append to any existing services so we don't clobber them.
    a11y = f"{pkg}/{GUARDIAN_CLASS_PKG}.core.accessibility.WirelessDebugAuthService"
    _, cur, _ = adb(["-s", serial, "shell", "settings", "get", "secure",
                     "enabled_accessibility_services"], timeout=10)
    cur = (cur or "").strip()
    if cur in ("", "null", "None"):
        newval = a11y
    elif a11y not in cur:
        newval = cur + ":" + a11y
    else:
        newval = cur
    sh("settings", "put", "secure", "enabled_accessibility_services", newval)
    sh("settings", "put", "secure", "accessibility_enabled", "1")
    ensure_scrcpy_jar(serial)   # so live view works on a freshly-onboarded phone
    args = ["-s", serial, "shell", "am", "broadcast", "--user", "0", "-f", "0x00000020",
            "-n", f"{pkg}/{GUARDIAN_CLASS_PKG}.core.receiver.ProvisioningReceiver", "-a", GUARDIAN_ARM_ACTION]
    if telemetry_url:
        args += ["--es", "telemetry_url", telemetry_url]
    if friendly_name:
        # The value lands in an on-device `am broadcast`, so it is parsed by the PHONE's shell.
        # An mDNS shadow serial ("adb-XXXX-yyy (2)._adb-tls-connect._tcp") carries spaces+parens
        # and made the device shell abort with `/system/bin/sh: syntax error: unexpected '('`,
        # so arming silently failed on every shadow-connected phone. Keep it shell-safe.
        _fn = re.sub(r"[^A-Za-z0-9._-]", "-", str(friendly_name))[:48]
        if _fn:
            args += ["--es", "friendly_name", _fn]
    code, out, err = adb(args, timeout=20)
    m = re.search(r'data="([^"]*)"', out + " " + err)
    data = m.group(1) if m else ""
    armed_ok = "armed" in data
    with STATE_LOCK:  # optimistic: reflect armed immediately, before telemetry's next health-tick
        if serial in STATE:
            STATE[serial]["guardianArmed"] = armed_ok
    remember_device(serial, guardianArmed=armed_ok)
    if data:
        scan_guardian(serial)
    return {"serial": serial, "ok": armed_ok, "armed": data or (out or err)[:200]}


def provision_guardians(serials, telemetry_url):
    if not serials:
        return []
    with STATE_LOCK:
        labels = {s: STATE.get(s, {}).get("label", s) for s in serials}
    with ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(lambda s: provision_guardian(s, telemetry_url, labels.get(s, s)), serials))


def install_guardian(serial, apk_path):
    """adb install -r -d one device (keep data, allow downgrade), then re-read the installed version."""
    with STATE_LOCK:
        if serial in STATE:
            STATE[serial]["guardianAction"] = "installing"
    code, out, err = adb(["-s", serial, "install", "-r", "-d", apk_path], timeout=180)
    text = ((out or "") + (("\n" + err) if err else "")).strip()
    ok = "Success" in text
    if ok:
        scan_guardian(serial)
    with STATE_LOCK:
        if serial in STATE:
            STATE[serial]["guardianAction"] = "" if ok else f"failed: {text[:120]}"
    return {"serial": serial, "ok": ok, "output": text[:500]}


GUARDIAN_JOB = {"active": False, "tag": "", "sha256": "", "total": 0,
                "done": 0, "ok": 0, "failed": 0, "startedAt": 0.0, "results": []}
GUARDIAN_JOB_LOCK = threading.Lock()


def guardian_install_job(serials, apk_path, rel, wave_size, wave_delay):
    """Waved background install so the whole fleet doesn't pull the APK / drop ADB at once."""
    def worker():
        with GUARDIAN_JOB_LOCK:
            GUARDIAN_JOB.update(active=True, tag=rel["tag"], sha256=rel.get("sha256", ""),
                                total=len(serials), done=0, ok=0, failed=0,
                                startedAt=time.time(), results=[])
        for i in range(0, len(serials), wave_size):
            wave = serials[i:i + wave_size]
            with ThreadPoolExecutor(max_workers=min(len(wave), 8)) as ex:
                res = list(ex.map(lambda s: install_guardian(s, apk_path), wave))
            with GUARDIAN_JOB_LOCK:
                for r in res:
                    GUARDIAN_JOB["results"].append(r)
                    GUARDIAN_JOB["done"] += 1
                    GUARDIAN_JOB["ok" if r["ok"] else "failed"] += 1
            if i + wave_size < len(serials):
                time.sleep(max(1, wave_delay))
        with GUARDIAN_JOB_LOCK:
            GUARDIAN_JOB["active"] = False

    threading.Thread(target=worker, daemon=True).start()


# -------------------------------------------------------------- KEEP LITE FOREFRONT
# Farm phones drift to the launcher/home while the processor keeps running in the work profile
# (procAlive=True, earning unaffected) — but the operator wants Lite in front. Shell can't foreground
# a user-11 app (SecurityException); only Guardian can, and re-arming (ENABLE_PROTECTION) makes it
# pull Lite forward. This sweeper checks each online phone's top activity and re-arms only the ones
# that have drifted off Lite. Runtime-toggleable via /api/guardian/keep-lite.
# LITE_MATCH is bound from config next to TARGET_PKG, just after load_config().


def lite_focused(serial):
    """True if the Acurast processor is the top/resumed activity, False if not, None if unknown.
    Uses the RESUMED activity (not window focus) so a screen-off phone doesn't read as a false drift."""
    code, out, _ = adb(["-s", serial, "shell",
                        "dumpsys activity activities | grep -m1 -i ResumedActivity"], timeout=12)
    if code != 0 or not out:
        return None
    return LITE_MATCH in out


def foreground_lite(serial):
    """Bring Lite to the front via Guardian: ensure the overlay appop (BAL needs it) then send the
    ENABLE_PROTECTION broadcast. Lighter than a full re-provision (no permission re-grants)."""
    adb(["-s", serial, "shell", "appops", "set", "--user", "0", GUARDIAN_PKG,
         "SYSTEM_ALERT_WINDOW", "allow"], timeout=10)
    args = ["-s", serial, "shell", "am", "broadcast", "--user", "0", "-f", "0x00000020",
            "-n", f"{GUARDIAN_PKG}/{GUARDIAN_CLASS_PKG}.core.receiver.ProvisioningReceiver", "-a", GUARDIAN_ARM_ACTION]
    tel = (GUARDIAN_CFG.get("telemetry_url") or "").strip()
    if tel:
        args += ["--es", "telemetry_url", tel]
    code, out, err = adb(args, timeout=15)
    return "armed" in (out + " " + err)


KEEP_LITE = {
    "enabled": bool(GUARDIAN_CFG.get("keep_lite_foreground", False)),
    "interval": max(60, int(GUARDIAN_CFG.get("keep_lite_interval_sec", 300))),
    "lastSweep": 0.0, "lastActed": 0, "acted": 0, "checked": 0,
}
KEEP_LITE_LOCK = threading.Lock()


# ---------------------------------------------------------------- TELEMETRY NUDGE
# Some OEMs throttle Guardian's periodic push far below its ~60s cadence even when the app is
# Doze-whitelisted, in the ACTIVE standby bucket and appops-allowed (measured on the TCL T607DL:
# ~5.3 min between pushes, occasionally past TELEMETRY_TTL). When a push lands outside the TTL the
# card goes blank and the device reads as "no compute" in the UI even though it is earning fine --
# which is why hitting Screenshot appeared to "fix" it: those broadcasts wake Guardian into pushing.
#
# The nudge does that deliberately: any online device whose telemetry has gone stale gets a
# HEARTBEAT broadcast, which Guardian answers with an immediate push (measured: <15s). This is
# generic -- it repairs any slow-pusher, not one model -- and it is cheap: one broadcast per stale
# device per NUDGE_MIN_GAP, and healthy 60s-cadence phones never qualify.
# Re-armed after v1.1.34, but deliberately BEHIND Guardian's own backstop rather than in front of
# it. Guardian's exact-alarm fires at ~180s when its in-process loop is frozen; our threshold sits
# at 480s, so:
#   - the alarm always gets first crack, and a freeze it rescues is still visible to us as a
#     sinceLastPushSec spike (~150-300) with NO [nudge] line in the log -- the measurement survives;
#   - if the alarm ever fails outright we still poke before TELEMETRY_TTL (600s), so the card never
#     goes blank and nobody has to hit Screenshot again.
# A [nudge] line for a v1.1.34+ device is therefore itself a finding: the alarm did not land.
NUDGE_ENABLED = True
NUDGE_STALE_AFTER = 480   # sits above Guardian's ~180s alarm, below the 600s TTL
NUDGE_MIN_GAP = 240       # never nudge the same device more often than this
_NUDGE_LAST = {}
_NUDGE_STATS = {"nudged": 0, "lastRun": 0}


def heartbeat_one(serial, verify=True):
    """Ask Guardian to push telemetry now, and confirm a push actually LANDED.

    "Broadcast completed" only means Android accepted the intent -- it says nothing about whether
    Guardian did anything with it. A wedged telemetry loop accepts the broadcast and pushes nothing,
    so counting delivery as success overstates what the nudge achieved (it logged 14 'rescues' of a
    phone whose loop was dead). Success = a telemetry sample newer than the one we started with."""
    ip = SERIAL_IP.get(serial)
    before = (TELEMETRY.get(ip) or {}).get("recv_ts", 0) if ip else 0
    args = ["-s", serial, "shell", "am", "broadcast", "--user", "0", "-f", "0x00000020",
            "-n", f"{GUARDIAN_PKG}/{GUARDIAN_CLASS_PKG}.core.receiver.ProvisioningReceiver", "-a", GUARDIAN_HEARTBEAT_ACTION]
    _, out, err = adb(args, timeout=15)
    if "Broadcast" not in (out + err):
        return False
    if not verify:
        return True
    # Guardian answers a live loop in <15s (measured); give it 25s before calling it wedged.
    deadline = time.time() + 25
    while time.time() < deadline:
        time.sleep(2.5)
        ip2 = SERIAL_IP.get(serial) or ip
        if (TELEMETRY.get(ip2) or {}).get("recv_ts", 0) > before:
            return True
    return False


_NUDGE_FAILS = {}          # serial -> consecutive verification failures
NUDGE_WEDGE_STRIKES = 2    # only call it wedged after this many in a row


# --- idle-hub detection -------------------------------------------------------------
# The Acurast canary runs TWO instances of the SAME package side by side: a user-0 "hub"
# (wallet UI carrying the "Open Processor to Provide Compute" button) and the work-profile
# Processor, which is the instance that actually earns. Guardian's own targetOnTop matches
# on package NAME only, so it reports "target on top" whenever EITHER is foregrounded -- a
# node can sit on the idle hub while computeStatus still reads "Running" (that value is
# retained across scrape failures) and every dashboard shows green. Observed 2026-08-01:
# the operator spotted such a node by eye; the console had it as healthy and earning.
#
# The foreground USER is what separates the two. user 0 + canary == the hub is up == that
# node is not computing.
IDLE_HUB_ENABLED = True
IDLE_HUB_INTERVAL = 180          # dumpsys is not free; this is a health signal, not a heartbeat
IDLE_HUB_WORKERS = 8
_IDLE_FG_RE = re.compile(r"\su(\d+)\s+(com\.acurast[^\s/]*)")
_IDLE_STATS = {"idle": 0, "unknown": 0, "lastRun": 0}


def probe_foreground_user(serial):
    """(userId, package) of the resumed activity, or (None, None) if unreadable.

    Both fields are needed: mResumedActivity resolves while Guardian's screensaver overlay
    is up, topResumedActivity resolves when it is not. Grepping on-device keeps the
    transfer small -- the full dumpsys is large."""
    _, out, _ = adb(["-s", serial, "shell",
                     "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'"],
                    timeout=20)
    m = _IDLE_FG_RE.search(out or "")
    if not m:
        return None, None
    return int(m.group(1)), m.group(2)


def idle_hub_loop():
    time.sleep(60)
    while True:
        try:
            if not IDLE_HUB_ENABLED:
                time.sleep(60)
                continue
            with STATE_LOCK:
                online = [s for s, d in STATE.items() if d.get("state") == "device"]
            if online:
                with ThreadPoolExecutor(max_workers=IDLE_HUB_WORKERS) as ex:
                    results = list(ex.map(probe_foreground_user, online))
                idle, unknown = [], 0
                with STATE_LOCK:
                    for serial, (user, pkg) in zip(online, results):
                        d = STATE.get(serial)
                        if not d:
                            continue
                        if user is None:
                            # Deliberately None, never the previous value. Retaining a stale
                            # reading is the exact bug this detector exists to catch.
                            d["foregroundUser"] = None
                            d["idleHub"] = None
                            unknown += 1
                            continue
                        d["foregroundUser"] = user
                        d["idleHub"] = bool(pkg and pkg.startswith(TARGET_PKG) and user == 0)
                        if d["idleHub"]:
                            idle.append(serial)
                _IDLE_STATS.update({"idle": len(idle), "unknown": unknown, "lastRun": time.time()})
                if idle:
                    print(f"[idle-hub] {len(idle)} node(s) sitting on the user-0 hub, not computing: "
                          f"{[s[:26] for s in idle[:6]]}")
        except Exception as e:  # noqa: BLE001
            print(f"[idle-hub] {e}")
        time.sleep(IDLE_HUB_INTERVAL)


# --- adb discovery self-heal -------------------------------------------------
# 2026-07-29: the host crashed, and on reboot adb's mDNS browse came up before the
# network was usable. It discovered nothing and NEVER retried -- all 76 phones sat
# unmanaged for 23 minutes until a human restarted the console. The unit already
# carries After=/Wants=network-online.target; that target was reached while the
# network still wasn't usable, so ordering cannot fix this. Only a retry can.
#
# Deliberately conservative, because `adb kill-server` drops every transport: it
# fires only when the online count has collapsed against a PERSISTED expectation
# (so there is effectively nothing to lose), never during an install job, and at
# most once per DISCOVERY_HEAL_MIN_GAP.
DISCOVERY_HEAL_ENABLED = True
DISCOVERY_GAP_AFTER = 900        # a small gap must persist this long before we report it
DISCOVERY_GAP_LOG_EVERY = 3600   # then re-log at most hourly, so it nags without spamming
LAST_ONLINE = {}                 # serial -> ts, in memory only (cleared by a console restart)
DISCOVERY_HEAL_AFTER = 180       # sustained collapse before acting; natural mDNS
                                 # re-announce recovered in ~141s in testing, so give
                                 # it a clear window first. The real failure mode never
                                 # self-recovered (23 min), so this still catches it fast.
                                 # re-announce recovered in ~141s in testing, so give
                                 # it a clear window first. The real failure mode never
                                 # self-recovered (23 min), so this still catches it fast.
DISCOVERY_HEAL_MIN_GAP = 900     # never re-heal more often than this
DISCOVERY_HEAL_FLOOR = 0.25      # "collapsed" = below 25% of expected
DISCOVERY_BASELINE = os.path.join(HERE, "discovery_baseline.json")
_HEAL = {"low_since": 0, "last": 0, "count": 0}


def _expected_devices():
    try:
        with open(DISCOVERY_BASELINE) as fh:
            return int((json.load(fh) or {}).get("expected") or 0)
    except Exception:  # noqa: BLE001
        return 0


def _remember_expected(n):
    """Persist a high-water mark. This has to survive a reboot, because the failure
    mode IS a fresh boot: devices.json carries no roster, so without this the
    console has no idea 76 phones are missing. Only ever raised -- a stale-high
    expectation makes healing LESS likely, which is the safe direction."""
    if n <= 0:
        return
    if n <= _expected_devices():
        return
    try:
        with open(DISCOVERY_BASELINE, "w") as fh:
            json.dump({"expected": n, "updated": time.time()}, fh)
    except Exception as e:  # noqa: BLE001
        print(f"[heal] baseline write failed: {e}")


def _ws_scrcpy_boot_check():
    """Restart ws-scrcpy after a console restart, but ONLY if it is actually stale.

    Restarting this service costs ~90s of downtime (node ignores SIGTERM, so systemd waits out
    TimeoutStopSec then SIGKILLs), so doing it unconditionally on every console restart means a
    90s Live outage for nothing. ws-scrcpy is stale exactly when the adb server is YOUNGER than it:
    that means the server was replaced underneath it and its adbkit tracker is bound to a dead one.

    Waits first because the adb server does not exist yet at startup — poll_loop's first adb call
    spawns it, inside this unit's cgroup, which is the whole reason it dies with us.
    """
    time.sleep(75)
    try:
        def age_of_pid(pid):
            if not pid:
                return None
            r = subprocess.run(["ps", "-o", "etimes=", "-p", str(pid)],
                               capture_output=True, text=True, timeout=15)
            v = r.stdout.strip()
            return int(v) if v.isdigit() else None

        # Ask systemd which pid IS ws-scrcpy. `ps -C node` matches every node process on the box
        # (the home-box backend among them), so taking a max there reports some unrelated 10-day-old
        # process and this check fires every time — exactly the needless 90s Live outage it exists
        # to avoid.
        r = subprocess.run(["systemctl", "show", "ws-scrcpy", "-p", "MainPID", "--value"],
                           capture_output=True, text=True, timeout=15)
        ws_pid = r.stdout.strip()
        ws = age_of_pid(ws_pid if ws_pid.isdigit() and ws_pid != "0" else None)

        r = subprocess.run(["pgrep", "-f", "adb -L tcp:5037 fork-server"],
                           capture_output=True, text=True, timeout=15)
        adb_pids = [p for p in r.stdout.split() if p.isdigit()]
        adb_age = age_of_pid(adb_pids[0]) if adb_pids else None
        if ws is None or adb_age is None:
            print(f"[heal] ws-scrcpy boot check skipped (ws={ws} adb={adb_age})")
            return
        if adb_age < ws:
            print(f"[heal] adb server ({adb_age}s) is younger than ws-scrcpy ({ws}s) — "
                  f"its device tracker is bound to a dead server, restarting it")
            _restart_ws_scrcpy()
        else:
            print(f"[heal] ws-scrcpy ({ws}s) predates nothing — adb server is {adb_age}s, leaving it alone")
    except Exception as e:  # noqa: BLE001
        print(f"[heal] ws-scrcpy boot check error: {e}")


def _restart_ws_scrcpy():
    """`adb kill-server` is global. ws-scrcpy keeps its own adbkit tracker against the
    adb server and does NOT re-attach when we replace it -- its device list silently
    goes empty and live screen stops working with no error surfaced anywhere. So any
    heal that restarts the adb server must restart ws-scrcpy behind it."""
    try:
        # --no-block: stopping takes up to TimeoutStopSec (90s here) because node ignores SIGTERM.
        # Waiting on it just times out the call and logs a misleading failure while the restart is
        # in fact proceeding.
        r = subprocess.run(["sudo", "-n", "systemctl", "restart", "--no-block", "ws-scrcpy"],
                           capture_output=True, text=True, timeout=20)
        if r.returncode == 0:
            print("[heal] ws-scrcpy restarted (it does not survive an adb server replacement)")
        else:
            print(f"[heal] ws-scrcpy restart FAILED rc={r.returncode}: {(r.stderr or '').strip()[:160]}")
    except Exception as e:  # noqa: BLE001
        print(f"[heal] ws-scrcpy restart error: {e}")


def discovery_heal_loop():
    time.sleep(90)   # boot grace: first discovery legitimately takes a moment
    while True:
        try:
            if not DISCOVERY_HEAL_ENABLED:
                time.sleep(60)
                continue
            now = time.time()
            with STATE_LOCK:
                online = sum(1 for d in STATE.values() if d.get("state") == "device")
            _remember_expected(online)
            expected = _expected_devices()
            floor = max(2, int(expected * DISCOVERY_HEAL_FLOOR))

            # Small persistent gap: not a collapse, so we report it and change nothing.
            if expected and online < expected:
                if not _HEAL.get("gap_since"):
                    _HEAL["gap_since"] = now
                elif (now - _HEAL["gap_since"]) > DISCOVERY_GAP_AFTER \
                        and (now - _HEAL.get("gap_logged", 0)) > DISCOVERY_GAP_LOG_EVERY:
                    _HEAL["gap_logged"] = now
                    gone = [x for x, t in LAST_ONLINE.items()
                            if x not in STATE or STATE.get(x, {}).get("state") != "device"]
                    print(f"[discovery] {expected - online} phone(s) missing for "
                          f"{int((now - _HEAL['gap_since']) / 60)} min (online={online} "
                          f"expected={expected}) - NOT restarting adb; a phone that is still "
                          f"advertising needs a fresh announce or a readb to be re-claimed"
                          + (f"; last-seen-online but gone now: {[g[4:18] for g in gone[:6]]}"
                             if gone else ""))
            else:
                _HEAL["gap_since"] = 0

            if expected and online < floor:
                if not _HEAL["low_since"]:
                    _HEAL["low_since"] = now
                    print(f"[heal] discovery looks collapsed: online={online} "
                          f"expected={expected} floor={floor}")
                with GUARDIAN_JOB_LOCK:
                    busy = GUARDIAN_JOB.get("active")
                if busy:
                    pass  # never yank transports out from under a running install
                elif (now - _HEAL["low_since"]) > DISCOVERY_HEAL_AFTER \
                        and (now - _HEAL["last"]) > DISCOVERY_HEAL_MIN_GAP:
                    _HEAL["last"] = now
                    _HEAL["count"] += 1
                    print(f"[heal] restarting adb server (online={online}/{expected}) "
                          f"- mDNS browse looks dead")
                    adb(["kill-server"], timeout=20)
                    time.sleep(3)
                    adb(["start-server"], timeout=30)
                    time.sleep(5)
                    discover_mdns()
                    _restart_ws_scrcpy()
                    time.sleep(25)   # let poll_loop run refresh_devices at least once
                    with STATE_LOCK:
                        after = sum(1 for d in STATE.values() if d.get("state") == "device")
                    print(f"[heal] adb server restarted; online now {after}/{expected} "
                          f"(heal #{_HEAL['count']})")
                    _HEAL["low_since"] = 0 if after >= floor else now
            else:
                _HEAL["low_since"] = 0
        except Exception as e:  # noqa: BLE001
            print(f"[heal] {e}")
        time.sleep(30)


def telemetry_nudge_loop():
    # A console restart empties TELEMETRY, so for the first few minutes EVERY device looks silent.
    # Nudging then is pointless (they are pushing fine, we just have not heard yet) and it produced
    # a false "49 devices WEDGED" report. Wait out a full push interval plus margin before the first
    # sweep, and never treat a device we have simply never heard from as stale.
    time.sleep(330)
    while True:
        try:
            if not NUDGE_ENABLED:
                time.sleep(60)
                continue
            now = time.time()
            targets = []
            with STATE_LOCK:
                for serial, dev in list(STATE.items()):
                    if dev.get("state") != "device":
                        continue
                    ip = SERIAL_IP.get(serial)
                    tel = TELEMETRY.get(ip) if ip else None
                    if not tel or not tel.get("recv_ts"):
                        continue  # never heard from it this process -- absence is not staleness
                    age = now - tel["recv_ts"]
                    if age > NUDGE_STALE_AFTER and (now - _NUDGE_LAST.get(serial, 0)) > NUDGE_MIN_GAP:
                        targets.append(serial)
            if targets:
                for s_ in targets:
                    _NUDGE_LAST[s_] = now
                with ThreadPoolExecutor(max_workers=6) as ex:
                    res = list(ex.map(heartbeat_one, targets))
                ok = sum(1 for r in res if r)
                dead = []
                for t, r in zip(targets, res):
                    if r:
                        _NUDGE_FAILS.pop(t, None)
                        continue
                    # One miss can just be a slow push racing our 25s window; only a device that
                    # fails repeatedly is genuinely wedged.
                    _NUDGE_FAILS[t] = _NUDGE_FAILS.get(t, 0) + 1
                    if _NUDGE_FAILS[t] >= NUDGE_WEDGE_STRIKES:
                        dead.append(t)
                _NUDGE_STATS["nudged"] += ok
                _NUDGE_STATS["wedged"] = len(dead)
                _NUDGE_STATS["lastRun"] = int(now)
                print(f"[nudge] poked {ok}/{len(targets)} stale device(s): {[t[4:18] for t in targets[:6]]}")
                if dead:
                    # broadcast delivered, no push followed -> telemetry loop is wedged. Neither the
                    # nudge nor Guardian's own alarm can fix that from inside; it needs a reboot.
                    print(f"[nudge] WEDGED (no push after broadcast, needs reboot): {[t[4:18] for t in dead[:6]]}")
        except Exception as e:  # noqa: BLE001
            print(f"[nudge] {e}")
        time.sleep(60)


def _in_maintenance(serial):
    """True if the phone's own fresh telemetry says Guardian is in maintenance mode.

    An operator who deliberately paused recovery must not be fought by the sweeper: re-arming sends
    ENABLE_PROTECTION, which yanks Lite back to the foreground — exactly what maintenance mode exists
    to prevent. Unknown/stale telemetry returns False so the sweeper still protects silent phones.
    """
    now = time.time()
    with STATE_LOCK:
        cands = [SERIAL_IP.get(serial), SERIAL_IP.get(_dedupe_base(serial)), serial.split(":")[0]]
        for c in cands:
            t = TELEMETRY.get(c) if c else None
            if t and (now - t.get("recv_ts", 0)) < TELEMETRY_TTL:
                return "MAINTENANCE" in str(t.get("guardianState") or "").upper()
    return False


OPPORTUNISTIC = {
    "enabled": bool(GUARDIAN_CFG.get("opportunistic_update", False)),
    "tag": (GUARDIAN_CFG.get("opportunistic_tag") or "latest").strip(),
    "interval": max(120, int(GUARDIAN_CFG.get("opportunistic_interval_sec", 600))),
    "batch": max(1, int(GUARDIAN_CFG.get("opportunistic_batch", 3))),
    "lastRun": 0.0, "installed": 0, "lastInstalled": 0, "lastError": "",
}
OPPORTUNISTIC_LOCK = threading.Lock()


def _idle_needing_update(target_version):
    """Online phones that are idle (no deployment to lose) and not yet on the target build.

    Idle is read from the phone's OWN telemetry, so a phone whose telemetry is stale is treated as
    busy and left alone — the conservative direction. Maintenance windows are skipped too: someone
    is working on that phone."""
    out = []
    now = time.time()
    with STATE_LOCK:
        online = [(sv, d) for sv, d in STATE.items() if d.get("state") == "device"]
    for serial, d in online:
        if (d.get("guardianVersion") or "") == target_version:
            continue
        cands = [SERIAL_IP.get(serial), SERIAL_IP.get(_dedupe_base(serial)), serial.split(":")[0]]
        tel = None
        with STATE_LOCK:
            for c in cands:
                t = TELEMETRY.get(c) if c else None
                if t and (now - t.get("recv_ts", 0)) < TELEMETRY_TTL:
                    tel = t
                    break
        if not tel:
            continue                                  # unknown state → assume busy
        if tel.get("computeActive"):
            continue                                  # has work; leave it alone
        if "MAINTENANCE" in str(tel.get("guardianState") or "").upper():
            continue
        out.append(serial)
    return out


def opportunistic_update_loop():
    time.sleep(90)   # let the first poll populate telemetry
    while True:
        try:
            with OPPORTUNISTIC_LOCK:
                enabled = OPPORTUNISTIC["enabled"]
                interval = OPPORTUNISTIC["interval"]
                batch = OPPORTUNISTIC["batch"]
                tag = OPPORTUNISTIC["tag"]
                last = OPPORTUNISTIC["lastRun"]
            with GUARDIAN_JOB_LOCK:
                busy = GUARDIAN_JOB.get("active")
            if enabled and GUARDIAN_REPO and not busy and (time.time() - last) >= interval:
                with OPPORTUNISTIC_LOCK:
                    OPPORTUNISTIC["lastRun"] = time.time()
                apk_path, rel = ensure_release_apk(tag)          # cached after the first fetch
                target = (rel.get("versionName") or "").strip() or rel["tag"].lstrip("v")
                idle = _idle_needing_update(target)[:batch]
                if idle:
                    print(f"[opportunistic] {len(idle)} idle phone(s) not on {target} — installing: "
                          f"{[sv[4:18] for sv in idle]}")
                    with ThreadPoolExecutor(max_workers=min(len(idle), 4)) as ex:
                        res = list(ex.map(lambda sv: install_guardian(sv, apk_path), idle))
                    ok = sum(1 for r in res if r["ok"])
                    with OPPORTUNISTIC_LOCK:
                        OPPORTUNISTIC["installed"] += ok
                        OPPORTUNISTIC["lastInstalled"] = int(time.time())
                        OPPORTUNISTIC["lastError"] = ""
                    print(f"[opportunistic] installed {ok}/{len(idle)}")
        except Exception as e:  # noqa: BLE001
            with OPPORTUNISTIC_LOCK:
                OPPORTUNISTIC["lastError"] = str(e)[:200]
            print(f"[opportunistic] {e}")
        time.sleep(15)


def keep_lite_loop():
    time.sleep(20)  # let the first poll connect + probe the fleet
    while True:
        try:
            with KEEP_LITE_LOCK:
                enabled = KEEP_LITE["enabled"]
                interval = max(60, KEEP_LITE["interval"])
                last = KEEP_LITE["lastSweep"]
            if enabled and GUARDIAN_REPO and (time.time() - last) >= interval:
                with STATE_LOCK:
                    online = [s for s, d in STATE.items() if d.get("state") == "device"]
                with ThreadPoolExecutor(max_workers=8) as ex:
                    foc = list(ex.map(lambda s: (s, lite_focused(s)), online))
                drifted = [s for s, f in foc if f is False]
                paused = [s for s in drifted if _in_maintenance(s)]
                offs = [s for s in drifted if s not in paused]
                checked = sum(1 for _, f in foc if f is not None)
                if paused:
                    print(f"[keep-lite] left {len(paused)} phone(s) in maintenance mode alone: "
                          f"{[p[4:18] for p in paused]}")
                if offs:
                    with ThreadPoolExecutor(max_workers=6) as ex:
                        list(ex.map(foreground_lite, offs))
                    print(f"[keep-lite] re-foregrounded Lite on {len(offs)}/{checked}: "
                          f"{[o[4:18] for o in offs]}")
                with KEEP_LITE_LOCK:
                    KEEP_LITE["lastSweep"] = time.time()
                    KEEP_LITE["checked"] = checked
                    KEEP_LITE["acted"] = len(offs)
                    if offs:
                        KEEP_LITE["lastActed"] = int(time.time())
        except Exception as e:  # noqa: BLE001
            print(f"[keep-lite] {e}")
        time.sleep(5)  # fine granularity so a UI toggle takes effect within seconds


# ---------------------------------------------------------------- DEBLOAT
# Guarded fleet debloat (see DEBLOAT-SPEC.md). Console-side over adb; reversible; never root;
# always --user 0 (never the work profile / user 11 = Lite). Guardian only *reports* the inventory.
#
# HARD never-touch guard: a fat-fingered package name must not be able to brick a phone or break
# earning. Matched case-insensitively. Broad connectivity/telephony substrings are intentional —
# the guard errs safe and *refuses* (logged), it never silently skips.
DEBLOAT_PROTECTED_EXACT = {
    "android",
    "com.android.shell",            # disabling this kills adb itself
    "com.android.systemui",
    "com.android.settings",
    "com.android.vending",          # Play Store (integrity + updates)
    "com.android.managedprovisioning",
}
DEBLOAT_PROTECTED_PREFIX = (
    "com.google.android.gms",       # Play Services (integrity/attestation backbone)
    "com.google.android.gsf",       # Google Services Framework (account/push infra) + gsf.login
    "com.acurast.",                 # the processor (any acurast pkg) + Guardian
    "com.android.providers.",       # settings/media/contacts/telephony providers
    "com.android.launcher",         # stock home
)
DEBLOAT_PROTECTED_SUBSTR = (
    "keychain", "keystore", "attest", ".security",          # attestation / keystore
    "trustonic", "mobilekey", "widevine", ".drm",           # TEE / DRM / hardware-key (attestation-adjacent)
    "devicepolicy", ".managed",                             # work-profile stack
    ".packageinstaller", "permissioncontroller",
    ".launcher", "telephony", ".phone", "server.telecom",   # active home + telephony
    ".ims", ".rcs", ".gba", "carrierconfig",                # telephony IMS/RCS/auth (farm never calls; don't risk radio)
    "wifi", ".networkstack", ".cellbroadcast",              # connectivity
)
# Google productivity apps kept by operator policy. Matched exact or as a "<id>." prefix (so Drive
# also covers com.google.android.apps.docs.editors.*). Consumer Google apps (YouTube/Maps/Photos/
# Assistant/Videos) are intentionally NOT here — they stay disable-able for RAM.
DEBLOAT_PROTECTED_GOOGLE_APPS = (
    "com.google.android.apps.docs",   # Drive + Docs/Sheets/Slides editors
    "com.google.android.gm",          # Gmail
    "com.google.android.calendar",
    "com.google.android.keep",
)


def debloat_guard(pkg):
    """Return (allowed, reason). Protected packages are refused, never silently skipped."""
    p = (pkg or "").strip()
    if not p:
        return False, "empty package name"
    lp = p.lower()
    if lp in DEBLOAT_PROTECTED_EXACT:
        return False, "protected (core system / adb / earning)"
    for pre in DEBLOAT_PROTECTED_PREFIX:
        if lp.startswith(pre):
            return False, f"protected (prefix {pre})"
    for sub in DEBLOAT_PROTECTED_SUBSTR:
        if sub in lp:
            return False, f"protected (matches '{sub}')"
    for ga in DEBLOAT_PROTECTED_GOOGLE_APPS:
        if lp == ga or lp.startswith(ga + "."):
            return False, "protected (Google productivity app — policy)"
    return True, "allowed"


def debloat_preview(packages):
    """Serial-independent: run every package through the guard without touching any phone."""
    out = []
    for pkg in packages:
        allowed, reason = debloat_guard(pkg)
        out.append({"pkg": pkg, "allowed": allowed, "reason": reason})
    return out


def _record_debloat(serial, pkg, method, disabled):
    """Persist the per-serial disabled set so restore is one command, fleet-wide."""
    with DEVICE_STATE_LOCK:
        d = DEVICE_STATE.setdefault(serial, {})
        bl = d.get("debloated") or {}
        if disabled:
            bl[pkg] = method
        else:
            bl.pop(pkg, None)
        d["debloated"] = bl
        try:
            with open(DEVICE_STATE_PATH, "w", encoding="utf-8") as f:
                json.dump(DEVICE_STATE, f)
        except Exception as e:  # noqa: BLE001
            print(f"[device-state] {e}")


def _debloat_one(serial, pkg, method):
    """Disable (or reversibly-uninstall) one package for user 0. Guard is re-checked defensively."""
    allowed, reason = debloat_guard(pkg)
    if not allowed:
        return False, f"blocked: {reason}"
    if method == "uninstall":
        _, out, err = adb(["-s", serial, "shell", "pm", "uninstall", "-k", "--user", "0", pkg], timeout=60)
    else:  # disable-user (cleanest, trivial undo)
        _, out, err = adb(["-s", serial, "shell", "pm", "disable-user", "--user", "0", pkg], timeout=60)
    text = ((out or "") + (("\n" + err) if err else "")).strip()
    lt = text.lower()
    ok = ("success" in lt) or ("new state: disabled" in lt) or ("disabled-user" in lt)
    return ok, text[:200]


def _restore_one(serial, pkg):
    """Undo either method: pm enable (for disable-user) then install-existing (for uninstall -k)."""
    _, out, err = adb(["-s", serial, "shell", "pm", "enable", "--user", "0", pkg], timeout=60)
    t1 = ((out or "") + (err or "")).strip()
    if "enabled" in t1.lower() or "success" in t1.lower():
        return True, t1[:200]
    _, out, err = adb(["-s", serial, "shell", "cmd", "package", "install-existing", "--user", "0", pkg], timeout=60)
    t2 = ((out or "") + (err or "")).strip()
    ok = "installed" in t2.lower() or "success" in t2.lower()
    return ok, (t1 + " | " + t2)[:200]


def _debloat_is_absent(detail):
    """True when the failure just means the package isn't on this device. Android words this
    several ways depending on OEM/version, so match on the recognisable fragments."""
    d = (detail or "").lower()
    return ("unknown package" in d
            or "package not found" in d
            or "not installed for user" in d
            or "failure [not_installed" in d)


DEBLOAT_JOB = {"active": False, "op": "", "method": "", "total": 0, "done": 0, "skipped": 0,
               "ok": 0, "failed": 0, "blocked": 0, "startedAt": 0.0, "results": []}
DEBLOAT_JOB_LOCK = threading.Lock()


def debloat_job(serials, packages, method, op, wave_size, wave_delay):
    """Waved background debloat/restore, mirroring the Guardian OTA job. packages=None on a
    restore means 'each serial's own recorded disabled set'."""
    def worker():
        with DEBLOAT_JOB_LOCK:
            DEBLOAT_JOB.update(active=True, op=op, method=method, total=len(serials),
                               done=0, ok=0, failed=0, blocked=0,
                               startedAt=time.time(), results=[])

        def do_serial(s):
            pkglist = packages
            if pkglist is None:  # restore-all: use what we recorded for this serial
                with DEVICE_STATE_LOCK:
                    pkglist = list((DEVICE_STATE.get(s, {}).get("debloated") or {}).keys())
            res = []
            for pkg in pkglist:
                if op == "restore":
                    ok, detail = _restore_one(s, pkg)
                    if ok:
                        _record_debloat(s, pkg, method, disabled=False)
                    res.append({"serial": s, "pkg": pkg, "ok": ok, "blocked": False,
                                "absent": (not ok) and _debloat_is_absent(detail), "detail": detail})
                else:
                    allowed, reason = debloat_guard(pkg)
                    if not allowed:
                        print(f"[debloat] REFUSED {pkg} on {s}: {reason}")
                        res.append({"serial": s, "pkg": pkg, "ok": False, "blocked": True, "detail": reason})
                        continue
                    ok, detail = _debloat_one(s, pkg, method)
                    if ok:
                        _record_debloat(s, pkg, method, disabled=True)
                    res.append({"serial": s, "pkg": pkg, "ok": ok, "blocked": False, "detail": detail})
            return res

        for i in range(0, len(serials), wave_size):
            wave = serials[i:i + wave_size]
            with ThreadPoolExecutor(max_workers=min(len(wave), 8)) as ex:
                batch = list(ex.map(do_serial, wave))
            with DEBLOAT_JOB_LOCK:
                for reslist in batch:
                    for r in reslist:
                        DEBLOAT_JOB["results"].append(r)
                        if r.get("blocked"):
                            DEBLOAT_JOB["blocked"] += 1
                        elif r["ok"]:
                            DEBLOAT_JOB["ok"] += 1
                        elif r.get("absent"):
                            # Not an error: this model simply does not ship that package.
                            DEBLOAT_JOB["skipped"] = DEBLOAT_JOB.get("skipped", 0) + 1
                        else:
                            DEBLOAT_JOB["failed"] += 1
                    DEBLOAT_JOB["done"] += 1
            if i + wave_size < len(serials):
                time.sleep(max(1, wave_delay))
        with DEBLOAT_JOB_LOCK:
            DEBLOAT_JOB["active"] = False

    threading.Thread(target=worker, daemon=True).start()


def debloat_report():
    """Aggregate Guardian's reported inventory (telemetry `packages`, v1.1.7+) into a candidate list,
    grouped by HARDWARE VARIANT (codename), not the ambiguous friendly model. Per group we surface the
    firmware-build spread and each package's coverage (present on n / N phones) — a package that isn't
    on every phone in the variant is firmware-specific and must be curated, never blindly waved.
    Good candidates: third-party (s=false) or updatable preinstall (u=true)."""
    now = time.time()
    with STATE_LOCK:
        devices = [dict(d) for d in STATE.values()]
        tel = {ip: dict(t) for ip, t in TELEMETRY.items()}
    with PKGCACHE_LOCK:
        pkgcache = {s: dict(v) for s, v in PKGCACHE.items()}
    groups = {}
    reporting = 0
    for d in devices:
        ip = SERIAL_IP.get(d["serial"]) or d["serial"].split(":")[0]
        pkgs = None
        t = tel.get(ip)
        if t and t.get("packages"):
            pts = t.get("packages_ts", t.get("recv_ts", 0))
            if (now - pts) <= PACKAGES_TTL:
                pkgs = t["packages"]
        if pkgs is None:  # fall back to the persisted inventory (survives restarts)
            c = pkgcache.get(d["serial"])
            if c and (now - c.get("ts", 0)) <= PKGCACHE_TTL:
                pkgs = c.get("packages")
        if not pkgs:
            continue
        reporting += 1
        model = d.get("model") or "unknown"
        codename = d.get("codename") or ""
        build_id = d.get("buildId") or ""
        key = codename or model  # group by real hardware; fall back to model if codename unread
        g = groups.setdefault(key, {"model": model, "codename": codename, "phones": 0,
                                     "serials": [], "builds": {}, "pkgs": {}})
        g["phones"] += 1
        g["serials"].append(d["serial"])
        if not g["codename"] and codename:
            g["codename"] = codename
        if build_id:
            g["builds"][build_id] = g["builds"].get(build_id, 0) + 1
        for it in pkgs:
            p = it.get("p")
            if not p:
                continue
            allowed, reason = debloat_guard(p)
            e = g["pkgs"].setdefault(p, {"count": 0, "sys": 0, "upd": 0, "enabled": 0,
                                         "guardable": allowed, "reason": reason, "bybuild": {}})
            e["count"] += 1
            if build_id:
                e["bybuild"][build_id] = e["bybuild"].get(build_id, 0) + 1
            if it.get("s"):
                e["sys"] += 1
            if it.get("u"):
                e["upd"] += 1
            if it.get("e"):
                e["enabled"] += 1
    out = []
    for key, g in groups.items():
        phones = g["phones"]
        cand = []
        for p, e in g["pkgs"].items():
            good = (e["sys"] < e["count"]) or (e["upd"] > 0)
            cand.append({
                "pkg": p, "installs": e["count"], "enabled": e["enabled"],
                "system": e["sys"] > 0, "updatable": e["upd"] > 0,
                "guardable": e["guardable"], "reason": e["reason"],
                "goodCandidate": bool(good and e["guardable"]),
                "universal": e["count"] >= phones,  # present on EVERY phone in the variant
                "byBuild": e["bybuild"],             # {buildId: count} — exposes carrier/firmware split
            })
        # universal candidates first (safe to wave), then partial (firmware-specific), then blocked
        cand.sort(key=lambda x: (not x["goodCandidate"], not x["universal"],
                                 not x["guardable"], -x["installs"], x["pkg"]))
        builds = [{"build": b, "phones": n}
                  for b, n in sorted(g["builds"].items(), key=lambda kv: -kv[1])]
        out.append({
            "model": g["model"], "codename": g["codename"], "phones": phones,
            "serials": g["serials"], "builds": builds, "multiBuild": len(builds) > 1,
            "packages": cand,
        })
    out.sort(key=lambda x: -x["phones"])
    return {"reporting": reporting, "variants": out}


# ---------------------------------------------------------------- HTTP

def snapshot():
    with STATE_LOCK:
        devices = [dict(d) for d in STATE.values()]
    devices.sort(key=lambda d: d["label"].lower())
    counts = {"device": 0, "offline": 0, "unauthorized": 0, "rebooting": 0}
    version_summary = {}
    latest_code = 0
    for d in devices:
        if d.get("action") == "rebooting":
            counts["rebooting"] += 1
        elif d.get("state") in counts:
            counts[d["state"]] += 1
        else:
            counts["offline"] += 1
        vc = d.get("versionCode", 0)
        if vc > latest_code:
            latest_code = vc
        v = d.get("version") or ""
        if v:
            version_summary[v] = version_summary.get(v, 0) + 1
    # Flag devices behind the newest version seen across the fleet + attach fresh Guardian telemetry.
    now = time.time()
    behind = 0
    with RELEASE_LOCK:
        rel = {k: RELEASE.get(k) for k in (
            "versionName", "assetName", "publishedAt", "certOk", "packageOk",
            "ready", "error", "checkedAt", "sizeBytes")}
    rel_t = _semver_tuple(rel["versionName"]) if rel.get("versionName") else None
    update_count = 0
    for d in devices:
        vc = d.get("versionCode", 0)
        d["behind"] = bool(vc and latest_code and vc < latest_code)
        if d["behind"]:
            behind += 1
        # updateAvailable = a verified newer LITE release exists AND this device is on an older version.
        inst_t = _semver_tuple(d.get("version", "")) if (d.get("version") and d["version"][:1].isdigit()) else None
        d["updateAvailable"] = bool(rel.get("ready") and rel_t and inst_t and inst_t < rel_t)
        if d["updateAvailable"]:
            update_count += 1
        with STATE_LOCK:
            _c = [SERIAL_IP.get(d["serial"]), SERIAL_IP.get(_dedupe_base(d["serial"])), d["serial"].split(":")[0]]
            ip = next((c for c in _c if c and TELEMETRY.get(c) and (now - TELEMETRY[c].get("recv_ts", 0)) < TELEMETRY_TTL), None) or _c[0] or _c[2]
            t = TELEMETRY.get(ip)
            a = ACURAST.get(d.get("address", "")) if d.get("address") else None
        if t and (now - t.get("recv_ts", 0)) < TELEMETRY_TTL:
            d["telemetry"] = t
            # guardianArmed/guardianVersion are persisted by remember_device() and only rewritten on
            # arm/provision/scan, so they go stale and can show a protected phone as UNARMED (proven
            # 2026-08-08: 4 phones read unarmed while their own telemetry reported armed + a live
            # protection gate). A fresh self-report from the device beats our last-known value.
            if t.get("armed") is not None:
                d["guardianArmed"] = bool(t.get("armed"))
            _afs = t.get("a11y_false_since")
            d["a11yFalseMin"] = round((now - _afs) / 60, 1) if _afs else None
        if a and (now - a.get("_recv", 0)) < ACURAST_TTL:
            d["acurast"] = a
        if d.get("address"):
            with PULSE_LOCK:
                ph = PULSE_HEALTH.get(d["address"])
            if ph:
                d["pulseHealth"] = ph          # only non-healthy processors are returned by Pulse
        # foreground-loss rate (losses/hour) from the rolling history
        with FG_HIST_LOCK:
            hist = FG_HIST.get(ip)
            if hist and len(hist) >= 2:
                cutoff = now - FG_RATE_WINDOW
                win = [p for p in hist if p[0] >= cutoff] or hist[-2:]
                (t0, c0), (t1, c1) = win[0], win[-1]
                span = t1 - t0
                if span >= 120 and c1 >= c0:
                    d["fgRate"] = round((c1 - c0) / (span / 3600.0), 2)
        d["ip"] = (t.get("ip") if t else None) or SERIAL_IP.get(d["serial"]) or SERIAL_IP.get(_dedupe_base(d["serial"])) or ""
        # Keep per-device temps compact in the state feed (full zone map is in /api/thermal-history).
        tt = d.get("temps")
        if tt:
            d["temps"] = {k: v for k, v in tt.items() if k != "zones"}
        with DEVICE_STATE_LOCK:
            d["debloated"] = dict((DEVICE_STATE.get(d["serial"], {}) or {}).get("debloated") or {})

    cpus = [d["temps"]["cpu"] for d in devices
            if d.get("temps") and d["temps"].get("cpu") is not None]
    hottest_dev = None
    for d in devices:
        c = (d.get("temps") or {}).get("cpu")
        if c is not None and (hottest_dev is None or c > hottest_dev["cpu"]):
            hottest_dev = {"label": d["label"], "cpu": c, "serial": d["serial"]}
    thermal_summary = {
        "count": len(cpus),
        "avgCpu": round(sum(cpus) / len(cpus), 1) if cpus else None,
        "maxCpu": max(cpus) if cpus else None,
        "hottest": hottest_dev,
    }
    # Fleet health alerts derived from the probe (all high-value farm signals).
    def _m(d):
        return d.get("metrics") or {}
    on_battery = sum(1 for d in devices if (_m(d).get("battery") or {}).get("status") == "discharging")
    proc_down = sum(1 for d in devices if d.get("state") == "device"
                    and _m(d).get("proc") and _m(d)["proc"].get("alive") is False)
    weak_wifi = sum(1 for d in devices
                    if (_m(d).get("wifi") or {}).get("rssi") is not None and _m(d)["wifi"]["rssi"] < -75)
    screen_on = sum(1 for d in devices if _m(d).get("wake") == "Awake")
    low_batt = sum(1 for d in devices
                   if (_m(d).get("battery") or {}).get("level") is not None
                   and _m(d)["battery"]["level"] < 20
                   and (_m(d).get("battery") or {}).get("status") == "discharging")
    throttling = sum(1 for d in devices
                     if (_m(d).get("throttle") or {}).get("level") not in (None, 0))
    metrics_summary = {
        "onBattery": on_battery, "procDown": proc_down, "weakWifi": weak_wifi,
        "screenOn": screen_on, "lowBattery": low_batt, "throttling": throttling,
    }
    fg_climbing = [d for d in devices if d.get("fgRate")]
    fg_worst = max(fg_climbing, key=lambda x: x["fgRate"], default=None)
    fg_summary = {
        "climbing": sum(1 for d in fg_climbing if d["fgRate"] >= 1),
        "worst": ({"label": fg_worst["label"], "rate": fg_worst["fgRate"], "serial": fg_worst["serial"]}
                  if fg_worst else None),
    }
    # Fleet arm-readiness rollup: aggregate the per-phone arm{} grant flags → catch provisioning drift.
    ARM_FLAGS = ["wdKeepAlive", "backgroundLaunch", "notifications", "batteryOptExcluded",
                 "protectionRunning", "fleetManagementMode", "adbWifiEnabled"]
    r_ready = r_degraded = r_reporting = 0
    miss_by_flag = {}
    degraded_devs = []
    for d in devices:
        t = d.get("telemetry")
        if not t:
            continue
        arm = t.get("arm") or {}
        if not arm:
            continue
        r_reporting += 1
        miss = [f for f in ARM_FLAGS if arm.get(f) is False]
        if miss:
            r_degraded += 1
            degraded_devs.append({"label": d["label"], "serial": d["serial"], "missing": miss})
            for f in miss:
                miss_by_flag[f] = miss_by_flag.get(f, 0) + 1
        else:
            r_ready += 1
    readiness = {"reporting": r_reporting, "ready": r_ready, "degraded": r_degraded,
                 "missingByFlag": miss_by_flag, "degradedDevices": degraded_devs}
    return {
        "devices": devices,
        "counts": counts,
        "total": len(devices),
        "batch": CFG.get("batch", {"wave_size": 8, "wave_delay_sec": 20}),
        "tokenRequired": bool(CFG.get("token", "")),
        "discovery": {
            "expected": _expected_devices(),
            "online": counts.get("device", 0),
            "gapSince": _HEAL.get("gap_since") or 0,
        },
        "pulseHealth": dict(PULSE_HEALTH_SUMMARY),
        "versionSummary": version_summary,
        "latestVersionCode": latest_code,
        "behindCount": behind,
        "wsScrcpyUrl": (CFG.get("ws_scrcpy_url") or "").strip().rstrip("/"),
        "maxWall": MAX_WALL,
        "release": rel,
        "updateCount": update_count,
        "updateBatch": {
            "wave_size": int(CFG.get("updates", {}).get("wave_size", 4)),
            "wave_delay_sec": int(CFG.get("updates", {}).get("wave_delay_sec", 15)),
        },
        "thermalSummary": thermal_summary,
        "metricsSummary": metrics_summary,
        "thermalPoll": int(CFG.get("thermal_poll_seconds", 45)),
        "guardian": {
            "enabled": bool(GUARDIAN_REPO and GUARDIAN_TOKEN),
            "screensaver": dict(SCREENSAVER),
            "repo": GUARDIAN_REPO,
            "package": GUARDIAN_PKG,
            "job": dict(GUARDIAN_JOB),
            "opportunistic": dict(OPPORTUNISTIC),
        "keepLite": {k: KEEP_LITE[k] for k in
                         ("enabled", "interval", "lastSweep", "acted", "checked", "lastActed")},
            "fgLoss": fg_summary,
            "readiness": readiness,
        },
        "debloat": {"job": dict(DEBLOAT_JOB)},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # no-store so browsers always fetch the latest UI (the split .css/.js have no cache-busting)
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def _auth_ok(self):
        need = CFG.get("token", "")
        if not need:
            return True
        return self.headers.get("X-Fleet-Token", "") == need

    def _read_json(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n == 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            with open(os.path.join(HERE, "static", "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif path == "/api/state":
            self._send(200, json.dumps(snapshot()))
        elif path == "/api/setup":
            if not self._auth_ok():
                return self._send(403, json.dumps({"error": "forbidden"}))
            self._send(200, json.dumps({"ok": True, "fields": setup_snapshot(),
                                        "groups": setup_groups()}))
        elif path.startswith("/vendor/"):
            fn = os.path.basename(path)  # basename strips any path-traversal
            fp = os.path.join(HERE, "static", "vendor", fn)
            if fn.endswith(".js") and os.path.isfile(fp):
                with open(fp, "rb") as f:
                    self._send(200, f.read(), "application/javascript; charset=utf-8")
            else:
                self._send(404, json.dumps({"error": "not found"}))
        elif path.endswith((".css", ".js")) and "/" not in path.strip("/"):
            # Top-level split static assets (the redesign's /fleet-console.css, /fleet-utils.js,
            # /fleet-console.js). Basename-guarded + single-segment path → no traversal.
            fn = os.path.basename(path)
            fp = os.path.join(HERE, "static", fn)
            if os.path.isfile(fp):
                ctype = "text/css; charset=utf-8" if fn.endswith(".css") \
                    else "application/javascript; charset=utf-8"
                with open(fp, "rb") as f:
                    self._send(200, f.read(), ctype)
            else:
                self._send(404, json.dumps({"error": "not found"}))
        elif path in ("/guardian.apk", "/api/guardian/apk"):
            tag = (urllib.parse.parse_qs(urlparse(self.path).query).get("tag", [""])[0] or "latest").strip()
            try:
                apk_path, rel = ensure_release_apk(tag)
                with open(apk_path, "rb") as f:
                    blob = f.read()
            except Exception as e:  # noqa: BLE001
                return self._send(503, json.dumps({"error": f"apk unavailable: {e}"}))
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.android.package-archive")
            self.send_header("Content-Disposition",
                             f'attachment; filename="{os.path.basename(apk_path)}"')
            self.send_header("Content-Length", str(len(blob)))
            self.send_header("X-Guardian-Version", str(rel.get("tag", "")))
            self.send_header("X-Guardian-SHA256", str(rel.get("sha256", "")))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(blob)
        elif path == "/api/thermal-history":
            qs = urllib.parse.parse_qs(urlparse(self.path).query)
            try:
                hours = float(qs.get("hours", ["6"])[0])
            except ValueError:
                hours = 6.0
            hours = max(0.1, min(hours, 24 * int(CFG.get("metrics_retention_days", 7))))
            try:
                hist = query_history(hours)
            except Exception as e:  # noqa: BLE001
                print(f"[metrics-db] query: {e}")
                hist = {}
            with STATE_LOCK:
                labels = {s: STATE[s]["label"] for s in hist if s in STATE}
            self._send(200, json.dumps({
                "history": hist, "labels": labels, "fields": HIST_FIELDS,
                "pollSeconds": int(CFG.get("thermal_poll_seconds", 45)),
                "retentionDays": int(CFG.get("metrics_retention_days", 7)),
            }))
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_json()

        # Telemetry ingest is unauthenticated (devices push here); it only stores informational health.
        if path == "/api/telemetry":
            ip = (body.get("ip") or "").strip()
            if ip:
                body["recv_ts"] = time.time()
                fresh_ser = None
                with STATE_LOCK:
                    prev = TELEMETRY.get(ip)
                    fresh_pkgs = bool(body.get("packages"))
                    if fresh_pkgs:
                        body["packages_ts"] = body["recv_ts"]
                    elif prev and prev.get("packages"):        # carry the throttled inventory forward
                        body["packages"] = prev["packages"]
                        body["packages_ts"] = prev.get("packages_ts", prev.get("recv_ts"))
                    # a11yHealthy flaps false for several minutes after any Guardian package
                    # replace (the OTA unbinds the accessibility service; Android re-binds it a few
                    # minutes later). Only a SUSTAINED false is actionable, so stamp when it first
                    # went false and carry that stamp across pushes; clear it as soon as it recovers.
                    if body.get("a11yHealthy") is False:
                        body["a11y_false_since"] = (prev or {}).get("a11y_false_since") or body["recv_ts"]
                    TELEMETRY[ip] = body
                    # Correct SERIAL_IP from the device self-report (name==serial, ip==real wlan0)
                    # so stale-mDNS IP collisions heal within one telemetry cycle instead of waiting
                    # on adb mDNS TTLs. See memory note: N-phones-share-one-IP.
                    _nm = body.get("name")
                    if isinstance(_nm, str) and _nm.startswith("adb-") and SERIAL_IP.get(_nm) != ip:
                        SERIAL_IP[_nm] = ip
                    if fresh_pkgs:
                        fresh_ser = next((s for s, i in SERIAL_IP.items() if i == ip), None)
                fc = body.get("foregroundLostCount")
                if isinstance(fc, (int, float)):  # track for the losses/hour rate
                    with FG_HIST_LOCK:
                        dq = FG_HIST.setdefault(ip, [])
                        dq.append((body["recv_ts"], fc))
                        if len(dq) > 180:
                            del dq[0]
                if fresh_ser:  # persist only a genuinely-new inventory (~once/30min per phone)
                    save_pkgcache(fresh_ser, body["packages"], body["packages_ts"])
                pa = body.get("processorAddressPartial")
                if pa:
                    try:
                        full = resolve_partial_address(pa)
                        if full:
                            _rser = None
                            with STATE_LOCK:
                                ser = next((sv for sv, iv in SERIAL_IP.items() if iv == ip), None)
                                d = STATE.get(ser) if ser else None
                                if d and not d.get("address"):
                                    d["address"] = full
                                    _rser = ser
                            if _rser:
                                remember_device(_rser, address=full)
                                print(f"[addr] {_rser[:26]} <- partial '{pa}' -> {full}")
                    except Exception:
                        pass  # partial-address resolution must NEVER break telemetry ingest
            resp = {"ok": bool(ip)}
            try:
                cmds = readb_command_for(body.get("uuid", ""), ip)
                if cmds:
                    resp["commands"] = cmds
            except Exception:
                pass  # command logic must NEVER break telemetry ingest
            return self._send(200, json.dumps(resp))

        if not self._auth_ok():
            return self._send(401, json.dumps({"error": "bad token"}))
        if path == "/api/import":
            devs = parse_csv(body.get("csv", ""))
            n = apply_devices(devs, bool(body.get("replace")))
            refresh_devices()
            return self._send(200, json.dumps({"ok": True, "imported": len(devs), "total": n}))
        if path == "/api/forget":
            forget_device(body.get("serial", ""))
            refresh_devices()
            return self._send(200, json.dumps({"ok": True}))
        if path == "/api/rename":
            serial = (body.get("serial") or "").strip()
            alias = (body.get("alias") or "").strip()[:40]
            if serial:
                with STATE_LOCK:
                    if serial in STATE:
                        STATE[serial]["alias"] = alias
                remember_device(serial, alias=alias)
            return self._send(200, json.dumps({"ok": bool(serial), "alias": alias}))
        if path == "/api/reboot":
            ok, msg = reboot(body.get("serial", ""), force=bool(body.get("force")))
            self._send(200, json.dumps({"ok": ok, "message": msg}))
        elif path == "/api/reboot-batch":
            serials = body.get("serials", [])
            b = CFG.get("batch", {})
            skipped = reboot_batch(serials, int(body.get("wave_size", b.get("wave_size", 8))),
                                   int(body.get("wave_delay_sec", b.get("wave_delay_sec", 20))),
                                   force=bool(body.get("force")))
            self._send(200, json.dumps({"ok": True, "queued": len(serials) - len(skipped),
                                        "skippedMaintenance": skipped}))
        elif path == "/api/connect":
            ok, msg = connect(body.get("host", ""))
            self._send(200, json.dumps({"ok": ok, "message": msg}))
        elif path == "/api/discover":
            discover_mdns()
            refresh_devices()
            self._send(200, json.dumps({"ok": True}))
        elif path == "/api/scan-versions":
            with STATE_LOCK:
                online = [s for s, d in STATE.items() if d.get("state") == "device"]
            scan_versions(online)
            self._send(200, json.dumps({"ok": True, "scanned": len(online)}))
        elif path == "/api/screenshot":
            png = screenshot_png(body.get("serial", ""))
            if png:
                self._send(200, json.dumps({"ok": True, "png": base64.b64encode(png).decode()}))
            else:
                self._send(200, json.dumps({"ok": False, "message": "capture failed (device offline?)"}))
        elif path == "/api/action":
            results = run_action_bulk(
                body.get("serials", []), body.get("action", ""), body.get("command", ""),
            )
            self._send(200, json.dumps({"ok": True, "results": results}))
        elif path == "/api/screenshot-batch":
            serials = body.get("serials", [])
            results = screenshot_batch(serials)
            self._send(200, json.dumps({"ok": True, "results": results, "capped": len(serials) > MAX_WALL}))
        elif path == "/api/update-check":
            # Re-check GitHub now (download+verify can take ~40s → run async; UI reflects it on next poll).
            threading.Thread(target=check_release, daemon=True).start()
            self._send(200, json.dumps({"ok": True, "message": "checking releases…"}))
        elif path == "/api/update":
            res = update_device(body.get("serial", ""), bool(body.get("allow_downgrade")))
            self._send(200, json.dumps({"ok": res["ok"], "result": res}))
        elif path == "/api/update-batch":
            serials = body.get("serials", [])
            u = CFG.get("updates", {})
            update_batch(
                serials,
                int(body.get("wave_size", u.get("wave_size", 4))),
                int(body.get("wave_delay_sec", u.get("wave_delay_sec", 15))),
                bool(body.get("allow_downgrade")),
            )
            self._send(200, json.dumps({"ok": True, "queued": len(serials)}))
        elif path == "/api/guardian/releases":
            try:
                rels = github_releases(force=bool(body.get("force")))
                self._send(200, json.dumps({"ok": True, "releases": rels}))
            except Exception as e:  # noqa: BLE001
                self._send(200, json.dumps({"ok": False, "message": str(e)}))
        elif path == "/api/guardian/scan":
            with STATE_LOCK:
                online = [s for s, d in STATE.items() if d.get("state") == "device"]
            scan_guardians(online)
            self._send(200, json.dumps({"ok": True, "scanned": len(online)}))
        elif path == "/api/guardian/reset-fg":
            serials = body.get("serials", [])
            if not serials:
                return self._send(200, json.dumps({"ok": False, "message": "no devices selected"}))
            results = reset_fg_losses(serials)
            ok = sum(1 for r in results if r["ok"])
            self._send(200, json.dumps({"ok": True, "reset": ok, "total": len(results), "results": results}))
        elif path == "/api/guardian/locate":
            serials = body.get("serials", [])
            if not serials:
                return self._send(200, json.dumps({"ok": False, "message": "no devices selected"}))
            if body.get("stop"):
                with ThreadPoolExecutor(max_workers=8) as ex:
                    results = list(ex.map(locate_stop_one, serials))
            else:
                seconds = int(body.get("seconds", 120))
                with STATE_LOCK:
                    labels = {sv: ((STATE.get(sv) or {}).get("alias") or (STATE.get(sv) or {}).get("label") or sv) for sv in serials}
                with ThreadPoolExecutor(max_workers=8) as ex:
                    results = list(ex.map(lambda sv: locate_one(sv, seconds, labels.get(sv, sv)), serials))
            ok = sum(1 for r in results if r["ok"])
            self._send(200, json.dumps({"ok": True, "located": ok, "total": len(results), "stop": bool(body.get("stop")), "results": results}))
        elif path == "/api/guardian/opportunistic":
            with OPPORTUNISTIC_LOCK:
                if "enabled" in body:
                    OPPORTUNISTIC["enabled"] = bool(body["enabled"])
                    if OPPORTUNISTIC["enabled"]:
                        OPPORTUNISTIC["lastRun"] = 0.0     # act on the next tick
                if "batch" in body:
                    try:
                        OPPORTUNISTIC["batch"] = max(1, min(20, int(body["batch"])))
                    except (TypeError, ValueError):
                        pass
                if "interval_sec" in body:
                    try:
                        OPPORTUNISTIC["interval"] = max(120, int(body["interval_sec"]))
                    except (TypeError, ValueError):
                        pass
                if "tag" in body:
                    OPPORTUNISTIC["tag"] = (str(body["tag"]) or "latest").strip()
                st = dict(OPPORTUNISTIC)
            self._send(200, json.dumps({"ok": True, "opportunistic": st}))
        elif path == "/api/guardian/maintenance":
            serials = body.get("serials", [])
            if not serials:
                return self._send(200, json.dumps({"ok": False, "message": "no devices selected"}))
            enter = bool(body.get("enter", True))
            # bounded the same way the app bounds it (1..1440), so the console cannot ask for a
            # window the phone will silently clamp
            try:
                minutes = max(1, min(1440, int(body.get("minutes", 15))))
            except (TypeError, ValueError):
                minutes = 15
            with ThreadPoolExecutor(max_workers=8) as ex:
                results = list(ex.map(lambda sv: maintenance_one(sv, enter, minutes), serials))
            ok = sum(1 for r in results if r["ok"])
            print(f"[maintenance] {'entered' if enter else 'exited'} on {ok}/{len(results)}"
                  + (f" for {minutes} min" if enter else ""))
            self._send(200, json.dumps({"ok": True, "enter": enter, "minutes": minutes,
                                        "applied": ok, "total": len(results), "results": results}))
        elif path == "/api/live/prep":
            serial = (body.get("serial") or "").strip()
            if not serial:
                return self._send(200, json.dumps({"ok": False, "message": "no serial"}))
            self._send(200, json.dumps(live_prep(serial, int(body.get("wait", 12)))))
        elif path == "/api/guardian/screensaver":
            enabled = bool(body.get("enabled"))
            serials = body.get("serials")
            if not serials:  # default: whole fleet (one transport per physical phone)
                with STATE_LOCK:
                    seen, serials = set(), []
                    for sv, d in STATE.items():
                        if d.get("state") != "device":
                            continue
                        b = _dedupe_base(sv)
                        if b not in seen:
                            seen.add(b)
                            serials.append(sv)
            with ThreadPoolExecutor(max_workers=8) as ex:
                results = list(ex.map(lambda sv: screensaver_one(sv, enabled), serials))
            ok = sum(1 for r in results if r["ok"])
            with SCREENSAVER_LOCK:
                SCREENSAVER["enabled"] = enabled
                SCREENSAVER["on" if enabled else "off"] = ok
                SCREENSAVER["ts"] = time.time()
            save_screensaver()
            self._send(200, json.dumps({"ok": True, "enabled": enabled, "applied": ok,
                                        "total": len(results), "results": results}))
        elif path == "/api/guardian/keep-lite":
            with KEEP_LITE_LOCK:
                if "enabled" in body:
                    KEEP_LITE["enabled"] = bool(body["enabled"])
                    if KEEP_LITE["enabled"]:
                        KEEP_LITE["lastSweep"] = 0.0  # sweep on the next loop tick (within ~5s)
                if "interval_sec" in body:
                    try:
                        KEEP_LITE["interval"] = max(60, int(body["interval_sec"]))
                    except (TypeError, ValueError):
                        pass
                st = {k: KEEP_LITE[k] for k in
                      ("enabled", "interval", "lastSweep", "acted", "checked", "lastActed")}
            self._send(200, json.dumps({"ok": True, "keepLite": st}))
        elif path == "/api/pairing-devices":
            self._send(200, json.dumps({"ok": True, "devices": discover_pairing()}))
        elif path == "/api/pair":
            host = (body.get("host") or "").strip()
            code = (body.get("code") or "").strip()
            if not host or not code:
                return self._send(200, json.dumps({"ok": False, "message": "host (ip:port) and code required"}))
            ok, msg = pair_device(host, code)
            if ok:
                discover_mdns()
                refresh_devices()
            self._send(200, json.dumps({"ok": ok, "message": msg}))
        elif path == "/api/guardian/provision":
            serials = body.get("serials", [])
            if not serials:
                return self._send(200, json.dumps({"ok": False, "message": "no devices selected"}))
            tel = (CFG.get("guardian_update", {}).get("telemetry_url") or "").strip()
            results = provision_guardians(serials, tel)
            self._send(200, json.dumps({"ok": True, "results": results}))
        elif path == "/api/setup":
            if not self._auth_ok():
                return self._send(403, json.dumps({"error": "forbidden"}))
            try:
                changed = apply_setup(body.get("values") or {}, body.get("clear") or [])
            except Exception as e:  # noqa: BLE001
                return self._send(200, json.dumps({"ok": False, "message": f"save failed: {e}"}))
            return self._send(200, json.dumps({"ok": True, "changed": changed,
                                               "fields": setup_snapshot(),
                                               "groups": setup_groups()}))
        elif path == "/api/guardian/install":
            serials = body.get("serials", [])
            tag = (body.get("tag") or "latest").strip()
            if not serials:
                return self._send(200, json.dumps({"ok": False, "message": "no devices selected"}))
            with GUARDIAN_JOB_LOCK:
                busy = GUARDIAN_JOB["active"]
            if busy:
                return self._send(200, json.dumps({"ok": False, "message": "an install job is already running"}))
            try:
                apk_path, rel = ensure_release_apk(tag)  # download + SHA-256 + cert verify, once
            except Exception as e:  # noqa: BLE001
                return self._send(200, json.dumps({"ok": False, "message": f"prepare failed: {e}"}))
            b = GUARDIAN_BATCH
            guardian_install_job(
                serials, apk_path, rel,
                int(body.get("wave_size", b.get("wave_size", 6))),
                int(body.get("wave_delay_sec", b.get("wave_delay_sec", 15))),
            )
            self._send(200, json.dumps({
                "ok": True, "queued": len(serials), "tag": rel["tag"],
                "apk": rel["apkName"], "sha256": rel.get("sha256", ""), "certOk": rel.get("certOk"),
            }))
        elif path == "/api/debloat/report":
            self._send(200, json.dumps({"ok": True, **debloat_report()}))
        elif path == "/api/debloat/preview":
            pkgs = [p for p in (body.get("packages") or []) if isinstance(p, str)]
            self._send(200, json.dumps({
                "ok": True, "preview": debloat_preview(pkgs), "serials": body.get("serials", []),
            }))
        elif path == "/api/debloat/apply":
            serials = body.get("serials", [])
            pkgs = [p for p in (body.get("packages") or []) if isinstance(p, str)]
            method = (body.get("method") or "disable").strip()
            if method not in ("disable", "uninstall"):
                return self._send(200, json.dumps({"ok": False, "message": "method must be disable|uninstall"}))
            if not serials or not pkgs:
                return self._send(200, json.dumps({"ok": False, "message": "serials and packages required"}))
            with DEBLOAT_JOB_LOCK:
                if DEBLOAT_JOB["active"]:
                    return self._send(200, json.dumps({"ok": False, "message": "a debloat job is already running"}))
            verdict = debloat_preview(pkgs)
            allowed_pkgs = [v["pkg"] for v in verdict if v["allowed"]]
            blocked = [{"pkg": v["pkg"], "reason": v["reason"]} for v in verdict if not v["allowed"]]
            if not allowed_pkgs:
                return self._send(200, json.dumps({"ok": False, "message": "all packages blocked by guard", "blocked": blocked}))
            b = CFG.get("batch", {})
            debloat_job(serials, allowed_pkgs, method, "apply",
                        int(body.get("wave_size", b.get("wave_size", 6))),
                        int(body.get("wave_delay_sec", b.get("wave_delay_sec", 15))))
            self._send(200, json.dumps({
                "ok": True, "queued": len(serials), "packages": len(allowed_pkgs),
                "blocked": blocked, "method": method,
            }))
        elif path == "/api/debloat/restore":
            serials = body.get("serials", [])
            if not serials:
                return self._send(200, json.dumps({"ok": False, "message": "serials required"}))
            with DEBLOAT_JOB_LOCK:
                if DEBLOAT_JOB["active"]:
                    return self._send(200, json.dumps({"ok": False, "message": "a debloat job is already running"}))
            raw = body.get("packages")
            pkglist = [p for p in raw if isinstance(p, str)] if raw else None  # None = each serial's recorded set
            b = CFG.get("batch", {})
            debloat_job(serials, pkglist, "", "restore",
                        int(body.get("wave_size", b.get("wave_size", 6))),
                        int(body.get("wave_delay_sec", b.get("wave_delay_sec", 15))))
            self._send(200, json.dumps({"ok": True, "queued": len(serials),
                                        "scope": "all-recorded" if pkglist is None else len(pkglist)}))
        else:
            self._send(404, json.dumps({"error": "not found"}))


def main():
    threading.Thread(target=poll_loop, daemon=True).start()
    threading.Thread(target=version_loop, daemon=True).start()
    threading.Thread(target=acurast_loop, daemon=True).start()
    threading.Thread(target=release_loop, daemon=True).start()
    threading.Thread(target=thermal_loop, daemon=True).start()
    threading.Thread(target=keep_lite_loop, daemon=True).start()
    threading.Thread(target=opportunistic_update_loop, daemon=True).start()
    threading.Thread(target=pulse_health_loop, daemon=True).start()
    threading.Thread(target=telemetry_nudge_loop, daemon=True).start()
    threading.Thread(target=discovery_heal_loop, daemon=True).start()
    threading.Thread(target=idle_hub_loop, daemon=True).start()
    # Restarting THIS service kills the adb server with it: the server is spawned by our own adb
    # calls, so it lives in this unit's cgroup. A fresh one starts on the next command, and
    # ws-scrcpy stays bound to the dead one — unit still "active", still answers 200, device list
    # silently empty, Live screen does nothing with no error anywhere. _restart_ws_scrcpy() already
    # existed for heal-triggered adb restarts; a plain console restart needs it just as much
    # (2026-08-09: Live was dead for hours after routine restarts until this was noticed).
    threading.Thread(target=_ws_scrcpy_boot_check, daemon=True).start()
    bind, port = CFG.get("bind", "127.0.0.1"), int(CFG.get("port", 8787))
    print(f"Acurast Fleet Console → http://{bind}:{port}   (adb: {ADB})")
    if bind == "0.0.0.0" and not CFG.get("token"):
        print("[warn] bound to 0.0.0.0 with NO token — anyone on the LAN can reboot your fleet. Set 'token'.")
    ThreadingHTTPServer((bind, port), Handler).serve_forever()


if __name__ == "__main__":
    main()

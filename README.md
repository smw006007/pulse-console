# Pulse Console

A tiny, self-hosted dashboard to monitor and manage your **own** Acurast processor phones over
wireless ADB — live device grid, health telemetry, reboots (staggered in waves), screenshots, live
screen control (via scrcpy / ws-scrcpy), Guardian APK updates, and arbitrary `adb shell` actions.
Python stdlib only, no pip installs.

---

## ⚠️ NO SUPPORT — AT ALL

**This is released as-is, with absolutely no support of any kind.** No help, no issues triage, no
warranty, no guarantee it works for you, no promise of updates or fixes. Do not open issues or ask for
help — they will not be answered. If you run it, **you are entirely on your own.** You are responsible
for understanding what every feature does before you use it, and for any consequences on your devices
or your Acurast earnings. See the LICENSE — it is provided "AS IS", without warranty of any kind.

If that is not acceptable to you, do not use this.

---

## 🔒 Read this before you run it — these are full device control

Every action/screenshot/shell/reboot endpoint is **full, root-equivalent control of the phones** it can
reach over adb. Treat this like handing out a root password.

- **`token`** — set a long random secret in `devices.json`. All privileged endpoints require it.
- **`bind`** — bind to a **private interface only** (`127.0.0.1`, or a VPN/tailnet IP). **Never expose
  this on the public internet or an untrusted LAN.** Anyone who reaches it can control your phones.
- **ws-scrcpy has NO AUTHENTICATION.** If you enable `ws_scrcpy_url`, the ws-scrcpy server (an external
  tool you run separately, port 8000) gives **anyone who can reach it full live control of every phone**.
  It **MUST** be locked to your private network with a firewall. Example systemd + iptables lock:
  ```ini
  # /etc/systemd/system/ws-scrcpy.service
  ExecStartPre=+/bin/sh -c 'iptables -C INPUT -p tcp --dport 8000 ! -i <YOUR_VPN_IF> -j DROP 2>/dev/null || iptables -I INPUT -p tcp --dport 8000 ! -i <YOUR_VPN_IF> -j DROP'
  ExecStart=/usr/bin/node /path/to/ws-scrcpy/dist/index.js
  ```
- **Do NOT script taps inside the attested Acurast processor.** It runs autonomously; automating its UI
  risks attestation (and your earnings). Use this for device-level actions, observation, and
  troubleshooting only.
- These are **your own** phones. Only ever point this at devices you own and control.

---

## Setup

Requirements: Python 3, `adb` (Android platform-tools) on your machine or path, and your phones on
Android 11+ **Wireless debugging** (paired once, left enabled).

1. Copy the config template and edit it:
   ```bash
   cp devices.example.json devices.json
   ```
   Set a `token`, keep `bind` private, and (optionally) fill in `ws_scrcpy_url`, `acurast_backend`,
   and `guardian_update` for your own setup. **`devices.json` is yours — never commit it.**
2. Run it:
   ```bash
   python3 fleet.py          # or run.bat on Windows
   ```
3. Open the dashboard at `http://<your-bind>:<port>` (default `http://127.0.0.1:8787`).

After first run you can configure most settings **from the UI** instead of editing JSON:
**⚙ Options → Open server settings** (token-gated; hot-reloads, no restart). `token`, `bind`, and
`port` are deliberately not editable there — a browser that could rewrite them could lock you out.

## Add a phone (wireless ADB, ~1 min)

Turn it on, pair once, and the console does the rest — it auto-connects, and re-connects after reboots.
Requires Android 11+ and the console machine being able to reach the phone (same LAN, or your VPN/tailnet).

**On the phone** (one-time):
1. **Settings → Developer options → Wireless debugging → ON.**
2. Tap **Pair device with pairing code.** It shows an **IP:port** and a **6-digit code** — leave it open.

**In the console:**
3. Click **Onboard phone**.
4. Click **Refresh scan** — the phone appears under **"Phones waiting to pair"**; click it (it fills in
   the host). *Or type the IP:port the phone is showing.*
5. Enter the **6-digit code** → **Pair.**

That's it. The phone appears on the grid, and everything after — health, reboots, screenshots, live
control, Guardian install/provision — is driven from the console.

> It's forgiving about the port: paste just the IP, or either port (connect *or* pairing) — it
> auto-resolves the correct `_adb-tls-pairing` port from mDNS.

### Point the Pulse Guardian app at this console (telemetry)
In the Guardian app's telemetry setting, set the URL to `http://<your-console>:<port>/api/telemetry`.
The console ingests it (unauthenticated ingest — it only stores health), keyed by the phone's Wi-Fi IP,
and merges it onto that device's card.

### Live screen control (optional)
Install [`scrcpy`](https://github.com/Genymobile/scrcpy) on a machine with a display for one-off
interactive control, or stand up [`ws-scrcpy`](https://github.com/NetrisTV/ws-scrcpy) for browser-based
control and set `ws_scrcpy_url` — **behind a firewall (see the security section).**

### Command channel (optional, advanced) — un-strand a phone that dropped off adb
The console can return a **signed `readb` command** in the telemetry response to a phone that's still
posting telemetry but has fallen off the adb bus, telling Guardian to re-announce wireless debugging so
your auto-connect re-grabs it. It's the one control path that survives an adb drop (everything else —
reboot, locate, screenshot — needs a live adb transport).

- Set the **same** secret on both halves: `guardian_command_secret` in `devices.json`, and provision the
  app with it over adb: `... ENABLE_PROTECTION --es command_secret <same-secret>`.
- **Blank secret = channel off** (the default). Signed HMAC-SHA256, single-use nonce, ±600 s window.
- **The channel ships gated OFF (`READB_ENABLED = False`) and is NOT field-validated** — the signing
  path has only ever run in a one-device test. Treat it as experimental; flip `READB_ENABLED` yourself
  only after your own operator-present check. `locate`/screensaver are **not** on this channel — they go
  out as direct adb broadcasts (so they need the phone reachable over adb).

---

## Honest limits

- `adb reboot` only reaches a phone whose wireless ADB is still responsive. A truly hung phone needs
  power control (smart plug / powered hub), not adb.
- Screenshots/scrcpy over relayed VPN links are laggy; on-LAN it's snappy.
- Classic `adb tcpip` does not survive reboot — use Android 11+ Wireless debugging; this console
  rediscovers devices via mDNS.

## License

MIT — see [LICENSE](LICENSE). Provided **AS IS, without warranty of any kind.** No support.

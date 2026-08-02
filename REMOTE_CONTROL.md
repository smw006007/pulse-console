# Remote control over wireless ADB

Because `adb` runs as the privileged shell user, it **bypasses the MediaProjection consent prompt** that
blocks on-device apps from screen-capturing. So from the management box you get real remote control of
your own phones, no root:

- **Screenshots** — silent, on-demand, headless-friendly (works on your-box).
- **Live screen + control** — via `scrcpy` / browser-based `ws-scrcpy`.
- **Fleet actions** — wake, open Acurast, logcat, arbitrary `adb shell`, across selected devices.

## In the Fleet Console (built in)
- **Per device:** `Screen` (live screenshot), `scrcpy`/`Live` (see below), `Reboot`.
- **Remote control toolbar (selected devices):** `Wake`, `Open Acurast`, `Logcat`, `Shell…`,
  **`Screenshot selected`** → a **thumbnail wall** (parallel capture, up to 24 at a time; click a tile
  to enlarge).
- **`Live` buttons via ws-scrcpy:** set `"ws_scrcpy_url"` in `devices.json` (e.g.
  `"http://<console-host>:8000"`). Each card's `scrcpy` button becomes a **`Live`** button that opens
  that device's ws-scrcpy stream in a browser tab — one-click live control, no desktop setup.
- All action/screenshot endpoints require the **token** (set one; bind to the tailnet). These are full
  device control — treat the token like a root password.

> Guardrail: use this for troubleshooting, observation, and device-level actions. **Do not script taps
> inside the attested Acurast processor** — it runs autonomously and automating its UI risks attestation.

## scrcpy — live view + control (one device, interactive)
Install scrcpy on a machine **with a display** (your workstation), then:
```bash
scrcpy -s <ip:port>        # the serial shown on the device card
```
The workstation's `adb` needs that device. Two ways:
- **Direct** (device reachable from the workstation, e.g. both on the LAN/tailnet): `adb connect <ip:port>` then `scrcpy -s …`.
- **Via the box's adb server** (headless box holds the connections): on your-box run the adb server on all interfaces (tailnet only!):
  ```bash
  adb kill-server
  adb -a -P 5037 nodaemon server start &     # -a = listen on all interfaces
  ```
  Then on the workstation:
  ```bash
  export ADB_SERVER_SOCKET=tcp:<console-host>:5037   # your-box tailnet IP
  adb devices            # shows the box's phones
  scrcpy -s <ip:port>
  ```
  ⚠ `adb -a` exposes full control on port 5037 — keep it **tailnet-only**, never public.

## ws-scrcpy — browser-based live control of the whole fleet (best for a headless box)
[`ws-scrcpy`](https://github.com/NetrisTV/ws-scrcpy) serves scrcpy in a web page; it talks to the local
adb server and streams to the browser. **There is no official Docker image** (`ghcr.io/netristv/…` is
bogus) — build from source (Node 20 + npm; verified on your-box):
```bash
cd ~ && git clone --depth 1 https://github.com/NetrisTV/ws-scrcpy.git && cd ws-scrcpy
npm install --ignore-scripts        # skip the appium/iOS postinstall that fails on a headless box
npm run dist:prod                    # webpack build → dist/
sudo apt-get install -y build-essential && npm rebuild node-pty   # native module (build/Release/pty.node)
node dist/index.js                   # → serves on :8000
```
It uses `@dead50f7/adbkit` as a **protocol client** — it does NOT version-kill the adb-37 server
(verified) — so it reuses the same wireless-ADB connections + the WD keep-alive.

**ws-scrcpy has NO AUTH** — anyone who reaches `:8000` gets full device control — so it MUST be
tailnet-locked. Run it under systemd with an iptables lock re-applied on every start:
```ini
# /etc/systemd/system/ws-scrcpy.service   (User=acurast, WorkingDirectory=~/ws-scrcpy/dist)
ExecStartPre=+/bin/sh -c 'iptables -C INPUT -p tcp --dport 8000 ! -i tailscale0 -j DROP 2>/dev/null || iptables -I INPUT -p tcp --dport 8000 ! -i tailscale0 -j DROP'
ExecStart=/usr/bin/node /home/acurast/ws-scrcpy/dist/index.js
```
ws-scrcpy is a **separate project** — it is not shipped with this console and the console does not
install it. The console only stores its URL and links to it.

Then point the console at it, either way:
- **In the UI:** ⚙ Options → *Open server settings* → **6. Remote screen** → save (applies immediately).
- **By hand:** set `"ws_scrcpy_url": "http://<console-host>:8000"` in `devices.json` and restart.

Each card then shows a **Live** button. (Verify: `ss -ltn | grep 8000` listening; `:8000` reachable from the tailnet, not the LAN.)

## Reliability notes
- **An adb server restart silently empties ws-scrcpy.** It holds its own adbkit device tracker, so
  `adb kill-server` (which the console's discovery self-heal runs when adb's mDNS browse goes blind)
  orphans it: the unit stays `active`, still answers HTTP 200, and lists **zero devices**. The console
  restarts ws-scrcpy after any adb server restart for exactly this reason — see `_restart_ws_scrcpy()`
  in `fleet.py`. If you run it under a different unit name, update that function or your Live buttons
  will quietly stop working with no error anywhere.
- Screenshots/scrcpy over relayed Tailscale links are laggy; on-LAN (your-box ↔ phones) it's snappy.
- A hung phone won't respond to adb screen/control either — that's a power-cycle case.
- Screenshotting all 130 at once is heavy; do it on-demand per device or in small batches.

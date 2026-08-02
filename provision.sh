#!/usr/bin/env bash
# Fleet provisioning: install Acurast Guardian on every connected phone, grant the one-time
# WRITE_SECURE_SETTINGS (so Fleet management mode can keep Wireless debugging alive across reboots),
# and verify. Run on your management machine with the phones adb-connected.
#
# Usage:
#   ./provision.sh /path/to/AcurastGuardian-release.apk [applicationId]
#     applicationId defaults to com.acurast.guardian (use com.acurast.guardian.debug for a debug APK)
#
# Safe + idempotent: re-running just reinstalls (-r) and re-grants. Personal profile (user 0) only —
# it never touches the Acurast Lite work profile.

set -uo pipefail

APK="${1:?usage: ./provision.sh <apk> [applicationId]}"
APPID="${2:-com.acurast.guardian}"
PERM="android.permission.WRITE_SECURE_SETTINGS"

[ -f "$APK" ] || { echo "APK not found: $APK"; exit 1; }
command -v adb >/dev/null || { echo "adb not on PATH"; exit 1; }

# One device serial per line (state == 'device').
mapfile -t DEVICES < <(adb devices | awk 'NR>1 && $2=="device"{print $1}')
[ "${#DEVICES[@]}" -gt 0 ] || { echo "No connected devices (adb devices shows none 'device')."; exit 1; }

echo "Provisioning ${#DEVICES[@]} device(s) with $APPID from $(basename "$APK")"
ok=0; fail=0
for d in "${DEVICES[@]}"; do
  printf '── %s ──\n' "$d"

  if adb -s "$d" install -r -g "$APK" >/dev/null 2>&1 || adb -s "$d" install -r "$APK" >/dev/null 2>&1; then
    echo "  install: ok"
  else
    echo "  install: FAILED"; fail=$((fail+1)); continue
  fi

  if adb -s "$d" shell pm grant --user 0 "$APPID" "$PERM" >/dev/null 2>&1; then
    echo "  grant WRITE_SECURE_SETTINGS: ok"
  else
    echo "  grant: FAILED (device may not allow it; that model needs USB adb / power-cycle instead)"
    fail=$((fail+1)); continue
  fi

  # Background-activity-launch exemption so Guardian can foreground the work-profile processor on
  # Android 14 (holding SYSTEM_ALERT_WINDOW grants BAL; no overlay is ever drawn).
  if adb -s "$d" shell appops set --user 0 "$APPID" SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1; then
    echo "  appops SYSTEM_ALERT_WINDOW (BAL exemption): ok"
  else
    echo "  appops SYSTEM_ALERT_WINDOW: FAILED (grant 'Display over other apps' manually)"
  fi

  # Verify the grant took.
  if adb -s "$d" shell dumpsys package "$APPID" 2>/dev/null | grep -q "$PERM: granted=true"; then
    echo "  verify: granted=true"
    ok=$((ok+1))
  else
    echo "  verify: could not confirm granted=true (check manually)"
    fail=$((fail+1))
  fi
done

echo "────────────────────────────"
echo "Done. granted+verified: $ok   problems: $fail   total: ${#DEVICES[@]}"
echo "Next: open Guardian on each phone → Settings → Fleet management → enable 'Fleet management mode'."
echo "(Or leave protection on; the ~60s keep-alive runs in the monitoring service once the flag is set.)"

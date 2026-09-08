"""Optional screenshot heartbeat reader for Guardian versions with incomplete telemetry."""
import io
import re
import subprocess
import json
import threading
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

AGE_RE = re.compile(r'\bheartbeat\s*:?\s*(\d+)\s*(second|minute|hour|day)s?\s+ago', re.I)


def parse_age(text):
    match = AGE_RE.search(text)
    if not match:
        return None
    value = int(match[1])
    if value > 100000:
        return None
    unit = match[2].lower()
    return value // 60 if unit == 'second' else value * {'minute': 1, 'hour': 60, 'day': 1440}[unit]


def read_age(png):
    # Lazy optional dependency: the console still starts without OCR installed.
    from PIL import Image, ImageOps
    image = Image.open(io.BytesIO(png)).convert('RGB')
    w, h = image.size
    # Colored compute cards are lost by whole-screen OCR on the black Lite background.
    # Find bright card interiors, merge text gaps, and OCR each crop on a white margin.
    rows = []
    for y in range(int(h * .15), int(h * .9), 3):
        pixels = [image.getpixel((x, y)) for x in range(int(w * .15), int(w * .85), 12)]
        if sum(max(p) > 160 and sum(p) > 300 for p in pixels) > len(pixels) * .55:
            rows.append(y)
    bands = []
    for y in rows:
        if not bands or y - bands[-1][1] > 30:
            bands.append([y, y])
        else:
            bands[-1][1] = y
    for top, bottom in bands:
        if bottom - top < 35:
            continue
        crop = image.crop((int(w * .08), top, int(w * .94), min(h, bottom + 3))).convert('L')
        crop = crop.point(lambda p: 255 if p > 100 else 0)
        crop = ImageOps.expand(crop, border=20, fill=255)
        buffer = io.BytesIO()
        crop.save(buffer, format='PNG')
        result = subprocess.run(['tesseract', 'stdin', 'stdout', '--psm', '6'],
                                input=buffer.getvalue(), capture_output=True, timeout=12)
        if result.returncode != 0:
            continue
        age = parse_age(result.stdout.decode('utf-8', errors='replace'))
        if age is not None:
            return age
    return None


def looks_like_overlay(png):
    from PIL import Image
    image = Image.open(io.BytesIO(png)).convert('RGB')
    w, h = image.size
    image = image.crop((0, int(h * .03), w, int(h * .97))).resize((80, 100))
    pixels = list(image.getdata())
    dark = sum(max(p) < 25 for p in pixels)
    colored = sum(max(p) > 35 and max(p) - min(p) > 15 for p in pixels)
    return dark > len(pixels) * .94 and colored > 3


class HeartbeatScanner:
    FRESH_SECONDS = 20 * 60

    def __init__(self, path, capture, screensaver, eligible):
        self.path = Path(path)
        self.capture, self.screensaver, self.eligible = capture, screensaver, eligible
        self.lock = threading.Lock()
        self.progress = {'active': False, 'done': 0, 'total': 0, 'lastRun': 0}
        try:
            self.results = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.results = {}

    def start(self, serials):
        with self.lock:
            if self.progress['active']:
                return False
            self.progress.update(active=True, done=0, total=len(serials))
        threading.Thread(target=self._run, args=(list(serials),), daemon=True).start()
        return True

    def _run(self, serials):
        try:
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(self._one, serials))
        finally:
            with self.lock:
                self.progress.update(active=False, lastRun=time.time())

    def _one(self, serial):
        restore = False
        age, error = None, ''
        try:
            if not self.eligible(serial):
                raise RuntimeError('offline, busy or in maintenance')
            png = self.capture(serial)
            if not png:
                raise RuntimeError('screenshot unavailable')
            if looks_like_overlay(png):
                restore = True
                if not self.screensaver(serial, False).get('ok'):
                    raise RuntimeError('screensaver did not acknowledge uncover')
                time.sleep(3)
                png = self.capture(serial)
            if not png:
                raise RuntimeError('uncovered screenshot unavailable')
            age = read_age(png)
            if age is not None and age > 45:
                # Confirm stale OCR on a second newly captured frame before flagging the phone.
                time.sleep(3)
                second_png = self.capture(serial)
                second = read_age(second_png) if second_png else None
                if second is None or second <= 45:
                    age = None
                    error = 'stale reading could not be confirmed'
                else:
                    age = min(age, second)
            if age is None and not error:
                error = 'heartbeat not readable on screen'
        except Exception as exc:
            error = str(exc)[:160]
        finally:
            if restore:
                try:
                    if not self.screensaver(serial, True).get('ok'):
                        error = 'screensaver restore not acknowledged'
                except Exception:
                    error = 'screensaver restore failed'
        with self.lock:
            previous = self.results.get(serial, {})
            record = dict(previous)
            record.update(lastAttempt=time.time(), error=error)
            if age is not None:
                record.update(ageMin=age, checkedAt=time.time())
            self.results[serial] = record
            self.progress['done'] += 1
            temp = self.path.with_suffix('.tmp')
            temp.write_text(json.dumps(self.results))
            temp.replace(self.path)

    def attach(self, device):
        with self.lock:
            record = dict(self.results.get(device['serial'], {}))
        device['heartbeatCheck'] = record
        telemetry = dict(device.get('telemetry') or {})
        screen_is_newer = telemetry.get('heartbeatAgeMin') is None or record.get('checkedAt', 0) >= telemetry.get('recv_ts', 0)
        if record.get('checkedAt', 0) > time.time() - self.FRESH_SECONDS and screen_is_newer:
            telemetry.update(heartbeatAgeMin=record['ageMin'], heartbeatKnown=True,
                             heartbeatStale=record['ageMin'] > 45, heartbeatSource='screen',
                             heartbeatCheckedAt=record['checkedAt'])
            if record['ageMin'] > 45:
                telemetry['earning'] = False
        elif telemetry.get('heartbeatAgeMin') is None:
            telemetry['heartbeatKnown'] = False
        device['telemetry'] = telemetry

    def status(self):
        with self.lock:
            return dict(self.progress)


if __name__ == '__main__':
    import sys
    from pathlib import Path
    print(read_age(Path(sys.argv[1]).read_bytes()))

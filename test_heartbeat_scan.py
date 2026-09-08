import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from heartbeat_scan import HeartbeatScanner, parse_age, looks_like_overlay


class HeartbeatScanTest(unittest.TestCase):
    def test_dim_idle_dot_is_still_an_overlay(self):
        try:
            from PIL import Image, ImageDraw
        except ImportError:
            self.skipTest('Pillow optional; checked on OCR host')
        import io
        image = Image.new('RGB', (720, 1600), 'black')
        ImageDraw.Draw(image).ellipse((300, 60, 360, 120), fill=(15, 53, 35))
        png = io.BytesIO()
        image.save(png, format='PNG')
        self.assertTrue(looks_like_overlay(png.getvalue()))

    def test_parser_requires_heartbeat_label_and_units(self):
        self.assertEqual(parse_age('heartbeat 14 hours ago'), 840)
        self.assertEqual(parse_age('heartbeat\n23 minutes ago'), 23)
        self.assertIsNone(parse_age('deployment ends in 14 hours'))
        self.assertIsNone(parse_age('heartbeat unknown'))

    def test_overlay_restored_even_when_ocr_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            overlay = Mock(return_value={'ok': True})
            scanner = HeartbeatScanner(Path(directory) / 'checks.json', Mock(return_value=b'png'), overlay, lambda _: True)
            with patch('heartbeat_scan.looks_like_overlay', return_value=True), patch('heartbeat_scan.read_age', side_effect=RuntimeError('OCR failed')), patch('heartbeat_scan.time.sleep'):
                scanner._one('phone')
            self.assertEqual([c.args for c in overlay.call_args_list], [('phone', False), ('phone', True)])
            self.assertNotIn('ageMin', scanner.results['phone'])

    def test_stale_reading_requires_second_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            scanner = HeartbeatScanner(Path(directory) / 'checks.json', Mock(return_value=b'png'), Mock(), lambda _: True)
            with patch('heartbeat_scan.looks_like_overlay', return_value=False), patch('heartbeat_scan.read_age', side_effect=[840, None]), patch('heartbeat_scan.time.sleep'):
                scanner._one('phone')
            self.assertNotIn('ageMin', scanner.results['phone'])

    def test_attach_fills_missing_age_but_expires_and_respects_newer_telemetry(self):
        with tempfile.TemporaryDirectory() as directory:
            scanner = HeartbeatScanner(Path(directory) / 'checks.json', Mock(), Mock(), lambda _: True)
            scanner.results['phone'] = {'checkedAt': time.time(), 'ageMin': 840}
            device = {'serial': 'phone', 'telemetry': {'computeStatus': 'NoDeployments'}}
            scanner.attach(device)
            self.assertTrue(device['telemetry']['heartbeatStale'])
            device = {'serial': 'phone', 'telemetry': {'recv_ts': time.time()+1, 'heartbeatAgeMin': 2}}
            scanner.attach(device)
            self.assertEqual(device['telemetry']['heartbeatAgeMin'], 2)
            scanner.results['phone']['checkedAt'] -= 1300
            device = {'serial': 'phone'}
            scanner.attach(device)
            self.assertFalse(device['telemetry']['heartbeatKnown'])


if __name__ == '__main__':
    unittest.main()

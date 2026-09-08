"""Isolate the action from fleet.py's server/config initialization; no device access."""
import ast
from pathlib import Path
import re
import threading
import time
import unittest
from unittest.mock import Mock


class RecoveryTest(unittest.TestCase):
    def test_native_recovery_interlock_expires_but_operator_maintenance_does_not(self):
        source = Path(__file__).resolve().parent / 'fleet.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_in_maintenance')
        sample = {'recv_ts': time.time(), 'heartbeatRecoveryActive': True, 'guardianState': 'TARGET_FOREGROUND'}
        ns = dict(CFG={'guardian_canary_serials': ['canary']}, STATE_LOCK=threading.Lock(),
                  SERIAL_IP={'phone': 'ip'}, TELEMETRY={'ip': sample}, TELEMETRY_TTL=900,
                  time=time, _dedupe_base=lambda s: s)
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), 'exec'), ns)
        self.assertTrue(ns['_in_maintenance']('phone'))
        sample['recv_ts'] -= 121
        self.assertFalse(ns['_in_maintenance']('phone'))
        sample['guardianState'] = 'MAINTENANCE_MODE'
        self.assertTrue(ns['_in_maintenance']('phone'))
        self.assertTrue(ns['_in_maintenance']('canary'))

    def action(self, source, replies, installed=(0, 11), profiles=(11,), legacy=False):
        tree = ast.parse(source.read_text(encoding="utf-8"))
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "recover_compute")
        adb = Mock(side_effect=replies)
        ns = dict(STATE_LOCK=threading.Lock(), STATE={"phone": {"state": "device"}},
                  TARGET_PKG="com.acurast.processor", GUARDIAN_PKG="com.acurast.guardian",
                  adb=adb, re=re, foreground_lite=Mock(return_value=legacy), read_version=lambda _: {"usersInstalled": list(installed)},
                  managed_user_ids=lambda _: list(profiles))
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), ns)
        return ns["recover_compute"]("phone"), adb

    def test_recovery(self):
        source = Path(__file__).resolve().parent / "fleet.py"
        ack = (0, 'data="compute_recovery_supported"', '')
        result, adb = self.action(source, [(0, 'result=0', '')])
        self.assertFalse(result['ok'])
        self.assertEqual(adb.call_count, 1)
        result, adb = self.action(source, [ack, (0, '', ''), ack])
        self.assertTrue(result['ok'])
        self.assertIn('11', adb.call_args_list[1].args[0])
        self.assertIn('force-stop', adb.call_args_list[1].args[0])
        self.assertIn('unverified', result['output'])
        result, adb = self.action(source, [ack, (1, '', 'SecurityException'), ack])
        self.assertTrue(result['ok'])
        self.assertIn('blocked force-stop', result['output'])
        result, adb = self.action(source, [ack, ack], profiles=())
        self.assertEqual(adb.call_count, 2)
        self.assertIn('ambiguous', result['output'])
        result, adb = self.action(source, [(0, '', ''), (0, '', '')], legacy=True)
        self.assertTrue(result['ok'])
        self.assertIn('force-stop', adb.call_args_list[1].args[0])


if __name__ == '__main__':
    unittest.main()

@echo off
REM Acurast Fleet Console launcher (Windows).
REM adb is found via "adb_path" in devices.json, or from PATH / ANDROID_HOME if you set one.
REM Set ANDROID_HOME here only if adb is not already on your PATH, e.g.:
REM   set "ANDROID_HOME=C:\Android\Sdk"
python "%~dp0fleet.py"
pause

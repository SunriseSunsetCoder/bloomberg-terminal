@echo off
setlocal enableextensions
REM ===========================================================================
REM strategies\m2\m2_alert.cmd — Task Scheduler wrapper for the M2 15:45 ET alert.
REM
REM Pins the working directory, forces UTF-8 before Python starts (the messages
REM carry em-dashes and the multiply sign), and captures output that m2_alert.py
REM cannot log itself (missing interpreter, syntax error). Exit code passes through:
REM   0 ok   1 error   2 Telegram send failed   3 no evaluation (data missing/stale)
REM
REM Register (VPS clock must be US Eastern; run as the user owning the
REM CommandCenter telegram.json under Documents):
REM   schtasks /Create /TN "M2 Alert" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 15:45 ^
REM     /RU Administrator /TR "\"%CD%\strategies\m2\m2_alert.cmd\""
REM
REM Set JACK_PYTHON (shared with run_daily.cmd) to pin an interpreter.
REM ===========================================================================

cd /d "%~dp0..\.."
set "REPO=%CD%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8:replace"

set "LOGDIR=%REPO%\data\m2\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "WRAPLOG=%LOGDIR%\m2_wrapper.log"

if defined JACK_PYTHON (
    set "PY=%JACK_PYTHON%"
) else (
    where py >nul 2>&1 && (set "PY=py") || (set "PY=python")
)

>>"%WRAPLOG%" echo ---- LAUNCH %DATE% %TIME%  py=%PY%  args=%*
"%PY%" -u "%REPO%\strategies\m2\m2_alert.py" %* >>"%WRAPLOG%" 2>&1
set "RC=%ERRORLEVEL%"
>>"%WRAPLOG%" echo ---- m2_alert.py exit %RC%

exit /b %RC%

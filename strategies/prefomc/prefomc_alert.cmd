@echo off
setlocal enableextensions
REM ===========================================================================
REM strategies\prefomc\prefomc_alert.cmd — Task Scheduler wrapper for the PreFOMC
REM SPY put-write 15:45 ET paper alert (alerts only). Sibling of m2_alert.cmd.
REM
REM Pins the working directory, forces UTF-8 before Python starts (the messages
REM carry em-dashes and the multiply sign), and captures output that
REM prefomc_alert.py cannot log itself (missing interpreter or package, syntax
REM error). Exit code passes through:
REM   0 ok   1 error / credentials / trade log   2 Telegram send failed
REM   3 SPY price missing or stale when a message needed it
REM
REM Needs pandas_market_calendars + tzdata in that Python:
REM   py -m pip install -r pipeline\requirements.txt
REM
REM Register (VPS clock must be US Eastern; run as the user owning the
REM CommandCenter telegram.json under Documents):
REM   schtasks /Create /TN "PreFOMC Alert" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 15:45 ^
REM     /RU Administrator /TR "\"%CD%\strategies\prefomc\prefomc_alert.cmd\""
REM
REM Set JACK_PYTHON (shared with run_daily.cmd and m2_alert.cmd) to pin an interpreter.
REM ===========================================================================

cd /d "%~dp0..\.."
set "REPO=%CD%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8:replace"

set "LOGDIR=%REPO%\data\prefomc\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "WRAPLOG=%LOGDIR%\prefomc_wrapper.log"

if defined JACK_PYTHON (
    set "PY=%JACK_PYTHON%"
) else (
    where py >nul 2>&1 && (set "PY=py") || (set "PY=python")
)

>>"%WRAPLOG%" echo ---- LAUNCH %DATE% %TIME%  py=%PY%  args=%*
"%PY%" -u "%REPO%\strategies\prefomc\prefomc_alert.py" %* >>"%WRAPLOG%" 2>&1
set "RC=%ERRORLEVEL%"
>>"%WRAPLOG%" echo ---- prefomc_alert.py exit %RC%

exit /b %RC%

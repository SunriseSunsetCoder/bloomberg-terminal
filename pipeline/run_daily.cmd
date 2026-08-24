@echo off
setlocal enableextensions
REM ===========================================================================
REM pipeline\run_daily.cmd — Task Scheduler wrapper for the JACK nightly run.
REM
REM WHY A WRAPPER AT ALL
REM   schtasks /Create has no working-directory option, and run_daily.py resolves
REM   the repo from its own path but the STAGE scripts are launched with
REM   cwd=REPO_ROOT. Pinning the directory here makes the task independent of
REM   whatever directory Task Scheduler happens to hand it.
REM
REM   It also captures output that run_daily.py CANNOT log itself: a missing
REM   interpreter, a syntax error, an import blow-up. Those happen before the
REM   orchestrator's own tee exists, so without this wrapper a failed launch
REM   would leave an empty log and a bare error code.
REM
REM   The exit code is passed through unchanged, so Task Scheduler's
REM   "Last Run Result" is the orchestrator's stage code (20s pull, 30s detect,
REM   40s ingest — see run_daily.py).
REM
REM USAGE
REM   pipeline\run_daily.cmd                 the nightly run
REM   pipeline\run_daily.cmd --skip-pull     any run_daily.py flag passes through
REM
REM   Set JACK_PYTHON to pin a specific interpreter, e.g.
REM     setx JACK_PYTHON "C:\Python312\python.exe"
REM ===========================================================================

cd /d "%~dp0.."
set "REPO=%CD%"
set "LOGDIR=%REPO%\data\pipeline_state\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul
set "WRAPLOG=%LOGDIR%\task_wrapper.log"

REM Interpreter: explicit override, else the py launcher, else python on PATH.
if defined JACK_PYTHON (
    set "PY=%JACK_PYTHON%"
) else (
    where py >nul 2>&1 && (set "PY=py") || (set "PY=python")
)

>>"%WRAPLOG%" echo.
>>"%WRAPLOG%" echo ======================================================================
>>"%WRAPLOG%" echo LAUNCH %DATE% %TIME%  repo=%REPO%  py=%PY%  args=%*
>>"%WRAPLOG%" echo ======================================================================

"%PY%" -u "%REPO%\pipeline\run_daily.py" %* >>"%WRAPLOG%" 2>&1
set "RC=%ERRORLEVEL%"

>>"%WRAPLOG%" echo ---- run_daily.py exit %RC% ----

REM Task Scheduler reads this as Last Run Result.
exit /b %RC%

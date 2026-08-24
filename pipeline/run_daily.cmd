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

REM --- UTF-8, before Python starts -----------------------------------------
REM Windows defaults stdout to the ANSI code page (cp1252), which cannot encode
REM the warning signs, arrows and emoji in this pipeline's log strings. print()
REM then raises UnicodeEncodeError and kills the stage — a 2026-08-24 run lost a
REM clean 76/76 detector pass to exactly that, on its last log line.
REM
REM UTF-8 mode is set here rather than only in code because it must also cover
REM output that never passes through our log(): papermill's progress and
REM tracebacks, and anything a dependency prints directly.
REM
REM This is the NON-INTERACTIVE path — under Task Scheduler there is no console
REM at all and stdout is the redirected handle below. chcp only affects a real
REM console, so it is best-effort and silenced; the two env vars are what
REM actually carry the fix headless.
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8:replace"
chcp 65001 >nul 2>&1
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

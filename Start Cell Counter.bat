@echo off
rem Source-checkout launcher: needs Python installed, builds .venv on first run.
rem End users get the release zip instead (own Python, nothing to install).
cd /d "%~dp0"

if not exist ".venv" (
  echo First run: setting up, takes a minute...
  python -m venv .venv
  if errorlevel 1 goto :failed
)

rem requirements.txt gains pins over time (it gained onnxruntime with the ML
rem engine), and a .venv built before that line existed serves an app that
rem crashes on the default quality level - so this has to run again whenever
rem requirements.txt changes. But it must not run, or abort the launch, on a
rem lab machine with a good .venv and no internet: that is the opposite of
rem the product's offline promise. The stamp file inside .venv (its state)
rem holds the hash of the requirements.txt an install last succeeded for.
set STAMP=.venv\requirements.sha256
rem CURHASH must start cleared: it is only ever set by the "for /f" below, and
rem if that command prints nothing (e.g. requirements.txt missing or unreadable
rem raises FileNotFoundError) a stale value inherited from the parent
rem environment must not be mistaken for a freshly-read hash.
set CURHASH=
for /f "usebackq delims=" %%h in (`.venv\Scripts\python -c "import hashlib;print(hashlib.sha256(open('requirements.txt','rb').read()).hexdigest())"`) do set CURHASH=%%h
set OLDHASH=
if exist "%STAMP%" set /p OLDHASH=<"%STAMP%"
rem An empty CURHASH means "unknown", not "unchanged". Left as a plain
rem not-equal check, a first run (no STAMP yet, so OLDHASH is also empty) would
rem read "" == "" as true, skip the install, and hand an empty, freshly-created
rem venv straight to app.py, which dies on "import cv2" instead of ever
rem installing anything. So an unknown hash always triggers install - but,
rem since we don't know what hash the install was actually run for, it must
rem never write the stamp file; only a successful install against a known
rem hash may do that.
if "%CURHASH%"=="" (
  .venv\Scripts\pip install --quiet --disable-pip-version-check -r requirements.txt
  if errorlevel 1 (
    echo Could not check for package updates - probably no internet.
    echo Continuing offline with the packages already installed.
  )
) else if not "%CURHASH%"=="%OLDHASH%" (
  .venv\Scripts\pip install --quiet --disable-pip-version-check -r requirements.txt
  if errorlevel 1 (
    echo Could not check for package updates - probably no internet.
    echo Continuing offline with the packages already installed.
  ) else (
    > "%STAMP%" echo %CURHASH%
  )
)

echo Starting Cell Counter - your browser will open shortly.
echo Keep this window open while using the app. Close it to quit.
.venv\Scripts\python app.py
set EXITCODE=%ERRORLEVEL%
rem A Ctrl-C quit exits with 0xC000013A (STATUS_CONTROL_C_EXIT), which
rem "errorlevel 1" also matches - so a normal, successful session used to end
rem with "Cell Counter stopped. If there is an error above, that is why."
rem 3221225786 is the same code read as unsigned; cmd.exe's errorlevel can
rem show either depending on Windows version, so both are checked.
if %EXITCODE% == -1073741510 exit /b 0
if %EXITCODE% == 3221225786 exit /b 0
if not %EXITCODE% == 0 goto :failed
exit /b 0

rem Hold the window open. Without this a first-run failure - no Python on PATH,
rem or the folder still inside the zip, so no write access for the .venv -
rem flashes past in under a second and the user sees nothing at all.
:failed
echo.
echo Cell Counter stopped. If there is an error above, that is why.
echo Common causes: Python is not installed, or this folder is still inside the
echo downloaded .zip - unzip it to your Desktop first, then try again.
pause
exit /b 1

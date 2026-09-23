#!/bin/bash
# Hold the window open on any failure. Without this a first-run failure - no
# python3, or the folder still inside the .zip, so no write access for the
# .venv - flashes past in under a second and the user sees nothing at all.
fail() {
  echo
  echo "Cell Counter could not start. The message above says why."
  echo "Common causes: python3 is not installed, or this folder is still inside"
  echo "the downloaded .zip - unzip it to your Desktop first, then try again."
  echo
  read -r -p "Press Return to close this window."
  exit 1
}
trap fail ERR
set -e

# Source-checkout launcher: needs Python installed, builds .venv on first run.
# End users get the release zip instead (own Python, nothing to install).
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "First run: setting up (takes a minute)..."
  python3 -m venv .venv
fi

# requirements.txt gains pins over time (it gained onnxruntime with the ML
# engine), and a .venv built before that line existed serves an app that
# crashes on the default quality level - so this has to run again whenever
# requirements.txt changes. But it must not run, or abort the launch, on a
# lab machine with a good .venv and no internet: that is the opposite of the
# product's offline promise. The stamp file inside .venv (its state) holds
# the hash of the requirements.txt an install last succeeded for.
STAMP=".venv/requirements.sha256"
CURHASH=$(./.venv/bin/python -c "import hashlib;print(hashlib.sha256(open('requirements.txt','rb').read()).hexdigest())")
OLDHASH=""
[ -f "$STAMP" ] && OLDHASH=$(cat "$STAMP")
if [ "$CURHASH" != "$OLDHASH" ]; then
  trap - ERR
  set +e
  ./.venv/bin/pip install --quiet --disable-pip-version-check -r requirements.txt
  PIP_STATUS=$?
  set -e
  trap fail ERR
  if [ $PIP_STATUS -eq 0 ]; then
    echo "$CURHASH" > "$STAMP"
  else
    echo "Could not check for package updates - probably no internet."
    echo "Continuing offline with the packages already installed."
  fi
fi

echo "Starting Cell Counter - your browser will open shortly."
echo "Keep this window open while using the app. Close it to quit."
# The server itself: a Ctrl-C quit is a normal exit, not a failure to report.
trap - ERR
set +e
./.venv/bin/python app.py
status=$?
if [ $status -ne 0 ] && [ $status -ne 130 ]; then fail; fi

#!/usr/bin/env bash
# Run the end-to-end suite against a real htcondor-api in demo mode.
#
# Deploys the bundle this repo just built, reads the generated passwords
# out of the demo credentials file, and runs Playwright.
#
# Used by `make e2e` and by CI, so the two cannot drift.
#
# TWO IMAGES, and the reason is not obvious. Demo mode runs a personal
# HTCondor, so it needs condor_master -- and the published API image is
# a minimal one carrying only the Go binary. Running it with --demo
# fails with "condor_master not found in PATH".
#
# So the pool comes from upstream's minicondor image, and the API binary
# is lifted out of the release image and mounted into it. The binary is
# statically linked, so it runs there even though the two images are
# built on different distributions. That beats publishing a second
# multi-gigabyte image whose only job is to hold both halves.
set -euo pipefail

APP="${APP:-$(basename "$PWD")}"
# Where the API binary comes from, and where the pool comes from.
# The BLAST pipeline is a DAG, and a demo pool only runs one if the
# server passes CONDOR_CONFIG down to the manager job and turns off
# DAGMan's refusal to keep a node log under /tmp. Both landed in the
# server together; against an image older than that, the workflow
# aborts in its first second and only that one spec fails.
API_IMAGE="${API_IMAGE:-ghcr.io/bbockelm/golang-htcondor:latest}"
POOL_IMAGE="${POOL_IMAGE:-htcondor/mini:latest}"
# The SAME port inside the container and out, which is not fussiness.
# Logging in is a real OAuth round trip and the server builds the IdP's
# address from its own listening address, so a container listening on
# 8443 behind a host port of 8843 sends the browser to 8443 -- where it
# reaches whatever else is there, or nothing.
PORT="${API_PORT:-8443}"
DEMO_CREDS="${DEMO_CREDS:-/tmp/htcondor-demo-credentials.json}"
# Under /tmp because the server no longer runs as root (see --user below)
# and /etc/condor belongs to root in the pool image.
APPS_DIR="${APPS_DIR:-/tmp/webapps}"
NAME="htcondor-api-e2e-$$"

cleanup() {
  # One trap, one function. A second `trap ... EXIT` would REPLACE this
  # one rather than add to it, and the container would be left running.
  [ -z "${BINDIR:-}" ] || rm -rf "$BINDIR"
  if [ -n "${KEEP_CONTAINER:-}" ]; then
    echo "==> leaving $NAME running (KEEP_CONTAINER set)"
    return
  fi
  echo "==> container logs (tail)"
  docker logs --tail 50 "$NAME" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Lift the binary out of the API image. `docker create` makes a
# container without running it, which is the documented way to copy a
# file out of an image that has no shell -- and this one has barely
# anything else either.
echo "==> taking htcondor-api out of $API_IMAGE"
BINDIR="$(mktemp -d)"
cid="$(docker create "$API_IMAGE")"
docker cp "$cid:/usr/local/bin/htcondor-api" "$BINDIR/htcondor-api" >/dev/null
docker rm -f "$cid" >/dev/null
chmod +x "$BINDIR/htcondor-api"

echo "==> starting $POOL_IMAGE with it"
# -h localhost is load-bearing. Logging in is a real OAuth round trip,
# and the server builds the IdP's address from its OWN hostname -- which
# in a container is a random id nothing outside it can resolve. Without
# this the browser follows the redirect to that name and fails with
# ERR_NAME_NOT_RESOLVED, reported against the page.goto that started the
# flow rather than against the redirect, which sends you looking in the
# wrong place entirely.
# The id as it appears in a configuration parameter name: upper-cased,
# hyphens to underscores. HTCondor parameter names are case-insensitive
# and a hyphen in one reads as subtraction, so the server derives the
# same spelling from the bundle's file name.
APP_MACRO="$(printf '%s' "$APP" | tr 'a-z-' 'A-Z_')"

# --user is the other load-bearing flag, and it is the one that makes
# submitting work at all. As root, HTCondor can change uid, so the schedd
# insists every submitter resolve to a real OS account and spools each
# job's input as that account -- and the demo's identities (admin, user,
# newbie) exist in no passwd file. Demo mode answers that with
# AP_GENERIC_OS_USERS, which hands out ONE OS account per AP user from a
# fixed list, so with three identities and one account only the first can
# submit; and the spooling account cannot traverse the 0750 spool
# directory anyway, which is the "(errno 13) Permission denied" the
# upload used to fail with.
#
# A demo started by an ordinary user has none of that: HTCondor cannot
# change uid unless it is root, so it takes the submitter's word and runs
# everything as the invoking account. All three identities submit, spool
# and run.
docker run -d --name "$NAME" -h localhost -p "${PORT}:${PORT}" --user condor \
  -v "$BINDIR/htcondor-api:/usr/local/bin/htcondor-api:ro" \
  -e "_CONDOR_HTTP_API_SITE_APPS_DIR=$APPS_DIR" \
  -e "_CONDOR_HTTP_API_SITE_APPS_RELOAD_INTERVAL=2s" \
  -e "_CONDOR_HTTP_API_SITE_APP_${APP_MACRO}_GROUPS=*" \
  --entrypoint /usr/local/bin/htcondor-api \
  "$POOL_IMAGE" \
  --demo --listen ":${PORT}" --demo-credentials-file "$DEMO_CREDS" >/dev/null

echo "==> waiting for the server"
for _ in $(seq 1 90); do
  if curl -ksf "https://localhost:${PORT}/healthz" >/dev/null 2>&1; then break; fi
  if ! docker ps -q --filter "name=$NAME" | grep -q .; then
    echo "container exited early" >&2
    exit 1
  fi
  sleep 2
done
curl -ksf "https://localhost:${PORT}/healthz" >/dev/null || {
  echo "server never became healthy" >&2
  exit 1
}

# The credentials file is a published contract of -demo, which is why
# this reads a path instead of grepping a banner out of the logs.
echo "==> reading demo credentials from $DEMO_CREDS"
mkdir -p .e2e
docker exec "$NAME" cat "$DEMO_CREDS" > .e2e/credentials.json || {
  echo "no credentials file in the container at $DEMO_CREDS." >&2
  echo "An older server may predate --demo-credentials-file." >&2
  exit 1
}

echo "==> deploying dist/${APP}.zip"
docker exec "$NAME" mkdir -p "$APPS_DIR"
docker cp "dist/${APP}.zip" "$NAME:${APPS_DIR}/${APP}.zip"
docker cp "dist/${APP}.zip.sha256" "$NAME:${APPS_DIR}/${APP}.zip.sha256"

# The server rescans on an interval, so the bundle is not served the
# instant it lands. Wait for it rather than letting the suite race the
# scan -- a spec that starts too early fails on an undefined
# window.__HTCONDOR_APP__, which reads like the injection is broken.
echo "==> waiting for /site/${APP}/ to be published"
for _ in $(seq 1 30); do
  if curl -ksf "https://localhost:${PORT}/site/${APP}/" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -ksf "https://localhost:${PORT}/site/${APP}/" >/dev/null || {
  echo "the app never appeared under /site/${APP}/" >&2
  echo "the server is told where bundles live and who may see them by the" >&2
  echo "_CONDOR_HTTP_API_SITE_APP* variables above; check them first." >&2
  exit 1
}

echo "==> running playwright"
DEMO_CREDENTIALS_FILE="$PWD/.e2e/credentials.json" \
APP_ID="$APP" \
PLAYWRIGHT_BASE_URL="https://localhost:${PORT}" \
  npx --prefix web playwright test --config "$PWD/web/playwright.config.ts"

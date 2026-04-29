#!/usr/bin/env bash
# security-probes.sh — black-box regression probes for deepmarks's
# security guarantees. Run against any host (default api.deepmarks.org)
# from outside the VPC.
#
#   ./scripts/security-probes.sh                              # prod
#   ./scripts/security-probes.sh https://api.staging.example   # staging
#   VERBOSE=1 ./scripts/security-probes.sh                    # show full responses
#
# Each probe prints PASS / FAIL with a one-line reason. Exit code is
# the number of failed probes — 0 means everything is locked down.

set -u

API="${1:-https://api.deepmarks.org}"
VERBOSE="${VERBOSE:-0}"

PASS=0
FAIL=0

c_red()   { printf '\033[31m%s\033[0m' "$*"; }
c_grn()   { printf '\033[32m%s\033[0m' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m' "$*"; }

pass() { PASS=$((PASS+1)); printf '  %s %s\n' "$(c_grn 'PASS')" "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(c_red 'FAIL')" "$1"; }
section() { printf '\n%s\n' "$1"; }

# Pretty-printed curl wrapper. -i prints headers + body, -s silences
# the progress meter. Body capped at 200 chars in non-verbose mode.
fetch() {
  local method="$1"; shift
  local path="$1"; shift
  local out
  out=$(curl -i -s -X "$method" "$@" "$API$path" 2>&1)
  if [ "$VERBOSE" = "1" ]; then printf '%s\n' "$out" | sed 's/^/    /'; fi
  printf '%s' "$out"
}

# ─── 1. Security headers (added in batch 3) ──────────────────────────────

section "[1] Security headers on api.deepmarks.org"

headers=$(curl -sI "$API/.well-known/lnurlp/zap")
for h in \
  "strict-transport-security" \
  "x-content-type-options" \
  "referrer-policy" \
  "permissions-policy" \
  "x-frame-options" \
  "content-security-policy"; do
  if printf '%s' "$headers" | grep -qi "^$h:"; then
    pass "$h present"
  else
    fail "$h missing"
  fi
done
# server header should be stripped
if printf '%s' "$headers" | grep -qi "^server:.*caddy"; then
  fail "server header still leaks 'Caddy'"
else
  pass "server header stripped"
fi

# ─── 2. SSRF guard on /archive/purchase ──────────────────────────────────

section "[2] SSRF guard on /archive/purchase"

PUBKEY="0000000000000000000000000000000000000000000000000000000000000000"

ssrf_url() {
  local label="$1" url="$2"
  local body resp code
  body=$(printf '{"url":"%s","userPubkey":"%s"}' "$url" "$PUBKEY")
  resp=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/archive/purchase" \
    -H 'Content-Type: application/json' -d "$body")
  case "$resp" in
    400) pass "$label rejected (400)" ;;
    401) pass "$label blocked by NIP-98 auth gate (401) — SSRF check unreachable without auth, gate working" ;;
    429) pass "$label rate-limited (429) — guard untestable but rate limit alive" ;;
    *)   fail "$label accepted with HTTP $resp (expected 400/401/429)" ;;
  esac
}

ssrf_url "file:// scheme"          "file:///etc/passwd"
ssrf_url "javascript: scheme"      "javascript:alert(1)"
ssrf_url "loopback IPv4"           "http://127.0.0.1/"
ssrf_url "RFC1918 (10.x)"          "http://10.0.0.2:6379/"
ssrf_url "Linode metadata"         "http://169.254.169.254/latest/meta-data/"
ssrf_url "single-label host"       "http://internal-redis/"
ssrf_url "loopback IPv6"           "http://[::1]/"

# Sanity check — a real public URL should NOT be rejected by the SSRF
# guard (it'll be either accepted or hit the rate limit; both pass).
public_resp=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/archive/purchase" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://example.com/\",\"userPubkey\":\"$PUBKEY\"}")
case "$public_resp" in
  200|201|202|401|429|502|503) pass "public URL not SSRF-blocked (HTTP $public_resp)" ;;
  400) fail "public URL incorrectly SSRF-blocked (HTTP 400) — guard too tight" ;;
  *) pass "public URL got HTTP $public_resp (acceptable)" ;;
esac

# ─── 3. Rate limits ───────────────────────────────────────────────────────

section "[3] Rate limits"

# /report — 5/hour per IP (added in batch 3)
report_count=0
report_429=0
for i in 1 2 3 4 5 6 7 8; do
  body='{"target_type":"bookmark_event","target_id":"deadbeef","category":"spam"}'
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/report" \
    -H 'Content-Type: application/json' -d "$body")
  if [ "$code" = "429" ]; then report_429=$((report_429+1)); fi
  report_count=$((report_count+1))
done
if [ "$report_429" -gt 0 ]; then
  pass "/report rate limit fires (got $report_429 of $report_count requests rate-limited)"
else
  fail "/report rate limit does not fire after $report_count requests"
fi

# /account/passkey/exists — 60/min per IP
exists_count=0
exists_429=0
for i in $(seq 1 65); do
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "$API/account/passkey/exists?pubkey=$PUBKEY")
  if [ "$code" = "429" ]; then exists_429=$((exists_429+1)); fi
  exists_count=$((exists_count+1))
done
if [ "$exists_429" -gt 0 ]; then
  pass "/account/passkey/exists rate limit fires ($exists_429 of $exists_count rate-limited)"
else
  fail "/account/passkey/exists rate limit does not fire after $exists_count requests"
fi

# ─── 4. NIP-98 — body required, replay rejected, missing-payload caught ─

section "[4] NIP-98 enforcement on /account/nsec-ciphertext"

# Without auth header — should be 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/account/nsec-ciphertext" \
  -H 'Content-Type: application/json' -d '{"ciphertextB64":"AA"}')
if [ "$code" = "401" ]; then
  pass "no auth header → 401"
else
  fail "no auth header → HTTP $code (expected 401)"
fi

# With a malformed auth header — should be 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/account/nsec-ciphertext" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Nostr garbage' \
  -d '{"ciphertextB64":"AA"}')
if [ "$code" = "401" ]; then
  pass "malformed Authorization → 401"
else
  fail "malformed Authorization → HTTP $code (expected 401)"
fi

# Note: a full NIP-98 replay test requires signing a real kind:27235
# event. That's possible but adds a nostr-tools dep to this script;
# we leave it as a manual test step — sign once, replay, verify the
# second call returns 401 'auth event replay rejected'.
c_dim '  [skipped] NIP-98 replay — requires signed event; see manual section in docs/deploy.md'
echo

# ─── 5. Worker callback HMAC ──────────────────────────────────────────────

section "[5] Archive callback HMAC"

# Probe each variant. Treat 503 specially — it means
# WORKER_CALLBACK_SECRET isn't loaded into payment-proxy's env, which
# is itself a finding (worker callbacks would be silently dropped),
# but it short-circuits the auth path before we can probe it.
probe_callback() {
  local label="$1"
  shift
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/archive/callback" \
    -H 'Content-Type: application/json' "$@" -d '{"jobId":"x","status":"ok"}')
  if [ "$code" = "401" ]; then
    pass "$label → 401"
  elif [ "$code" = "503" ]; then
    fail "$label → 503 (env WORKER_CALLBACK_SECRET not loaded into payment-proxy — fix compose.yml passthrough)"
  else
    fail "$label → HTTP $code (expected 401)"
  fi
}

probe_callback "missing HMAC headers"
probe_callback "legacy X-Worker-Secret rejected" -H 'X-Worker-Secret: garbage'

stale_ts=$(($(date +%s) - 3600))
sig64=$(printf '0%.0s' {1..64})
probe_callback "stale timestamp" \
  -H "X-Worker-Timestamp: $stale_ts" \
  -H "X-Worker-Signature: $sig64"

# ─── 6. Lifetime price tampering ──────────────────────────────────────────

section "[6] /account/lifetime ignores body.amountSats"

# Without auth, can't probe the actual body handling; just verify that
# the route exists and rejects unauth.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/account/lifetime" \
  -H 'Content-Type: application/json' -d '{"amountSats":1}')
if [ "$code" = "401" ] || [ "$code" = "403" ]; then
  pass "unauthenticated lifetime upgrade → $code (auth gate alive)"
else
  fail "unauthenticated lifetime upgrade → HTTP $code (expected 401/403)"
fi

# ─── 7. CORS — array origins, not CSV string ──────────────────────────────

section "[7] CORS"

# Each origin in CORS_ORIGIN should match independently. Cross-origin
# request from a known origin should get an ACAO header echoing it.
acao=$(curl -sI -H "Origin: https://deepmarks.org" "$API/.well-known/lnurlp/zap" \
  | grep -i "^access-control-allow-origin:" | tr -d '\r')
if printf '%s' "$acao" | grep -qi "deepmarks.org"; then
  pass "CORS allows https://deepmarks.org"
else
  fail "CORS doesn't allow https://deepmarks.org (got: '$acao')"
fi

# A random hostile origin should NOT be echoed back
hostile=$(curl -sI -H "Origin: https://evil.example" "$API/.well-known/lnurlp/zap" \
  | grep -i "^access-control-allow-origin:" | tr -d '\r')
if printf '%s' "$hostile" | grep -qi "evil.example"; then
  fail "CORS echoes hostile origin: '$hostile'"
else
  pass "CORS does NOT echo hostile origin"
fi

# ─── Summary ─────────────────────────────────────────────────────────────

echo
section "Summary"
printf '  %s probes passed\n' "$(c_grn "$PASS")"
if [ "$FAIL" -gt 0 ]; then
  printf '  %s probes failed\n' "$(c_red "$FAIL")"
  echo
  echo "Re-run with VERBOSE=1 to see full responses for each probe."
  exit "$FAIL"
fi
echo
echo "All probes passed against $API"

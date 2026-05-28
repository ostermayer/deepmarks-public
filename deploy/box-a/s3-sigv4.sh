#!/usr/bin/env bash
# Minimal AWS SigV4 helpers for Linode Object Storage.
#
# Intentionally small: backup jobs should not require awscli/s3cmd on the
# host. Supports virtual-hosted-style GET/PUT for object keys made of
# safe path chars, which is the URL form Linode Object Storage documents
# for bucket access.

require_var() {
  local v="$1"
  if [ -z "${!v:-}" ]; then
    echo "✗ missing env var: $v" >&2
    exit 1
  fi
}

sha256_file() {
  openssl dgst -sha256 -hex "$1" | awk '{print $NF}'
}

s3_signed_curl() {
  local method="$1"
  local bucket="$2"
  local key="$3"
  local endpoint="$4"
  local file="${5:-}"
  local output="${6:-}"

  local host
  host="$(echo "$endpoint" | sed -E 's|https?://||' | sed 's|/$||')"
  local scheme
  scheme="$(echo "$endpoint" | sed -E 's|://.*||')"
  if [ "$scheme" != "http" ] && [ "$scheme" != "https" ]; then
    scheme="https"
  fi
  local request_host="${bucket}.${host}"
  local region
  region="$(echo "$host" | cut -d. -f1)"
  local date_iso
  date_iso="$(date -u +%Y%m%dT%H%M%SZ)"
  local date_ymd="${date_iso:0:8}"
  local content_sha
  if [ "$method" = "PUT" ]; then
    content_sha="$(sha256_file "$file")"
  else
    content_sha="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  fi

  local canonical_request="${method}
/${key}

host:${request_host}
x-amz-content-sha256:${content_sha}
x-amz-date:${date_iso}

host;x-amz-content-sha256;x-amz-date
${content_sha}"
  local hashed_canonical
  hashed_canonical="$(printf "%s" "$canonical_request" | openssl dgst -sha256 -hex | awk '{print $NF}')"
  local scope="${date_ymd}/${region}/s3/aws4_request"
  local string_to_sign="AWS4-HMAC-SHA256
${date_iso}
${scope}
${hashed_canonical}"

  local k1 k2 k3 k4 sig
  k1="$(printf "%s" "$date_ymd" | openssl dgst -sha256 -hex -mac HMAC -macopt "key:AWS4${LINODE_SECRET_KEY}" | awk '{print $NF}')"
  k2="$(printf "%s" "$region" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:$k1" | awk '{print $NF}')"
  k3="$(printf "%s" "s3" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:$k2" | awk '{print $NF}')"
  k4="$(printf "%s" "aws4_request" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:$k3" | awk '{print $NF}')"
  sig="$(printf "%s" "$string_to_sign" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:$k4" | awk '{print $NF}')"

  local auth="AWS4-HMAC-SHA256 Credential=${LINODE_ACCESS_KEY}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}"
  local url="${scheme}://${request_host}/${key}"

  if [ "$method" = "PUT" ]; then
    curl --fail-with-body --silent --show-error \
      -X PUT "$url" \
      -H "Host: ${request_host}" \
      -H "Authorization: ${auth}" \
      -H "x-amz-content-sha256: ${content_sha}" \
      -H "x-amz-date: ${date_iso}" \
      --upload-file "$file"
  elif [ "$method" = "GET" ]; then
    if [ -n "$output" ]; then
      curl --fail-with-body --silent --show-error \
        -X GET "$url" \
        -H "Host: ${request_host}" \
        -H "Authorization: ${auth}" \
        -H "x-amz-content-sha256: ${content_sha}" \
        -H "x-amz-date: ${date_iso}" \
        -o "$output"
    else
      curl --fail-with-body --silent --show-error \
        -X GET "$url" \
        -H "Host: ${request_host}" \
        -H "Authorization: ${auth}" \
        -H "x-amz-content-sha256: ${content_sha}" \
        -H "x-amz-date: ${date_iso}"
    fi
  else
    echo "✗ unsupported s3 method: $method" >&2
    exit 1
  fi
}

s3_put() {
  s3_signed_curl PUT "$1" "$2" "$4" "$3"
}

s3_get() {
  s3_signed_curl GET "$1" "$2" "$3" "" "${4:-}"
}

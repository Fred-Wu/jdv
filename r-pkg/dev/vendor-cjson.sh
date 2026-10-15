#!/usr/bin/env bash
# Refresh the pinned upstream source, or use a local upstream checkout.
# Usage: ./vendor-cjson.sh [--from-upstream DIRECTORY]
set -euo pipefail

TAG="v1.7.19"
REPO="DaveGamble/cJSON"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${SCRIPT_DIR}/../src/cjson"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PATCHES=("${DEST}/patches/"*.patch)

if [[ $# -eq 2 && "$1" == "--from-upstream" ]]; then
  SOURCE="$2"
  [[ -f "${SOURCE}/cJSON.c" && -f "${SOURCE}/cJSON.h" ]] || {
    echo "Expected cJSON.c and cJSON.h in ${SOURCE}" >&2
    exit 1
  }
  major="$(awk '$1 == "#define" && $2 == "CJSON_VERSION_MAJOR" { print $3 }' "${SOURCE}/cJSON.h")"
  minor="$(awk '$1 == "#define" && $2 == "CJSON_VERSION_MINOR" { print $3 }' "${SOURCE}/cJSON.h")"
  patch="$(awk '$1 == "#define" && $2 == "CJSON_VERSION_PATCH" { print $3 }' "${SOURCE}/cJSON.h")"
  [[ "${major}.${minor}.${patch}" == "${TAG#v}" ]] || {
    echo "Expected cJSON ${TAG}; found ${major}.${minor}.${patch}" >&2
    exit 1
  }
  cp "${SOURCE}/cJSON.c" "${SOURCE}/cJSON.h" "$WORK/"
elif [[ $# -eq 0 ]]; then
  gh api "repos/${REPO}/contents/cJSON.c?ref=${TAG}" -q '.content' | base64 -d > "${WORK}/cJSON.c"
  gh api "repos/${REPO}/contents/cJSON.h?ref=${TAG}" -q '.content' | base64 -d > "${WORK}/cJSON.h"
else
  echo "Usage: $0 [--from-upstream DIRECTORY]" >&2
  exit 1
fi

for p in "${PATCHES[@]}"; do
  git -C "$WORK" apply "$p"
done
cp "${WORK}/cJSON.c" "${WORK}/cJSON.h" "$DEST/"
printf '%s\n' "$TAG" > "${DEST}/VERSION"
echo "Vendored cJSON ${TAG} with ${#PATCHES[@]} local patches"

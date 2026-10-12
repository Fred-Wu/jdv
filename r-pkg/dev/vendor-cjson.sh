#!/usr/bin/env bash
# Refresh the pinned upstream source, or validate an already patched local copy.
# Usage: ./vendor-cjson.sh [--from-patched DIRECTORY]
set -euo pipefail

TAG="v1.7.19"
REPO="DaveGamble/cJSON"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${SCRIPT_DIR}/../src/cjson"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PATCHES=("${DEST}/patches/"*.patch)

if [[ $# -eq 2 && "$1" == "--from-patched" ]]; then
  SOURCE="$2"
  [[ "$(cat "${SOURCE}/VERSION")" == "$TAG" ]] || {
    echo "Expected cJSON ${TAG}" >&2
    exit 1
  }
  cp "${SOURCE}/cJSON.c" "${SOURCE}/cJSON.h" "$WORK/"
  for ((i=${#PATCHES[@]}-1; i>=0; i--)); do
    git -C "$WORK" apply --reverse "${PATCHES[i]}"
  done
elif [[ $# -eq 0 ]]; then
  gh api "repos/${REPO}/contents/cJSON.c?ref=${TAG}" -q '.content' | base64 -d > "${WORK}/cJSON.c"
  gh api "repos/${REPO}/contents/cJSON.h?ref=${TAG}" -q '.content' | base64 -d > "${WORK}/cJSON.h"
else
  echo "Usage: $0 [--from-patched DIRECTORY]" >&2
  exit 1
fi

for p in "${PATCHES[@]}"; do
  git -C "$WORK" apply "$p"
done
cp "${WORK}/cJSON.c" "${WORK}/cJSON.h" "$DEST/"
printf '%s\n' "$TAG" > "${DEST}/VERSION"
echo "Vendored cJSON ${TAG} with ${#PATCHES[@]} local patches"

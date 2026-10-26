#!/bin/bash
# Builds the small presence helper (camera / mic / full-screen checks) as a universal binary.
# Needs the Xcode command line tools: xcode-select --install
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping titli-presence: it can only be built on a Mac."
  exit 0
fi
if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "Skipping titli-presence: install the Xcode command line tools with 'xcode-select --install'."
  echo "Titli still runs without it, it just can't tell when you're on a call."
  exit 0
fi
mkdir -p build
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "${arch}-apple-macos11" -o "build/titli-presence-${arch}" TitliPresence.swift \
    -framework AppKit -framework CoreAudio -framework CoreMediaIO
done
lipo -create -output bin/titli-presence build/titli-presence-arm64 build/titli-presence-x86_64
rm -rf build
echo "Built native/mac/bin/titli-presence"

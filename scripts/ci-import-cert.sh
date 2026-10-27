#!/bin/bash
# CI (macOS): put Titli's code-signing certificate in a temporary keychain and print its identity.
#   scripts/ci-import-cert.sh <cert.p12> <password>   ->   writes TITLI_SIGN_IDENTITY to $GITHUB_ENV
set -euo pipefail
P12="$1"; PASS="$2"
KC="$RUNNER_TEMP/titli-sign.keychain-db"; KCP="$(openssl rand -hex 16)"
security create-keychain -p "$KCP" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KCP" "$KC"
security import "$P12" -k "$KC" -P "$PASS" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCP" "$KC" >/dev/null
security list-keychains -d user -s "$KC" $(security list-keychains -d user | sed -e 's/"//g')
# trusted on this build machine only, so codesign accepts it; people's Macs never need to trust it
security find-certificate -c "Titli Self-Signed" -p "$KC" > "$RUNNER_TEMP/titli-sign.pem"
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$RUNNER_TEMP/titli-sign.pem" \
  || echo "::warning::Couldn't mark the signing certificate as trusted on the build machine"
ID="$(security find-identity -p codesigning "$KC" | awk '/Titli Self-Signed/ {print $2; exit}')"
test -n "$ID" || { echo "::error::The signing certificate didn't import"; exit 1; }
echo "TITLI_SIGN_IDENTITY=$ID" >> "$GITHUB_ENV"
echo "TITLI_SIGN_KEYCHAIN=$KC" >> "$GITHUB_ENV"
echo "signing identity $ID"

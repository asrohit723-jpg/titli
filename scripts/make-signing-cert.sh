#!/bin/bash
# Makes Titli's self-signed code-signing certificate as a .p12 (used to sign the Mac app the same way every time).
#   scripts/make-signing-cert.sh <out.p12> <password> [days]
# An explicit config with nothing implicit: some OpenSSL builds otherwise add a second, conflicting
# "Basic Constraints" from their default config, which macOS rejects.
set -euo pipefail
OUT="$1"; PASS="$2"; DAYS="${3:-7300}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cert.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Titli Self-Signed
O = Titli
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
openssl req -x509 -newkey rsa:3072 -sha256 -days "$DAYS" -nodes -config "$TMP/cert.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
# macOS's importer wants the older p12 encryption
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "Titli Self-Signed" -out "$OUT" -passout "pass:$PASS" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 2>/dev/null \
  || openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "Titli Self-Signed" -out "$OUT" -passout "pass:$PASS"
openssl x509 -in "$TMP/cert.pem" -noout -text | sed -n '/X509v3 extensions/,/Signature Algorithm/p' >&2

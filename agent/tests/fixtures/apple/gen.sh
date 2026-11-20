#!/usr/bin/env bash
# Regenerates the TEST certificate chain for agent/tests/billing_apple.test.ts:
# a stand-in for Apple's App Store signing chain (root -> WWDR-style
# intermediate -> App Store signing leaf), with the same curves, signature
# algorithms and Apple marker extensions as the real one. TEST KEYS ONLY:
# nothing here is trusted anywhere but the tests (the relay pins the real
# Apple Root CA G3).
#
#   agent/tests/fixtures/apple/gen.sh    (writes chain.json next to itself)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT
cd "$t"

cat >ext.cnf <<'EOF'
[root]
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[inter]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
1.2.840.113635.100.6.2.1 = ASN1:NULL
[leaf]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
1.2.840.113635.100.6.11.1 = ASN1:NULL
[plainleaf]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
EOF

openssl ecparam -name secp384r1 -genkey -noout -out root.key
openssl ecparam -name secp384r1 -genkey -noout -out other.key
openssl ecparam -name secp384r1 -genkey -noout -out inter.key
openssl ecparam -name prime256v1 -genkey -noout -out leaf.key

openssl req -x509 -new -key root.key -sha384 -days 7300 -subj "/CN=Test Root CA - G3/O=Splanc tests" -extensions root -config <(cat /etc/ssl/openssl.cnf ext.cnf) -out root.pem
openssl req -x509 -new -key other.key -sha384 -days 7300 -subj "/CN=Not Apple Root/O=Splanc tests" -extensions root -config <(cat /etc/ssl/openssl.cnf ext.cnf) -out other.pem

sign() { # key cert-name subject ext days issuer-cert issuer-key
  openssl req -new -key "$1" -subj "$3" -out "$2.csr"
  openssl x509 -req -in "$2.csr" -CA "$6" -CAkey "$7" -CAcreateserial -sha384 -days "$5" -extfile ext.cnf -extensions "$4" -out "$2.pem"
}
sign inter.key inter "/CN=Test WWDR CA/OU=G6/O=Splanc tests" inter 3650 root.pem root.key
sign leaf.key leaf "/CN=Test StoreKit Signing/O=Splanc tests" leaf 1825 inter.pem inter.key
sign leaf.key plainleaf "/CN=Test Not StoreKit/O=Splanc tests" plainleaf 1825 inter.pem inter.key
sign leaf.key shortleaf "/CN=Test StoreKit Short/O=Splanc tests" leaf 1 inter.pem inter.key
sign inter.key otherinter "/CN=Other WWDR CA/O=Splanc tests" inter 3650 other.pem other.key

der() { openssl x509 -in "$1.pem" -outform der | base64 -w0; }
pk8() { openssl pkcs8 -topk8 -nocrypt -in "$1.key" -outform DER | base64 -w0; }
cat >"$here/chain.json" <<EOF
{
  "//": "TEST-ONLY App Store-style signing chain (gen.sh). DER certificates and PKCS#8 keys, base64.",
  "root": "$(der root)",
  "intermediate": "$(der inter)",
  "leaf": "$(der leaf)",
  "leaf_without_apple_oid": "$(der plainleaf)",
  "leaf_expires_in_a_day": "$(der shortleaf)",
  "other_root": "$(der other)",
  "intermediate_of_other_root": "$(der otherinter)",
  "leaf_key_pkcs8": "$(pk8 leaf)",
  "generated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "wrote $here/chain.json"

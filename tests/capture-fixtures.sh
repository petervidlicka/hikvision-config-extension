#!/bin/zsh
# Capture real ISAPI responses from a device as local test fixtures.
# Read-only: sends GET requests only. Output goes to tests/fixtures/local/,
# which is git-ignored because it can contain serial numbers and MACs.
#
# Usage: tests/capture-fixtures.sh <host> [user] [channel]
set -u
host=${1:?usage: $0 <host> [user] [channel]}
user=${2:-admin}
ch=${3:-1}
out="${0:A:h}/fixtures/local"
mkdir -p "$out"
read -rs "pw?Password for $user@$host: "; echo

paths=(
  "/ISAPI/System/deviceInfo"
  "/ISAPI/System/Video/inputs/channels"
  "/ISAPI/ContentMgmt/InputProxy/channels"
  "/ISAPI/Streaming/channels"
  "/ISAPI/System/Video/inputs/channels/$ch/motionDetection"
  "/ISAPI/System/Video/inputs/channels/$ch/privacyMask"
  "/ISAPI/Event/triggers/VMD-$ch"
  "/ISAPI/Event/triggers"
)
for p in $paths; do
  name=${${p#/ISAPI/}//\//_}.xml
  code=$(/usr/bin/curl -s --digest -u "$user:$pw" -o "$out/$name" -w '%{http_code}' "http://$host$p")
  echo "$code  $p"
  [[ $code == 200 ]] || rm -f "$out/$name"
  # Stop on a 401 so a wrong password costs one failed login, not eight
  [[ $code == 401 ]] && { echo "Login rejected — stopping."; exit 1; }
done
echo "Saved to $out"

#!/bin/zsh
# Probe what a device supports for playback, read-only: recording searches,
# the monthly recording calendar, and still images (live sub-stream, picture
# track, snapshot-at-time). Never downloads video. Responses are saved to
# tests/fixtures/local/ (git-ignored) for the tests.
#
# Usage: tests/probe-playback.sh <host> [user] [channel]
set -u
host=${1:?usage: $0 <host> [user] [channel]}
user=${2:-admin}
ch=${3:-1}
out="${0:A:h}/fixtures/local"
mkdir -p "$out"
read -rs "pw?Password for $user@$host: "; echo

# Device times are local wall-clock time with a "Z" suffix (as the web UI sends them)
today=$(date +%Y-%m-%d)
year=$(date +%Y); month=$(date +%-m)

# request <name> <method> <path> [xml body]; prints status, type and size
request() {
  local name=$1 method=$2 path=$3 body=${4:-}
  local args=(-s --digest -u "$user:$pw" -o "$out/playback-$name" -w '%{http_code} %{content_type} %{size_download}')
  [[ -n $body ]] && args+=(-X "$method" -H 'Content-Type: application/xml' --data "$body")
  local result
  result=$(/usr/bin/curl "${args[@]}" "http://$host$path")
  printf '%-22s %s  %s\n' "$name" "$result" "$path"
  if [[ ${result%% *} == 401 ]]; then echo "Login rejected — stopping."; exit 1; fi
}

search_xml() { # <trackID>
  print -r -- "<?xml version='1.0' encoding='utf-8'?><CMSearchDescription><searchID>$(uuidgen)</searchID><trackList><trackID>$1</trackID></trackList><timeSpanList><timeSpan><startTime>${today}T00:00:00Z</startTime><endTime>${today}T23:59:59Z</endTime></timeSpan></timeSpanList><maxResults>100</maxResults><searchResultPostion>0</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>"
}

echo "== Recording calendar and searches (channel $ch, $today)"
request calendar.xml POST "/ISAPI/ContentMgmt/record/tracks/${ch}01/dailyDistribution" \
  "<?xml version='1.0' encoding='utf-8'?><trackDailyParam><year>$year</year><monthOfYear>$month</monthOfYear></trackDailyParam>"
request search-video.xml POST /ISAPI/ContentMgmt/search "$(search_xml "${ch}01")"
request search-pictures.xml POST /ISAPI/ContentMgmt/search "$(search_xml "${ch}03")"
request record-tracks.xml GET /ISAPI/ContentMgmt/record/tracks
request download-caps.xml GET /ISAPI/ContentMgmt/download/capabilities

echo "== Still images"
request live-main.jpg GET "/ISAPI/Streaming/channels/${ch}01/picture"
request live-sub.jpg GET "/ISAPI/Streaming/channels/${ch}02/picture"

# A time inside the first recorded segment today, for snapshot-at-time attempts
start=$(python3 -I - "$out/playback-search-video.xml" <<'PY'
import re, sys
xml = open(sys.argv[1], errors='replace').read()
m = re.search(r'<startTime>([^<]+)</startTime>', xml.split('<matchList', 1)[-1])
print(m.group(1) if m else '')
PY
)
if [[ -n $start ]]; then
  st=${start//:/%3A}
  request at-time-proxy.jpg GET "/ISAPI/ContentMgmt/StreamingProxy/channels/${ch}01/picture?starttime=$st"
  request at-time-direct.jpg GET "/ISAPI/Streaming/channels/${ch}01/picture?starttime=$st"
else
  echo "(no recordings found today; skipping snapshot-at-time attempts)"
fi

echo "== Summary"
python3 -I - "$out" <<'PY'
import re, sys, os
d = sys.argv[1]
def read(n):
    p = os.path.join(d, 'playback-' + n)
    return open(p, errors='replace').read() if os.path.exists(p) else ''
cal = read('calendar.xml')
days = re.findall(r'<dayOfMonth>(\d+)</dayOfMonth>\s*<record>true</record>', cal)
print('days with recordings this month:', ', '.join(days) or 'none found')
for kind in ('video', 'pictures'):
    x = read(f'search-{kind}.xml')
    status = re.search(r'<responseStatusStrg>([^<]+)', x)
    n = re.search(r'<numOfMatches>(\d+)', x)
    uri = re.search(r'<playbackURI>([^<]{0,90})', x)
    types = sorted(set(re.findall(r'recordType\.meta\.std-cgi\.com/?([^<"]*)', x)))
    print(f'{kind} search: status={status.group(1) if status else "?"} matches={n.group(1) if n else "?"}'
          + (f' first URI={uri.group(1)}...' if uri else '') + (f' metadata={types[:5]}' if types else ''))
PY
echo "Saved responses to $out"

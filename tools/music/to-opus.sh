#!/usr/bin/env bash
# Selector channels (issue #34): tools/music/audio/<channel>/*.mp3 → tools/music/opus/<channel>/*.opus
# Opus 96 kb/s stereo, loudness-levelled to -14 LUFS (peaks under -1.5 dB) so a channel plays at an
# even volume. Skips files already converted; then adds opus file, size and length to audio/manifest.json.
set -euo pipefail
cd "$(dirname "$0")"
export BITRATE="${BITRATE:-96k}"

convert() {
  src="$1"; out="opus/${src#audio/}"; out="${out%.mp3}.opus"
  [ -s "$out" ] && exit 0
  mkdir -p "$(dirname "$out")"
  if ffmpeg -nostdin -loglevel error -y -i "$src" -vn -map_metadata -1 \
       -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 48000 -ac 2 \
       -c:a libopus -b:a "$BITRATE" -vbr on "$out.tmp.opus"; then
    mv "$out.tmp.opus" "$out" && echo "ok   $out"
  else
    rm -f "$out.tmp.opus"; echo "FAIL $src"
  fi
}
export -f convert

find audio -name '*.mp3' -print0 | xargs -0 -P "$(nproc)" -I{} bash -c 'convert "$1"' _ {}

node -e '
const fs = require("fs"), { execFileSync } = require("child_process");
const m = JSON.parse(fs.readFileSync("audio/manifest.json"));
for (const t of m) {
  const f = "opus/" + t.file.replace(/\.mp3$/, ".opus");
  if (!fs.existsSync(f)) continue;
  t.opus = f.slice(5); t.opusBytes = fs.statSync(f).size;
  t.sec = Math.round(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString()));
}
fs.writeFileSync("audio/manifest.json", JSON.stringify(m, null, 2));
fs.copyFileSync("audio/manifest.json", "opus/manifest.json");
const done = m.filter((t) => t.opus);
console.log(`${done.length}/${m.length} in opus: ${(done.reduce((a, t) => a + t.opusBytes, 0) / 1e6).toFixed(0)} MB, ${(done.reduce((a, t) => a + t.sec, 0) / 3600).toFixed(1)} h`);
'

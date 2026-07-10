#!/usr/bin/env bash
# Web-video ingestion: download → pose keypoints → recordings_web/<name>.jsonl
#
#   lab/web.sh <name> <url | "ytsearch1:query"> [maxSeconds=75]
#
# Downloads at most maxSeconds of ≤480p video to a temp dir, runs
# MediaPipe pose extraction (lab/ingest_video.py), writes the keypoint
# JSONL with source/title provenance, and deletes the video. Then:
#
#   RECORD_DIR=recordings_web node lab/drop.js   → gallery in lab/out/drop-recordings_web/
set -euo pipefail

name=$1
src=$2
max=${3:-75}
labdir=$(cd "$(dirname "$0")" && pwd)
out="$labdir/../recordings_web"
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

yt-dlp -f "mp4[height<=480]/best[height<=480]/best" --no-playlist \
  --download-sections "*0-$max" --force-keyframes-at-cuts \
  --print-to-file "%(webpage_url)s" "$tmp/url.txt" \
  --print-to-file "%(title)s" "$tmp/title.txt" \
  -o "$tmp/video.%(ext)s" "$src"

video=$(ls "$tmp"/video.* | head -1)
python3 "$labdir/ingest_video.py" "$video" "$out/$name.jsonl" \
  --source "$(head -1 "$tmp/url.txt")" \
  --title "$(head -1 "$tmp/title.txt")" \
  --max-s "$max"
echo "ingested -> $out/$name.jsonl (video deleted)"

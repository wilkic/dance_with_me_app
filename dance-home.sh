#!/usr/bin/env bash
# Dance With Me — home studio: one command on the laptop, then just open the
# phone and dance a training session.
#
#   ./dance-home.sh           (--no-obs to leave OBS alone)
#
# Starts the LAN stack (dance-lan.sh) with:
#   - recording on: every session lands in server/library/sessions/
#   - the room "home", always there, with its own OBS stream key
#   - OBS, on its own profile "Dance home", streaming this laptop's sound
#     (the music you play in a browser) into that room
# and prints the phone link (https://<laptop>:5173/?room=home) as a QR code.
# Ctrl+C stops everything, including the OBS it started.
exec "$(dirname "$0")/dance-lan.sh" --home "$@"

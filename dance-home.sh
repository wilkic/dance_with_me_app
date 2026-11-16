#!/usr/bin/env bash
# Dance With Me — home studio: one command on the laptop, then just open the
# phone and dance a training session.
#
#   ./dance-home.sh           (--no-obs to leave OBS alone, --no-music to
#                              not open the music page)
#
# Starts the LAN stack (dance-lan.sh) with:
#   - a ● Record button on the phone: each Record → Stop is one clip in
#     server/library/sessions/ (nothing is recorded otherwise)
#   - the room "home", always there, with its own OBS stream key
#   - OBS, on its own profile "Dance home", streaming this laptop's sound
#     (the music you play in a browser) into that room
#   - your music opened in the browser: YouTube Music, your liked songs
#     (another page: DANCE_HOME_MUSIC=<url> ./dance-home.sh)
# and prints the phone link (https://<laptop>:5173/?room=home) as a QR code.
# Ctrl+C stops everything, including the OBS it started.
exec "$(dirname "$0")/dance-lan.sh" --home "$@"

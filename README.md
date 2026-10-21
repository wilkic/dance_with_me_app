# Dance With Me — MVP

A phone-based web app: capture your room, step into frame, and see yourself
as a real-time stick figure dancing in your own (person-free) space.

## Run it

```bash
npm install
npm run dev
```

Vite prints a `https://<your-lan-ip>:5173` URL — open that on your phone
(same Wi-Fi). HTTPS is self-signed, so accept the browser warning once;
camera access requires a secure context. The pose model downloads from a
CDN on first load, so the phone needs internet the first time.

## How to use

1. **Pick your guests** — the start screen asks who dances in your space:
   **⏱ Delayed you** (your own moves, a minute later), **👥 Other people**
   (real dancers online right now, brought into your space by the server)
   and **✨ AI dancers** (real recorded dances from the library, replayed
   on your beat with borrowed moves), 0–3 of each. Tap **Dance**. Or dance
   in a room: the start screen lists the rooms that are open right now
   (who's dancing, room BPM); tap one to join, or start a new one — the
   app suggests a name like `funky-otter` (🎲 shuffles), tap **Start this
   room**, and anyone who picks it from the list or types the same name
   joins you. Room links work too: `https://…/?room=funky-otter`. Grant
   camera permission.
2. **Capture Room** — prop the phone up facing your dance space, step out
   of frame, tap the button. A 5-second countdown fires, then the app
   averages several frames into a "clean plate" of your empty room.
3. **Dance** — step back in. You're gone from the screen; a stick figure
   dances in your room instead. Room-mates show up as stick figures behind
   you, each in their own color. The HUD shows FPS, your BPM (and the
   music's once it's heard), and the room line (how many dancing · room
   BPM). No song titles: we can't know what's playing.

Controls: **Ghost** toggles between the clean room (user removed) and the
live feed (debugging). **Rescan** recaptures the room. **Flip** switches
front/back camera before capture. The **☰ menu** (top right while dancing)
has the same guest picker, the delay before each replay appears, guest
opacity, **AI variation** (how far the AI dancers stray from the person
they replay), the **sharing levels** (below) and **Exit** back to the start
screen (which also leaves the room). Replay guests default to 1 when solo
and 0 in a room, where real people are the guests; AI dancers default to
1 whenever a dance server is reachable. Everyone but you is drawn behind
you at 90% opacity by default; AI dancers are white and carry their style
tag (`✨ salsa`) above the head, real people carry their tempo.

### Guests: delayed you, other people, AI dancers

All three kinds arrive through the same path (`PoseChannel.subscribe`) and
render as extra stick figures behind you.

- **Delayed you** is client-side: your frames come back after a delay.
- **Other people** are real dancers online right now. When you ask for N,
  the server assigns up to N of them to your space (tempo-compatible
  first, then whoever is in the fewest spaces) and relays their frames to
  you exactly like room-mates'. They don't see you unless they asked for
  people too — so you can be dancing in someone's space while dancing
  alone in yours. Rooms still work as before; room-mates are never
  double-booked as guests.
- **AI dancers** are built server-side from the **dance library**. No
  choreography is generated: an AI dancer is a real person's recorded
  dance, retimed so its tempo lands on yours (half/double time allowed),
  with *variation in the "moves" sense* — for a phrase at a time its arms
  or legs are borrowed from a second dancer of similar tempo and style,
  hung off its own shoulders/hips, and limbs swing a little further. Every
  two minutes it moves on to another person's dance (crossfaded). The beat
  comes in as a number, so this works for silent dancers; when the phone
  hears music the number is better and the style match tighter.

### The dance library, and what your phone shares

Every session is library material: the server records each session's
PoseFrames and tempo into `server/library/sessions/` (short blips are
dropped; sessions ≥300 frames join the library live). What else leaves
the phone is up to the dancer, two dials in the ☰ menu (remembered on the
device):

| dial  | minimal                          | …                                                  | full                        |
|-------|----------------------------------|----------------------------------------------------|-----------------------------|
| video | **points** — the PoseFrames only |                                                    | **video** — the camera feed |
| music | **motion** — no microphone       | **beat** — mic on, only a 30 Hz onset envelope sent | **audio** — the mic recording |

At the **beat** level the server hears the tempo (`♫ 120` in the HUD)
without ever receiving sound; it drives the AI dancers and is stored with
the session. Full media lands next to the session as `.audio.webm` /
`.video.webm` (MediaRecorder chunks) for later ingestion.

The library itself (`server/library.js`) indexes `recordings_web/` (the
harvested web clips, tagged by genre), `recordings/` (metronome sessions)
and `library/sessions/`; each clip gets a descriptor — tempo (metronome
label > music tempo > motion tempo), a **style vector** (per body part,
how far it travels and how fast, in torso lengths — `server/style.js`),
pose coverage, source aspect — cached in `library/index.json`. Picking a
clip is tempo-first, style-second, tag-third, and needs none of them to
be known.

## Architecture

```
src/
  camera.js            getUserMedia wrapper, front/back switching
  room/roomModel.js    RoomModel: session-persistent room representation
  pose/
    poseFormat.js      ★ standardized PoseFrame: the app-wide contract
    poseDetector.js    MediaPipe PoseLandmarker behind a swappable interface
    smoothing.js       One Euro filter per joint (low jitter, low lag)
  avatar/
    avatar.js          Avatar interface (render(ctx, poseFrame, viewport, beat))
    stickFigure.js     MVP implementation: glowing stick figure, beat pulse
  net/poseChannel.js   networking seam: publish/subscribe of PoseFrames
  share/sessionShare.js what the phone shares for the library (mic envelope, media)
  main.js              app state machine + render loop
server/                dance-analysis server (Node, separate package.json)
  index.js             WebSocket ingest of PoseFrames → opinions out
  beatDetector.js      tempo + beats from motion alone (moved from the client)
  tempo.js             autocorrelation tempo for any signal; music tempo from a mic envelope
  style.js             body space + movement-style descriptor (keypoints only)
  library.js           the dance library: descriptors, cache, tempo/style picking
  aiDancer.js          AI dancer: retimed replay + borrowed moves, in body space
  recorder.js          per-session recording into library/sessions/
  test/synthetic.js    end-to-end: 2 synthetic dancers → profiled, relayed, room tempo
  lab/                 dance lab: BPM calibration + rhythm research tools
    run.js             scenario suite ("dance unit tests") + recording analysis
    synthDancer.js     synthetic dancer with per-body-part oscillators
    signals.js         per-part position/speed channels from PoseFrames
    stft.js            STFT on a BPM grid → waterfall matrices
    report.js          self-contained HTML report (waterfall heatmaps)
```

### Dance server: rooms + rhythm analysis

The server does two things. **Dance rooms:** a room is a name; the first
to arrive creates it, the last to leave closes it. Every PoseFrame a
member sends is relayed to the other members (wrapped in an envelope
carrying the sender's id, `src/net/envelope.js`), and the client renders
them through the same guest-avatar path as its delayed replays — dancing
with room-mates is dancing with "delayed you's", except they're real
people. A `rooms` lobby message (every open room, dancer count, tempo)
goes to every connection on connect, every scan and on any membership
change — it feeds the start screen's room list. The one thing assessed per room is tempo: each member's BPM and a
confidence-weighted room BPM go out in `room` opinions every scan and on
every join/leave. This is where the app will later pick music for the
room (tastes × each dancer's tempo × the room's tempo). No audio is
shared yet — play whatever you like.

**Rhythm analysis:** the client streams raw PoseFrames (the same binary
format used everywhere) and the server runs a per-dancer BeatDetector,
and forms an opinion of each dancer's tempo and the room's (the room's
music when it plays, else its dancers' movement). Without a server the app is fully
offline, solo only (no BPM shown).

```bash
cd server && npm install && npm start   # ws://0.0.0.0:8901
npm run dev                             # in another terminal, as usual
```

Under `npm run dev` the app connects to the server automatically through
the Vite proxy (`/ws` → the server), so the phone reuses the
already-accepted HTTPS cert; `?server=0` forces offline. On any other
host, the server URL is baked in at build time from `VITE_SERVER_URL`
(the Pages workflow reads it from the `DANCE_SERVER_URL` repository
variable; unset = solo-only deploy) or passed per-visit as
`?server=wss://host/path`. The server speaks plain `ws://`; put it behind
a TLS terminator (Caddy, a Cloudflare tunnel, fly.io, …) because the
HTTPS app can only open `wss://`.

`cd server && npm test` runs the unit tests (rooms registry, room tempo,
envelope; tempo/style/library/AI dancer/recorder) and the synthetic
end-to-end check: two fake dancers at 120/118 BPM join a room, must
receive each other's frames, be profiled, see the room tempo, and be
matched; a third, solo, asks for one real person and one AI dancer and
must receive both, hear its music tempo, and have its session recorded.

### Dance lab (BPM calibration)

Dancers layer frequencies — hips carry a slow groove, arms flourish on top,
and moving at half tempo (the Nyquist of the song) is idiomatic. The
production detector collapses the body into one speed scalar, so the
fastest limb wins. The lab in `server/lab/` measures this instead of
guessing:

```bash
cd server && npm run lab      # synthetic scenario suite → lab/out/report.html
```

Each scenario is a synthetic dancer with independent per-part oscillators;
checks are PASS/FAIL for required behavior and KNOWN GAP for measured
shortcomings we intend to fix. The report renders STFT waterfall heatmaps
(time × BPM) of the detector's speed scalar and per-part position channels,
with ground truth and the live detector estimate overlaid.

To capture real data, dance to the built-in metronome while the server
records:

```bash
cd server && RECORD_DIR=recordings npm start
# phone: https://<lan-ip>:5173/?server=1&click=100   ← metronome at 100 BPM
cd server && node lab/run.js analyze recordings/<file>.jsonl
```

The `?click=BPM` parameter plays an accented click once dancing starts and
labels the recorded session with the ground-truth BPM, so recorded moves
("dance unit tests" performed by a human) can be checked against what the
detector and the waterfalls saw.

### Design decisions (and how they serve the end-state)

**Room "scanning" = clean plate, not 3D mesh.** Mobile browsers expose no
LiDAR/depth APIs, so a Teleport-style scan isn't possible on the web today.
Instead, the phone is positioned once and a person-free photo of the room
("clean plate") becomes the session's room model. This makes user removal
free and perfect: the live feed is only ever used for pose detection, and
the *plate* is what's rendered — no segmentation artifacts, no ML cost.
`RoomModel.geometry` is reserved so real 3D (WebXR depth on Android Chrome,
or a native wrapper for LiDAR phones) can be added without changing
consumers. Device orientation at capture is already recorded as metadata.

**PoseFrame is the universal currency.** Every pose is a flat
`Float32Array` (33 keypoints × x,y,z,visibility, MediaPipe topology) with a
timestamp, plus binary serialize/deserialize helpers. Avatar rendering,
rhythm analysis, and the network channel all consume this one format, so a
remote dancer's frames are indistinguishable from local ones downstream.

**Avatars are pluggable.** `StickFigureAvatar` implements a tiny `Avatar`
interface that takes a PoseFrame and a canvas. AI-generated dancers or
remote users are new implementations fed from a different PoseFrame source
— the render loop doesn't change. (Rendering is 2D canvas for MVP speed;
the interface doesn't preclude a Three.js-backed avatar later, and
PoseFrames already carry z.)

**Rhythm from motion, no audio.** `BeatDetector` computes a body-size-
normalized motion-energy signal from weighted joint speeds, resamples it to
30 Hz, and autocorrelates a 6 s window to find the dominant period
(50–200 BPM) plus a confidence. Beats are marked at adaptive energy peaks,
which gives beat *phase* — the quantity you'll need to sync dancers across
locations. Verified on synthetic motion: recovers 120 BPM at 0.91
confidence. Real-world caveat: it finds the tempo of *your movement*, which
may lock to half/double the musical tempo depending on the dance.

**Networking is a seam, not a feature.** The render loop publishes every
local PoseFrame through `PoseChannel` (serialized, network-ready), and
every remote dancer — replay guest or real room-mate — arrives through the
same `subscribe()` path and renders as an additional avatar. Rooms landed
as a `WebSocketTransport` that also receives; detection, smoothing, and
rendering were untouched. Relay is star-topology through the server
(~16 KB/s per dancer at 30 fps), which is what lets the server keep
forming opinions on everyone; WebRTC could replace it if latency ever
matters more than that.

### Performance notes (mobile-first)

- MediaPipe `pose_landmarker_lite` with GPU delegate; 720p capture cap.
- Detection runs only on new video frames (`currentTime` guard).
- One Euro filtering instead of moving averages: smooth when still,
  responsive when fast — the right trade-off for dance.
- 2D canvas compositing (one `drawImage` + stroked lines per frame); no 3D
  engine overhead in the hot loop.

## Phase status

- **Phase 1 (room setup):** done, via clean-plate capture (see caveat above).
- **Phase 2 (pose → stick figure, user removal):** done.
- **Phase 3 (rhythm from motion):** first version done — BPM + beat pulses.
- **Phase 4 (polish/testing):** needs on-device testing across rooms,
  lighting, and phones.
- **Multi-user (dance rooms):** first version done — named rooms, pose
  relay, per-member and room BPM. Next: the room as music selector; shared
  audio (mic forwarding vs. re-casting the source) deliberately deferred.

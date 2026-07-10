#!/usr/bin/env python3
"""Video file → dance-lab recording JSONL (pose keypoints only).

    ingest_video.py <video> <out.jsonl> [--source URL] [--title T] [--max-s N]

Runs MediaPipe PoseLandmarker (Tasks API, VIDEO mode) over the frames
using the SAME model the phone app ships (public/models/
pose_landmarker_lite.task), so web ingests are measured by production
eyes. Single person — the most prominent one. Output is the lab
recording format: one label line with provenance, then
{"t": ms, "k": [x,y,z,visibility] * 33} per frame. No pixels are
stored; the video can be deleted after ingestion. Frames with no
detected person are omitted.
"""
import argparse
import json
import os
import sys

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

DEFAULT_MODEL = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "public", "models", "pose_landmarker_lite.task")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--source", default=None)
    ap.add_argument("--title", default=None)
    ap.add_argument("--max-s", type=float, default=90.0,
                    help="stop after this many seconds of video")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    # Process at most ~30 fps: skip frames of high-fps sources.
    step = max(1, round(fps / 30.0))

    landmarker = vision.PoseLandmarker.create_from_options(
        vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=args.model),
            running_mode=vision.RunningMode.VIDEO))

    n_in = n_out = 0
    last_ts = -1
    with open(args.out, "w") as f:
        label = {"type": "label", "ingest": "video"}
        if args.source:
            label["source"] = args.source
        if args.title:
            label["title"] = args.title
        f.write(json.dumps(label) + "\n")

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t_ms = n_in * 1000.0 / fps
            n_in += 1
            if t_ms / 1000.0 > args.max_s:
                break
            if (n_in - 1) % step:
                continue
            ts = int(t_ms)
            if ts <= last_ts:  # VIDEO mode needs monotonic timestamps
                continue
            last_ts = ts
            img = mp.Image(image_format=mp.ImageFormat.SRGB,
                           data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            res = landmarker.detect_for_video(img, ts)
            if not res.pose_landmarks:
                continue
            k = []
            for lm in res.pose_landmarks[0]:
                k += [round(lm.x, 4), round(lm.y, 4),
                      round(lm.z, 4), round(lm.visibility, 4)]
            f.write(json.dumps({"t": round(t_ms, 1), "k": k}) + "\n")
            n_out += 1

    landmarker.close()
    cap.release()
    dur = min(n_in / fps, args.max_s)
    print(f"{args.out}: {n_out} pose frames from {dur:.0f}s of video "
          f"({n_in} frames read, source fps {fps:.0f})")
    if n_out < 90:
        print("warning: fewer than 90 frames with a detected person — "
              "drop.js will skip this file", file=sys.stderr)


if __name__ == "__main__":
    main()

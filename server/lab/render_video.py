#!/usr/bin/env python3
"""Frame renderer + metronome WAV for dance-lab scenario videos.

Called by video.js:  render_video.py <job.json> <framesDir> <click.wav>

Draws the synthetic dancer's keypoints as the app-style glowing green
stick figure on a dark background, one PNG per frame, plus a beat-flash
dot so metronome sync is visible even with muted playback. The WAV is a
uniform (unaccented) click track at the scenario's design tempo.
"""
import json
import math
import struct
import sys
import wave

from PIL import Image, ImageDraw, ImageFont

# MediaPipe keypoint indices (src/pose/poseFormat.js KP), stride 4.
NOSE = 0
L_SHO, R_SHO, L_ELB, R_ELB, L_WRI, R_WRI = 11, 12, 13, 14, 15, 16
L_HIP, R_HIP, L_KNE, R_KNE, L_ANK, R_ANK = 23, 24, 25, 26, 27, 28
BONES = [
    (L_SHO, R_SHO), (L_SHO, L_ELB), (L_ELB, L_WRI), (R_SHO, R_ELB),
    (R_ELB, R_WRI), (L_SHO, L_HIP), (R_SHO, R_HIP), (L_HIP, R_HIP),
    (L_HIP, L_KNE), (L_KNE, L_ANK), (R_HIP, R_KNE), (R_KNE, R_ANK),
]

BG = (12, 14, 22)
GLOW = [(14, (24, 70, 40)), (7, (40, 160, 85)), (3, (150, 255, 190))]
TEXT = (150, 160, 175)
FLASH = (255, 235, 130)

SR = 44100


def load_font(size):
    try:
        return ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size)
    except OSError:
        return ImageFont.load_default()


def kp(k, i):
    return k[i * 4], k[i * 4 + 1]


def render_frames(job, frames_dir):
    W, H = job["size"]
    font = load_font(15)
    small = load_font(12)
    clicks = job["clickTimes"]

    for n, fr in enumerate(job["frames"]):
        t = fr["t"] / 1000.0
        k = fr["k"]
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)

        def px(p):
            return (p[0] * W, p[1] * H)

        neck = px(((kp(k, L_SHO)[0] + kp(k, R_SHO)[0]) / 2,
                   (kp(k, L_SHO)[1] + kp(k, R_SHO)[1]) / 2))
        nose = px(kp(k, NOSE))
        head_r = 0.045 * H / 2
        for width, color in GLOW:
            for a, b in BONES:
                d.line([px(kp(k, a)), px(kp(k, b))], fill=color, width=width)
            d.line([neck, (nose[0], nose[1] + head_r)], fill=color, width=width)
            d.ellipse([nose[0] - head_r, nose[1] - head_r,
                       nose[0] + head_r, nose[1] + head_r],
                      outline=color, width=max(2, width // 3))

        # Beat flash: decays over ~150 ms after each click.
        last = max((c for c in clicks if c <= t), default=None)
        if last is not None and t - last < 0.4:
            a = math.exp(-(t - last) / 0.15)
            r = 9 + 10 * a
            col = tuple(int(c * (0.25 + 0.75 * a)) for c in FLASH)
            d.ellipse([W / 2 - r, 30 - r, W / 2 + r, 30 + r], fill=col)

        d.text((14, 12), job["title"], fill=TEXT, font=font)
        for i, line in enumerate(job["partLines"]):
            d.text((14, 36 + 17 * i), line, fill=TEXT, font=small)
        if job["click"]:
            d.text((14, H - 40), f"click {job['click']['bpm']} BPM — {job['click']['note']}",
                   fill=TEXT, font=small)
        d.text((W - 60, H - 40), f"{t:5.1f}s", fill=TEXT, font=small)

        img.save(f"{frames_dir}/{n:05d}.png")


def render_wav(job, wav_path):
    dur = job["frames"][-1]["t"] / 1000.0 + 1.0 / job["fps"]
    samples = [0.0] * int(dur * SR)
    for c in job["clickTimes"]:
        start = int(c * SR)
        for i in range(int(0.04 * SR)):
            if start + i >= len(samples):
                break
            samples[start + i] += 0.8 * math.sin(2 * math.pi * 1200 * i / SR) \
                * math.exp(-i / (0.008 * SR))
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(struct.pack(
            f"<{len(samples)}h",
            *(int(max(-1.0, min(1.0, s)) * 32767) for s in samples)))


def main():
    job_path, frames_dir, wav_path = sys.argv[1:4]
    with open(job_path) as f:
        job = json.load(f)
    render_frames(job, frames_dir)
    render_wav(job, wav_path)


if __name__ == "__main__":
    main()

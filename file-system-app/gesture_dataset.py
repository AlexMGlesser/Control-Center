"""
Gesture dataset format: writing, indexing and loading labeled samples.

Kept free of camera/UI imports (stdlib only; numpy optional for
load_sample_arrays) so a future training script can `import gesture_dataset`
without pulling in OpenCV, MediaPipe or Tkinter.

On-disk layout (see README.md "Gesture dataset format" for the full schema):

    <dataset_dir>/
      manifest.json                 # index, rebuilt from the files on every change
      <label>/
        <sample_id>.json            # one repetition = one sample
        <sample_id>.mp4             # optional raw clip (recorder --save-video)
"""

import json
import os
import re
import tempfile
from datetime import datetime

SCHEMA_VERSION = 1
MANIFEST_NAME = "manifest.json"
NUM_LANDMARKS = 21
BACKGROUND_LABEL = "none"

_LABEL_RE = re.compile(r"[^a-z0-9_-]+")


def normalize_label(raw):
    """Lowercase, spaces -> underscores, drop anything outside [a-z0-9_-].
    Returns "" when nothing usable is left."""
    label = str(raw or "").strip().lower().replace(" ", "_")
    label = _LABEL_RE.sub("", label).strip("_-")
    return label[:64]


def new_sample_id(label, when=None):
    when = when or datetime.now()
    return f"{label}_{when.strftime('%Y%m%d_%H%M%S_%f')}"


def _atomic_write_json(path, payload):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def _round_points(points, ndigits=6):
    return [[round(float(p[0]), ndigits), round(float(p[1]), ndigits), round(float(p[2]), ndigits)] for p in points]


def hand_to_record(hand):
    """Convert one HandTracker hand dict (MediaPipe landmark objects) into the
    plain-JSON per-hand record. Also accepts already-plain [[x,y,z],...]
    lists, which is what the headless tests feed it."""
    def as_points(lms):
        if lms is None:
            return None
        out = []
        for lm in lms:
            if hasattr(lm, "x"):
                out.append((lm.x, lm.y, lm.z))
            else:
                out.append((lm[0], lm[1], lm[2]))
        return _round_points(out)

    score = hand.get("score")
    return {
        "label": hand.get("label"),
        "score": None if score is None else round(float(score), 4),
        "landmarks": as_points(hand.get("landmarks")),
        "world_landmarks": as_points(hand.get("world_landmarks")),
    }


def build_sample(*, label, sample_id, session_id, rep_index, frames, frame_size,
                 target_duration_sec, recorder_version, started_at, video_file=None,
                 extra=None):
    """Assemble a sample dict. `frames` is a list of
    {"t": float, "seq": int, "hands": [hand_record, ...]}."""
    duration = frames[-1]["t"] - frames[0]["t"] if len(frames) >= 2 else 0.0
    frames_with_hands = sum(1 for f in frames if f.get("hands"))
    sample = {
        "schema_version": SCHEMA_VERSION,
        "recorder_version": recorder_version,
        "sample_id": sample_id,
        "label": label,
        "is_background": label == BACKGROUND_LABEL,
        "session_id": session_id,
        "rep_index": int(rep_index),
        "recorded_at": started_at,
        "target_duration_sec": float(target_duration_sec),
        "duration_sec": round(float(duration), 4),
        "num_frames": len(frames),
        "frames_with_hands": frames_with_hands,
        "fps_estimate": round((len(frames) - 1) / duration, 2) if duration > 0 else 0.0,
        "frame_size": {"width": int(frame_size[0]), "height": int(frame_size[1])},
        "mirrored": True,
        "coordinate_notes": (
            "landmarks: x,y normalized to [0,1] of the mirrored frame (x right, y down), "
            "z relative depth (wrist-origin, same scale as x). world_landmarks: metres, "
            "hand-centred. Handedness labels are MediaPipe's on the mirrored image."
        ),
        "video_file": video_file,
        "frames": frames,
    }
    if extra:
        sample["extra"] = dict(extra)
    return sample


def sample_path(dataset_dir, label, sample_id):
    return os.path.join(dataset_dir, label, f"{sample_id}.json")


def write_sample(dataset_dir, sample):
    path = sample_path(dataset_dir, sample["label"], sample["sample_id"])
    _atomic_write_json(path, sample)
    return path


def delete_sample(dataset_dir, label, sample_id):
    """Remove a sample's JSON and any sidecar video. Returns files removed."""
    removed = []
    label_dir = os.path.join(dataset_dir, label)
    for ext in (".json", ".mp4", ".avi"):
        path = os.path.join(label_dir, f"{sample_id}{ext}")
        if os.path.exists(path):
            os.remove(path)
            removed.append(path)
    return removed


def load_sample(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def iter_sample_paths(dataset_dir):
    if not os.path.isdir(dataset_dir):
        return
    for label in sorted(os.listdir(dataset_dir)):
        label_dir = os.path.join(dataset_dir, label)
        if not os.path.isdir(label_dir) or label.startswith("."):
            continue
        for name in sorted(os.listdir(label_dir)):
            if name.endswith(".json") and not name.startswith("."):
                yield os.path.join(label_dir, name)


def rebuild_manifest(dataset_dir, recorder_version=None):
    """Scan the dataset folder and (re)write manifest.json. The manifest is
    derived data — deleting a sample file by hand and re-running this keeps
    it truthful."""
    samples = []
    labels = {}
    for path in iter_sample_paths(dataset_dir):
        try:
            sample = load_sample(path)
        except (OSError, json.JSONDecodeError):
            continue
        label = sample.get("label") or os.path.basename(os.path.dirname(path))
        labels[label] = labels.get(label, 0) + 1
        samples.append(
            {
                "sample_id": sample.get("sample_id"),
                "label": label,
                "path": os.path.relpath(path, dataset_dir).replace("\\", "/"),
                "video_file": sample.get("video_file"),
                "num_frames": sample.get("num_frames"),
                "frames_with_hands": sample.get("frames_with_hands"),
                "duration_sec": sample.get("duration_sec"),
                "recorded_at": sample.get("recorded_at"),
                "session_id": sample.get("session_id"),
                "schema_version": sample.get("schema_version"),
            }
        )

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "recorder_version": recorder_version,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "background_label": BACKGROUND_LABEL,
        "total_samples": len(samples),
        "labels": dict(sorted(labels.items())),
        "samples": samples,
    }
    _atomic_write_json(os.path.join(dataset_dir, MANIFEST_NAME), manifest)
    return manifest


def read_manifest(dataset_dir):
    path = os.path.join(dataset_dir, MANIFEST_NAME)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_sample_arrays(path_or_sample, max_hands=2):
    """Convenience for training code: returns a dict of numpy arrays
        landmarks: (T, max_hands, 21, 3) float32, zeros where absent
        world:     (T, max_hands, 21, 3) float32, zeros where absent
        mask:      (T, max_hands) bool, True where that hand slot is present
        t:         (T,) float32 seconds from clip start
    plus "label" and "handedness" ((T, max_hands) list of str|None).
    Hands are kept in MediaPipe's per-frame order; reorder by handedness
    yourself if your model needs a stable left/right slot."""
    import numpy as np

    sample = load_sample(path_or_sample) if isinstance(path_or_sample, str) else path_or_sample
    frames = sample.get("frames", [])
    count = len(frames)
    landmarks = np.zeros((count, max_hands, NUM_LANDMARKS, 3), dtype=np.float32)
    world = np.zeros((count, max_hands, NUM_LANDMARKS, 3), dtype=np.float32)
    mask = np.zeros((count, max_hands), dtype=bool)
    times = np.zeros((count,), dtype=np.float32)
    handedness = [[None] * max_hands for _ in range(count)]
    for i, frame in enumerate(frames):
        times[i] = frame.get("t", 0.0)
        for j, hand in enumerate(frame.get("hands", [])[:max_hands]):
            if hand.get("landmarks"):
                landmarks[i, j] = hand["landmarks"]
                mask[i, j] = True
            if hand.get("world_landmarks"):
                world[i, j] = hand["world_landmarks"]
            handedness[i][j] = hand.get("label")
    return {
        "label": sample.get("label"),
        "landmarks": landmarks,
        "world": world,
        "mask": mask,
        "t": times,
        "handedness": handedness,
    }

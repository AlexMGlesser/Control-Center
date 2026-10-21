# File System App (v0.1)

A gesture-controlled file explorer plus a gesture training-data recorder,
built on OpenCV + MediaPipe hand landmarks + Tkinter. It's ported from the
standalone project at `D:\Code\Hand_Tracker` (left untouched) and integrated
into Control Center as a **native** app. Control Center launches and stops it
as a child process instead of serving it as a web page.

| File | What it is |
|---|---|
| `file_explorer.py` | Main app: camera thread (`HandTracker`), gesture logic, Tk file explorer, calibration wizard, profile builder. |
| `gesture_recorder.py` | **New.** Guided recorder for labeled gesture training samples. |
| `gesture_dataset.py` | **New.** Dataset format: writer, manifest builder, loader helpers (stdlib; numpy only for `load_sample_arrays`). |
| `hand_tracker.py` | Minimal camera + skeleton demo / smoke test. |
| `hand_landmarker.task` | MediaPipe hand landmarker model (7.8 MB, loaded offline). |
| `panel/` | **New.** Small web status panel, served by Control Center at `/file-system-app/` and shown as the app's tab content. |
| `requirements.txt` | Third-party packages actually imported. |
| `gesture_profiles/` | Your calibration recordings + `profiles.json` (gitignored, see below). |
| `dataset/` | Recorder output (gitignored, created on first recording). |

## Changes from the original

The port only changes integration points, plus one deliberate behavior change
(hidden files). Everything else (gesture thresholds, UI and file operations)
is identical to `D:\Code\Hand_Tracker\file_explorer.py`.

`file_explorer.py`
1. `__version__ = "0.1.0"`; the window title is now `File System v0.1.0`.
2. Paths: new `APP_DIR` (folder of this file) and `DATA_DIR` (env
   `FILE_SYSTEM_DATA_DIR`, default `APP_DIR`). `MODEL_PATH` uses `APP_DIR`;
   `PROFILE_DIR` is now `DATA_DIR/gesture_profiles` (was "next to the script").
   Nothing refers to `D:\Code\Hand_Tracker`.
3. `HandTracker` additions, all additive, nothing existing changes:
   - Per-frame `seq` counter and capture timestamp, exposed by a new
     `latest_with_meta()` method (`latest()` is unchanged).
   - Each hand dict also carries `score` (handedness confidence) and
     `world_landmarks` (MediaPipe metric 3-D landmarks). Existing code
     ignores the extra keys.

   The recorder needs all of these.
4. **Behavior change: hidden files are hidden by default.** The toolbar has a
   new **Show hidden files** checkbox, unchecked by default and not persisted
   between runs. A new helper `is_hidden_entry()` treats an entry as hidden if
   any of these hold:
   - its name starts with `.` (`.git`, `.venv`, ...),
   - it has the Windows `FILE_ATTRIBUTE_HIDDEN` attribute,
   - it has the Windows `FILE_ATTRIBUTE_SYSTEM` attribute (`$Recycle.Bin`,
     `System Volume Information`, `pagefile.sys`, ...).

   If its attributes can't be read, the entry counts as not hidden. All
   directory listing now goes through `list_dir_entries()`: the file grid on
   initial load, navigation, back gesture, `..`, drive switch, tree clicks and
   refresh after file operations, and the folder tree on the left too. The
   `..` entry is never filtered.
   - Toggling the box re-lists the current folder in place. The selection
     follows the same item if it's still listed, an orphaned preview is
     cleared, and scroll is clamped. Already-expanded tree branches are
     re-listed too.
   - The checkbox can be toggled by the gesture "select" like the other
     toolbar controls, because `Checkbutton` has `invoke()`.
   - If a file operation creates or pastes a hidden item while the box is
     unchecked, it won't appear until you check the box.
   - Fix that came with it: when the current folder is inside a hidden
     folder (e.g. under `AppData`), the tree can't highlight it while hidden
     files are off. `_load_tree_children` now skips the missing branch
     instead of raising `TclError`.

`hand_tracker.py`: `__version__ = "0.1.0"` and a versioned window title. Nothing else.

## Running standalone

Requires Python 3.12 (python.org build, which includes Tkinter) and a webcam:

```powershell
cd file-system-app
python -m pip install -r requirements.txt
python file_explorer.py                 # gesture file explorer
python gesture_recorder.py              # recorder, pick a label in the window
python gesture_recorder.py --label swipe_left --reps 20 --duration 2 --autostart
python hand_tracker.py                  # bare camera/skeleton smoke test (q / Esc quits)
```

Recorder options: `--label`, `--reps` (default 10), `--duration` seconds per
clip (2.0), `--countdown` (3), `--rest` (1.5), `--dataset-dir`,
`--save-video` (also write each rep as `.mp4`), `--autostart` (start the
loop once the camera is ready; requires `--label`), `--version`.

Set `FILE_SYSTEM_DATA_DIR` to keep profiles and datasets somewhere other
than this folder.

## In Control Center

- **Opens like every other app:** clicking its card or tab, the
  "Open File System App" button, the agent's `open_app` (e.g. "Jarvis, open
  the file explorer"), `open_app "all"` and the Electron
  `file-system-app:open` IPC all launch the native explorer window
  directly. Closing through `close_app`, the `file-system-app:close` IPC,
  "close all apps" and Control Center shutdown stops it. The tab's content
  is the status panel (`panel/`), which has:
  - Launch/Stop for the explorer
  - recorder settings with Start/Stop
  - running status and the version
  - recorded-sample counts per label
- **API:**
  - `GET /api/apps/file-system-app/status`
  - `POST /api/apps/file-system-app/launch`
  - `POST /api/apps/file-system-app/recorder/launch` with
    `{label, reps, duration, saveVideo, autostart}`
  - `POST /api/apps/file-system-app/stop` with
    `{process: "explorer"|"recorder"|"all"}`
- **Agent:**
  - `open_app` / `close_app` with `target: "file-system-app"` launch/stop the
    explorer (close stops the recorder too).
  - `start_gesture_recorder {label, reps, autostart}` launches the recorder.
  - It is a regular member of `open_app "all"` and `close_app "all-apps"`.
    Opening everything therefore also turns the webcam on, which is
    deliberate, for parity with the other apps.
- **Process management** (`control-app/server/services/fileSystemService.js`):
  - Interpreter: `FILE_SYSTEM_PYTHON` if set, otherwise the first of
    `.venv` in this folder, the `py` launcher's Python, or `python` on PATH
    that has the required packages, checked before launch. Its `pythonw.exe`
    is used, so no console window appears. If none has them, the launch
    error names each interpreter tried and the `pip install` command.
  - Only one of the two programs runs at a time, since they share the camera.
  - A crash in the first ~2.5 s is reported as a launch failure, with the
    tail of the program's output.
  - Stop first closes the window gracefully (`taskkill /t`), so the app
    releases the camera. After 3 s it force-kills the process tree.
  - Control Center stops both on shutdown. It only ever signals processes it
    started itself.
- **Packaged build:**
  - `electron-builder` copies this folder to `resources/apps/file-system-app`,
    excluding `dataset/`, `gesture_profiles/` and bytecode.
  - The data dir becomes `%APPDATA%\Control Center\file-system-app`.
  - Python and its packages are **not** bundled; the machine needs them
    installed.

## Your data (gitignored)

`gesture_profiles/` (your existing calibration, copied from the original
folder) and `dataset/` are gitignored. They're personal biometric-ish
recordings and can grow large. They live only in the working copy where they
were created. **When this branch is merged into another checkout, copy
`gesture_profiles/` across by hand.** Without it, the explorer runs on its
built-in default thresholds until you recalibrate.

## Gesture dataset format

Written by `gesture_recorder.py` via `gesture_dataset.py` (schema version 1):

```
dataset/
  manifest.json
  <label>/
    <label>_<YYYYMMDD_HHMMSS_ffffff>.json   # one sample = one repetition
    <label>_<YYYYMMDD_HHMMSS_ffffff>.mp4    # only with --save-video
```

Labels are normalized to lowercase `[a-z0-9_-]` (spaces become `_`). `none`
is the reserved **background/negative** class. Record idle hands, random
non-gesture motion, hands entering or leaving the frame, and empty frames,
roughly as many as your largest gesture class.

**Sample file** (compact JSON):

| Field | Meaning |
|---|---|
| `schema_version` | `1` |
| `recorder_version` | e.g. `"0.1.0"` |
| `sample_id`, `label`, `is_background` | identity; `is_background` is `label == "none"` |
| `session_id`, `rep_index` | recorder session and 0-based rep number within it |
| `recorded_at` | ISO local time the clip started |
| `target_duration_sec`, `duration_sec` | configured clip length; actual first-to-last frame span |
| `num_frames`, `frames_with_hands`, `fps_estimate` | counts; `fps` ≈ 24 (tracker rate) |
| `frame_size` | `{width, height}` of the camera frame (640×360 requested) |
| `mirrored` | `true`: frames are horizontally flipped before inference (selfie view) |
| `video_file` | sidecar `.mp4` name or `null` |
| `frames[]` | ordered frames captured during the clip, each `{t, seq, hands[]}` |

- `t` is seconds since the clip started.
- `seq` is the tracker's frame counter. Gaps mean frames were skipped, but no
  frame appears twice.
- Each `hands[]` entry has these fields:
  - `label`: MediaPipe handedness on the *mirrored* image, so `"Left"` is
    normally the user's right hand.
  - `score`: handedness confidence.
  - `landmarks`: 21 × `[x, y, z]`. `x` and `y` are normalized to [0,1] of the
    frame (x right, y down). `z` is depth relative to the wrist, on the same
    scale as `x`.
  - `world_landmarks`: 21 × `[x, y, z]` in metres, centred on the hand.
    May be `null`.
- Landmark order is MediaPipe's: 0 wrist; 1–4 thumb; 5–8 index; 9–12 middle;
  13–16 ring; 17–20 pinky (tips at 4, 8, 12, 16, 20).
- A frame with no detected hands has `hands: []`. Those frames are kept,
  because they matter for timing and for the background class.

**`manifest.json`** is rebuilt by scanning the folder after every save or
discard (`gesture_dataset.rebuild_manifest(dir)` regenerates it after manual
edits). It contains:
- `schema_version`, `recorder_version`, `updated_at`, `background_label`,
  `total_samples`
- `labels` (`{label: count}`)
- `samples[]` with `sample_id`, `label`, `path` (relative, forward slashes),
  `video_file`, `num_frames`, `frames_with_hands`, `duration_sec`,
  `recorded_at`, `session_id`, `schema_version`

**Loading for training:** `gesture_dataset.load_sample_arrays(path)` returns
these numpy arrays:
- `landmarks` and `world`: shape `(T, 2, 21, 3)`, zero-filled where a hand is
  absent
- `mask`: shape `(T, 2)`, `True` where a hand is present
- `t`: shape `(T,)`
- `handedness`: a list of labels

Hands stay in MediaPipe's per-frame order, so assign stable left/right slots
yourself if the model needs them. Clips have variable length, so resample or
pad to a fixed `T`. There is no training script yet; this format is what one
should consume.

## Recorder controls

| Key | Action |
|---|---|
| Space | Start, pause, or resume. Resuming re-runs the countdown, and a clip interrupted by pause is dropped. |
| R | Redo: discard the last saved rep and immediately re-record it |
| D / Backspace | Discard the last saved rep (the loop records one extra to make up the count) |
| Esc | Quit (any partial clip is dropped; the manifest is rebuilt) |

The **Record background (none)** button switches the label to `none`.

## Known limits (v0.1)

- Gesture recognition is rule-based. The calibration profiles only nudge its
  thresholds.
- Windows-specific: DirectShow camera, drive letters, `os.startfile`, and the
  hidden/system attributes.
- The camera is index 0 or 1 via DirectShow. If neither delivers frames, the
  window still opens and shows "Camera unavailable".

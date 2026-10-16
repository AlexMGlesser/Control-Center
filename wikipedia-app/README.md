# wikipedia-app

Offline English Wikipedia inside Control Center. This is a port of the
**GLESSER ARCHIVE** librarian (`librarian.py`, from
`D:\Glesser-Industries-Database\Wikipedia\Offline-AI-Wikipedia`): a
stdlib-only Python 3 HTTP server with ranked full-text search, an article
reader, a librarian chat page (`/agent`), and an HTTP API (`/api/v1`, guide
at `/agents.txt`).

## Layout

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | Thin wrapper page served by Control Center at `/wikipedia-app/`. It asks Control Center to start the librarian, then embeds the librarian's own UI in an iframe. |
| `librarian/librarian.py` | The librarian server (see "Changes from the original" below). |
| `librarian/LICENSE-AND-ATTRIBUTION.txt` | Content license note from the original archive folder. |

**No data lives here.** The archive (`en/enwiki.sqlite`, `en/search_index.sqlite`
and the article files, tens of GB) is read in place, read-only, from
`WIKIPEDIA_DATA_DIR` (default `D:\Glesser-Industries-Database\Wikipedia\organized`).
`.gitignore` blocks `*.sqlite*` under this folder as a safety net.

## How Control Center uses it

- `control-app/server/services/wikipediaService.js` runs
  `python -B librarian/librarian.py --data-dir <parent of organized> --port 8766 --no-browser --model <OLLAMA_MODEL> --llm-url <OLLAMA_BASE_URL>`
  as a child process when the app is opened (card, tab, launch button, or
  `open_app`). If something already answers as GLESSER ARCHIVE on that port,
  it's reused. On shutdown, Control Center kills the server only if it spawned
  it.
- It's an app you use yourself: search and read in the window, or ask the
  librarian's own `/agent` chat page. Control Center's agent (Jarvis) can open
  and close it but has no wiki lookup tools of its own.
- Config (`control-app/.env`): `WIKIPEDIA_DATA_DIR`, `WIKIPEDIA_PYTHON`,
  `WIKIPEDIA_LIBRARIAN_PORT`, `WIKIPEDIA_LIBRARIAN_MODEL` (see `.env.example`).

Running it by hand still works exactly like the original:
`python librarian/librarian.py --no-browser` (port 8766).

## Changes from the original `librarian.py`

Only these; everything else is byte-for-byte the original (compare with the
first commit that added this file).

1. **Default port 8765 -> 8766** (`PORT`, and the URLs in the module
   docstring), so this copy and the original can run side by side.
2. **Databases opened immutable.** `ro_connect()` now opens
   `file:...?mode=ro&immutable=1` instead of `?mode=ro`. On a WAL-mode database
   a plain read-only connection still writes read-marks into the `-shm` file;
   `immutable=1` makes SQLite skip the `-wal`/`-shm` files and all locking, so
   nothing in the archive folder is written. This is only correct while the
   `-wal` file is empty (all writes checkpointed), so if a non-empty `-wal` is
   found it falls back to the original `?mode=ro` open and prints a warning.
3. A short note in the module docstring pointing to this README.

Not changed, but worth knowing:
- `--build-index` still writes `search_index.sqlite` into the data folder.
  Control Center never runs it.
- The `/agent` page's "start engine" button can spawn `ollama serve` (the
  original's behavior). Control Center normally already has Ollama running,
  and passes its own model via `--model` so the page doesn't load a second,
  larger model next to Control Center's.

## Known limits (inherited from the original)

- The archive is on a hard drive. A search whose index pages aren't in the
  OS cache can take 10 s to over a minute for common words; repeats are
  sub-second.
- Plain text drops all `{{templates}}`, so figures written with templates
  such as `{{convert|8848.86|m}}` vanish ("measured as ."), so some numbers
  (heights, distances) are missing from article text.
- The "View the live article on Wikipedia" link needs internet.

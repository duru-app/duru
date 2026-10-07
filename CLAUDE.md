# duru

## Where things are written

- `README.md` is for people who install and run duru: what it does, how to set it up, each config key, each
  command, and what each line it prints means for the map. It does not say how each source shape is judged,
  and it does not tell the history of a change.
- Which source shape gives which result is fixed by the tests under `test/`.
- Why a choice was made, and what it was compared with, goes in `docs/decisions.md`.
- `skills/duru/SKILL.md` is for an agent that runs duru: what to run and how to read what comes out.
- When README and the code disagree on how a shape is judged, take the rule out of README instead of adding
  the shape to it.

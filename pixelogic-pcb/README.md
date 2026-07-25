# Pixelogic PCB

A pure-pixel, PCB-styled logic simulator with direct mux support, packaged as
an installable PWA. Connectivity is by adjacency (no per-edge wiring); muxes,
crossovers, and voltage sources are inferred from pixel shape.

Live at <https://spencerschumann.github.io/pixelogic-pcb/>.

## This directory is generated — don't edit it here

The source of truth is
[`simulation/pixelogic_pcb`](https://github.com/spencerschumann/bitweaver_cpu/tree/main/simulation/pixelogic_pcb)
in the `bitweaver_cpu` repository, where the app's design notes (`PLAN.md`) and
tests live. Edit it there. A `Publish Pixelogic PCB` workflow in that
repository copies the app into this directory and commits it automatically on
every push to `main` that touches it, so anything changed here directly will be
overwritten on the next sync.

The synced files are:

    index.html  pixelogic-pcb.css  model.js  view.js  ui.js
    pwa.js  sw.js  manifest.webmanifest  icon-*.png

Nothing else from that directory is needed — the app is static HTML/CSS/vanilla
JS with no build step, and every path in it is relative, so it runs from this
subdirectory as-is.

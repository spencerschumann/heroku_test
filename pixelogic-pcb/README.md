# Pixelogic PCB

A pure-pixel, PCB-styled logic simulator with direct mux support, packaged as
an installable PWA. Connectivity is by adjacency (no per-edge wiring); muxes,
crossovers, and voltage sources are inferred from pixel shape.

Live at <https://spencerschumann.github.io/pixelogic-pcb/>.

## This is a published copy

The source of truth is
[`simulation/pixelogic_pcb`](https://github.com/spencerschumann/bitweaver_cpu/tree/main/simulation/pixelogic_pcb)
in the `bitweaver_cpu` repository, where the app's design notes (`PLAN.md`)
and tests live. Edit it there, then republish by copying these files across:

    index.html  pixelogic-pcb.css  model.js  view.js  ui.js
    pwa.js  sw.js  manifest.webmanifest  icon-*.png

Nothing else from that directory is needed — the app is static HTML/CSS/vanilla
JS with no build step, and every path in it is relative, so it runs from this
subdirectory as-is.

When republishing, bump `CACHE_VERSION` in `sw.js` if you want installed copies
to purge their old cached assets. The worker is network-first, so an online
visit already picks up new code without it.

(function (window) {
    const M = window.PixelogicModel;

    const canvas = document.getElementById('grid');
    const ctx = canvas.getContext('2d');

    // ===== PCB palette =====
    const COLOR_INSULATOR = '#065300';
    const COLOR_CONDUCTOR = '#0a9000';   // single conductor color; charge shown by the grey box
    const COLOR_GRAY_BODY = '#2b1b0b';
    const COLOR_GOLD = '#e6b800';
    const COLOR_INVALID = '#ff3b3b';
    // Explicit sources: +V white with a black border/glyph, -V black with a
    // white border/glyph (each bordered in the opposite color so it reads on
    // any background).
    const COLOR_POS_BG = '#ffffff', COLOR_POS_FG = '#000000';
    const COLOR_NEG_BG = '#000000', COLOR_NEG_FG = '#ffffff';
    // Output LED: red, dark when off, bright (with a glow) when on.
    const COLOR_LED_OFF = '#4a0d0d', COLOR_LED_ON = '#ff2a2a';
    // Momentary switch: light "solder" gray; brighter when pressed.
    const COLOR_SWITCH = '#9aa0a6', COLOR_SWITCH_PRESSED = '#e8ebee';
    // Latching toggle: same solder family, drawn as a round pad — dark when
    // off, bright when latched on.
    const COLOR_TOGGLE_OFF = '#565b60', COLOR_TOGGLE_ON = '#e8ebee';
    // Isolated-source circle rings: a green darker than the substrate itself
    // for the gold (+) circle (reads as a groove cut into the board, rather
    // than blending into or brightening the background), a dimmer silver gray
    // for the black (-) circle.
    const COLOR_ISOLATED_POS_RING = '#032900', COLOR_ISOLATED_NEG_RING = '#6e747a';
    // Charge is shown uniformly across conductors, mux pixels and crossovers
    // as a faint (25% opacity) light-grey box: full-size for ON, slightly
    // smaller for FALLING, nothing for OFF.
    const COLOR_CHARGE = 'rgba(216, 216, 216, 0.25)';

    var zoom = 1;
    var panX = 0, panY = 0;
    // Whether the faint cell-grid overlay is drawn; ui.js drives this
    // per-mode (build vs. interact remember separate on/off preferences).
    var gridVisible = true;

    // Overlay rectangle drawn on top of the cells by drawGrid: the active
    // selection (also used to highlight a floating paste). {x0,y0,x1,y1} in
    // grid coords, or null.
    var selectionRect = null;

    // Non-rectangular overlay for the Rearrange tool: the grabbed/selected
    // object's cells ([[x,y],...] or null). Drawn in a different hue from
    // the selection rectangle so "an object is grabbed" doesn't read as "a
    // region is selected".
    var objectHighlight = null;

    function cellSize() { return M.CELL_SIZE * zoom; }

    function resizeCanvas() {
        const viewport = document.getElementById('viewport');
        canvas.width = viewport.clientWidth;
        canvas.height = viewport.clientHeight;
    }

    function screenToCell(sx, sy) {
        const cs = cellSize();
        return {
            x: Math.floor((sx - panX) / cs),
            y: Math.floor((sy - panY) / cs),
        };
    }

    // Charge on a wire cell, collapsed to a single value for the normal
    // (non-crossover) rendering. A crossover holds two; each axis is drawn on
    // its own (see drawCell).
    function wireCharge(id) {
        if (M.isXover(id)) return M.xoverV(id) === M.ON || M.xoverH(id) === M.ON ? M.ON
            : M.xoverV(id) === M.FALLING || M.xoverH(id) === M.FALLING ? M.FALLING : M.OFF;
        return M.conductorCharge(id);
    }

    // ===== Thin-wire rendering =====
    //
    // Rather than filling the whole cell, a conductor draws a hub at the
    // cell's center plus a bar reaching toward each side that's actually
    // connected to another wire/component (M.cellConnects) — so it reads as
    // a dot (0 neighbors), a dead-end stub (1), a straight line (2 opposite),
    // an elbow (2 adjacent, chamfered — see addElbowShape), a tee (3), or a
    // plus (4), all from the same hub-plus-arms shape with no case-by-case
    // special drawing needed beyond the elbow's chamfer.
    //
    // Every wire cell's geometry (and the charge overlay's) is accumulated
    // into one shared Path2D per layer and filled ONCE at the end of
    // drawGrid, rather than each cell calling fillRect independently: two
    // adjacent fillRect calls of the same color, even when their edges are
    // meant to touch exactly, can leave a faint antialiased seam wherever
    // floating-point cell math doesn't land the shared edge on a whole pixel.
    // A single fill() over the union of all rects in one path has no such
    // internal seams — only the outer silhouette against the substrate is
    // antialiased.
    //
    // A crossover is the one shape still drawn specially (addCrossoverWire):
    // it's a self-contained "pipe fitting" over/under within its own cell —
    // the vertical run breaks well clear of the horizontal one, a deliberately
    // large gap (not just clearing the horizontal bar's own width) so the
    // break reads clearly rather than blending into the wire's normal
    // thickness. Neighbors don't need to know or care it's there — they just
    // see a normally-connected cell and draw their own arm toward it.
    const WIRE_THICKNESS = 0.44;
    // The charge highlight reuses the exact same hub-plus-arms shape, only
    // smaller, so it reads as the wire's own core lighting up rather than a
    // shape unrelated to the (now much thinner) wire body. This shape math is
    // also what a future flowing-charge animation would move fluid along.
    const CHARGE_THICKNESS_ON = WIRE_THICKNESS * 0.55, CHARGE_THICKNESS_FALLING = WIRE_THICKNESS * 0.38;
    // How far a chamfer cuts into an elbow's outer corner, relative to the
    // wire's own half-thickness — a bit of the 45°-routing PCB look.
    const ELBOW_CHAMFER_RATIO = 1.4;
    // The crossover's vertical break, as a fraction of the cell — deliberately
    // large (matching the old two-cell gap-cutting look) so it reads as an
    // obvious interruption rather than just "as wide as the wire."
    const CROSSOVER_GAP_FRAC = 0.8;

    function wireArms(x, y) {
        return {
            n: M.cellConnects(x, y - 1),
            e: M.cellConnects(x + 1, y),
            s: M.cellConnects(x, y + 1),
            w: M.cellConnects(x - 1, y),
        };
    }

    // Exactly two ADJACENT (perpendicular) arms — a bend, as opposed to a
    // straight run (2 opposite) or a tee/plus (3/4).
    function isElbow(arms) {
        const count = (arms.n ? 1 : 0) + (arms.e ? 1 : 0) + (arms.s ? 1 : 0) + (arms.w ? 1 : 0);
        return count === 2 && !(arms.n && arms.s) && !(arms.e && arms.w);
    }

    // An elbow's outer corner — the one nearest the two arms that are
    // *missing* — cut at 45°, instead of the sharp right angle a plain
    // hub+arms union would give. Each of the 4 orientations is a 90° rotation
    // of the same 7-point outline: two arm tips, the two corners where each
    // arm's outer edge meets the hub, and the chamfer's two cut points
    // replacing what would otherwise be the hub's one sharp outer corner.
    function addElbowShape(path, px, py, cs, half, chamfer, arms) {
        const cx = px + cs / 2, cy = py + cs / 2;
        let pts;
        if (arms.n && arms.e) {
            pts = [
                [cx - half, py], [cx + half, py], [cx + half, cy - half],
                [px + cs, cy - half], [px + cs, cy + half],
                [cx - half + chamfer, cy + half], [cx - half, cy + half - chamfer],
            ];
        } else if (arms.e && arms.s) {
            pts = [
                [px + cs, cy - half], [px + cs, cy + half], [cx + half, cy + half],
                [cx + half, py + cs], [cx - half, py + cs],
                [cx - half, cy - half + chamfer], [cx - half + chamfer, cy - half],
            ];
        } else if (arms.s && arms.w) {
            pts = [
                [cx + half, py + cs], [cx - half, py + cs], [cx - half, cy + half],
                [px, cy + half], [px, cy - half],
                [cx + half - chamfer, cy - half], [cx + half, cy - half + chamfer],
            ];
        } else { // arms.w && arms.n
            pts = [
                [px, cy + half], [px, cy - half], [cx - half, cy - half],
                [cx - half, py], [cx + half, py],
                [cx + half, cy + half - chamfer], [cx + half - chamfer, cy + half],
            ];
        }
        path.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
        path.closePath();
    }

    // Adds a hub-plus-arms wire shape to a shared path: a square hub at the
    // cell's center plus a rectangle extended to each active arm's edge (all
    // one thickness, seaming together with no gap or overlap at the hub) — or,
    // for an elbow specifically, the chamfered polygon above.
    function addWireShape(path, px, py, cs, arms, thicknessFrac) {
        const t = cs * thicknessFrac, half = t / 2;
        if (isElbow(arms)) {
            addElbowShape(path, px, py, cs, half, half * ELBOW_CHAMFER_RATIO, arms);
            return;
        }
        const cx = px + cs / 2, cy = py + cs / 2;
        path.rect(cx - half, cy - half, t, t);
        if (arms.n) path.rect(cx - half, py, t, cy - half - py);
        if (arms.s) path.rect(cx - half, cy + half, t, py + cs - (cy + half));
        if (arms.e) path.rect(cx + half, cy - half, px + cs - (cx + half), t);
        if (arms.w) path.rect(px, cy - half, cx - half - px, t);
    }

    function addChargeShape(path, px, py, cs, arms, charge) {
        if (charge !== M.ON && charge !== M.FALLING) return;
        addWireShape(path, px, py, cs, arms, charge === M.ON ? CHARGE_THICKNESS_ON : CHARGE_THICKNESS_FALLING);
    }

    // Crossover: the horizontal run is solid across the full cell width; the
    // vertical run breaks well clear of it on both sides (CROSSOVER_GAP_FRAC,
    // not just the horizontal bar's own width) so it visually passes under —
    // the standard schematic crossing convention, self-contained in one cell.
    function addCrossoverWire(path, px, py, cs) {
        const t = cs * WIRE_THICKNESS, half = t / 2, gap = cs * CROSSOVER_GAP_FRAC / 2;
        const cx = px + cs / 2, cy = py + cs / 2;
        path.rect(cx - half, py, t, (cy - gap) - py);
        path.rect(cx - half, cy + gap, t, (py + cs) - (cy + gap));
        path.rect(px, cy - half, cs, t);
    }

    function chargeThicknessFrac(charge) {
        if (charge === M.ON) return CHARGE_THICKNESS_ON;
        if (charge === M.FALLING) return CHARGE_THICKNESS_FALLING;
        return 0;
    }

    // Same split-bar shape as addCrossoverWire, but for the charge overlay —
    // each axis highlighted independently, since a crossover keeps two.
    function addCrossoverCharge(path, px, py, cs, vCharge, hCharge) {
        const cx = px + cs / 2, cy = py + cs / 2, gap = cs * CROSSOVER_GAP_FRAC / 2;
        const vf = chargeThicknessFrac(vCharge);
        if (vf) {
            const t = cs * vf, half = t / 2;
            path.rect(cx - half, py, t, (cy - gap) - py);
            path.rect(cx - half, cy + gap, t, (py + cs) - (cy + gap));
        }
        const hf = chargeThicknessFrac(hCharge);
        if (hf) {
            const t = cs * hf, half = t / 2;
            path.rect(px, cy - half, cs, t);
        }
    }

    // `layers` bundles every shared Path2D (plus the mux-indicator list/set)
    // accumulated across the current drawGrid pass, all filled once after
    // the per-cell loop rather than per-cell — see the comment above
    // addWireShape for why (per-cell fillRect calls leave antialiased
    // seams). The same reasoning applies to the mux control band's gray/gold
    // fills and to LED cells, which is why those route into shared paths
    // here too instead of calling ctx.fillRect directly.
    function drawCell(x, y, layers) {
        const cs = cellSize();
        const px = panX + x * cs, py = panY + y * cs;
        if (px + cs < 0 || py + cs < 0 || px > canvas.width || py > canvas.height) return;

        const id = M.getCell(x, y);

        if (M.isInsulatorId(id)) return; // substrate is already the base fill (see drawGrid)

        if (M.isConductorId(id) || M.isXover(id)) {
            // The wire no longer fills the cell; the substrate base fill (see
            // drawGrid) already shows through the gaps around it.
            if (M.isCrossoverAt(x, y)) {
                addCrossoverWire(layers.wirePath, px, py, cs);
                const vCharge = M.isXover(id) ? M.xoverV(id) : M.conductorCharge(id);
                const hCharge = M.isXover(id) ? M.xoverH(id) : M.conductorCharge(id);
                addCrossoverCharge(layers.chargePath, px, py, cs, vCharge, hCharge);
            } else {
                const arms = wireArms(x, y);
                addWireShape(layers.wirePath, px, py, cs, arms, WIRE_THICKNESS);
                addChargeShape(layers.chargePath, px, py, cs, arms, wireCharge(id));
            }
            return;
        }

        if (id === M.ID_POS || id === M.ID_NEG) {
            const role = M.roles[M.idx(x, y)];
            if (role && (role.kind === 'endSource' || role.kind === 'comSource')) {
                drawMuxSourceCell(x, y, px, py, cs, role, layers);
            } else {
                drawSource(px, py, cs, id === M.ID_POS);
            }
            return;
        }

        if (M.isLed(id)) {
            addLedShape(M.ledIsOn(id) ? layers.ledOnPath : layers.ledOffPath, x, y, px, py, cs);
            return;
        }
        if (M.isSwitch(id)) { drawSwitch(px, py, cs, M.switchIsPressed(id)); return; }
        if (M.isToggle(id)) { drawToggle(px, py, cs, M.toggleIsOn(id)); return; }

        if (M.isGoldId(id) || M.isGrayId(id)) {
            drawMuxPixel(x, y, id, px, py, cs, layers);
            return;
        }
    }

    // Explicit source: +V is white with a black +, -V is black with a white -,
    // each ringed in the opposite color so it stands out on any background.
    function drawSource(px, py, cs, positive) {
        const bg = positive ? COLOR_POS_BG : COLOR_NEG_BG;
        const fg = positive ? COLOR_POS_FG : COLOR_NEG_FG;
        ctx.fillStyle = bg;
        ctx.fillRect(px, py, cs, cs);
        const border = Math.max(1, cs * 0.1);
        ctx.strokeStyle = fg;
        ctx.lineWidth = border;
        ctx.strokeRect(px + border / 2, py + border / 2, cs - border, cs - border);
        ctx.lineWidth = Math.max(2, cs * 0.15);
        ctx.lineCap = 'round';
        const cx = px + cs / 2, cy = py + cs / 2, r = cs * 0.28;
        ctx.beginPath();
        ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
        if (positive) { ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); }
        ctx.stroke();
    }

    // A rect with 0-4 of its corners chamfered — used to bevel only an LED
    // blob's outer (silhouette) corners, so a lone LED reads as a rounded
    // chip and a cluster reads as one pad with just its outer edge cut,
    // rather than every cell looking identically notched.
    function addChamferedRect(path, px, py, cs, cut, bevel) {
        const x0 = px, y0 = py, x1 = px + cs, y1 = py + cs;
        const pts = [];
        if (cut.nw) { pts.push([x0, y0 + bevel]); pts.push([x0 + bevel, y0]); } else pts.push([x0, y0]);
        if (cut.ne) { pts.push([x1 - bevel, y0]); pts.push([x1, y0 + bevel]); } else pts.push([x1, y0]);
        if (cut.se) { pts.push([x1, y1 - bevel]); pts.push([x1 - bevel, y1]); } else pts.push([x1, y1]);
        if (cut.sw) { pts.push([x0 + bevel, y1]); pts.push([x0, y1 - bevel]); } else pts.push([x0, y1]);
        path.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
        path.closePath();
    }

    function isLedAt(x, y) { return M.inBounds(x, y) && M.isLed(M.getCell(x, y)); }

    // Output LED: a red cell, dark when off, bright when on — added to a
    // shared per-color path (see drawCell) rather than filled immediately,
    // both to avoid the antialiased-seam issue addWireShape's own batching
    // avoids, and to let a corner's bevel decision look past this one cell.
    // A corner is chamfered only when NEITHER of its two orthogonal
    // neighbors is also an LED — i.e. only true outer/convex corners of the
    // blob, never a concave inner corner of an L-shaped cluster or an edge
    // shared with a same-blob neighbor.
    const LED_BEVEL_FRAC = 0.3;
    function addLedShape(path, x, y, px, py, cs) {
        const cut = {
            nw: !isLedAt(x - 1, y) && !isLedAt(x, y - 1),
            ne: !isLedAt(x + 1, y) && !isLedAt(x, y - 1),
            se: !isLedAt(x + 1, y) && !isLedAt(x, y + 1),
            sw: !isLedAt(x - 1, y) && !isLedAt(x, y + 1),
        };
        if (!cut.nw && !cut.ne && !cut.se && !cut.sw) { path.rect(px, py, cs, cs); return; }
        addChamferedRect(path, px, py, cs, cut, cs * LED_BEVEL_FRAC);
    }

    // Momentary switch: a round solder pad, dark when released, bright while
    // held.
    function drawSwitch(px, py, cs, pressed) {
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fillRect(px, py, cs, cs);
        const cx = px + cs / 2, cy = py + cs / 2;
        ctx.fillStyle = pressed ? COLOR_SWITCH_PRESSED : COLOR_SWITCH;
        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.34, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = Math.max(1, cs * 0.06);
        ctx.stroke();
    }

    // Latching toggle: a square solder pad, dark when off, bright/inset when
    // latched on.
    function drawToggle(px, py, cs, on) {
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fillRect(px, py, cs, cs);
        const m = on ? cs * 0.12 : cs * 0.06;
        ctx.fillStyle = on ? COLOR_TOGGLE_ON : COLOR_TOGGLE_OFF;
        ctx.fillRect(px + m, py + m, cs - 2 * m, cs - 2 * m);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = Math.max(1, cs * 0.05);
        ctx.strokeRect(px + m, py + m, cs - 2 * m, cs - 2 * m);
    }

    // The source glyph itself — a filled circle, gold ringed in dark green
    // for +, black ringed in dimmer silver gray for - — shared by every
    // "this cell/pin is a constant source" rendering (isolated gold/gray
    // pixels, and a mux corner's own +V/-V pin, below).
    function drawSourceCircleGlyph(cx, cy, cs, positive) {
        ctx.fillStyle = positive ? COLOR_GOLD : '#000000';
        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.36, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = positive ? COLOR_ISOLATED_POS_RING : COLOR_ISOLATED_NEG_RING;
        ctx.lineWidth = Math.max(1, cs * 0.08);
        ctx.stroke();
    }

    // Bridges the gap between a wire body (which stops at this cell's edge,
    // same as any other neighbor) and a source glyph's circle: a stub in one
    // direction reaching to the cell's center, which the opaque circle drawn
    // after naturally clips flush with its own edge. The charge highlight
    // rides along at the source's own constant drive state so it, too, reads
    // as continuing onto the circle rather than stopping short of it.
    function addSourceArmStub(px, py, cs, cx, cy, dx, dy, positive) {
        const t = cs * WIRE_THICKNESS, half = t / 2;
        ctx.fillStyle = COLOR_CONDUCTOR;
        if (dy === -1) ctx.fillRect(cx - half, py, t, cy - py);
        else if (dy === 1) ctx.fillRect(cx - half, cy, t, py + cs - cy);
        else if (dx === 1) ctx.fillRect(cx, cy - half, px + cs - cx, t);
        else ctx.fillRect(px, cy - half, cx - px, t);
        const chargeFrac = positive ? CHARGE_THICKNESS_ON : CHARGE_THICKNESS_FALLING;
        const ct = cs * chargeFrac, chalf = ct / 2;
        ctx.fillStyle = COLOR_CHARGE;
        if (dy === -1) ctx.fillRect(cx - chalf, py, ct, cy - py);
        else if (dy === 1) ctx.fillRect(cx - chalf, cy, ct, py + cs - cy);
        else if (dx === 1) ctx.fillRect(cx, cy - chalf, px + cs - cx, ct);
        else ctx.fillRect(px, cy - chalf, cx - px, ct);
    }

    // Isolated gold/gray (a lone-blob mux-colored pixel touching no body/
    // control of the opposite color) acts as a +V/-V source. A genuinely
    // single pixel is drawn as the source circle glyph so it reads as a
    // source. A multi-pixel clump reads as a "pad" instead: the circle
    // glyph doesn't tile, so it switches immediately to a plain colored
    // square.
    function drawIsolatedMuxSource(x, y, px, py, cs, positive) {
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fillRect(px, py, cs, cs);
        const cx = px + cs / 2, cy = py + cs / 2;
        const arms = wireArms(x, y);
        if (arms.n) addSourceArmStub(px, py, cs, cx, cy, 0, -1, positive);
        if (arms.s) addSourceArmStub(px, py, cs, cx, cy, 0, 1, positive);
        if (arms.e) addSourceArmStub(px, py, cs, cx, cy, 1, 0, positive);
        if (arms.w) addSourceArmStub(px, py, cs, cx, cy, -1, 0, positive);
        drawSourceCircleGlyph(cx, cy, cs, positive);
    }

    // A mux body cell standing in for a +V/-V source — a NO/NC pin
    // ('endSource') or COM itself ('comSource') — is drawn as the mux cell
    // first (into the shared gray body path, same as any other body cell,
    // so it seams cleanly with the rest of the macro), then the source
    // glyph overlaid directly on top of it, rather than replacing it with
    // the isolated-source's own substrate background. Only the cell's own
    // outward side (the one direction that can plausibly carry a real
    // external connection: away from COM for a pin, COM's own exit for
    // COM — every other neighbor is just another part of the same mux)
    // gets a bridging arm stub, if something is actually wired there.
    //
    // The glyph circle sits slightly off-center, shifted along `toward`
    // (away from the gold band) so the cell reads balanced under the
    // control band rather than crowding it. The stub stays on the
    // grid-center line — the external wire must run straight, kink-free —
    // and the circle (radius 0.36cs >> the 0.1cs offset) still fully
    // covers the stub's inner end, so the joint stays hidden beneath it.
    //
    // The glyph itself is queued rather than drawn immediately: the shared
    // muxBodyPath this cell's own rect went into is only filled after the
    // whole per-cell loop (see drawGrid), so drawing the glyph immediately
    // would just get painted over a moment later by that later fill.
    const MUX_SOURCE_GLYPH_OFFSET = 0.1;
    function drawMuxSourceCell(x, y, px, py, cs, role, layers) {
        layers.muxBodyPath.rect(px, py, cs, cs);
        const macro = role.macro, along = macro.along;
        const outward = role.kind === 'comSource' ? macro.toward
            : role.isFirst ? [-along[0], -along[1]] : along;
        layers.muxSourceGlyphs.push({
            px, py,
            toward: macro.toward,
            positive: role.positive,
            wired: isExternalWireAt(x + outward[0], y + outward[1]),
            outward,
        });
        // A macro's indicator is otherwise only queued from a plain 'end'
        // cell; a macro with both ends sourced has none — queueing is
        // deduped per macro (queuedMacroKeys) so it's harmless either way.
        queueMuxIndicator(macro, layers.muxIndicators, layers.queuedMacroKeys);
    }

    function drawMuxSourceGlyph(g, cs) {
        const cx = g.px + cs / 2, cy = g.py + cs / 2;
        if (g.wired) addSourceArmStub(g.px, g.py, cs, cx, cy, g.outward[0], g.outward[1], g.positive);
        drawSourceCircleGlyph(cx + g.toward[0] * MUX_SOURCE_GLYPH_OFFSET * cs,
            cy + g.toward[1] * MUX_SOURCE_GLYPH_OFFSET * cs, cs, g.positive);
    }

    // A red "!" on one representative cell (the blob's own cell nearest its
    // bounding-box center — role.isCenter, set by markBlob in model.js) marks
    // an invalid gold/gray fragment, instead of decorating every cell in the
    // clump identically.
    function drawInvalidMark(px, py, cs) {
        const cx = px + cs / 2, cy = py + cs / 2;
        ctx.fillStyle = COLOR_INVALID;
        ctx.font = `bold ${Math.round(cs * 0.72)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', cx, cy + cs * 0.04);
    }

    // A mux's control (gold) band always thins toward the body side, so the
    // body's gray bleeds into the near edge of each control cell instead of
    // gold filling the whole cell. Returns the gold sub-rectangle's bounds.
    const CONTROL_THIN_FRAC = 0.55;
    function controlBounds(px, py, cs, toward) {
        const thin = cs * CONTROL_THIN_FRAC;
        let gx0 = px, gy0 = py, gx1 = px + cs, gy1 = py + cs;
        if (toward[0] === 1) gx1 = px + thin;             // body right -> gold on the left
        else if (toward[0] === -1) gx0 = px + cs - thin;  // body left -> gold on the right
        else if (toward[1] === 1) gy1 = py + thin;        // body below -> gold on top
        else gy0 = py + cs - thin;                         // body above -> gold on bottom
        return [gx0, gy0, gx1, gy1];
    }

    // The single outer corner to chamfer for the non-live end: the corner
    // simultaneously furthest in the outAlong direction (the band's outward
    // tip) and the outToward direction (away from the body) — the one corner
    // that thinning above never insets, since thinning only touches the
    // toward (body-facing) edge. Only one corner is cut (not both ends of the
    // tip edge), for a single, not symmetric, bevel.
    function bevelCornerPoint(px, py, cs, outAlong, outToward) {
        const dx = outAlong[0] || outToward[0], dy = outAlong[1] || outToward[1];
        return [dx === 1 ? px + cs : px, dy === 1 ? py + cs : py];
    }

    // Adds a (thinned) gold rectangle to the shared gold path, optionally
    // chamfering one corner — the control band's non-live end's outward tip
    // — to cap it off. The notch is added to the shared notch path as
    // substrate (green), not the body-gray that's elsewhere under the band,
    // since it reads as "nothing here" rather than "the body shows through
    // here" (that's what the thinning above is for). Both are accumulated
    // rather than filled immediately (see drawCell/drawGrid) so adjacent
    // control cells of the same macro don't leave an antialiased seam
    // between their separately-thinned rects.
    function addGoldShape(goldPath, notchPath, gx0, gy0, gx1, gy1, bevelCorner, bevel) {
        if (!bevelCorner) {
            goldPath.rect(gx0, gy0, gx1 - gx0, gy1 - gy0);
            return;
        }
        const [cx, cy] = bevelCorner;
        const dx = cx === gx0 ? bevel : -bevel, dy = cy === gy0 ? bevel : -bevel;
        notchPath.moveTo(cx, cy); notchPath.lineTo(cx, cy + dy); notchPath.lineTo(cx + dx, cy);
        notchPath.closePath();

        // Walk the rectangle clockwise (TL, TR, BR, BL), replacing the
        // matched corner with its two chamfer points. Which of the two comes
        // first depends on which edge is incoming at that corner (vertical
        // at TL/BR, horizontal at TR/BL) — a fixed order for both would
        // self-intersect at two of the four corners (the bug this replaced).
        if (cx === gx0 && cy === gy0) { // TL
            goldPath.moveTo(cx, cy + dy); goldPath.lineTo(cx + dx, cy);
            goldPath.lineTo(gx1, gy0); goldPath.lineTo(gx1, gy1); goldPath.lineTo(gx0, gy1);
        } else if (cx === gx1 && cy === gy0) { // TR
            goldPath.moveTo(gx0, gy0); goldPath.lineTo(cx + dx, cy); goldPath.lineTo(cx, cy + dy);
            goldPath.lineTo(gx1, gy1); goldPath.lineTo(gx0, gy1);
        } else if (cx === gx1 && cy === gy1) { // BR
            goldPath.moveTo(gx0, gy0); goldPath.lineTo(gx1, gy0);
            goldPath.lineTo(cx, cy + dy); goldPath.lineTo(cx + dx, cy); goldPath.lineTo(gx0, gy1);
        } else { // BL
            goldPath.moveTo(gx0, gy0); goldPath.lineTo(gx1, gy0); goldPath.lineTo(gx1, gy1);
            goldPath.lineTo(cx + dx, cy); goldPath.lineTo(cx, cy + dy);
        }
        goldPath.closePath();
    }

    // Whether the given corner currently has anything wired to either of its
    // two external directions — mirrors the model's own isWired check (used
    // internally to pick the live/NO side) so the bevel always marks the same
    // end the simulation treats as inactive.
    function cornerIsWired(x, y, role) {
        return role.cornerExternalDirs.some(([dx, dy]) => {
            const nx = x + dx, ny = y + dy;
            return M.inBounds(nx, ny) && !M.isInsulatorId(M.getCell(nx, ny));
        });
    }

    function macroLiveIsFirst(macro) {
        const firstRole = M.roles[M.idx(macro.firstCorner[0], macro.firstCorner[1])];
        const lastRole = M.roles[M.idx(macro.lastCorner[0], macro.lastCorner[1])];
        const firstWired = cornerIsWired(macro.firstCorner[0], macro.firstCorner[1], firstRole);
        const lastWired = cornerIsWired(macro.lastCorner[0], macro.lastCorner[1], lastRole);
        return !(!firstWired && lastWired);
    }

    // Which end is actually conducting right now — as opposed to
    // macroLiveIsFirst, which is only which end has a wire attached (a fixed
    // structural property the corner bevel uses, since it shouldn't flicker
    // with the control signal). The mux is a relay: the wired/live corner's
    // OWN charge (controlOn) toggles which end is active, exactly mirroring
    // the model's own getMacroControl/getMacroBody.
    function macroActiveIsFirst(macro) {
        const liveIsFirst = macroLiveIsFirst(macro);
        const liveCorner = liveIsFirst ? macro.firstCorner : macro.lastCorner;
        const liveId = M.getCell(liveCorner[0], liveCorner[1]);
        const controlOn = M.isGoldId(liveId) && M.goldCharge(liveId) === M.ON;
        return controlOn ? liveIsFirst : !liveIsFirst;
    }

    const CORNER_BEVEL_FRAC = 0.3;
    // A control-row cell (corner or midSpacer) of a valid mux: thinning
    // always applies; a corner additionally gets its outward tip beveled
    // when it isn't the live/wired end (cornerRole is null for a midSpacer,
    // which has no tip to bevel). No charge indication here for now — square
    // read wrong against the thinned/beveled shape and nothing's replaced it
    // yet. Both the gray base and the gold overlay accumulate into shared
    // paths (layers.muxBodyPath/muxGoldPath/muxNotchPath) rather than
    // filling immediately, so adjacent control cells of the same macro don't
    // leave an antialiased seam between their separately-thinned rects.
    function drawMuxControlCell(px, py, cs, macro, cornerRole, layers) {
        layers.muxBodyPath.rect(px, py, cs, cs);
        const [gx0, gy0, gx1, gy1] = controlBounds(px, py, cs, macro.toward);
        let bevelCorner = null;
        if (cornerRole) {
            const isLive = cornerRole.isFirst === macroLiveIsFirst(macro);
            if (!isLive) bevelCorner = bevelCornerPoint(px, py, cs, cornerRole.cornerExternalDirs[0], cornerRole.cornerExternalDirs[1]);
        }
        addGoldShape(layers.muxGoldPath, layers.muxNotchPath, gx0, gy0, gx1, gy1, bevelCorner, cs * CORNER_BEVEL_FRAC);
    }

    // True only for a genuine external wire/terminal connection, never
    // another cell of any mux macro — plain M.cellConnects alone can't tell
    // the two apart, since it also returns true for a mux's own corner/end/
    // comMiddle cells (which is exactly the case one axis over: the COM
    // cell's own next depth row, or two adjacent muxes tiled flush against
    // each other).
    function isExternalWireAt(x, y) {
        if (!M.cellConnects(x, y)) return false;
        const id = M.getCell(x, y);
        return !M.isGoldId(id) && !M.isGrayId(id);
    }

    // A body cell's own charge as ON/FALLING/OFF, whether it's plain gray
    // or a +V/-V source standing in for the pin/COM (see the model's
    // endSource/comSource roles) — grayCharge's bit math would misread a
    // +V/-V id.
    function bodyCellCharge(x, y) {
        const id = M.getCell(x, y);
        if (M.isGrayId(id)) return M.grayCharge(id);
        if (id === M.ID_POS) return M.ON;
        if (id === M.ID_NEG) return M.FALLING;
        return M.OFF;
    }

    // The macro's active NO/NC-to-COM connection gets one indicator: a
    // badge over the active end + COM cells, plus a flow line when the path
    // is actually carrying charge. Queued once per macro — queuedMacroKeys
    // dedupes the repeat visits from the macro's other cells — and drawn
    // once after the whole grid pass in drawGrid, since it reaches into a
    // neighboring cell that may not have been drawn yet in raster order.
    function queueMuxIndicator(macro, muxIndicators, queuedMacroKeys) {
        if (queuedMacroKeys.has(macro.key)) return;
        queuedMacroKeys.add(macro.key);

        const activeIsFirst = macroActiveIsFirst(macro);
        const along = macro.along, toward = macro.toward;
        // Outward: away from COM along the band axis — the one direction
        // guaranteed to be outside the macro's own footprint, so it safely
        // identifies an actual external pin wire rather than another part
        // of the same mux.
        const outward = activeIsFirst ? [-along[0], -along[1]] : along;
        const ex = macro.rowStart[0] + toward[0] + (activeIsFirst ? 0 : along[0] * 2);
        const ey = macro.rowStart[1] + toward[1] + (activeIsFirst ? 0 : along[1] * 2);
        const comX = macro.rowStart[0] + along[0] + toward[0];
        const comY = macro.rowStart[1] + along[1] + toward[1];

        // The flow line draws only for a genuinely ON path. OFF shows
        // nothing, and FALLING shows nothing either — a dimmer wire for a
        // signal that isn't carrying charge (e.g. the constant state of a
        // -V source) read as a phantom signal rather than "off".
        const on = bodyCellCharge(ex, ey) === M.ON || bodyCellCharge(comX, comY) === M.ON;

        // The flush extension out to an attached wire only happens from a
        // plain gray pin/COM. A sourced cell's opaque glyph (and its own
        // arm stub) covers its side of the connection — running the flow
        // line under it too would double-composite the translucent charge.
        const pinFlush = M.isGrayId(M.getCell(ex, ey)) && isExternalWireAt(ex + outward[0], ey + outward[1]);
        const comFlush = M.isGrayId(M.getCell(comX, comY)) && isExternalWireAt(comX + toward[0], comY + toward[1]);

        muxIndicators.push({ ex, ey, comX, comY, toward, outward, on, pinFlush, comFlush });
    }

    function drawMuxPixel(x, y, id, px, py, cs, layers) {
        const role = M.roles[M.idx(x, y)];
        const isGold = M.isGoldId(id);
        const basePath = isGold ? layers.muxGoldPath : layers.muxBodyPath;

        if (role && (role.kind === 'isolatedGold' || role.kind === 'isolatedGray')) {
            if (role.size === 1) {
                drawIsolatedMuxSource(x, y, px, py, cs, role.kind === 'isolatedGold');
            } else {
                basePath.rect(px, py, cs, cs);
            }
            return;
        }

        if (!role || role.kind === 'invalidGold' || role.kind === 'invalidGray') {
            basePath.rect(px, py, cs, cs);
            if (role && role.isCenter) drawInvalidMark(px, py, cs);
            return;
        }

        if (role.kind === 'corner') { drawMuxControlCell(px, py, cs, role.macro, role, layers); return; }
        if (role.kind === 'midSpacer') { drawMuxControlCell(px, py, cs, role.macro, null, layers); return; }

        // Body (end / comMiddle): plain color (always gray — a valid body
        // cell is never gold), no per-cell charge square — see
        // queueMuxIndicator for the body's own charge indication.
        layers.muxBodyPath.rect(px, py, cs, cs);
        if (role.kind === 'end') queueMuxIndicator(role.macro, layers.muxIndicators, layers.queuedMacroKeys);
    }

    // A rounded-rect "badge" over the active end + COM cells — a
    // de-emphasized background hint (a faint rgba wash, close to the body's
    // own color) rather than a strong shape, marking the active-path
    // region. A uniform margin on every side keeps it balanced within the
    // body: centered on the same line the wires (and the flow line) run
    // along, and clear of the gold band rather than crowding it.
    //
    // The actual electrical path is a separate, thin flow line at exactly
    // the same thickness a wire's own charge overlay uses
    // (CHARGE_THICKNESS_ON) so it reads as the same current continuing
    // through the mux. It draws only when the path is genuinely ON —
    // nothing for OFF, and nothing for FALLING either. Being much thinner
    // than the badge, it pokes straight through the badge's margin to
    // connect flush with a real external wire without the badge needing to
    // touch the wire itself.
    //
    // The line is built as rects + cap/joint circles accumulated into ONE
    // Path2D and filled once: overlapping subpaths in a single
    // nonzero-winding fill composite once, so the legs, their rounded ends
    // and the elbow joint can overlap freely without the translucent color
    // double-stacking. (The overlap artifacts this replaces came from
    // stroking with round caps, which overshoot each endpoint by half the
    // line width — right into the neighboring wire's own charge fill.)
    const COLOR_MUX_BADGE = 'rgba(200, 200, 200, 0.07)';
    const MUX_INDICATOR_INSET = 0.15;
    const MUX_INDICATOR_RADIUS = 0.3;

    function drawMuxIndicator(ind, cs) {
        const bx0 = panX + Math.min(ind.ex, ind.comX) * cs + MUX_INDICATOR_INSET * cs;
        const by0 = panY + Math.min(ind.ey, ind.comY) * cs + MUX_INDICATOR_INSET * cs;
        const bw = (Math.abs(ind.comX - ind.ex) + 1) * cs - 2 * MUX_INDICATOR_INSET * cs;
        const bh = (Math.abs(ind.comY - ind.ey) + 1) * cs - 2 * MUX_INDICATOR_INSET * cs;
        ctx.fillStyle = COLOR_MUX_BADGE;
        ctx.beginPath();
        ctx.roundRect(bx0, by0, bw, bh, Math.min(MUX_INDICATOR_RADIUS * cs, bw / 2, bh / 2));
        ctx.fill();

        if (!ind.on) return;
        const t = cs * CHARGE_THICKNESS_ON, half = t / 2;
        const addLeg = (path, ax, ay, bx, by) => {
            if (ay === by) path.rect(Math.min(ax, bx), ay - half, Math.abs(bx - ax), t);
            else path.rect(ax - half, Math.min(ay, by), t, Math.abs(by - ay));
        };
        const addCap = (path, x, y) => { path.moveTo(x + half, y); path.arc(x, y, half, 0, Math.PI * 2); };

        // Pin-side leg runs from the end cell's center (extended flush to
        // the cell edge when a wire is attached there) to the COM cell's
        // center; a second, perpendicular leg continues to COM's own exit
        // edge when that side is wired — an elbow, not a diagonal, matching
        // the PCB routing language everywhere else. Interior endpoints get
        // a cap circle (the flush ends stay square, meeting the wire's own
        // charge fill exactly at the shared boundary); the elbow joint gets
        // one too, rounding the turn's outer corner.
        const ecx = panX + ind.ex * cs + cs / 2, ecy = panY + ind.ey * cs + cs / 2;
        const ccx = panX + ind.comX * cs + cs / 2, ccy = panY + ind.comY * cs + cs / 2;
        const sx = ind.pinFlush ? ecx + ind.outward[0] * cs / 2 : ecx;
        const sy = ind.pinFlush ? ecy + ind.outward[1] * cs / 2 : ecy;
        const path = new Path2D();
        addLeg(path, sx, sy, ccx, ccy);
        if (!ind.pinFlush) addCap(path, sx, sy);
        addCap(path, ccx, ccy);
        if (ind.comFlush) addLeg(path, ccx, ccy, ccx + ind.toward[0] * cs / 2, ccy + ind.toward[1] * cs / 2);
        ctx.fillStyle = COLOR_CHARGE;
        ctx.fill(path);
    }

    function drawGrid() {
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const cs = cellSize();
        const x0 = Math.max(0, Math.floor(-panX / cs));
        const y0 = Math.max(0, Math.floor(-panY / cs));
        const x1 = Math.min(M.GRID_W - 1, Math.ceil((canvas.width - panX) / cs));
        const y1 = Math.min(M.GRID_H - 1, Math.ceil((canvas.height - panY) / cs));

        // One combined fill for the whole visible substrate, rather than each
        // insulator/conductor cell filling its own square — adjacent
        // same-color fillRect calls leave antialiased seams between them at
        // non-integer zoom (same issue addWireShape's batching avoids below).
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fillRect(panX + x0 * cs, panY + y0 * cs, (x1 - x0 + 1) * cs, (y1 - y0 + 1) * cs);

        // Every wire/charge/mux-band/LED shape in the redraw accumulates into
        // one path per layer, filled once each below — see the comment above
        // addWireShape for why (per-cell fillRect calls leave antialiased
        // seams). Mux indicators accumulate too, for a different reason (see
        // queueMuxIndicator): they reach into a neighboring cell that may not
        // have been drawn yet, and are deduped per macro via queuedMacroKeys.
        const layers = {
            wirePath: new Path2D(),
            chargePath: new Path2D(),
            muxBodyPath: new Path2D(),
            muxGoldPath: new Path2D(),
            muxNotchPath: new Path2D(),
            ledOnPath: new Path2D(),
            ledOffPath: new Path2D(),
            muxIndicators: [],
            queuedMacroKeys: new Set(),
            muxSourceGlyphs: [],
        };
        for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++)
                drawCell(x, y, layers);
        ctx.fillStyle = COLOR_GRAY_BODY;
        ctx.fill(layers.muxBodyPath);
        ctx.fillStyle = COLOR_GOLD;
        ctx.fill(layers.muxGoldPath);
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fill(layers.muxNotchPath);
        ctx.fillStyle = COLOR_LED_OFF;
        ctx.fill(layers.ledOffPath);
        ctx.fillStyle = COLOR_LED_ON;
        ctx.fill(layers.ledOnPath);
        ctx.fillStyle = COLOR_CONDUCTOR;
        ctx.fill(layers.wirePath);
        ctx.fillStyle = COLOR_CHARGE;
        ctx.fill(layers.chargePath);
        // Indicators first, then the opaque source glyphs on top: the flow
        // line runs from cell center to cell center, and a sourced cell's
        // circle then covers the line's end — the current visibly emerges
        // from under the glyph instead of lying translucently across it.
        for (const ind of layers.muxIndicators) drawMuxIndicator(ind, cs);
        for (const g of layers.muxSourceGlyphs) drawMuxSourceGlyph(g, cs);

        if (gridVisible && cs > 6) {
            // Fade the grid lines out as cells get small, so a zoomed-out board
            // reads as solid color instead of a busy mesh.
            const gridAlpha = Math.min(0.25, cs / 180);
            ctx.strokeStyle = `rgba(0,0,0,${gridAlpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let x = x0; x <= x1 + 1; x++) {
                const px = panX + x * cs;
                ctx.moveTo(px + 0.5, panY + y0 * cs);
                ctx.lineTo(px + 0.5, panY + (y1 + 1) * cs);
            }
            for (let y = y0; y <= y1 + 1; y++) {
                const py = panY + y * cs;
                ctx.moveTo(panX + x0 * cs, py + 0.5);
                ctx.lineTo(panX + (x1 + 1) * cs, py + 0.5);
            }
            ctx.stroke();
        }

        if (selectionRect) drawOverlayRect(selectionRect, '#7dffb3', 'rgba(125, 255, 179, 0.12)');
        if (objectHighlight) drawObjectHighlight(objectHighlight);
    }

    // Translucent wash over each cell of the grabbed object, outlined only
    // along its silhouette (edges with no same-object neighbor) so a mux or
    // a winding wire run reads as one grabbed shape, not a pile of squares.
    function drawObjectHighlight(cellsList) {
        const cs = cellSize();
        const set = new Set(cellsList.map(([x, y]) => x + ',' + y));
        ctx.fillStyle = 'rgba(125, 184, 255, 0.18)';
        for (const [x, y] of cellsList) ctx.fillRect(panX + x * cs, panY + y * cs, cs, cs);
        ctx.strokeStyle = '#7db8ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (const [x, y] of cellsList) {
            const px = panX + x * cs, py = panY + y * cs;
            if (!set.has(x + ',' + (y - 1))) { ctx.moveTo(px, py); ctx.lineTo(px + cs, py); }
            if (!set.has(x + ',' + (y + 1))) { ctx.moveTo(px, py + cs); ctx.lineTo(px + cs, py + cs); }
            if (!set.has((x - 1) + ',' + y)) { ctx.moveTo(px, py); ctx.lineTo(px, py + cs); }
            if (!set.has((x + 1) + ',' + y)) { ctx.moveTo(px + cs, py); ctx.lineTo(px + cs, py + cs); }
        }
        ctx.stroke();
    }

    function drawOverlayRect(r, stroke, fill) {
        const cs = cellSize();
        const px = panX + r.x0 * cs, py = panY + r.y0 * cs;
        const w = (r.x1 - r.x0 + 1) * cs, h = (r.y1 - r.y0 + 1) * cs;
        ctx.fillStyle = fill;
        ctx.fillRect(px, py, w, h);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(px + 1, py + 1, w - 2, h - 2);
        ctx.setLineDash([]);
    }

    // Keep the grid from being panned entirely off-screen: at least half of
    // whichever is smaller (the grid or the viewport) must stay visible on
    // each axis. That floor still lets any edge cell be brought to the
    // viewport center, but never into the void beyond it.
    function clampPan() {
        const gw = M.GRID_W * cellSize(), gh = M.GRID_H * cellSize();
        const marginX = Math.min(gw, canvas.width) / 2;
        const marginY = Math.min(gh, canvas.height) / 2;
        panX = Math.max(marginX - gw, Math.min(canvas.width - marginX, panX));
        panY = Math.max(marginY - gh, Math.min(canvas.height - marginY, panY));
    }

    function fitToWindow() {
        resizeCanvas();
        const cs = Math.min(canvas.width / M.GRID_W, canvas.height / M.GRID_H);
        zoom = Math.max(0.25, cs / M.CELL_SIZE);
        panX = (canvas.width - M.GRID_W * cellSize()) / 2;
        panY = (canvas.height - M.GRID_H * cellSize()) / 2;
    }

    window.PixelogicView = {
        canvas, drawGrid, resizeCanvas, screenToCell, fitToWindow,
        get zoom() { return zoom; },
        setZoom(z) { zoom = Math.max(0.25, Math.min(4, z)); clampPan(); },
        pan(dx, dy) { panX += dx; panY += dy; clampPan(); },
        get panX() { return panX; }, get panY() { return panY; },
        // Set an exact pan without clamping — used to restore a saved pan on
        // undo/redo so the drawing lands back in the same place.
        setPan(x, y) { panX = x; panY = y; },
        // When the grid auto-grows on the left/top, existing content shifts by
        // (leftCells, topCells); move the view the opposite way so nothing on
        // screen appears to move. No clamp — exactness matters here.
        compensateExpansion(leftCells, topCells) {
            panX -= leftCells * cellSize();
            panY -= topCells * cellSize();
        },
        setSelection(r) { selectionRect = r; },
        setObjectHighlight(cellsList) { objectHighlight = cellsList; },
        get gridVisible() { return gridVisible; },
        setGridVisible(v) { gridVisible = v; },
    };
})(window);

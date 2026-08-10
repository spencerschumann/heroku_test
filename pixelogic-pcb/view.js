(function (window) {
    const M = window.PixelogicModel;

    const canvas = document.getElementById('grid');
    const ctx = canvas.getContext('2d');

    // ===== PCB palette =====
    const COLOR_INSULATOR = '#065300';
    const COLOR_CONDUCTOR = '#0a9000';   // single conductor color; charge shown by the grey box
    const COLOR_GRAY_BODY = '#2b1b0b';
    const COLOR_POS_PAD = '#e6b800';   // gold plating, for a +V pad's glyph
    // Explicit sources: +V white with a black border/glyph, -V black with a
    // white border/glyph (each bordered in the opposite color so it reads on
    // any background).
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
    const COLOR_ISOLATED_POS_RING = '#032900', COLOR_ISOLATED_NEG_RING = '#8c949c';
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

    // Campaign pad labels: [{x, y, text, side:'left'|'right'}], drawn just
    // outside the cell so a level's terminals are named on the board itself
    // rather than only in the brief. Empty in the sandbox.
    var labels = [];

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
    // How far a miter cuts into an elbow's corners, relative to the wire's
    // own half-thickness — the 45°-routing PCB look. sqrt(2) is the value
    // that makes the diagonal exactly as wide as the wire (see
    // addElbowShape); anything less leaves it pinched, anything more bulges.
    const ELBOW_CHAMFER_RATIO = Math.SQRT2;
    // The crossover's vertical break, as a fraction of the cell — deliberately
    // large (matching the old two-cell gap-cutting look) so it reads as an
    // obvious interruption rather than just "as wide as the wire."
    const CROSSOVER_GAP_FRAC = 0.8;

    // Each side is asked with the direction pointing back at this cell, so a
    // neighbor that only connects on one face (a box mux lead) answers for
    // the face we are actually reaching toward rather than for itself as a
    // whole — otherwise a wire routing past a pin grows an arm into the
    // package and draws as a tee where it should be an elbow.
    function wireArms(x, y) {
        return {
            n: M.cellConnects(x, y - 1, [0, 1]),
            e: M.cellConnects(x + 1, y, [-1, 0]),
            s: M.cellConnects(x, y + 1, [0, -1]),
            w: M.cellConnects(x - 1, y, [1, 0]),
        };
    }

    // Exactly two ADJACENT (perpendicular) arms — a bend, as opposed to a
    // straight run (2 opposite) or a tee/plus (3/4).
    function isElbow(arms) {
        const count = (arms.n ? 1 : 0) + (arms.e ? 1 : 0) + (arms.s ? 1 : 0) + (arms.w ? 1 : 0);
        return count === 2 && !(arms.n && arms.s) && !(arms.e && arms.w);
    }

    // An elbow, mitered on BOTH corners at 45° instead of the sharp right
    // angles a plain hub+arms union would give. The outer corner — nearest
    // the two arms that are *missing* — is cut away; the inner one is filled
    // in, since a bend cut on the outside alone still reads as a kink with a
    // hard corner sitting in the middle of it.
    //
    // Cutting both by the same amount is what makes the diagonal a genuine
    // 45° routed track: the two cuts lie on parallel 45° lines whose spacing
    // is (outer + inner)/sqrt(2), so cutting each by sqrt(2)*half leaves the
    // diagonal exactly the wire's own width (see ELBOW_CHAMFER_RATIO).
    //
    // Each of the 4 orientations is a 90° rotation of the same 8-point
    // outline: two arm tips, the two corners where each arm's outer edge
    // meets the hub, and two cut points at each of the bend's corners.
    function addElbowShape(path, px, py, cs, half, chamfer, inner, arms) {
        const cx = px + cs / 2, cy = py + cs / 2;
        let pts;
        if (arms.n && arms.e) {
            pts = [
                [cx - half, py], [cx + half, py],
                [cx + half, cy - half - inner], [cx + half + inner, cy - half],
                [px + cs, cy - half], [px + cs, cy + half],
                [cx - half + chamfer, cy + half], [cx - half, cy + half - chamfer],
            ];
        } else if (arms.e && arms.s) {
            pts = [
                [px + cs, cy - half], [px + cs, cy + half],
                [cx + half + inner, cy + half], [cx + half, cy + half + inner],
                [cx + half, py + cs], [cx - half, py + cs],
                [cx - half, cy - half + chamfer], [cx - half + chamfer, cy - half],
            ];
        } else if (arms.s && arms.w) {
            pts = [
                [cx + half, py + cs], [cx - half, py + cs],
                [cx - half, cy + half + inner], [cx - half - inner, cy + half],
                [px, cy + half], [px, cy - half],
                [cx + half - chamfer, cy - half], [cx + half, cy - half + chamfer],
            ];
        } else { // arms.w && arms.n
            pts = [
                [px, cy + half], [px, cy - half],
                [cx - half - inner, cy - half], [cx - half, cy - half - inner],
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
            // The inner miter runs back along an arm rather than into the
            // hub, so it is capped at the arm's own length — past the cell
            // edge it would show as a spur beside the neighbor's arm.
            const chamfer = half * ELBOW_CHAMFER_RATIO;
            addElbowShape(path, px, py, cs, half, chamfer,
                Math.min(chamfer, cs / 2 - half), arms);
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
    // seams). The same reasoning applies to gray body fills and to LED
    // cells, which is why those route into shared paths here too instead of
    // calling ctx.fillRect directly.
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
            // One drawing for one thing — arm stubs and all — whether it sits
            // out on its own or flush against an LED or a mux lead, where the
            // stub is what makes the connection read.
            drawSourceCell(x, y, px, py, cs, id === M.ID_POS);
            return;
        }

        if (M.isLed(id)) {
            addLedShape(M.ledIsOn(id) ? layers.ledOnPath : layers.ledOffPath, x, y, px, py, cs);
            return;
        }
        if (M.isSwitch(id)) { drawSwitch(px, py, cs, M.switchIsPressed(id)); return; }
        if (M.isToggle(id)) { drawToggle(px, py, cs, M.toggleIsOn(id)); return; }

        if (M.isGrayId(id)) {
            drawMuxPixel(x, y, id, px, py, cs, layers);
            return;
        }
    }

    // Explicit source: +V is white with a black +, -V is black with a white -,
    // each ringed in the opposite color so it stands out on any background.
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
    // "this cell is a constant source" rendering (the explicit +V/-V cells
    // and a lone gray pixel acting as -V).
    function drawSourceCircleGlyph(cx, cy, cs, positive) {
        ctx.fillStyle = positive ? COLOR_POS_PAD : '#000000';
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

    // A source standing on its own: the explicit +V/-V cell, or a lone gray
    // pixel acting as -V. Substrate background, a stub
    // toward every neighbor it actually connects to, and the circle glyph on
    // top — the stub is what makes it read as plugged into a wire, an LED or
    // a mux edge rather than merely abutting it.
    function drawSourceCell(x, y, px, py, cs, positive) {
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

    // A body cell's own charge as ON/FALLING/OFF.
    function bodyCellCharge(x, y) {
        const id = M.getCell(x, y);
        return M.isGrayId(id) ? M.grayCharge(id) : M.OFF;
    }

    // The macro's active pin-to-COM connection gets one indicator: a
    // diagonal trace across the package, lit when the path is carrying.
    // Queued once per macro — queuedMacroKeys dedupes the repeat visits from
    // the macro's other cells — and drawn once after the whole grid pass in
    // drawGrid, since it reaches into a neighboring cell that may not have
    // been drawn yet in raster order.
    function queueMuxIndicator(macro, muxIndicators, queuedMacroKeys) {
        // disabling for now
        return;

        if (queuedMacroKeys.has(macro.key)) return;
        queuedMacroKeys.add(macro.key);

        // Which end is bridged to COM this tick: the select end when the
        // select is charged, the other one when it isn't. (The model's
        // getMacroControl says the same thing; this is the view's own read,
        // so drawing never has to run a tick.)
        const ctlId = M.getCell(macro.selCell[0], macro.selCell[1]);
        const controlOn = M.isGrayId(ctlId) && M.grayCharge(ctlId) === M.ON;
        const activeIsFirst = controlOn ? macro.selIsFirst : !macro.selIsFirst;

        const along = macro.along, toward = macro.toward;
        const at = (i, d) => [macro.rowStart[0] + along[0] * i + toward[0] * d,
                              macro.rowStart[1] + along[1] * i + toward[1] * d];
        const i = activeIsFirst ? 0 : 2;

        // The pin and COM are diagonally opposite, and the trace runs
        // straight between them — the slanted contact line a mux symbol
        // draws, rather than an elbow that would read as routing. Each end
        // stops at the package edge rather than the cell boundary: from
        // there out it is the lead's job, and the line would otherwise tint
        // the silver.
        const pinCell = at(i, 1), comCell = at(1, 0);
        const edge = ([cx, cy], out) => [cx + out[0] * (0.5 - BOX_PKG_INSET),
                                         cy + out[1] * (0.5 - BOX_PKG_INSET)];
        const pts = [edge(pinCell, toward), edge(comCell, [-toward[0], -toward[1]])];

        // Lit only for a genuinely ON path. OFF shows nothing, and FALLING
        // shows nothing either — a dimmer trace for a signal that isn't
        // carrying (e.g. the constant state of a -V source) read as a
        // phantom signal rather than "off". Tested over the whole electrical
        // path, including the COM cell the diagonal passes by rather than
        // through, so it lights the tick charge arrives rather than after.
        const on = [pinCell, at(i, 0), comCell]
            .some(([cx, cy]) => bodyCellCharge(cx, cy) === M.ON);

        muxIndicators.push({ pts, on });
    }

    // ---- Box mux: drawn as a surface-mount part ----
    // A box mux has no control band to give it a shape, so instead of the
    // per-cell squares every other macro cell draws, the whole macro is one
    // part: a package sitting on the board, with silvery SOIC leads at
    // exactly the faces that carry a connection.
    //
    // The outline follows the model's three states (see buildBoxMux). Fresh
    // out of the tool it is a plain rounded rectangle — six gray pixels with
    // no orientation yet (`boxIdle`), so no leads and nothing printed on it.
    // A wire on a long side settles which way round it goes (`boxFrame`):
    // the package becomes the mux's trapezoid and grows the three leads that
    // are now known — COM and both pins. The first wire to land on a corner
    // is SELECT and fixes the rest, adding the fourth lead and the
    // silkscreen.
    const BOX_PKG_INSET = 0.15;   // package edge, in from the footprint
    const BOX_PKG_RADIUS = 0.24;
    // Once the axis is known the package tapers toward COM — the mux's own
    // trapezoid, but softened into something that still reads as a part:
    // a shallow taper, rounded corners, and a shallow notch in the middle of
    // the wide side, where nothing connects.
    const BOX_TAPER = 0.2;
    const BOX_NOTCH_HALF = 0.34, BOX_NOTCH_DEPTH = 0.16, BOX_NOTCH_RADIUS = 0.16;
    const BOX_LEAD_HALF = WIRE_THICKNESS / 2;  // a lead is a wire wide, so they line up
    const BOX_LEAD_TUCK = 0.2;    // how far the lead runs under the package
    const COLOR_BOX_BODY = '#343434', COLOR_BOX_OUTLINE = '#8e8e8e';
    const COLOR_BOX_LEAD = '#c3c8ce';
    const COLOR_BOX_SILK = 'rgba(235, 235, 235, 0.42)';
    const BOX_OUTLINE_FRAC = 0.04;
    const BOX_PIN1_R = 0.13, BOX_PIN1_U = 0.58;

    // Queues one box mux — deduped by key, like the indicator. `idle` boxes
    // carry only a footprint (no orientation, hence no leads or silkscreen).
    function queueBoxPart(layers, key, part) {
        if (layers.queuedBoxKeys.has(key)) return;
        layers.queuedBoxKeys.add(key);
        layers.boxParts.push(part);
    }

    // A closed polygon with every corner rounded: start mid-edge, then arc
    // through each vertex. Each radius is clamped to half the shorter of its
    // two edges, so a tight corner rounds as much as it can and no more.
    function roundedPoly(pts, radii) {
        const n = pts.length, p = new Path2D();
        const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
        p.moveTo(...mid(pts[n - 1], pts[0]));
        for (let i = 0; i < n; i++) {
            const cur = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
            const r = Math.min(radii[i], dist(prev, cur) / 2, dist(cur, next) / 2);
            p.arcTo(cur[0], cur[1], ...mid(cur, next), r);
        }
        p.closePath();
        return p;
    }

    // The package body. With no orientation yet it's a plain rounded
    // rectangle over the footprint, inset so the leads have somewhere to
    // emerge from; once the axis is known it tapers toward COM and picks up
    // the notch (see BOX_TAPER).
    function boxPackagePath(frame, cs) {
        const I = BOX_PKG_INSET, rect = frame.rect;
        if (!frame.toward) {
            const p = new Path2D();
            const w = rect.w * cs - 2 * I * cs, h = rect.h * cs - 2 * I * cs;
            p.roundRect(panX + rect.x * cs + I * cs, panY + rect.y * cs + I * cs,
                w, h, Math.min(BOX_PKG_RADIUS * cs, w / 2, h / 2));
            return p;
        }
        // (u, v) cell frame: u along the long axis from the first end, v
        // across from the COM side. The COM edge is pulled in at both ends.
        const along = frame.along, toward = frame.toward;
        const ox = panX + (frame.rowStart[0] + 0.5) * cs - (along[0] + toward[0]) * cs / 2;
        const oy = panY + (frame.rowStart[1] + 0.5) * cs - (along[1] + toward[1]) * cs / 2;
        const P = (u, v) => [ox + (along[0] * u + toward[0] * v) * cs,
        oy + (along[1] * u + toward[1] * v) * cs];
        const near = I, far = 2 - I, lo = I + BOX_TAPER, hi = 3 - I - BOX_TAPER;
        const pts = [
            [lo, near], [hi, near],                          // COM (narrow) edge
            [3 - I, far],                                    // pin side, last end
            [1.5 + BOX_NOTCH_HALF, far],
            [1.5, far - BOX_NOTCH_DEPTH],                    // notch apex
            [1.5 - BOX_NOTCH_HALF, far],
            [I, far],                                        // pin side, first end
        ].map(([u, v]) => P(u, v));
        const R = BOX_PKG_RADIUS * cs, N = BOX_NOTCH_RADIUS * cs;
        return roundedPoly(pts, [R, R, R, N, N, N, R]);
    }

    // One lead: a silver tab on `cell`'s `dir` face, from the cell boundary
    // in under the package edge. Drawn before the package, so the body
    // trims its inner end and it reads as emerging from underneath.
    function addBoxLead(path, [cx, cy], [dx, dy], cs) {
        const ccx = panX + cx * cs + cs / 2, ccy = panY + cy * cs + cs / 2;
        const outer = 0.5, inner = 0.5 - BOX_PKG_INSET - BOX_LEAD_TUCK;
        const ax = ccx + dx * inner * cs, ay = ccy + dy * inner * cs;
        const bx = ccx + dx * outer * cs, by = ccy + dy * outer * cs;
        const hx = -dy * BOX_LEAD_HALF * cs, hy = dx * BOX_LEAD_HALF * cs;
        path.moveTo(ax + hx, ay + hy); path.lineTo(bx + hx, by + hy);
        path.lineTo(bx - hx, by - hy); path.lineTo(ax - hx, ay - hy);
        path.closePath();
    }

    // Silkscreen: just the pin-1 dot, by the select corner — the one
    // asymmetry on the package, and the same corner the frame is measured
    // from. The package outline is already the mux's trapezoid, so there is
    // nothing else worth printing: the diagonal drawn across it (see
    // drawMuxIndicator) says "switch" and carries the live state as well.
    // Sits on the COM row's centerline, in line with the SELECT lead and
    // clear of the tapered corner.
    function drawBoxSilk(macro, cs) {
        const along = macro.along, toward = macro.toward;
        const ox = panX + (macro.rowStart[0] + 0.5) * cs - (along[0] + toward[0]) * cs / 2;
        const oy = panY + (macro.rowStart[1] + 0.5) * cs - (along[1] + toward[1]) * cs / 2;
        const u = macro.selIsFirst ? BOX_PIN1_U : 3 - BOX_PIN1_U;
        const dx = ox + (along[0] * u + toward[0] * 0.5) * cs;
        const dy = oy + (along[1] * u + toward[1] * 0.5) * cs;
        ctx.beginPath();
        ctx.arc(dx, dy, BOX_PIN1_R * cs, 0, Math.PI * 2);
        ctx.fillStyle = COLOR_BOX_SILK;
        ctx.fill();
    }

    function drawBoxPart(part, cs) {
        const leads = part.frame.leads;
        if (leads.length) {
            const leadPath = new Path2D();
            for (const [cell, dir] of leads) addBoxLead(leadPath, cell, dir, cs);
            ctx.fillStyle = COLOR_BOX_LEAD;
            ctx.fill(leadPath);
        }
        const body = boxPackagePath(part.frame, cs);
        ctx.fillStyle = COLOR_BOX_BODY;
        ctx.fill(body);
        ctx.strokeStyle = COLOR_BOX_OUTLINE;
        ctx.lineWidth = Math.max(1, cs * BOX_OUTLINE_FRAC);
        ctx.stroke(body);
        if (part.macro) drawBoxSilk(part.macro, cs);
    }

    function drawMuxPixel(x, y, id, px, py, cs, layers) {
        const role = M.roles[M.idx(x, y)];

        // Gray that isn't a mux is a -V source pad: a glyph on its own, a
        // plain square once it clumps (the circle doesn't tile).
        if (!role || role.kind === 'isolatedGray') {
            if (role && role.size === 1) drawSourceCell(x, y, px, py, cs, false);
            else layers.muxBodyPath.rect(px, py, cs, cs);
            return;
        }

        // The whole macro draws as one surface-mount part rather than
        // per-cell squares, so its cells contribute nothing here — each just
        // hands over the frame it belongs to. See drawBoxPart. Uncommissioned
        // states carry a frame but no macro: a blank package with no
        // orientation, or a trapezoid with three of its leads once a long
        // side has said which way round it goes.
        if (role.kind === 'boxIdle' || role.kind === 'boxFrame') {
            queueBoxPart(layers, role.frame.key, { frame: role.frame, macro: null });
            return;
        }
        const m = role.macro;
        queueBoxPart(layers, m.key, { frame: m, macro: m });
        if (role.kind === 'end') queueMuxIndicator(m, layers.muxIndicators, layers.queuedMacroKeys);
    }

    // A box mux's internal connection path: dim enough to read as a hint
    // printed inside the package rather than another wire on the board, and
    // brighter (but still muted against a real trace) when carrying.
    const COLOR_BOX_TRACE = 'rgba(216, 216, 216, 0.07)';
    const COLOR_BOX_TRACE_ON = 'rgba(216, 216, 216, 0.16)';

    // ---- The ratsnest ----
    // A connection a rearrange could not keep is drawn as a straight dashed
    // line between the two ends that should be joined — a PCB tool's unrouted
    // airwire. It deliberately ignores the grid: it is a statement about what
    // the circuit owes, not a route, and looking nothing like a trace is what
    // keeps the two from being confused. Draw the wire and it disappears.
    const COLOR_PENDING = '#ffb020';
    const PENDING_WIDTH = 0.06, PENDING_DASH = [0.34, 0.26], PENDING_DOT = 0.11;

    function drawPendingLinks(cs) {
        const links = M.pendingLinks();
        if (!links.length) return;
        ctx.save();
        ctx.strokeStyle = COLOR_PENDING;
        ctx.fillStyle = COLOR_PENDING;
        ctx.lineWidth = Math.max(1, cs * PENDING_WIDTH);
        ctx.setLineDash(PENDING_DASH.map((d) => Math.max(2, d * cs)));
        ctx.lineCap = 'butt';
        for (const [[ax, ay], [bx, by]] of links) {
            const x0 = panX + ax * cs + cs / 2, y0 = panY + ay * cs + cs / 2;
            const x1 = panX + bx * cs + cs / 2, y1 = panY + by * cs + cs / 2;
            ctx.beginPath();
            ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
            ctx.stroke();
            // A dot at each end, so a short link still reads as a link even
            // when the dashes have nowhere to fall.
            ctx.setLineDash([]);
            for (const [px, py] of [[x0, y0], [x1, y1]]) {
                ctx.beginPath();
                ctx.arc(px, py, Math.max(1, cs * PENDING_DOT), 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.setLineDash(PENDING_DASH.map((d) => Math.max(2, d * cs)));
        }
        ctx.restore();
    }

    // The internal connection, drawn as one quad plus a cap circle at each
    // end, all in a single nonzero fill so the overlap composites once
    // rather than double-stacking the translucent color.
    function drawMuxIndicator(ind, cs) {
        const t = cs * CHARGE_THICKNESS_ON, half = t / 2;
        // The diagonal, as a quad. The normal's sign is chosen so it winds
        // the same way Path2D.rect and arc do — the line and its end caps
        // are one nonzero fill, and a subpath wound the other way would
        // punch a hole through the caps instead of merging with them.
        const [a, b] = ind.pts.map(([cx, cy]) => [panX + cx * cs + cs / 2, panY + cy * cs + cs / 2]);
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 1e-6) return;
        const nx = dy / len * half, ny = -dx / len * half;
        const path = new Path2D();
        path.moveTo(a[0] + nx, a[1] + ny); path.lineTo(b[0] + nx, b[1] + ny);
        path.lineTo(b[0] - nx, b[1] - ny); path.lineTo(a[0] - nx, a[1] - ny);
        path.closePath();
        for (const [x, y] of [a, b]) { path.moveTo(x + half, y); path.arc(x, y, half, 0, Math.PI * 2); }
        ctx.fillStyle = ind.on ? COLOR_BOX_TRACE_ON : COLOR_BOX_TRACE;
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
            ledOnPath: new Path2D(),
            ledOffPath: new Path2D(),
            muxIndicators: [],
            queuedMacroKeys: new Set(),
            boxParts: [],
            queuedBoxKeys: new Set(),
        };
        for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++)
                drawCell(x, y, layers);
        ctx.fillStyle = COLOR_GRAY_BODY;
        ctx.fill(layers.muxBodyPath);
        // Box mux parts go in with the rest of the mux bodies — under the
        // wires, so a wire meeting a lead draws over the shared boundary.
        for (const part of layers.boxParts) drawBoxPart(part, cs);
        ctx.fillStyle = COLOR_LED_OFF;
        ctx.fill(layers.ledOffPath);
        ctx.fillStyle = COLOR_LED_ON;
        ctx.fill(layers.ledOnPath);
        ctx.fillStyle = COLOR_CONDUCTOR;
        ctx.fill(layers.wirePath);
        ctx.fillStyle = COLOR_CHARGE;
        ctx.fill(layers.chargePath);
        for (const ind of layers.muxIndicators) drawMuxIndicator(ind, cs);
        drawPendingLinks(cs);

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

        if (labels.length) drawLabels(cs);
        if (selectionRect) drawOverlayRect(selectionRect, '#7dffb3', 'rgba(125, 255, 179, 0.12)');
        if (objectHighlight) drawObjectHighlight(objectHighlight);
    }

    // Pad names, in the black margin beyond the board's edge rather than over
    // the build area. The text scales with the zoom but is floored and capped,
    // so the labels stay legible on a zoomed-out board without swelling into
    // the circuit on a zoomed-in one.
    function drawLabels(cs) {
        const size = Math.max(9, Math.min(16, cs * 0.6));
        ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#9a9a9a';
        const gap = Math.max(4, cs * 0.25);
        for (const l of labels) {
            const cy = panY + (l.y + 0.5) * cs;
            if (cy < -size || cy > canvas.height + size) continue;
            ctx.textAlign = l.side === 'left' ? 'right' : 'left';
            const cx = l.side === 'left' ? panX + l.x * cs - gap : panX + (l.x + 1) * cs + gap;
            ctx.fillText(l.text, cx, cy);
        }
        ctx.textAlign = 'left';
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

    // The board is the whole world, so the view never strays far from it: at
    // most ONE cell of empty space is allowed beyond any edge. Panning past
    // that is not a feature — there is nothing out there, and being able to
    // fling the board half off-screen only ever loses it. When an axis has
    // room to spare the board is centred on it outright, so a small board
    // sits in the middle instead of drifting into a corner.
    const MARGIN_CELLS = 1;

    // Height at the foot of the canvas covered by an overlay drawn on top of
    // it (the campaign's level bar). Fitting and clamping both work against
    // the part that is actually visible, so a board is never tucked behind it.
    var insetBottom = 0;
    const usableHeight = () => Math.max(80, canvas.height - insetBottom);

    function clampPan() {
        const cs = cellSize(), m = cs * MARGIN_CELLS;
        const gw = M.GRID_W * cs, gh = M.GRID_H * cs;
        const vw = canvas.width, vh = usableHeight();
        panX = gw + 2 * m <= vw ? (vw - gw) / 2 : Math.max(vw - gw - m, Math.min(m, panX));
        panY = gh + 2 * m <= vh ? (vh - gh) / 2 : Math.max(vh - gh - m, Math.min(m, panY));
    }

    // The zoom at which the board plus its one-cell margin exactly fills the
    // viewport — and therefore the furthest out anyone can go. Zooming past
    // "the whole board, framed" would only add black.
    function minZoom() {
        const cs = Math.min(canvas.width / (M.GRID_W + 2 * MARGIN_CELLS),
            usableHeight() / (M.GRID_H + 2 * MARGIN_CELLS));
        return Math.max(0.05, cs / M.CELL_SIZE);
    }

    function fitToWindow() {
        resizeCanvas();
        zoom = Math.min(4, minZoom());
        clampPan();
    }

    window.PixelogicView = {
        canvas, drawGrid, resizeCanvas, screenToCell, fitToWindow,
        get zoom() { return zoom; },
        setZoom(z) { zoom = Math.max(minZoom(), Math.min(4, z)); clampPan(); },
        get minZoom() { return minZoom(); },
        // Re-apply both limits — after a resize, a board swap, or the level
        // bar changing height, the current zoom/pan may no longer be legal.
        clampView() { resizeCanvas(); if (zoom < minZoom()) zoom = Math.min(4, minZoom()); clampPan(); },
        setViewInset(bottom) { insetBottom = bottom || 0; },
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
        get labels() { return labels; },
        setLabels(list) { labels = list || []; },
        setSelection(r) { selectionRect = r; },
        setObjectHighlight(cellsList) { objectHighlight = cellsList; },
        get gridVisible() { return gridVisible; },
        setGridVisible(v) { gridVisible = v; },
    };
})(window);

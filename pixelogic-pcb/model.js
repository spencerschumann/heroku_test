(function (window) {
    // model.js - pure-pixel adjacency simulation with direct mux support.
    //
    // Unlike simulation/pixelogic's tile world, connectivity here is purely
    // adjacency-based: two orthogonally-touching conductor-ish pixels are
    // connected, full stop - there is no per-side "pipe fitting" bitmask to
    // draw. Four pixel colors only: insulator, conductor, mux body (gray),
    // mux control (gold). Crossovers, voltage sources and mux macros are all
    // *inferred* from adjacency/shape rather than placed as distinct tools.

    const CELL_SIZE = 32;
    const DEFAULT_W = 48, DEFAULT_H = 30;
    // The grid grows on demand (see expandForBorder) so drawing never runs out
    // of room, so its dimensions are mutable.
    let GRID_W = DEFAULT_W, GRID_H = DEFAULT_H;

    // ===== Charge states (3-state decay model, ported from pixelogic/model.js) =====
    const OFF = 0, ON = 1, FALLING = 2;

    function nextCharge(charge, n, e, s, w) {
        if (charge === OFF) {
            if (n === ON || e === ON || s === ON || w === ON) return ON;
        } else if (charge === ON) {
            if (n === FALLING || e === FALLING || s === FALLING || w === FALLING) return FALLING;
        } else if (charge === FALLING) {
            return OFF;
        }
        return charge;
    }

    // ===== Cell ID space (fits in a Uint8Array) =====
    //
    // Insulator: 0 (plain only - a bare insulator is inert, and an insulator
    //            hole no longer means anything special)
    // Conductor: 10-12 (charge 0-2)
    // +V: 13   -V: 14  (explicit sources - a distinct tool that can sit right
    //            against a mux and drive it directly; an isolated gold/gray
    //            pixel that doesn't touch any mux body/control also acts as
    //            one, see isolatedGold/isolatedGray below)
    // Gold (mux control colored pixel): 15-20 (charge*2 + wasActive)
    // Gray (mux body colored pixel):     21-26 (charge*2 + wasActive)
    // Crossover conductor: 27-35 (27 + v*3 + h) - a conductor whose four
    //            neighbors are all conductors routes its vertical axis (N<->S)
    //            independently from its horizontal axis (E<->W), so it needs to
    //            remember two charges. Crossover-ness itself is geometric (see
    //            isCrossoverAt); the distinct id only exists to hold both.
    // LED (output): 36-38 (36 + charge) - a pure sink that never drives a wire,
    //            but LED cells conduct to each other over the 8-neighborhood so
    //            a multi-cell pad lights (and drains) as one square unit.
    // Switch (momentary input): 39 released, 40 pressed - drives like +V while
    //            pressed and like -V (pulls down) when released. Pressing floods
    //            the whole 8-connected switch pad, so a big button acts as one.
    // Toggle (latching input): 41 off, 42 on - same drive as the switch (+V on,
    //            -V off), but a click flips and holds instead of press-and-hold.
    const ID_INSULATOR_PLAIN = 0;
    const ID_CONDUCTOR_BASE = 10, ID_CONDUCTOR_MAX = 12;
    const ID_POS = 13;
    const ID_NEG = 14;
    const ID_GOLD_BASE = 15, ID_GOLD_MAX = 20;
    const ID_GRAY_BASE = 21, ID_GRAY_MAX = 26;
    const ID_XOVER_BASE = 27, ID_XOVER_MAX = 35;
    const ID_LED_BASE = 36, ID_LED_MAX = 38;
    const ID_SWITCH_OFF = 39, ID_SWITCH_ON = 40;
    const ID_TOGGLE_OFF = 41, ID_TOGGLE_ON = 42;

    function isInsulatorId(id) { return id === ID_INSULATOR_PLAIN; }
    function isLed(id) { return id >= ID_LED_BASE && id <= ID_LED_MAX; }
    function ledCharge(id) { return id - ID_LED_BASE; }
    function makeLed(charge) { return ID_LED_BASE + charge; }
    function ledIsOn(id) { return ledCharge(id) === ON; }
    function isSwitch(id) { return id === ID_SWITCH_OFF || id === ID_SWITCH_ON; }
    function switchIsPressed(id) { return id === ID_SWITCH_ON; }
    function isToggle(id) { return id === ID_TOGGLE_OFF || id === ID_TOGGLE_ON; }
    function toggleIsOn(id) { return id === ID_TOGGLE_ON; }

    // Orthogonal + diagonal offsets (the 8-neighborhood / Moore neighborhood),
    // used for pad-internal spreading so pads fill a solid square rather than a
    // 4-connected diamond.
    const NEIGHBORS_8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]];

    // Variadic form of nextCharge for cells that read more than four inputs
    // (an LED sees up to eight LED neighbors plus its orthogonal drivers).
    function nextChargeN(cur, inputs) {
        if (cur === OFF) return inputs.some((c) => c === ON) ? ON : OFF;
        if (cur === ON) return inputs.some((c) => c === FALLING) ? FALLING : ON;
        if (cur === FALLING) return OFF;
        return cur;
    }

    function isConductorId(id) { return id >= ID_CONDUCTOR_BASE && id <= ID_CONDUCTOR_MAX; }
    function conductorCharge(id) { return id - ID_CONDUCTOR_BASE; }
    function makeConductor(charge) { return ID_CONDUCTOR_BASE + charge; }

    function isXover(id) { return id >= ID_XOVER_BASE && id <= ID_XOVER_MAX; }
    function xoverV(id) { return Math.floor((id - ID_XOVER_BASE) / 3); }
    function xoverH(id) { return (id - ID_XOVER_BASE) % 3; }
    function makeXover(v, h) { return ID_XOVER_BASE + v * 3 + h; }

    // A "wire" is anything a conductor run connects to for the purpose of
    // deciding crossovers: a plain conductor or an existing crossover. Sources
    // and mux pins are deliberately excluded, so a junction of two wires is a
    // crossover but a wire meeting a source/mux stays a normal connection.
    function isWireId(id) { return isConductorId(id) || isXover(id); }
    function combineCharge(v, h) {
        if (v === ON || h === ON) return ON;
        if (v === FALLING || h === FALLING) return FALLING;
        return OFF;
    }

    function isGoldId(id) { return id >= ID_GOLD_BASE && id <= ID_GOLD_MAX; }
    function goldCharge(id) { return Math.floor((id - ID_GOLD_BASE) / 2); }
    function goldWasActive(id) { return ((id - ID_GOLD_BASE) % 2) === 1; }
    function makeGold(charge, wasActive) { return ID_GOLD_BASE + charge * 2 + (wasActive ? 1 : 0); }

    function isGrayId(id) { return id >= ID_GRAY_BASE && id <= ID_GRAY_MAX; }
    function grayCharge(id) { return Math.floor((id - ID_GRAY_BASE) / 2); }
    function grayWasActive(id) { return ((id - ID_GRAY_BASE) % 2) === 1; }
    function makeGray(charge, wasActive) { return ID_GRAY_BASE + charge * 2 + (wasActive ? 1 : 0); }

    const AXIS_V = 0, AXIS_H = 1;

    var cells = new Uint8Array(GRID_W * GRID_H).fill(ID_INSULATOR_PLAIN);
    var nextCells = new Uint8Array(GRID_W * GRID_H);
    var roles = new Array(GRID_W * GRID_H).fill(null);
    var tickCount = 0;
    // Locked cells (game.js): the campaign's fixed input/output pads. Every
    // structural edit path refuses to touch one, so a level's terminals stay
    // where the verifier expects them however the player rearranges the rest.
    // Empty (all zero) in the sandbox, which is the only state the editor
    // itself ever produces.
    var locked = new Uint8Array(GRID_W * GRID_H);
    var anyLocked = false;

    function idx(x, y) { return y * GRID_W + x; }
    function inBounds(x, y) { return x >= 0 && x < GRID_W && y >= 0 && y < GRID_H; }
    function getCell(x, y) { return inBounds(x, y) ? cells[idx(x, y)] : ID_INSULATOR_PLAIN; }
    function setCellRaw(x, y, id) { if (inBounds(x, y)) cells[idx(x, y)] = id; }
    function isLocked(x, y) { return anyLocked && inBounds(x, y) && locked[idx(x, y)] === 1; }

    // Replaces the whole lock set with the given cell list ([[x,y],...]).
    // Called once when a level loads and cleared on the way back to the
    // sandbox; nothing incremental, so there's no partial state to get wrong.
    function setLockedCells(list) {
        locked.fill(0);
        anyLocked = false;
        for (const [x, y] of (list || [])) {
            if (!inBounds(x, y)) continue;
            locked[idx(x, y)] = 1;
            anyLocked = true;
        }
    }
    function lockedCells() {
        const out = [];
        if (!anyLocked) return out;
        for (let i = 0; i < locked.length; i++)
            if (locked[i] === 1) out.push([i % GRID_W, Math.floor(i / GRID_W)]);
        return out;
    }

    // A wire pixel whose four orthogonal neighbors are all wires is a
    // crossover: the two axes pass over each other without connecting. Purely
    // geometric, so both the simulation and the renderer agree the instant the
    // fourth arm is drawn (before any step converts the id to an xover form).
    function isCrossoverAt(x, y) {
        if (!isWireId(getCell(x, y))) return false;
        return isWireId(getCell(x, y - 1)) && isWireId(getCell(x + 1, y)) &&
               isWireId(getCell(x, y + 1)) && isWireId(getCell(x - 1, y));
    }

    // Whether the cell at (x,y) is something a wire visually/electrically
    // joins onto — used to decide which of a wire pixel's four sides should
    // actually be drawn reaching toward that neighbor (see view.js's thin-
    // wire rendering) rather than filling the whole cell regardless of what,
    // if anything, is actually there. Mirrors contribCharge's notion of "does
    // this cell conduct" but direction-agnostic and boolean: a crossover's
    // two axes are kept separate for charge, but both still read as "wire is
    // here" for this shape/connectivity purpose.
    function cellConnects(x, y) {
        if (!inBounds(x, y)) return false;
        const id = cells[idx(x, y)];
        if (isInsulatorId(id)) return false;
        if (isConductorId(id) || isXover(id)) return true;
        if (id === ID_POS || id === ID_NEG) return true;
        if (isLed(id) || isSwitch(id) || isToggle(id)) return true;
        if (isGoldId(id) || isGrayId(id)) {
            const role = roles[idx(x, y)];
            if (!role) return false;
            return role.kind === 'corner' || role.kind === 'end' || role.kind === 'comMiddle'
                || role.kind === 'isolatedGold' || role.kind === 'isolatedGray';
        }
        return false;
    }

    // ===== Painting =====
    // Colors: 'insulator', 'conductor', 'gold', 'gray'
    function paintCell(x, y, color) {
        if (!inBounds(x, y) || isLocked(x, y)) return;
        let id;
        switch (color) {
            case 'conductor': id = makeConductor(OFF); break;
            case 'gold': id = makeGold(OFF, false); break;
            case 'gray': id = makeGray(OFF, false); break;
            case 'pos': id = ID_POS; break;
            case 'neg': id = ID_NEG; break;
            case 'led': id = makeLed(OFF); break;
            case 'switch': id = ID_SWITCH_OFF; break;
            case 'toggle': id = ID_TOGGLE_OFF; break;
            default: id = ID_INSULATOR_PLAIN;
        }
        cells[idx(x, y)] = id;
        // Auto-complete affordance: a gray pixel dropped flush against a
        // 3-long gold bar fills out the whole 3-cell body row. (The old
        // widen/deepen affordances went away with multi-size muxes.)
        if (color === 'gray') autoExtendMuxBody(x, y);
        recomputeRoles();
    }

    // Drawing affordance: the usual way to build a mux is to draw the gold
    // control bar, then tap once below it. Dropping a body (gray) pixel
    // flush against a straight, exactly-3-long, 1-thick gold bar fills out
    // the whole 3-cell body row, snapping to a complete, valid 2x3 mux from
    // a single pixel. Bars of any other length aren't a valid mux size, so
    // they get no autofill (the stray pixel just reads as invalid feedback).
    function autoExtendMuxBody(bx, by) {
        for (const [dx, dy] of DIRS) {
            const gx = bx + dx, gy = by + dy; // must land directly on the bar
            if (!isGoldId(getCell(gx, gy))) continue;
            const along = dy !== 0 ? [1, 0] : [0, 1];  // bar runs perpendicular to the walk
            let lo = 0, hi = 0;
            while (isGoldId(getCell(gx - along[0] * (lo + 1), gy - along[1] * (lo + 1)))) lo++;
            while (isGoldId(getCell(gx + along[0] * (hi + 1), gy + along[1] * (hi + 1)))) hi++;
            if (lo + hi + 1 !== 3) continue;
            // Require a 1-thick bar: no gold on either perpendicular side of the
            // run (a 2D gold blob isn't a control band and shouldn't autofill).
            let thin = true;
            for (let i = -lo; i <= hi && thin; i++) {
                const cx = gx + along[0] * i, cy = gy + along[1] * i;
                if (isGoldId(getCell(cx + dx, cy + dy)) || isGoldId(getCell(cx - dx, cy - dy))) thin = false;
            }
            if (!thin) continue;
            // Fill the body row across the bar's full extent. Skips a +V/-V
            // source cell (see processGoldBlob) — an already-meaningful cell
            // the sweep shouldn't silently clobber back to plain gray.
            for (let i = -lo; i <= hi; i++) {
                const cx = gx + along[0] * i - dx, cy = gy + along[1] * i - dy;
                if (!inBounds(cx, cy) || isLocked(cx, cy)) continue;
                const existing = getCell(cx, cy);
                if (existing === ID_POS || existing === ID_NEG) continue;
                setCellRaw(cx, cy, makeGray(OFF, false));
            }
            return;
        }
    }

    function colorOfCell(id) {
        if (isGoldId(id)) return 'gold';
        if (isGrayId(id)) return 'gray';
        if (id === ID_POS) return 'pos';
        if (id === ID_NEG) return 'neg';
        if (isLed(id)) return 'led';
        if (isSwitch(id)) return 'switch';
        if (isToggle(id)) return 'toggle';
        if (isConductorId(id) || isXover(id)) return 'conductor';
        return 'insulator';
    }

    // Flood the whole 8-connected pad the touched cell belongs to (same-kind
    // cells) to a target id, so a large button/pad acts as one.
    function floodPad(x, y, memberFn, target) {
        const stack = [[x, y]], seen = new Set([idx(x, y)]);
        while (stack.length) {
            const [cx, cy] = stack.pop();
            cells[idx(cx, cy)] = target;
            for (const [dx, dy] of NEIGHBORS_8) {
                const nx = cx + dx, ny = cy + dy;
                if (!inBounds(nx, ny) || seen.has(idx(nx, ny)) || !memberFn(cells[idx(nx, ny)])) continue;
                seen.add(idx(nx, ny));
                stack.push([nx, ny]);
            }
        }
    }

    // Momentary switch: press/release the whole pad. Toggle: flip the whole pad.
    // Both are interaction (not structural edits, so not recorded for undo).
    // Each returns true only if the touched cell was that kind.
    function setSwitch(x, y, pressed) {
        if (!inBounds(x, y) || !isSwitch(cells[idx(x, y)])) return false;
        floodPad(x, y, isSwitch, pressed ? ID_SWITCH_ON : ID_SWITCH_OFF);
        return true;
    }
    function toggleAt(x, y) {
        if (!inBounds(x, y) || !isToggle(cells[idx(x, y)])) return false;
        floodPad(x, y, isToggle, toggleIsOn(cells[idx(x, y)]) ? ID_TOGGLE_OFF : ID_TOGGLE_ON);
        return true;
    }
    // Absolute form of toggleAt, for driving a level's input pads to a test
    // vector: a flip would depend on where the previous case left the pad.
    function setToggle(x, y, on) {
        if (!inBounds(x, y) || !isToggle(cells[idx(x, y)])) return false;
        floodPad(x, y, isToggle, on ? ID_TOGGLE_ON : ID_TOGGLE_OFF);
        return true;
    }

    // ===== Mux macro detection =====
    //
    // A mux macro is a rectangle: a 1-pixel-deep control band (gold) of
    // width W>=3 flush against one full edge of a body band (gray) of the
    // same width and any depth D>=1. Corner control pixels (the band's two
    // ends) are the only ones that accept an external wire; whichever
    // corner currently has a wire attached is the live NO side. The body's
    // two end columns (1 pixel wide, D deep) are the switched NO/NC pins;
    // everything else in the body is COM (a (W-2) x D shared bus). This
    // works at any of the 4 orientations.
    //
    // Detection runs on the whole grid after every edit (grids here are
    // small enough - tens of columns - that a full rescan is cheap).

    const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N, E, S, W
    function axisOf(dx, dy) { return dx !== 0 ? AXIS_H : AXIS_V; }
    function neighborSpec(x, y, dx, dy) { return [x + dx, y + dy, axisOf(dx, dy)]; }

    function floodFill(x0, y0, matchFn, visited) {
        const stack = [[x0, y0]];
        const cellsOut = [];
        visited.add(idx(x0, y0));
        while (stack.length) {
            const [x, y] = stack.pop();
            cellsOut.push([x, y]);
            for (const [dx, dy] of DIRS) {
                const nx = x + dx, ny = y + dy;
                if (!inBounds(nx, ny)) continue;
                const ni = idx(nx, ny);
                if (visited.has(ni)) continue;
                if (!matchFn(nx, ny)) continue;
                visited.add(ni);
                stack.push([nx, ny]);
            }
        }
        return cellsOut;
    }

    function recomputeRoles() {
        roles.fill(null);
        const claimedGray = new Set(); // idx of gray cells claimed as end/comMiddle

        const goldVisited = new Set();
        for (let y = 0; y < GRID_H; y++) {
            for (let x = 0; x < GRID_W; x++) {
                const i = idx(x, y);
                if (goldVisited.has(i)) continue;
                if (!isGoldId(cells[i])) continue;
                const blob = floodFill(x, y, (nx, ny) => isGoldId(cells[idx(nx, ny)]), goldVisited);
                processGoldBlob(blob, claimedGray);
            }
        }

        const grayVisited = new Set();
        for (let y = 0; y < GRID_H; y++) {
            for (let x = 0; x < GRID_W; x++) {
                const i = idx(x, y);
                if (grayVisited.has(i) || claimedGray.has(i)) continue;
                if (!isGrayId(cells[i])) continue;
                const blob = floodFill(x, y, (nx, ny) => isGrayId(cells[idx(nx, ny)]) && !claimedGray.has(idx(nx, ny)), grayVisited);
                // Gray with no adjacent control band is either the second mux
                // style — a 3x2 box of body cells and nothing else (see
                // buildBoxMux) — or an isolated -V source. Gray that DOES
                // touch gold without forming a valid band mux is an inert
                // stray fragment; gold adjacency is also what keeps the two
                // mux styles from ever competing for the same pixels, so a
                // stray body row flush against a band mux still reads as the
                // mistake it is rather than silently becoming a box.
                const touchesGold = blob.some(([bx, by]) => DIRS.some(([dx, dy]) => isGoldId(getCell(bx + dx, by + dy))));
                if (!touchesGold && buildBoxMux(blob)) continue;
                const kind = touchesGold ? 'invalidGray' : 'isolatedGray';
                markBlob(blob, kind);
            }
        }
    }

    // ===== Box mux: the second mux style =====
    //
    // Six gray pixels in a 3x2 rectangle, touching no gold at all — the whole
    // device is body, with no control band. Which pixel is which terminal is
    // decided entirely by what is wired to it:
    //
    //                    COM
    //                     |
    //              +---+---+---+
    //       SEL ---|   |   |   |--- SEL      the COM-row corners
    //              +---+---+---+
    //              |   |   |   |
    //              +-+-+---+-+-+
    //                |         |
    //              NO/NC     NO/NC
    //
    //  - COM is the long side with a wire at its MIDDLE. That's the
    //    discriminator precisely because a working mux has its OTHER long
    //    side wired at the ENDS, so "which side has a wire" could never tell
    //    the two apart. Any wire along the COM side joins COM; only the
    //    middle one decides which side it is.
    //  - The two end cells of the opposite long side are the switched pins.
    //  - SEL goes on a SHORT side, at the one corner adjacent to the COM
    //    side — one cell per end, not the whole short side. The end SEL is
    //    wired to is NO, so select ON bridges the pin on SEL's own side and
    //    OFF bridges the far one: the same convention as the band mux, whose
    //    wired control corner also marks NO. Ties and nothing-wired default
    //    to the first end, again as the band mux. The pin row's short faces
    //    connect to nothing.
    //
    // The pin row's middle cell is an inert spacer that holds the sensed
    // select charge — with no gold cell to keep it in, the select would
    // otherwise have no state, and it is that stored bit that gives the
    // control the same one-tick delay every other signal here has.
    //
    // Everything downstream (node charges, the fill-wave animation, region
    // ops, rearrange) is shared with the band mux: the box's cells carry the
    // same 'end'/'comMiddle' roles, and rowStart/along/toward keep their band
    // meaning with d=0 the COM row and d=1 the pin row, so macroFootprint and
    // objectAt need no special case.
    function buildBoxMux(blob) {
        if (blob.length !== 6) return false;
        const xs = blob.map((c) => c[0]), ys = blob.map((c) => c[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = maxX - minX + 1, h = maxY - minY + 1;
        if (w * h !== 6) return false; // 6 cells filling a 6-cell bbox = solid 3x2
        const along = w === 3 ? [1, 0] : [0, 1];
        const perp = w === 3 ? [0, 1] : [1, 0];
        const neg = ([dx, dy]) => [-dx, -dy];
        const wiredAt = ([x, y], [dx, dy]) => {
            const nx = x + dx, ny = y + dy;
            return inBounds(nx, ny) && cells[idx(nx, ny)] !== ID_INSULATOR_PLAIN;
        };
        const gridAt = (i, d) => [minX + along[0] * i + perp[0] * d, minY + along[1] * i + perp[1] * d];

        const comIsNear = !(!wiredAt(gridAt(1, 0), neg(perp)) && wiredAt(gridAt(1, 1), perp));
        const toward = comIsNear ? perp : neg(perp); // COM row -> pin row
        const comOut = neg(toward);                  // COM's outward face
        const pinOut = toward;                       // the pins' outward face
        const rowStart = gridAt(0, comIsNear ? 0 : 1);
        const at = (i, d) => [rowStart[0] + along[0] * i + toward[0] * d,
                              rowStart[1] + along[1] * i + toward[1] * d];

        const macro = {
            kind: 'box',
            key: `box:${rowStart[0]},${rowStart[1]},${along[0]},${along[1]},${toward[0]},${toward[1]}`,
            rowStart, along, toward,
            selCell: at(1, 1),
            // One select contact per end: the COM-row corner's outward face.
            selFirst: neighborSpec(at(0, 0)[0], at(0, 0)[1], -along[0], -along[1]),
            selLast: neighborSpec(at(2, 0)[0], at(2, 0)[1], along[0], along[1]),
            nodes: {
                first: { cells: [], ext: [] },
                com: { cells: [], ext: [] },
                last: { cells: [], ext: [] },
            },
        };
        // A box cell's SEL faces lie along the long axis and its contact
        // faces across it, so the two are told apart by axis alone — which is
        // exactly what contribCharge is handed. Muting the long axis is what
        // keeps a select wire an INPUT: without it the pin/COM charge sitting
        // on the same cell would drive the select line straight back out.
        const mutedAxis = axisOf(along[0], along[1]);
        const gateAxis = axisOf(toward[0], toward[1]);

        for (let i = 0; i < 3; i++) {
            const [cx, cy] = at(i, 0);
            const ext = [neighborSpec(cx, cy, comOut[0], comOut[1])];
            macro.nodes.com.cells.push([cx, cy]);
            macro.nodes.com.ext.push(...ext);
            const sibs = [];
            if (i > 0) sibs.push(at(i - 1, 0));
            if (i < 2) sibs.push(at(i + 1, 0));
            roles[idx(cx, cy)] = {
                kind: 'comMiddle', macro, external: ext, sibs, mutedAxis,
                // COM's gate to a pin is the cell straight across from it;
                // the middle of the COM row faces the inert select spacer
                // and so has no gate at all.
                gates: i === 1 ? [] : [{ pos: at(i, 1), endIsFirst: i === 0, axis: gateAxis }],
            };
        }
        for (const i of [0, 2]) {
            const [px, py] = at(i, 1);
            const ext = [neighborSpec(px, py, pinOut[0], pinOut[1])];
            const node = i === 0 ? macro.nodes.first : macro.nodes.last;
            node.cells.push([px, py]);
            node.ext.push(...ext);
            roles[idx(px, py)] = {
                kind: 'end', macro, isFirst: i === 0, external: ext, sibs: [], mutedAxis,
                gates: [{ pos: at(i, 0), endIsFirst: i === 0, axis: gateAxis }],
            };
        }
        roles[idx(macro.selCell[0], macro.selCell[1])] = { kind: 'boxSel', macro };
        return true;
    }

    // The blob's own cell nearest its bounding-box center — used to pick one
    // representative cell to mark (e.g. the invalid-fragment "!") instead of
    // decorating every cell in a multi-pixel blob identically.
    function blobCenterCell(blob) {
        const xs = blob.map(c => c[0]), ys = blob.map(c => c[1]);
        const ccx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const ccy = (Math.min(...ys) + Math.max(...ys)) / 2;
        let best = blob[0], bestDist = Infinity;
        for (const [bx, by] of blob) {
            const d = (bx - ccx) ** 2 + (by - ccy) ** 2;
            if (d < bestDist) { bestDist = d; best = [bx, by]; }
        }
        return best;
    }

    function markBlob(blob, kind) {
        const [centerX, centerY] = blobCenterCell(blob);
        for (const [bx, by] of blob) {
            roles[idx(bx, by)] = { kind, size: blob.length, isCenter: bx === centerX && by === centerY };
        }
    }

    // Probes one perpendicular side of a control band for a valid body: the
    // single 3-cell row flush against it (a mux is exactly 2x3 — one 3-long
    // control band + one 3-long body row — the sweet-spot size; arbitrary
    // widths/depths were more complexity than they were worth).
    //
    // An end cell (the NO/NC pin) or the middle COM cell may be a +V/-V
    // source standing in for the pin (see the source-cell handling in
    // processGoldBlob) — but a sourced COM excludes sourced ends: with COM
    // welded to a rail, a sourced end would leave nothing to actually
    // switch, so that combination reads as a mistake and invalidates the
    // mux rather than being silently accepted. Every plain-gray body cell
    // must belong to no other macro and connect to no gray outside the row
    // — a stray gray flush against the body invalidates the mux instead of
    // silently deepening it, since deeper bodies no longer exist.
    function probeBody(rowStart, along, toward, claimedGray) {
        const grays = [];
        let endSources = 0, comSource = false;
        for (let i = 0; i < 3; i++) {
            const x = rowStart[0] + along[0] * i + toward[0];
            const y = rowStart[1] + along[1] * i + toward[1];
            if (!inBounds(x, y)) return false;
            const id = cells[idx(x, y)];
            if (id === ID_POS || id === ID_NEG) {
                if (i === 1) comSource = true; else endSources++;
                continue;
            }
            if (!isGrayId(id) || claimedGray.has(idx(x, y))) return false;
            grays.push([x, y]);
        }
        if (comSource && endSources > 0) return false;
        // Each gray's connected region must stay within the row's own gray
        // cells. Regions are per-component: a sourced COM splits the two
        // (gray) ends into separate single-cell components.
        const graySet = new Set(grays.map(([x, y]) => idx(x, y)));
        const free = (x, y) => inBounds(x, y) && isGrayId(cells[idx(x, y)]) && !claimedGray.has(idx(x, y));
        const visited = new Set();
        for (const [gx, gy] of grays) {
            if (visited.has(idx(gx, gy))) continue;
            const region = floodFill(gx, gy, free, visited);
            if (!region.every(([x, y]) => graySet.has(idx(x, y)))) return false;
        }
        return true;
    }

    function processGoldBlob(blob, claimedGray) {
        const xs = blob.map(c => c[0]), ys = blob.map(c => c[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = maxX - minX + 1, h = maxY - minY + 1;
        const isRect = blob.length === w * h;

        // Gold with no adjacent body at all is an isolated +V source; it only
        // reads as an incomplete mux fragment once it touches gray without
        // forming a valid one (handled below).
        const touchesGray = blob.some(([bx, by]) => DIRS.some(([dx, dy]) => isGrayId(getCell(bx + dx, by + dy))));
        if (!touchesGray) {
            markBlob(blob, 'isolatedGold');
            return;
        }

        if (!isRect || !((h === 1 && w === 3) || (w === 1 && h === 3))) {
            markBlob(blob, 'invalidGold');
            return;
        }

        const horizontal = h === 1;
        const along = horizontal ? [1, 0] : [0, 1];
        const rowStart = [minX, minY]; // control band's first (i=0) pixel

        // Try the body row on either perpendicular side.
        const perpOptions = horizontal ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
        const toward = perpOptions.find((p) => probeBody(rowStart, along, p, claimedGray)) || null;
        if (!toward) {
            markBlob(blob, 'invalidGold');
            return;
        }

        const macro = {
            key: `${rowStart[0]},${rowStart[1]},${along[0]},${along[1]},${toward[0]},${toward[1]}`,
            rowStart, along, toward,
            firstCorner: [rowStart[0], rowStart[1]],
            lastCorner: [rowStart[0] + along[0] * 2, rowStart[1] + along[1] * 2],
            // The body's three electrical nodes (first end, COM, last end):
            // cell positions and external contact specs. Node charges are
            // computed at this level each tick (the proven tile-mux
            // algorithm); cells only animate toward their node value.
            nodes: {
                first: { cells: [], ext: [] },
                com: { cells: [], ext: [] },
                last: { cells: [], ext: [] },
            },
        };
        // Macro-local coords: i along the band (0..2), d away from it
        // (0 = control band, 1 = the body row).
        const posAt = (i, d) => [rowStart[0] + along[0] * i + toward[0] * d, rowStart[1] + along[1] * i + toward[1] * d];

        for (let i = 0; i < 3; i++) {
            const [cx, cy] = posAt(i, 0);
            if (i === 1) { roles[idx(cx, cy)] = { kind: 'midSpacer', macro }; continue; }
            const isFirst = i === 0;
            // -along/along points outward along the row; -toward points away from body.
            const outAlong = isFirst ? [-along[0], -along[1]] : [along[0], along[1]];
            const outToward = [-toward[0], -toward[1]];
            roles[idx(cx, cy)] = {
                kind: 'corner',
                macro,
                isFirst,
                externalNeighbors: [
                    neighborSpec(cx, cy, outAlong[0], outAlong[1]),
                    neighborSpec(cx, cy, outToward[0], outToward[1]),
                ],
                cornerExternalDirs: [outAlong, outToward],
            };
        }

        for (let i = 0; i < 3; i++) {
            const [bx, by] = posAt(i, 1);
            const isEnd = i !== 1;
            const node = i === 0 ? macro.nodes.first : i === 1 ? macro.nodes.com : macro.nodes.last;
            const cid = cells[idx(bx, by)];

            // A body cell may be a +V/-V source standing in for the pin
            // (end) or for COM itself (see probeBody). It isn't simulated
            // as a body cell at all — nextState already treats a POS/NEG id
            // as fixed — so it's registered as one of the node's own
            // external drivers (exactly as if a real +V/-V cell were wired
            // directly against it) plus a fixed sourceCharge for
            // nodeCharge, and gets an endSource/comSource role purely for
            // the view to render.
            if (cid === ID_POS || cid === ID_NEG) {
                node.ext.push([bx, by, AXIS_H]);
                node.sourceCharge = cid === ID_POS ? ON : FALLING;
                roles[idx(bx, by)] = isEnd
                    ? { kind: 'endSource', macro, isFirst: i === 0, positive: cid === ID_POS }
                    : { kind: 'comSource', macro, positive: cid === ID_POS };
                continue;
            }

            node.cells.push([bx, by]);
            // A body cell's neighbors split into: `external` (out-of-macro
            // contacts, which feed the node-level charge computation) and
            // the cross-node gate boundary (end<->COM adjacency, which
            // seeds the cell-level fill wave — the visible flow).
            const external = [];
            const gates = [];
            for (const [dx, dy] of DIRS) {
                const nx = bx + dx, ny = by + dy;
                const ni = (nx - rowStart[0]) * along[0] + (ny - rowStart[1]) * along[1];
                const nd = (nx - rowStart[0]) * toward[0] + (ny - rowStart[1]) * toward[1];
                if (ni < 0 || ni > 2 || nd < 0 || nd > 1) {
                    const spec = neighborSpec(bx, by, dx, dy);
                    external.push(spec);
                    node.ext.push(spec);
                    continue;
                }
                if (nd === 0) continue; // control band: no electrical connection to body
                // The only in-body neighbors left are across the end<->COM
                // boundary. endIsFirst: which end that boundary belongs to
                // (the COM cell touches both ends, hence a list).
                gates.push({ pos: [nx, ny], endIsFirst: isEnd ? i === 0 : ni === 0, axis: axisOf(dx, dy) });
            }
            roles[idx(bx, by)] = isEnd
                ? { kind: 'end', macro, isFirst: i === 0, external, gates }
                : { kind: 'comMiddle', macro, external, gates };
            claimedGray.add(idx(bx, by));
        }
    }

    // ===== Per-tick macro control cache =====
    var macroControlCache = new Map();
    var macroControlCacheTick = -1;

    function isWired(pos, dirs) {
        for (const [dx, dy] of dirs) {
            const nx = pos[0] + dx, ny = pos[1] + dy;
            if (!inBounds(nx, ny)) continue;
            if (cells[idx(nx, ny)] !== ID_INSULATOR_PLAIN) return true;
        }
        return false;
    }

    // Whether a neighbor spec holds something (anything) — the box mux's
    // form of isWired, over an absolute position rather than a cell's own
    // directions, since its select contact is on a specific corner.
    function specWired([nx, ny]) {
        return inBounds(nx, ny) && cells[idx(nx, ny)] !== ID_INSULATOR_PLAIN;
    }

    // liveIsFirst: which end the drawn control wiring points at — the NO end
    // in both mux styles, so control ON bridges it and OFF bridges the other
    // (NC). controlOn: that control's own stored charge, one tick behind its
    // input wire like every signal here — a band mux keeps it on the live
    // gold corner, a box mux on its select spacer. activeIsFirst folds the
    // two together into the single fact the body update needs: which end is
    // bridged to COM this tick.
    function getMacroControl(macro) {
        if (macroControlCacheTick !== tickCount) { macroControlCache.clear(); macroControlCacheTick = tickCount; }
        let v = macroControlCache.get(macro.key);
        if (v) return v;
        let liveIsFirst, controlOn;
        if (macro.kind === 'box') {
            liveIsFirst = !(!specWired(macro.selFirst) && specWired(macro.selLast));
            const selId = cells[idx(macro.selCell[0], macro.selCell[1])];
            controlOn = isGrayId(selId) && grayCharge(selId) === ON;
        } else {
            const firstRole = roles[idx(macro.firstCorner[0], macro.firstCorner[1])];
            const lastRole = roles[idx(macro.lastCorner[0], macro.lastCorner[1])];
            const firstWired = isWired(macro.firstCorner, firstRole.cornerExternalDirs);
            const lastWired = isWired(macro.lastCorner, lastRole.cornerExternalDirs);
            liveIsFirst = !(!firstWired && lastWired);
            const liveCornerPos = liveIsFirst ? macro.firstCorner : macro.lastCorner;
            const liveId = cells[idx(liveCornerPos[0], liveCornerPos[1])];
            controlOn = isGoldId(liveId) && goldCharge(liveId) === ON;
        }
        v = { liveIsFirst, controlOn, activeIsFirst: controlOn ? liveIsFirst : !liveIsFirst };
        macroControlCache.set(macro.key, v);
        return v;
    }

    // ===== Generic charge contribution (what a cell reports to a neighbor) =====
    function contribCharge(x, y, axis) {
        if (!inBounds(x, y)) return OFF;
        const id = cells[idx(x, y)];
        if (isConductorId(id)) return conductorCharge(id);
        // A crossover reports its vertical charge to N/S queries and its
        // horizontal charge to E/W queries, keeping the two axes separate.
        if (isXover(id)) return axis === AXIS_V ? xoverV(id) : xoverH(id);
        if (id === ID_POS) return ON;
        if (id === ID_NEG) return FALLING;
        // Switch (momentary) and toggle (latching) both drive +V when on and
        // pull down (-V) when off.
        if (isSwitch(id)) return switchIsPressed(id) ? ON : FALLING;
        if (isToggle(id)) return toggleIsOn(id) ? ON : FALLING;
        if (isLed(id)) return OFF; // output sink, never drives
        if (isGoldId(id) || isGrayId(id)) {
            const role = roles[idx(x, y)];
            if (!role) return OFF;
            switch (role.kind) {
                case 'corner': return goldCharge(id);
                case 'end': case 'comMiddle':
                    // A box mux's select faces share their cells with a pin
                    // or with COM, and are told apart by axis (see
                    // buildBoxMux): report nothing along the select axis, so
                    // the select line stays an input rather than being
                    // driven by the very node it switches.
                    if (role.mutedAxis !== undefined && role.mutedAxis === axis) return OFF;
                    return grayCharge(id);
                case 'isolatedGold': return ON;
                case 'isolatedGray': return FALLING;
                default: return OFF; // midSpacer, invalidGold, invalidGray
            }
        }
        return OFF;
    }

    // ===== Per-cell-kind next-state =====
    // Handles both plain conductors and crossovers, since which one a wire cell
    // is depends only on its neighbors (isCrossoverAt) and can flip when the
    // user edits an adjacent cell. A crossover keeps N<->S and E<->W separate;
    // a plain conductor is one node taking charge from all four sides.
    function nextConductor(x, y, id) {
        const n = contribCharge(x, y - 1, AXIS_V);
        const e = contribCharge(x + 1, y, AXIS_H);
        const s = contribCharge(x, y + 1, AXIS_V);
        const w = contribCharge(x - 1, y, AXIS_H);
        if (isCrossoverAt(x, y)) {
            const vOld = isXover(id) ? xoverV(id) : isConductorId(id) ? conductorCharge(id) : OFF;
            const hOld = isXover(id) ? xoverH(id) : isConductorId(id) ? conductorCharge(id) : OFF;
            return makeXover(nextCharge(vOld, n, OFF, s, OFF), nextCharge(hOld, OFF, e, OFF, w));
        }
        const cOld = isXover(id) ? combineCharge(xoverV(id), xoverH(id)) : conductorCharge(id);
        return makeConductor(nextCharge(cOld, n, e, s, w));
    }

    function nextGold(x, y, id) {
        const role = roles[idx(x, y)];
        if (!role) return id;
        if (role.kind === 'isolatedGold') return id; // fixed +V source, not simulated
        if (role.kind === 'invalidGold' || role.kind === 'midSpacer') return makeGold(OFF, false);
        if (role.kind === 'corner') {
            const c = role.externalNeighbors.map(([nx, ny, axis]) => contribCharge(nx, ny, axis));
            const newCharge = nextCharge(goldCharge(id), c[0], c[1], OFF, OFF);
            return makeGold(newCharge, false);
        }
        return id;
    }

    // ===== Body node charges (the proven tile-mux algorithm) =====
    //
    // The body's charge TRUTH lives at the level of its three electrical
    // nodes — first end, COM, last end — computed each tick with single
    // nextCharge steps exactly like simulation/pixelogic's mux2 (which stores
    // westCharge/eastCharge/comCharge on its anchor): the active end reads
    // its externals + COM (isolated for one break-before-make tick after a
    // switch), the inactive end reads only its externals, and COM reads the
    // active end + its externals, with a FALLING injected when switching away
    // from a charged end so COM drains instead of latching. Cells then merely
    // ANIMATE toward their node's value (fill spreads as a wavefront, drain
    // fades), so the visible flow is kept but cells cannot sustain dynamics
    // of their own — no circulating electrons, no sticky half-drained nodes.
    var macroBodyCache = new Map();
    var macroBodyCacheTick = -1;

    // A node's current charge, derived from its cells (ON if any cell is ON,
    // else FALLING if any is falling). Derived rather than stored so it
    // survives serialize/undo/paste for free. A node with a corner-source
    // override (see processGoldBlob) reports that fixed value directly
    // instead — its cells array may even be empty (a depth-1 end entirely
    // consumed by the source cell), and regardless of depth the override IS
    // the node's true electrical value, not something to infer from cells
    // that are themselves only animating toward it.
    function nodeCharge(node) {
        if (node.sourceCharge !== undefined) return node.sourceCharge;
        let v = OFF;
        for (const [cx, cy] of node.cells) {
            const c = grayCharge(cells[idx(cx, cy)]);
            if (c === ON) return ON;
            if (c === FALLING) v = FALLING;
        }
        return v;
    }

    function getMacroBody(macro) {
        if (macroBodyCacheTick !== tickCount) { macroBodyCache.clear(); macroBodyCacheTick = tickCount; }
        let v = macroBodyCache.get(macro.key);
        if (v) return v;
        const { activeIsFirst } = getMacroControl(macro);
        const first = macro.nodes.first, last = macro.nodes.last, com = macro.nodes.com;
        // wasActive is tracked on whichever node still has an animated gray
        // cell — a sourced cell can't hold it. Prefer COM (nextComMiddle
        // stores activeIsFirst in its otherwise-unused wasActive bit); when
        // COM itself is a source both ends are guaranteed gray (probeBody
        // rejects source-COM + source-end), and an end's own bit encodes
        // the same fact: nextEnd stores isActive, and for the first end
        // isActive === activeIsFirst.
        const wasCell = com.cells.length ? com.cells[0] : first.cells[0];
        const wasFirstActive = grayWasActive(cells[idx(wasCell[0], wasCell[1])]);
        const justSwitched = wasFirstActive !== activeIsFirst;
        const extIn = (node) => node.ext.map(([nx, ny, axis]) => contribCharge(nx, ny, axis));
        const firstCur = nodeCharge(first), lastCur = nodeCharge(last), comCur = nodeCharge(com);
        const aCur = activeIsFirst ? firstCur : lastCur;
        const iCur = activeIsFirst ? lastCur : firstCur;
        // Active end: externals + COM through the open gate (closed on the
        // switching tick). Inactive end: externals only.
        const aNext = nextChargeN(aCur, extIn(activeIsFirst ? first : last).concat(justSwitched ? [] : [comCur]));
        const iNext = nextChargeN(iCur, extIn(activeIsFirst ? last : first));
        // COM: the active end's charge, with the break-before-make falling
        // injection when switching away from a charged end.
        let pinVal = aCur;
        if (justSwitched && iCur === ON && pinVal !== ON) pinVal = FALLING;
        const comNext = nextChargeN(comCur, [pinVal].concat(extIn(com)));
        v = {
            activeIsFirst,
            firstNext: activeIsFirst ? aNext : iNext,
            lastNext: activeIsFirst ? iNext : aNext,
            comNext,
        };
        macroBodyCache.set(macro.key, v);
        return v;
    }

    // Animate one body cell toward its node's next value. Filling spreads as
    // a wave: an OFF cell lights only when adjacent to something already ON
    // (a same-node cell, an external contact, or the cell across an open
    // gate), so charge visibly flows in from where it actually enters.
    // Draining is a fade: ON -> FALLING -> OFF.
    function relaxBodyCell(id, role, target, gateOpen) {
        const cur = grayCharge(id);
        if (target !== ON) return cur === ON ? FALLING : OFF;
        if (cur === ON) return ON;
        if (cur === FALLING) return OFF;
        const seedOn = ([nx, ny, axis]) => contribCharge(nx, ny, axis) === ON;
        if (role.external.some(seedOn)) return ON;
        // Same-node neighbors (a box mux's COM row is three cells; every
        // band-mux node is a single cell, so this is empty there). Read
        // directly rather than through contribCharge, which deliberately
        // reports nothing along a box cell's select axis — and that axis is
        // exactly the one the COM row's own cells sit on.
        if (role.sibs && role.sibs.some(([nx, ny]) => grayCharge(cells[idx(nx, ny)]) === ON)) return ON;
        for (const g of role.gates) {
            if (!gateOpen(g)) continue;
            // contribCharge (not a raw isGrayId/grayCharge read) so a gate
            // that leads to a source cell (see processGoldBlob) is
            // recognized too — its id is +V/-V, not gray, but contribCharge
            // already dispatches on that correctly for every cell type.
            if (contribCharge(g.pos[0], g.pos[1], g.axis) === ON) return ON;
        }
        return OFF;
    }

    function nextEnd(x, y, id, role) {
        const body = getMacroBody(role.macro);
        const isActive = role.isFirst === body.activeIsFirst;
        const target = role.isFirst ? body.firstNext : body.lastNext;
        // This end's gate to COM is open only while the end is active.
        const charge = relaxBodyCell(id, role, target, () => isActive);
        return makeGray(charge, isActive);
    }

    function nextComMiddle(x, y, id, role) {
        const body = getMacroBody(role.macro);
        // A COM cell's gate to an end is open only toward the active end.
        const charge = relaxBodyCell(id, role, body.comNext, (g) => g.endIsFirst === body.activeIsFirst);
        // COM's own wasActive bit doesn't mean anything to COM itself, but
        // getMacroBody reads it (off any COM cell, always populated) as the
        // macro-wide "was first active" memory instead of an end's own bit,
        // since an end can be entirely corner-sourced with no cells of its
        // own to hold it.
        return makeGray(charge, body.activeIsFirst);
    }

    // A box mux's select-sense spacer: the stand-in for the band mux's gold
    // control corner. It drives nothing (contribCharge reports OFF for it)
    // and only ever reads the LIVE end's select contact, so wiring both ends
    // leaves the dead one ignored rather than ORed in.
    function nextBoxSel(id, role) {
        const { liveIsFirst } = getMacroControl(role.macro);
        const [nx, ny, axis] = liveIsFirst ? role.macro.selFirst : role.macro.selLast;
        return makeGray(nextCharge(grayCharge(id), contribCharge(nx, ny, axis), OFF, OFF, OFF), false);
    }

    function nextGray(x, y, id) {
        const role = roles[idx(x, y)];
        if (!role) return id;
        if (role.kind === 'isolatedGray') return id; // fixed -V source, not simulated
        if (role.kind === 'invalidGray') return makeGray(OFF, false);
        if (role.kind === 'end') return nextEnd(x, y, id, role);
        if (role.kind === 'comMiddle') return nextComMiddle(x, y, id, role);
        if (role.kind === 'boxSel') return nextBoxSel(id, role);
        return id;
    }

    // Output LED. A pure sink (contribCharge returns OFF, so it never loads a
    // wire), but LED cells spread charge to each other over the 8-neighborhood
    // so a multi-cell pad lights and drains as one square. External drive is
    // read from orthogonal non-LED neighbors (wires/sources/mux) as usual; the
    // 3-state charge lets a pad drain when its driver falls instead of latching.
    function nextLed(x, y, id) {
        const inputs = [];
        for (const [dx, dy] of NEIGHBORS_8) {
            const nid = getCell(x + dx, y + dy);
            if (isLed(nid)) inputs.push(ledCharge(nid));
        }
        const n = getCell(x, y - 1), e = getCell(x + 1, y), s = getCell(x, y + 1), w = getCell(x - 1, y);
        if (!isLed(n)) inputs.push(contribCharge(x, y - 1, AXIS_V));
        if (!isLed(e)) inputs.push(contribCharge(x + 1, y, AXIS_H));
        if (!isLed(s)) inputs.push(contribCharge(x, y + 1, AXIS_V));
        if (!isLed(w)) inputs.push(contribCharge(x - 1, y, AXIS_H));
        return makeLed(nextChargeN(ledCharge(id), inputs));
    }

    function nextState(x, y) {
        const id = cells[idx(x, y)];
        if (isConductorId(id) || isXover(id)) return nextConductor(x, y, id);
        if (id === ID_POS || id === ID_NEG || isSwitch(id) || isToggle(id)) return id; // fixed / set by interaction
        if (isLed(id)) return nextLed(x, y, id);
        if (isGoldId(id)) return nextGold(x, y, id);
        if (isGrayId(id)) return nextGray(x, y, id);
        return id; // insulator (inert)
    }

    function stepSimulation() {
        for (let y = 0; y < GRID_H; y++)
            for (let x = 0; x < GRID_W; x++)
                nextCells[idx(x, y)] = nextState(x, y);
        const tmp = cells; cells = nextCells; nextCells = tmp;
        tickCount++;
    }

    // Reallocate the cell arrays at a new size, copying existing content offset
    // by (offX, offY). Used both by auto-expansion and by load/undo restoring a
    // different size.
    function resizeGrid(newW, newH, offX, offY, keepContent) {
        const oldW = GRID_W, oldH = GRID_H, old = cells, oldLocked = locked;
        const newCells = new Uint8Array(newW * newH); // 0 = insulator
        const newLocked = new Uint8Array(newW * newH);
        if (keepContent) {
            for (let y = 0; y < oldH; y++)
                for (let x = 0; x < oldW; x++) {
                    newCells[(y + offY) * newW + (x + offX)] = old[y * oldW + x];
                    newLocked[(y + offY) * newW + (x + offX)] = oldLocked[y * oldW + x];
                }
        } else {
            anyLocked = false; // a wholesale reload brings its own locks, if any
        }
        cells = newCells;
        locked = newLocked;
        nextCells = new Uint8Array(newW * newH);
        roles = new Array(newW * newH).fill(null);
        GRID_W = newW; GRID_H = newH;
    }

    // Auto-grow the grid so drawn content always keeps a 1-cell empty border.
    // Returns how much was added on each side; {left, top} is how far existing
    // content shifted, which the view uses to compensate pan so the drawing
    // doesn't appear to move.
    function expandForBorder() {
        let left = 0, top = 0, right = 0, bottom = 0;
        for (let y = 0; y < GRID_H; y++) {
            if (cells[idx(0, y)] !== ID_INSULATOR_PLAIN) left = 1;
            if (cells[idx(GRID_W - 1, y)] !== ID_INSULATOR_PLAIN) right = 1;
        }
        for (let x = 0; x < GRID_W; x++) {
            if (cells[idx(x, 0)] !== ID_INSULATOR_PLAIN) top = 1;
            if (cells[idx(x, GRID_H - 1)] !== ID_INSULATOR_PLAIN) bottom = 1;
        }
        if (left || top || right || bottom) {
            resizeGrid(GRID_W + left + right, GRID_H + top + bottom, left, top, true);
            recomputeRoles();
        }
        return { left, top, right, bottom };
    }

    // With locks in play (a campaign level) "clear" means "clear what the
    // player drew": the board keeps its size and its fixed I/O pads, so
    // starting over doesn't destroy the level's terminals. In the sandbox
    // there are no locks and this is the original full reset.
    function clearGrid() {
        if (anyLocked) {
            for (let i = 0; i < cells.length; i++)
                if (locked[i] !== 1) cells[i] = ID_INSULATOR_PLAIN;
        } else {
            resizeGrid(DEFAULT_W, DEFAULT_H, 0, 0, false);
        }
        tickCount = 0;
        recomputeRoles();
    }

    function resetCharges() {
        for (let i = 0; i < cells.length; i++) {
            const id = cells[i];
            // Crossovers collapse to a plain conductor; the next tick re-derives
            // the crossover form from geometry.
            if (isConductorId(id) || isXover(id)) cells[i] = makeConductor(OFF);
            else if (isGoldId(id)) cells[i] = makeGold(OFF, false);
            else if (isGrayId(id)) cells[i] = makeGray(OFF, false);
            else if (isLed(id)) cells[i] = makeLed(OFF);
            else if (isSwitch(id)) cells[i] = ID_SWITCH_OFF;
            else if (isToggle(id)) cells[i] = ID_TOGGLE_OFF;
        }
        tickCount = 0;
        recomputeRoles();
    }

    // ===== Region editing (selection / clipboard / undo support) =====
    //
    // Structural form = the cell with simulation-computed charge stripped.
    // Crossovers strip to a plain OFF conductor: their crossover-ness is
    // emergent from neighbors (also captured in the snapshot), so it's
    // re-derived on the next tick. Undo snapshots and clipboard clips both use
    // this, so stepping never creates bogus undo steps and pasting duplicates
    // the drawing, not a frozen instant of mid-flight charge.
    function stripId(id) {
        if (isConductorId(id) || isXover(id)) return makeConductor(OFF);
        if (isGoldId(id)) return makeGold(OFF, false);
        if (isGrayId(id)) return makeGray(OFF, false);
        if (isLed(id)) return makeLed(OFF);    // lit state is transient, like charge
        if (isSwitch(id)) return ID_SWITCH_OFF; // pressed state is transient too
        if (isToggle(id)) return ID_TOGGLE_OFF; // latched state resets on copy/undo baseline
        return isValidId(id) ? id : ID_INSULATOR_PLAIN;
    }

    function isValidId(id) {
        return id === ID_INSULATOR_PLAIN || (id >= ID_CONDUCTOR_BASE && id <= ID_TOGGLE_ON);
    }

    function getStructuralSnapshot() {
        const data = new Uint8Array(cells.length);
        for (let i = 0; i < cells.length; i++) data[i] = stripId(cells[i]);
        return { w: GRID_W, h: GRID_H, data };
    }

    // When the grid size is unchanged, only touch cells whose structure differs,
    // so unchanged cells keep their live charge instead of flashing back to
    // charge-OFF. When the size differs (undo/redo across an auto-expand),
    // reallocate to the snapshot's size and restore it wholesale.
    function restoreStructuralSnapshot(snap) {
        if (snap.w === GRID_W && snap.h === GRID_H) {
            for (let i = 0; i < cells.length; i++) {
                if (stripId(cells[i]) !== snap.data[i]) cells[i] = snap.data[i];
            }
        } else {
            resizeGrid(snap.w, snap.h, 0, 0, false);
            cells.set(snap.data);
        }
        recomputeRoles();
    }

    function normalizeRect(x0, y0, x1, y1) {
        if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
        if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
        return {
            x0: Math.max(0, Math.min(GRID_W - 1, x0)),
            y0: Math.max(0, Math.min(GRID_H - 1, y0)),
            x1: Math.max(0, Math.min(GRID_W - 1, x1)),
            y1: Math.max(0, Math.min(GRID_H - 1, y1)),
        };
    }

    function copyRegion(x0, y0, x1, y1) {
        const r = normalizeRect(x0, y0, x1, y1);
        const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
        const data = new Uint8Array(w * h);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
                data[y * w + x] = stripId(cells[idx(r.x0 + x, r.y0 + y)]);
        return { w, h, data };
    }

    function clearRegion(x0, y0, x1, y1) {
        const r = normalizeRect(x0, y0, x1, y1);
        for (let y = r.y0; y <= r.y1; y++)
            for (let x = r.x0; x <= r.x1; x++)
                if (!isLocked(x, y)) cells[idx(x, y)] = ID_INSULATOR_PLAIN;
        recomputeRoles();
    }

    // Writes a clip (from copyRegion, or a stored component) with its
    // top-left corner at (x0, y0), silently clipping whatever falls outside
    // the grid. Data is re-stripped on the way in since components come
    // back from localStorage as untrusted plain arrays.
    function pasteRegion(clip, x0, y0) {
        for (let y = 0; y < clip.h; y++) {
            const gy = y0 + y;
            if (gy < 0 || gy >= GRID_H) continue;
            for (let x = 0; x < clip.w; x++) {
                const gx = x0 + x;
                if (gx < 0 || gx >= GRID_W || isLocked(gx, gy)) continue;
                cells[idx(gx, gy)] = stripId(clip.data[y * clip.w + x] & 0xff);
            }
        }
        recomputeRoles();
    }

    // Region rotate/mirror are pure pixel moves — cells here have no stored
    // orientation (mux orientation is an emergent property of the pixel
    // pattern), so unlike simulation/pixelogic there is no per-cell
    // reorientation step. Rotation keeps the region's top-left anchor and
    // swaps its w/h; the new bounds (clipped to the grid) are returned so
    // the caller can update its selection.
    // A region holding any locked cell can't be rotated or mirrored: the
    // transform would slide a fixed I/O pad off its coordinates. Refusing the
    // whole operation is the honest answer — silently transforming everything
    // *except* the pad would scramble the circuit around it.
    function regionHasLocked(r) {
        if (!anyLocked) return false;
        for (let y = r.y0; y <= r.y1; y++)
            for (let x = r.x0; x <= r.x1; x++)
                if (locked[idx(x, y)] === 1) return true;
        return false;
    }

    function rotateRegionCW(x0, y0, x1, y1) {
        const r = normalizeRect(x0, y0, x1, y1);
        if (regionHasLocked(r)) return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
        const clip = copyRegion(r.x0, r.y0, r.x1, r.y1);
        for (let y = r.y0; y <= r.y1; y++)
            for (let x = r.x0; x <= r.x1; x++)
                cells[idx(x, y)] = ID_INSULATOR_PLAIN;
        for (let y = 0; y < clip.h; y++) {
            for (let x = 0; x < clip.w; x++) {
                const gx = r.x0 + (clip.h - 1 - y), gy = r.y0 + x;
                if (!inBounds(gx, gy)) continue;
                cells[idx(gx, gy)] = clip.data[y * clip.w + x];
            }
        }
        recomputeRoles();
        return {
            x0: r.x0, y0: r.y0,
            x1: Math.min(GRID_W - 1, r.x0 + clip.h - 1),
            y1: Math.min(GRID_H - 1, r.y0 + clip.w - 1),
        };
    }

    function mirrorRegionH(x0, y0, x1, y1) {
        const r = normalizeRect(x0, y0, x1, y1);
        if (regionHasLocked(r)) return;
        for (let y = r.y0; y <= r.y1; y++) {
            for (let lo = r.x0, hi = r.x1; lo <= hi; lo++, hi--) {
                const a = stripId(cells[idx(lo, y)]), b = stripId(cells[idx(hi, y)]);
                cells[idx(lo, y)] = b;
                cells[idx(hi, y)] = a;
            }
        }
        recomputeRoles();
    }

    // ===== Rearrange: whole-object move/rotate that keeps connectivity =====
    //
    // objectAt identifies the movable "object" under a cell at the
    // granularity a user actually thinks in: a whole 2x3 mux macro
    // (including any +V/-V cells standing in for its pins), an isolated or
    // invalid gold/gray blob, an LED/switch/toggle pad (8-connected,
    // matching how pads light/press as one), a lone +V/-V cell, or — for
    // wires — the straight SEGMENT under the cursor (see wireSegmentAt),
    // not the whole net: rearranging is about nudging one run at a time,
    // with the rest of the net stretching/rerouting to follow.

    function flood8(x0, y0, memberFn) {
        const stack = [[x0, y0]], seen = new Set([idx(x0, y0)]), out = [];
        while (stack.length) {
            const [x, y] = stack.pop();
            out.push([x, y]);
            for (const [dx, dy] of NEIGHBORS_8) {
                const nx = x + dx, ny = y + dy;
                if (!inBounds(nx, ny) || seen.has(idx(nx, ny)) || !memberFn(cells[idx(nx, ny)])) continue;
                seen.add(idx(nx, ny));
                stack.push([nx, ny]);
            }
        }
        return out;
    }

    function macroFootprint(macro) {
        const out = [];
        for (let i = 0; i < 3; i++) {
            const gx = macro.rowStart[0] + macro.along[0] * i, gy = macro.rowStart[1] + macro.along[1] * i;
            out.push([gx, gy], [gx + macro.toward[0], gy + macro.toward[1]]);
        }
        return out;
    }

    // The wire "object" a click grabs: not the whole 4-connected net (too
    // coarse to rearrange with), but the maximal STRAIGHT run of wire cells
    // through the clicked cell — including any elbow/tee cell it ends on, so
    // dragging a run perpendicular takes its corners along and the adjoining
    // legs stretch/shrink via re-routing. Runs stop at crossovers: a crossing
    // cell carries two separate nets, so it can't ride along with either;
    // clicking the crossover itself grabs just that one cell. At a corner or
    // tee the busier axis wins (ties go horizontal) — click one cell over to
    // get the other leg.
    function wireSegmentAt(x, y) {
        if (isCrossoverAt(x, y)) return [[x, y]];
        const wireAt = (ax, ay) => isWireId(getCell(ax, ay));
        const hc = (wireAt(x - 1, y) ? 1 : 0) + (wireAt(x + 1, y) ? 1 : 0);
        const vc = (wireAt(x, y - 1) ? 1 : 0) + (wireAt(x, y + 1) ? 1 : 0);
        const axis = vc > hc ? [0, 1] : [1, 0];
        const out = [[x, y]];
        for (const s of [-1, 1]) {
            let cx = x + axis[0] * s, cy = y + axis[1] * s;
            while (isWireId(getCell(cx, cy)) && !isCrossoverAt(cx, cy)) {
                out.push([cx, cy]);
                cx += axis[0] * s;
                cy += axis[1] * s;
            }
        }
        return out;
    }

    function objectAt(x, y) {
        if (!inBounds(x, y)) return null;
        const id = cells[idx(x, y)];
        if (isInsulatorId(id)) return null;
        const role = roles[idx(x, y)];
        if (role && role.macro) return { kind: 'mux', cells: macroFootprint(role.macro) };
        if (id === ID_POS || id === ID_NEG) return { kind: 'source', cells: [[x, y]] };
        if (isWireId(id)) return { kind: 'wire', cells: wireSegmentAt(x, y) };
        if (isGoldId(id)) return { kind: 'blob', cells: floodFill(x, y, (nx, ny) => isGoldId(cells[idx(nx, ny)]), new Set()) };
        if (isGrayId(id)) return { kind: 'blob', cells: floodFill(x, y, (nx, ny) => isGrayId(cells[idx(nx, ny)]), new Set()) };
        if (isLed(id)) return { kind: 'pad', cells: flood8(x, y, isLed) };
        if (isSwitch(id)) return { kind: 'pad', cells: flood8(x, y, isSwitch) };
        if (isToggle(id)) return { kind: 'pad', cells: flood8(x, y, isToggle) };
        return null;
    }

    // Rigid transform for a move gesture: rotate quarterTurns times 90° CW
    // about the object's bounding-box center (the bbox's w/h swap and the
    // center is kept put, rounded on half-cell ties), then translate. Cells
    // here carry no orientation of their own — a mux's orientation is
    // emergent from the pixel pattern — so moving the pixels IS the whole
    // transform.
    function transformObjectCells(objCells, dx, dy, quarterTurns) {
        let pts = objCells.map(([x, y]) => [x, y]);
        const q = ((quarterTurns % 4) + 4) % 4;
        for (let i = 0; i < q; i++) {
            const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const w = maxX - minX + 1, h = maxY - minY + 1;
            const nMinX = Math.round((minX + maxX) / 2 - (h - 1) / 2);
            const nMinY = Math.round((minY + maxY) / 2 - (w - 1) / 2);
            pts = pts.map(([x, y]) => [nMinX + (maxY - y), nMinY + (x - minX)]);
        }
        return pts.map(([x, y]) => [x + dx, y + dy]);
    }

    // The electrical net reachable from a wire cell, walked over the CURRENT
    // grid (call after lifting the object, so the walk sees only the
    // stationary world): plain conductors spread all four ways, a crossover
    // only passes straight through (its two axes are separate nets), and
    // every non-wire connecting neighbor is recorded as a terminal
    // (pin/pad/source) rather than entered. Crossover cells are
    // pass-throughs, not members — you can't attach to one axis of a
    // crossover by adjacency anyway. (entryDx/entryDy: the direction the
    // walk enters the first cell with, in case that cell is itself a
    // crossover.)
    function floodNet(ax, ay, entryDx, entryDy) {
        const cellsOut = new Set(), terminals = new Set(), seen = new Set();
        const stack = [[ax, ay, entryDx, entryDy]];
        while (stack.length) {
            const [x, y, dx2, dy2] = stack.pop();
            if (!inBounds(x, y)) continue;
            const i = idx(x, y);
            if (!isWireId(cells[i])) {
                if (cellConnects(x, y)) terminals.add(i);
                continue;
            }
            if (isCrossoverAt(x, y)) {
                const k = i + (dx2 !== 0 ? ':h' : ':v');
                if (seen.has(k)) continue;
                seen.add(k);
                stack.push([x + dx2, y + dy2, dx2, dy2]);
                continue;
            }
            if (seen.has(i)) continue;
            seen.add(i);
            cellsOut.add(i);
            for (const [ddx, ddy] of DIRS) stack.push([x + ddx, y + ddy, ddx, ddy]);
        }
        let min = Infinity;
        for (const i of cellsOut) if (i < min) min = i;
        if (min === Infinity) for (const i of terminals) if (i < min) min = i;
        return {
            key: 'w' + (min === Infinity ? idx(ax, ay) : min), cells: cellsOut, terminals,
            isNet: true, preTouch: new Set(), routed: new Set(), failed: false,
        };
    }

    // The stationary electrical node a non-wire contact belongs to: a pad
    // (LED/switch/toggle) is its whole 8-connected clump, anything else —
    // a mux pin, a source — is its own single cell.
    function anchorNode(ax, ay) {
        const id = cells[idx(ax, ay)];
        const pad = isLed(id) ? isLed : isSwitch(id) ? isSwitch : isToggle(id) ? isToggle : null;
        // isNet:false — these carry no wire of their own, so the shrink pass
        // has nothing to prune here.
        const extra = { isNet: false, preTouch: new Set(), routed: new Set(), failed: false };
        if (!pad) return Object.assign({ key: 'n' + idx(ax, ay), cells: new Set([idx(ax, ay)]), terminals: new Set() }, extra);
        const set = new Set(flood8(ax, ay, pad).map(([x, y]) => idx(x, y)));
        let min = Infinity;
        for (const i of set) if (i < min) min = i;
        return Object.assign({ key: 'p' + min, cells: set, terminals: new Set() }, extra);
    }

    // Which cells of a net are surplus to requirement: everything whose
    // removal still leaves every anchor it has to tie together mutually
    // connected. That covers dead ends (a tail's removal disconnects
    // nothing) AND redundant loops — a doubled-back run where each cell has
    // two neighbours, so pure leaf-pruning can never unpick it, which is
    // what a drag alongside a net's own wire used to leave behind.
    //
    // Removal is farthest-anchor-first so that when a loop is broken it's
    // the long way round that goes and the direct connection that stays.
    // The result is irreducible rather than provably minimal — good enough,
    // and it can't disconnect anything by construction. Cells in `keep` are
    // never removed and must stay reachable, so a stub the user drew (or a
    // loop they drew) survives with its connection to the net intact.
    // Pure analysis — the caller decides what to actually erase.
    function reduceNet(netSet, requiredSet, keep, nodeId) {
        const live = new Set(netSet);
        const held = new Set([...(keep || [])].filter((ci) => live.has(ci)));
        const removed = new Set();
        const neighborsIn = (ci, set) => {
            const x = ci % GRID_W, y = (ci - x) / GRID_W, out = [];
            for (const [dx2, dy2] of DIRS) {
                const nx = x + dx2, ny = y + dy2;
                if (!inBounds(nx, ny)) continue;
                if (set.has(idx(nx, ny))) { out.push(idx(nx, ny)); continue; }
                // A crossover belonging to some OTHER net is a pass-through:
                // the cell straight beyond it continues this same axis of
                // this net. Without this a route that crosses something reads
                // as two disconnected halves and gets reduced away as joining
                // nothing to nothing. Restricted to cells outside this net,
                // since a 4-way junction of the net's own wire is an ordinary
                // member here, not a bridge to jump over.
                if (!netSet.has(idx(nx, ny)) && isCrossoverAt(nx, ny)) {
                    const fx = nx + dx2, fy = ny + dy2;
                    if (inBounds(fx, fy) && set.has(idx(fx, fy))) out.push(idx(fx, fy));
                }
            }
            return out;
        };
        // Anchors are the things whose interconnection must survive: the
        // required cells the net touches, plus the protected cells
        // themselves — wire the user drew has to keep whatever attachment it
        // had, or the pass could strand it by cutting the run that feeds it.
        const anchors = [...requiredSet].filter((ri) => neighborsIn(ri, live).length > 0)
            .concat([...held]);
        const idOf = (ci) => (held.has(ci) ? 'h' + ci : nodeId(ci));
        // Which anchors can currently reach which, as a canonical string. The
        // rule is to PRESERVE this, not to require one connected whole: a net
        // whose middle the object just absorbed arrives here in two pieces,
        // and reduction still has useful work to do within each.
        // What must be preserved is which electrical NODE reaches which —
        // not which cell. Anchor cells are grouped by node (every cell of a
        // dragged wire is one node; each mux pin its own; a pad's cells one
        // between them), because a run reconnecting two cells the object
        // already joins internally is exactly the redundant doubling this
        // pass exists to remove. And what a node must keep reaching is the
        // OTHER nodes: one that ties to nothing else needs no wire at all,
        // so "reaches none" and "detached" are the same state — treating
        // them as different left an orphan cell clinging to every pin.
        const groupsOf = (set) => {
            const reach = new Map();
            for (const a of anchors) {
                const na = idOf(a);
                if (!reach.has(na)) reach.set(na, new Set());
                const ns = neighborsIn(a, set);
                if (!ns.length) continue;
                const seen = new Set(ns), stack = [...ns];
                while (stack.length) {
                    const c = stack.pop();
                    for (const n of neighborsIn(c, set)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
                }
                for (const b of anchors) {
                    const nb = idOf(b);
                    if (nb !== na && neighborsIn(b, seen).length) reach.get(na).add(nb);
                }
            }
            return [...reach.entries()].map(([k, v]) => k + ':' + [...v].sort().join(','))
                .sort().join('|');
        };
        const baseline = groupsOf(live);
        const holds = (set) => groupsOf(set) === baseline;
        for (;;) {
            const dist = new Map(), queue = [];
            for (const a of anchors) for (const n of neighborsIn(a, live)) if (!dist.has(n)) { dist.set(n, 1); queue.push(n); }
            if (!anchors.length) for (const h of held) if (!dist.has(h)) { dist.set(h, 0); queue.push(h); }
            for (let qi = 0; qi < queue.length; qi++) {
                const c = queue[qi];
                for (const n of neighborsIn(c, live)) if (!dist.has(n)) { dist.set(n, dist.get(c) + 1); queue.push(n); }
            }
            // A cell next to a crossover is load-bearing: take it away and
            // the crossing drops from four neighbours to three, which is no
            // longer two independent axes but a tee welding them together.
            const nearCrossing = (ci) => {
                const x = ci % GRID_W, y = (ci - x) / GRID_W;
                return DIRS.some(([dx2, dy2]) => isCrossoverAt(x + dx2, y + dy2));
            };
            const cand = [...live].filter((ci) => !held.has(ci) && !nearCrossing(ci))
                .sort((a, b) => (dist.has(b) ? dist.get(b) : Infinity) - (dist.has(a) ? dist.get(a) : Infinity));
            let did = false;
            for (const ci of cand) {
                live.delete(ci);
                if (holds(live)) { removed.add(ci); did = true; break; }
                live.add(ci);
            }
            if (!did) break;
        }
        return removed;
    }

    // Shortest free path from ANY of a net's cells to ANY cell of the target
    // node, preferring straight runs (a turn costs a fraction of a step).
    //
    // The search runs over (cell, travel direction) states and validates
    // EDGES rather than cells: at each step, the two neighbors the path
    // neither arrives from nor leaves by must not touch anything conductive.
    // That single rule buys both of the things this router needs:
    //
    //  - It cannot tee into anything it passes — including its OWN net. An
    //    earlier version allowed hugging the net it came from, which let it
    //    lay a second path right alongside the existing run: that reads as a
    //    loop, and it also strands the old run (now two-connected everywhere)
    //    where the shrink pass can no longer prune it.
    //  - It CAN cross an existing wire head-on, because the crossed cell
    //    sits in the excluded "came from"/"going to" slots. A straight run
    //    crossed at right angles picks up the path's cells as its other pair
    //    of neighbors and becomes a 4-way crossover, which this world
    //    already keeps electrically separate per axis (isCrossoverAt) — so
    //    the crossing costs the circuit nothing and opens up routes that
    //    would otherwise dead-end and report as unroutable.
    //
    // Touching the net's own TERMINALS (its pads, pins and sources) stays
    // legal throughout: a pad is one node however many of its cells the path
    // brushes, so that can't fork the net the way running beside its wire
    // can — and forbidding it would wall a route in against the very pad it
    // is leaving. The path's first cell may additionally touch the net's
    // wire, since that is the connection being made.
    // Returns the list of cells to fill with conductor, or null.
    const ROUTE_STEP_COST = 16;  // turn penalty is 1, so length dominates
    const ROUTE_CROSS_COST = 64; // a crossing is legal, but prefer a short detour
    const OPP = (d) => (d + 2) % 4;
    function routeNet(seedIdxs, targetSet, netCells, terminalCells, volatileCells) {
        const free = (x, y) => inBounds(x, y) && isInsulatorId(cells[idx(x, y)]);
        const sidesClear = (x, y, dIn, dOut, allowed) => {
            for (let d = 0; d < 4; d++) {
                if (d === OPP(dIn) || d === dOut) continue; // where the path came from / goes
                const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
                if (!inBounds(nx, ny) || !cellConnects(nx, ny)) continue;
                if (!allowed.has(idx(nx, ny))) return false;
            }
            return true;
        };
        // Note targetSet is deliberately NOT blanket-allowed: the step that
        // reaches the target already excludes the direction it steps in, so
        // the path meets its node at exactly one cell instead of being free
        // to run the length of it (which, for a multi-cell object like a
        // dragged wire, laid a parallel run right beside it — a loop).
        const openAllowed = new Set(terminalCells);
        const firstAllowed = new Set([...openAllowed, ...netCells]);
        // Dijkstra over (cell, incoming direction) with a bucket queue —
        // costs are small bounded integers, so buckets beat a real heap.
        const skey = (i, d) => i * 4 + d;
        const dist = new Map(), prev = new Map();
        const buckets = [];
        const push = (cost, i, d, from_) => {
            const k = skey(i, d);
            if (dist.get(k) !== undefined && dist.get(k) <= cost) return;
            dist.set(k, cost);
            prev.set(k, from_);
            (buckets[cost] || (buckets[cost] = [])).push([i, d]);
        };
        const rebuild = (k) => {
            const out = [];
            for (let cur = k; cur !== -1; cur = prev.get(cur)) out.push(Math.floor(cur / 4));
            return out.reverse().map((ci) => [ci % GRID_W, Math.floor(ci / GRID_W)]);
        };
        for (const si of seedIdxs) {
            const sx = si % GRID_W, sy = (si - sx) / GRID_W;
            for (let d = 0; d < 4; d++) {
                const nx = sx + DIRS[d][0], ny = sy + DIRS[d][1];
                if (free(nx, ny)) push(ROUTE_STEP_COST, idx(nx, ny), d, -1);
            }
        }
        for (let cost = 0; cost < buckets.length; cost++) {
            const bucket = buckets[cost];
            if (!bucket) continue;
            for (const [i, d] of bucket) {
                const k = skey(i, d);
                if (dist.get(k) !== cost) continue; // superseded by a cheaper entry
                const x = i % GRID_W, y = (i - x) / GRID_W;
                // Only the path's own first cell may touch the net it leaves.
                const allowed = prev.get(k) === -1 ? firstAllowed : openAllowed;
                for (let nd = 0; nd < 4; nd++) {
                    if (nd === OPP(d)) continue; // no doubling back
                    if (!sidesClear(x, y, d, nd, allowed)) continue;
                    const turn = nd === d ? 0 : 1;
                    const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
                    if (!inBounds(nx, ny)) continue;
                    if (targetSet.has(idx(nx, ny))) return rebuild(k);
                    if (free(nx, ny)) { push(cost + ROUTE_STEP_COST + turn, idx(nx, ny), nd, k); continue; }
                    // Cross straight through a perpendicular run (-> 4-way
                    // crossover). Both of the crossed cell's side neighbors
                    // must already be wires, so the crossing really is a
                    // crossing and not a tee onto some wire's dead end.
                    if (!isWireId(cells[idx(nx, ny)])) continue;
                    // Only ever cross a net that is standing still. Crossing
                    // one this same move is re-contracting means the cell
                    // relied on can be reduced away underneath the crossing,
                    // quietly severing it.
                    if (volatileCells.has(idx(nx, ny))) continue;
                    const perp = nd % 2 === 0 ? [1, 3] : [0, 2];
                    if (!perp.every((q) => isWireId(getCell(nx + DIRS[q][0], ny + DIRS[q][1])))) continue;
                    const bx = nx + DIRS[nd][0], by = ny + DIRS[nd][1];
                    if (!free(bx, by)) continue; // must land clear on the far side
                    push(cost + 2 * ROUTE_STEP_COST + ROUTE_CROSS_COST + turn, idx(bx, by), nd, k);
                }
            }
        }
        return null;
    }

    // Move (and/or rotate) an object's cells as one rigid piece, keeping
    // every electrical contact it had: each stationary net that was touching
    // the object gets re-connected to the same node (pin) of the object at
    // its new place. The steps:
    //
    //   1. Record contacts (stationary connecting neighbor -> object node).
    //   2. Validate the destination. Solid cells (mux/pad/source) reject
    //      outright; stationary WIRE cells are forgiving: a moved wire
    //      landing on one merges with it (the cell stays a wire, nothing is
    //      severed), and a non-wire cell may land on one only if that wire
    //      belongs to a net already attached to the object — absorbing a few
    //      cells of a net that's being re-routed anyway is repairable, while
    //      eating an unrelated net is not, and still rejects.
    //   3. Lift the object, flood each contact's stationary net (crossover-
    //      aware: the two axes of a crossing are separate nets), and dedupe
    //      contacts into per-(net, node) contracts.
    //   4. Place the object; absorb overlapped net cells; TRIM net cells now
    //      flush against a different node of a multi-node object (a mux)
    //      than the one they're contracted to — in an adjacency world flush
    //      IS connected, and rotation frequently parks a body cell right on
    //      the old wire, which must not silently rewire COM onto a pin.
    //   5. Re-route each contract whose net no longer touches its node, from
    //      any surviving net cell (or the net's terminal pads/pins/sources
    //      if every wire cell was consumed) to any cell of the node (see
    //      routeNet). Unroutable contracts are counted in `unrouted`, never
    //      guessed at. Returns {ok, cells (moved positions, same order),
    //      unrouted}.
    // Move one object. Thin wrapper over moveObjects, which is the general
    // form (a multi-select drag moves several objects as one rigid piece).
    function moveObject(objCells, dx, dy, quarterTurns) {
        const res = moveObjects([{ cells: objCells }], dx, dy, quarterTurns);
        return res.ok ? { ok: true, cells: res.objects[0].cells, unrouted: res.unrouted } : res;
    }

    // Move a GROUP as one rigid piece. Everything below is driven by a
    // per-cell node key rather than a single "is this a mux" flag: within a
    // mux each cell is its own electrical node (its pins must not be welded
    // to each other), while any other object is one node however many cells
    // it has — and in a group each object contributes its own. That one map
    // is what lets a mixed selection of muxes, wires and pads move together
    // without their contracts getting confused.
    // Returns {ok, objects:[{cells}] in input order, unrouted}.
    function moveObjects(objectList, dx, dy, quarterTurns) {
        // Within a mux each cell is its own node — except a box mux's COM
        // row, whose three cells ARE one node: a wire that comes back flush
        // against a different one of them than it left is still attached to
        // the same thing, and must not be trimmed as a stray new contact.
        const muxNodeKey = (x, y) => {
            const r = roles[idx(x, y)];
            if (r && r.macro && r.macro.kind === 'box' && r.kind === 'comMiddle') return 'm' + r.macro.key + '|com';
            return 'm' + idx(x, y);
        };
        const objCells = [], nodeKeys = [];
        objectList.forEach((o, oi) => {
            const isMux = o.cells.some(([x, y]) => { const r = roles[idx(x, y)]; return r && r.macro; });
            for (const [x, y] of o.cells) {
                objCells.push([x, y]);
                nodeKeys.push(isMux ? muxNodeKey(x, y) : 'o' + oi);
            }
        });
        const objSet = new Set(objCells.map(([x, y]) => idx(x, y)));
        if (objSet.size !== objCells.length) return { ok: false }; // overlapping picks
        // A level's fixed I/O pad is not draggable, and nothing may be dropped
        // onto one. (Re-routing can't hit a locked cell on its own: the router
        // only lays wire through insulator, and a locked cell always holds a
        // pad.) Checked before anything is written, so there's nothing to undo.
        if (anyLocked) {
            const dest = transformObjectCells(objCells, dx, dy, quarterTurns);
            for (let i = 0; i < objCells.length; i++) {
                if (isLocked(objCells[i][0], objCells[i][1]) || isLocked(dest[i][0], dest[i][1]))
                    return { ok: false, reason: 'locked' };
            }
        }
        const rawIds = objCells.map(([x, y]) => cells[idx(x, y)]);
        const ids = rawIds.map(stripId);
        // Every rejection path restores wholesale from this: the checks that
        // can only be made after the object is placed (see the new-contact
        // scan below) would otherwise have to unpick absorbed and trimmed
        // cells by hand. The grid is small, so a copy is cheaper than the
        // bookkeeping.
        const savedCells = cells.slice();
        const reject = (why) => { cells.set(savedCells); recomputeRoles(); return { ok: false, reason: why || 'blocked' }; };

        // Raw contacts, collected against the pre-move grid.
        const contacts = [];
        for (const [cx, cy] of objCells) {
            if (!cellConnects(cx, cy)) continue;
            for (const [ddx, ddy] of DIRS) {
                const ax = cx + ddx, ay = cy + ddy;
                if (!inBounds(ax, ay) || objSet.has(idx(ax, ay)) || !cellConnects(ax, ay)) continue;
                contacts.push({ anchor: [ax, ay], objCell: [cx, cy], entry: [ddx, ddy] });
            }
        }

        const moved = transformObjectCells(objCells, dx, dy, quarterTurns);
        const movedSet = new Set(moved.map(([x, y]) => idx(x, y)));
        const newIdxOf = new Map();
        objCells.forEach(([x, y], i) => newIdxOf.set(idx(x, y), idx(moved[i][0], moved[i][1])));
        // Moved cells that can carry a connection (for a mux, everything but
        // its inert spacer — the band's mid control cell, the box's
        // select-sense cell) — the trim step's notion of "flush against a
        // node". Uses pre-move roles, captured before the lift below.
        const capableMoved = new Set();
        objCells.forEach(([x, y], i) => {
            const r = roles[idx(x, y)];
            if (!r || (r.kind !== 'midSpacer' && r.kind !== 'boxSel')) capableMoved.add(idx(moved[i][0], moved[i][1]));
        });

        // Cells belonging to one electrical node share an id, so the shrink
        // pass can tell "these two are already joined" from "these two need
        // a wire between them" (see reduceNet).
        const nodeOfOrig = new Map(), nodeOfMoved = new Map(), cellsOfNode = new Map();
        objCells.forEach(([x, y], i) => {
            const mi = idx(moved[i][0], moved[i][1]);
            nodeOfOrig.set(idx(x, y), nodeKeys[i]);
            nodeOfMoved.set(mi, nodeKeys[i]);
            if (!cellsOfNode.has(nodeKeys[i])) cellsOfNode.set(nodeKeys[i], new Set());
            cellsOfNode.get(nodeKeys[i]).add(mi);
        });
        const nodeIdFor = (map) => (ci) => {
            if (map.has(ci)) return map.get(ci);
            const nx = ci % GRID_W, ny = (ci - nx) / GRID_W;
            return anchorNode(nx, ny).key;
        };

        // Bounds/solidity validation; wire overlaps noted for later.
        const overlaps = [];
        for (let i = 0; i < moved.length; i++) {
            const [mx, my] = moved[i];
            if (!inBounds(mx, my)) return { ok: false };
            const di = idx(mx, my);
            if (objSet.has(di) || isInsulatorId(cells[di])) continue;
            if (isWireId(cells[di])) { overlaps.push({ di, movedIsWire: isWireId(ids[i]) }); continue; }
            return { ok: false }; // something solid in the way
        }

        // Lift the object so the net floods see only the stationary world.
        for (const [x, y] of objCells) cells[idx(x, y)] = ID_INSULATOR_PLAIN;

        const components = new Map(); // key -> {cells:Set, terminals:Set}
        const contracts = new Map();  // key|node -> {compKey, targets:Set of moved idx}
        for (const ct of contacts) {
            let comp = isWireId(cells[idx(ct.anchor[0], ct.anchor[1])])
                ? floodNet(ct.anchor[0], ct.anchor[1], ct.entry[0], ct.entry[1])
                : anchorNode(ct.anchor[0], ct.anchor[1]);
            if (components.has(comp.key)) comp = components.get(comp.key);
            else components.set(comp.key, comp);
            comp.preTouch.add(idx(ct.objCell[0], ct.objCell[1]));
            // The object-side node this contact is against — its whole node
            // is the re-route target, so a wire that met a pad anywhere along
            // its edge may come back to any part of that pad.
            const gk = nodeOfOrig.get(idx(ct.objCell[0], ct.objCell[1]));
            const ck = comp.key + '|' + gk;
            if (!contracts.has(ck)) contracts.set(ck, { compKey: comp.key, targets: new Set() });
            for (const mi of cellsOfNode.get(gk)) contracts.get(ck).targets.add(mi);
        }

        // Dangles that already existed BEFORE the move (a stub the user drew
        // on purpose, going nowhere). They're protected from the shrink pass
        // below, which is only meant to clean up tails this move orphaned —
        // never to quietly delete wire that was already like that.
        for (const comp of components.values()) {
            if (!comp.isNet) continue;
            comp.preDangling = reduceNet(comp.cells, new Set([...comp.terminals, ...comp.preTouch]), null, nodeIdFor(nodeOfOrig));
        }

        // A non-wire cell may only absorb wire cells of an attached net.
        const contractedWire = new Set();
        for (const comp of components.values()) for (const ci of comp.cells) contractedWire.add(ci);
        for (const o of overlaps) {
            if (!o.movedIsWire && !contractedWire.has(o.di)) return reject();
        }

        // Place the object (overwriting overlapped wire cells) and drop the
        // absorbed cells from their nets' bookkeeping.
        for (const comp of components.values())
            for (const ci of [...comp.cells]) if (movedSet.has(ci)) comp.cells.delete(ci);
        moved.forEach(([x, y], i) => { cells[idx(x, y)] = ids[i]; });
        recomputeRoles();

        // Trim: a surviving net cell flush against a node it is NOT
        // contracted to would silently connect to the wrong pin — delete it;
        // the re-route below reconnects the net properly. (A single-node
        // object trims nothing, since every target cell is then allowed.)
        {
            const allowed = new Map(); // compKey -> Set of moved idx it may touch
            for (const c of contracts.values()) {
                const s = allowed.get(c.compKey) || new Set();
                for (const t of c.targets) s.add(t);
                allowed.set(c.compKey, s);
            }
            for (const [key, comp] of components) {
                const ok = allowed.get(key) || new Set();
                for (const ci of [...comp.cells]) {
                    if (!isWireId(cells[ci])) continue;
                    const cx2 = ci % GRID_W, cy2 = (ci - cx2) / GRID_W;
                    const bad = DIRS.some(([bdx, bdy]) => {
                        const nx = cx2 + bdx, ny = cy2 + bdy;
                        if (!inBounds(nx, ny)) return false;
                        const ni = idx(nx, ny);
                        return capableMoved.has(ni) && !ok.has(ni);
                    });
                    if (bad) { cells[ci] = ID_INSULATOR_PLAIN; comp.cells.delete(ci); }
                }
            }
        }

        // Preserving connectivity means not INVENTING it either: a move that
        // parks the object flush against something it wasn't touching before
        // has silently wired the two together. The classic case is a wire
        // dragged under a mux body, which shorts the first end, COM and the
        // last end into one node — every destination cell is empty, so
        // nothing above catches it. Identify each stationary node the object
        // now touches and reject anything that wasn't in contact before.
        const nodeKeyAt = (nx, ny) => {
            if (isWireId(cells[idx(nx, ny)])) {
                for (const [key, comp] of components)
                    if (comp.cells.has(idx(nx, ny)) || comp.routed.has(idx(nx, ny))) return key;
                return 'new:' + idx(nx, ny);
            }
            return anchorNode(nx, ny).key; // stationary, so its key is stable across the move
        };
        for (const mi of movedSet) {
            if (!capableMoved.has(mi)) continue;
            const mx = mi % GRID_W, my = (mi - mx) / GRID_W;
            if (!cellConnects(mx, my)) continue;
            for (const [ddx, ddy] of DIRS) {
                const nx = mx + ddx, ny = my + ddy;
                if (!inBounds(nx, ny) || movedSet.has(idx(nx, ny)) || !cellConnects(nx, ny)) continue;
                if (!components.has(nodeKeyAt(nx, ny))) return reject();
            }
        }

        // Re-route each contract until it is genuinely satisfied.
        //
        // A contract is not "some cell of the net still touches the pin" —
        // absorbing and trimming can SPLIT a net, and the piece left touching
        // the pin is often not the piece carrying the net's source or pad.
        // (That is exactly how a rotation could drop a connection while
        // reporting success: the far half was then orphaned, and the shrink
        // pass, quite correctly, saw wire joining nothing to nothing.) So the
        // test is reachability: every terminal the net had must end up in one
        // piece with the object's node, and anything still adrift is routed
        // in, one piece at a time.
        let unrouted = 0;
        const volatileCells = new Set();
        for (const comp of components.values()) for (const ci of comp.cells) volatileCells.add(ci);
        // Everything reachable from a set of cells through wire (a crossover
        // passes straight through): the wire covered, and the non-wire
        // connecting cells touched at the edges.
        const floodFrom = (startIdxs) => {
            const wires = new Set(), touched = new Set(), seen = new Set(), stack = [];
            for (const si of startIdxs) {
                const sx = si % GRID_W, sy = (si - sx) / GRID_W;
                for (const [dx2, dy2] of DIRS) stack.push([sx + dx2, sy + dy2, dx2, dy2]);
            }
            while (stack.length) {
                const [x, y, dx2, dy2] = stack.pop();
                if (!inBounds(x, y)) continue;
                const i = idx(x, y);
                if (!isWireId(cells[i])) { if (cellConnects(x, y)) touched.add(i); continue; }
                if (isCrossoverAt(x, y)) {
                    const k = i + (dx2 !== 0 ? 'h' : 'v');
                    if (seen.has(k)) continue;
                    seen.add(k);
                    stack.push([x + dx2, y + dy2, dx2, dy2]);
                    continue;
                }
                if (seen.has(i)) continue;
                seen.add(i);
                wires.add(i);
                for (const [a2, b2] of DIRS) stack.push([x + a2, y + b2, a2, b2]);
            }
            return { wires, touched };
        };
        const runContract = (c) => {
            const comp = components.get(c.compKey);
            // What has to end up joined to the object's node. A net with no
            // terminals at all (wire dead-ending on the object) just has to
            // stay attached, so its own surviving cells stand in.
            for (let guard = 0; guard < 8; guard++) {
                const at = floodFrom([...c.targets]);
                // What has to end up joined to the object's node: every
                // terminal the net had. A comp that IS a pad or pin, with no
                // wire of its own, joins via its own cells; a wire net with
                // no terminals just has to stay attached, so one of its cells
                // stands in. (Testing a pad against the wire set alone marks
                // it adrift even when it is flush against the pin, and lays a
                // second route beside the connection that already exists.)
                const mustJoin = comp.terminals.size ? [...comp.terminals]
                    : [...comp.cells].filter((ci) => !isWireId(cells[ci]));
                if (!mustJoin.length && comp.cells.size) mustJoin.push([...comp.cells][0]);
                const want = mustJoin.filter((t) => !at.touched.has(t) && !at.wires.has(t));
                if (!want.length) break;
                const from = want[0];
                const island = floodFrom([from]);
                const seeds = [...island.wires, from].filter((ci) => !isCrossoverAt(ci % GRID_W, Math.floor(ci / GRID_W)));
                const targetCells = new Set([...at.wires, ...c.targets]);
                const path = routeNet(seeds, targetCells, new Set(seeds), comp.terminals, volatileCells);
                if (!path) { unrouted++; comp.failed = true; break; }
                for (const [px, py] of path) {
                    cells[idx(px, py)] = makeConductor(OFF);
                    comp.routed.add(idx(px, py));
                }
            }
        };

        // Contracts compete for the same free space, so the order they are
        // laid in decides whether they all fit: route the wrong one first and
        // it takes the only corridor another one needed. Rather than commit
        // to one guess, try a few orders and keep the first that gets
        // everything through — most-constrained-first is usually right, but
        // not always, so plain and reversed are tried too.
        const approachRoom = (c) => {
            let n = 0;
            for (const ti of c.targets) {
                const tx = ti % GRID_W, ty = (ti - tx) / GRID_W;
                for (const [ax, ay] of DIRS) if (inBounds(tx + ax, ty + ay) && isInsulatorId(cells[idx(tx + ax, ty + ay)])) n++;
            }
            return n;
        };
        const contractList = [...contracts.values()];
        const orders = [
            [...contractList].sort((p, q) => approachRoom(p) - approachRoom(q)),
            contractList,
            [...contractList].reverse(),
        ];
        const preRoute = cells.slice();
        for (const order of orders) {
            cells.set(preRoute);
            for (const comp of components.values()) { comp.routed.clear(); comp.failed = false; }
            unrouted = 0;
            for (const c of order) runContract(c);
            if (!unrouted) break;
        }

        // Shrink: erase whatever the move left leading nowhere — the tail of
        // a run a component was dragged along, the far end of a wire whose
        // middle got absorbed. Without this a drag "into" a wire strands the
        // old endpoint where it was instead of the wire following the part
        // that moved. The object's own cells and pre-existing dangles are
        // kept, and a net whose contract couldn't be re-routed is left
        // untouched rather than made worse.
        for (const comp of components.values()) {
            if (comp.failed) continue;
            // Only wire is prunable; a component's own non-wire cells (the
            // pin or pad it stands for) are things the net must stay on.
            const net = new Set(), required = new Set(capableMoved);
            for (const ci of comp.cells) (isWireId(cells[ci]) ? net : required).add(ci);
            for (const ci of comp.routed) net.add(ci);
            for (const t of comp.terminals) required.add(t);
            const keep = new Set([...(comp.preDangling || []), ...movedSet]);
            for (const ci of reduceNet(net, required, keep, nodeIdFor(nodeOfMoved))) {
                if (isWireId(cells[ci])) cells[ci] = ID_INSULATOR_PLAIN;
            }
        }
        // A move that cannot keep every connection is not done at all. The
        // alternative — completing it and reporting the breakage — leaves the
        // user with a circuit that is quietly wrong, which is precisely what
        // rotating a well-connected mux used to do. Refusing means a drag
        // simply sticks at the last position where everything still fits,
        // the same behaviour a collision already has.
        if (unrouted) return reject('unroutable');

        recomputeRoles();
        const out = [];
        let at = 0;
        for (const o of objectList) { out.push({ cells: moved.slice(at, at + o.cells.length) }); at += o.cells.length; }
        return { ok: true, objects: out, cells: moved, unrouted };
    }

    function serialize() {
        return JSON.stringify({ w: GRID_W, h: GRID_H, cells: Array.from(cells) });
    }

    function deserialize(text) {
        try {
            const data = JSON.parse(text);
            if (!data || !Array.isArray(data.cells)) return false;
            // Restore the saved size (grids grow, so it may differ from now).
            const w = Number.isInteger(data.w) && data.w > 0 ? data.w : GRID_W;
            const h = Number.isInteger(data.h) && data.h > 0 ? data.h : GRID_H;
            resizeGrid(w, h, 0, 0, false);
            const n = Math.min(data.cells.length, cells.length);
            for (let i = 0; i < n; i++) {
                const v = data.cells[i] & 0xff;
                cells[i] = isValidId(v) ? v : ID_INSULATOR_PLAIN;
            }
            tickCount = 0;
            recomputeRoles();
            return true;
        } catch (e) {
            return false;
        }
    }

    recomputeRoles();

    window.PixelogicModel = {
        CELL_SIZE,
        get GRID_W() { return GRID_W; },
        get GRID_H() { return GRID_H; },
        OFF, ON, FALLING,
        idx, inBounds, getCell, paintCell, colorOfCell, setSwitch, toggleAt, setToggle, expandForBorder,
        isLocked, setLockedCells, lockedCells,
        // Raw cell array copy — the campaign verifier compares consecutive
        // ticks to decide a circuit has settled, which needs every bit of
        // live charge, not the structural (charge-stripped) snapshot.
        copyCells() { return cells.slice(); },
        isInsulatorId,
        isConductorId, conductorCharge,
        isXover, xoverV, xoverH, isCrossoverAt, cellConnects,
        isGoldId, goldCharge,
        isGrayId, grayCharge,
        isLed, ledIsOn, isSwitch, switchIsPressed, isToggle, toggleIsOn,
        ID_POS, ID_NEG,
        get roles() { return roles; },
        stepSimulation, clearGrid, resetCharges,
        getStructuralSnapshot, restoreStructuralSnapshot,
        copyRegion, clearRegion, pasteRegion,
        rotateRegionCW, mirrorRegionH,
        objectAt, moveObject, moveObjects,
        serialize, deserialize,
        get tickCount() { return tickCount; },
        recomputeRoles,
    };
})(window);

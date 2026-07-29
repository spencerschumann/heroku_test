(function (window) {
    const M = window.PixelogicModel;
    const V = window.PixelogicView;
    const G = window.PixelogicGame;

    // The active campaign level, or null in the sandbox. Almost everything
    // about the editor is unchanged inside a level; what differs is where the
    // circuit is saved, that the board is a fixed size with locked I/O pads,
    // and that there is something to verify against.
    let gameLevel = null;
    let gameProgress = G.loadProgress();

    // drawMode is one of the four paint colors, 'select', or 'paste'.
    const PAINT_MODES = ['conductor', 'gold', 'gray', 'insulator'];
    // How far (in screen px) a press-and-hold in Interact must move before
    // it's read as "pan the view" instead of "hold this switch/toggle".
    const INTERACT_PAN_THRESHOLD = 8;
    let drawMode = 'conductor';
    let painting = false;
    let strokeColor = null; // color for the in-progress paint stroke (right-drag = insulator)
    let selecting = false;
    let selectStart = null;
    let pressedSwitch = null; // {x,y} of a momentary switch held down in Interact mode
    let interactPending = null; // {x,y,sx,sy,wasSwitch,wasToggle,panning} - see beginStroke's interact branch
    let selection = null;   // {x0,y0,x1,y1} normalized, or null
    let clipboard = null;   // {w,h,data:Uint8Array} or null
    // A pasted clip floats (draggable, not yet a permanent edit) from the
    // moment Paste is selected until it's committed - see enterPasteFloat.
    let floatBase = null;   // structural snapshot from just before the float started, or null when not floating
    let floatPos = null;    // {x,y} - the floating clip's current top-left
    let floatDragging = false;
    let floatDragStart = null; // {cellX,cellY,origX,origY}
    // Rearrange tool: `arrangeSel` is the selected object list (a
    // multi-select drags them as one rigid piece), `arrange` the in-progress
    // grab/drag, `band` an in-progress rubber-band selection.
    let arrange = null;         // {objs,base,grabX,grabY,dx,dy,rot,last,cur,unrouted,moved}
    let arrangeSel = [];        // [{cells:[[x,y],...]}]
    let band = null;            // {x0,y0,x1,y1} while rubber-band selecting
    let longPressTimer = null;  // touch: hold to add/remove one object
    const LONG_PRESS_MS = 450;
    let lastHoveredCell = null;
    let running = false;
    // Exponential so the slider gives fine control at the slow end and still
    // reaches a genuinely fast rate at the top (was capped at 20 steps/s).
    // The default is fast enough that a circuit visibly *runs* on first
    // contact rather than creeping; the slider is there to slow it down when
    // you want to watch a signal propagate.
    const MIN_TPS = 1, MAX_TPS = 200, DEFAULT_TPS = 60;
    let tickIntervalMs = 1000 / DEFAULT_TPS;
    let lastTick = 0;
    let panning = false;
    let lastPanPos = null;

    const playPauseBtn = document.getElementById('playPauseBtn');
    const zoomValueEl = document.getElementById('zoomValue');
    const intervalSlider = document.getElementById('intervalSlider');
    const intervalValueEl = document.getElementById('intervalValue');
    const statusEl = document.getElementById('saveStatus');
    const pasteBtn = document.getElementById('pasteBtn');
    const copyBtn = document.getElementById('copyBtn');
    const cutBtn = document.getElementById('cutBtn');
    const rotateBtn = document.getElementById('rotateBtn');
    const mirrorBtn = document.getElementById('mirrorBtn');
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    const saveComponentBtn = document.getElementById('saveComponentBtn');
    const componentsBtn = document.getElementById('componentsBtn');
    const componentsPanel = document.getElementById('componentsPanel');
    const componentsBackdrop = document.getElementById('componentsBackdrop');
    const componentsCloseBtn = document.getElementById('componentsCloseBtn');
    const componentsListEl = document.getElementById('componentsList');
    const componentsEmptyEl = document.getElementById('componentsEmpty');
    const selectionActionsEl = document.getElementById('selectionActions');
    const menuBtn = document.getElementById('menuBtn');
    const menuPanel = document.getElementById('menuPanel');
    const menuBackdrop = document.getElementById('menuBackdrop');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const gridToggleBtn = document.getElementById('gridToggleBtn');
    const campaignBtn = document.getElementById('campaignBtn');
    const levelsPanel = document.getElementById('levelsPanel');
    const levelsBackdrop = document.getElementById('levelsBackdrop');
    const levelsCloseBtn = document.getElementById('levelsCloseBtn');
    const levelsListEl = document.getElementById('levelsList');
    const sandboxBtn = document.getElementById('sandboxBtn');
    const resetProgressBtn = document.getElementById('resetProgressBtn');
    const levelBar = document.getElementById('levelBar');
    const levelTitleEl = document.getElementById('levelTitle');
    const levelBriefEl = document.getElementById('levelBrief');
    const levelHintEl = document.getElementById('levelHint');
    const levelResultEl = document.getElementById('levelResult');
    const levelStepsEl = document.getElementById('levelSteps');
    const hintBtn = document.getElementById('hintBtn');
    const verifyBtn = document.getElementById('verifyBtn');
    const levelsBtn = document.getElementById('levelsBtn');
    const levelCollapseBtn = document.getElementById('levelCollapseBtn');
    const sandboxToggleBtn = document.getElementById('sandboxToggleBtn');

    const LEVEL_BAR_KEY = 'pixelogic-pcb.levelBar.v1';
    let levelBarCollapsed = false;
    try { levelBarCollapsed = JSON.parse(localStorage.getItem(LEVEL_BAR_KEY) || 'false') === true; } catch (e) { }

    // Grid-line visibility remembers separate on/off preferences for build
    // tools vs. Interact (the anticipated default: on while drawing, off
    // while interacting), rather than one flag shared across both.
    let gridVisibleBuild = true, gridVisibleInteract = false;

    // ---- Compact export encoding (gzip + base64) ----
    async function gzipToBase64(str) {
        const cs = new CompressionStream('gzip');
        const w = cs.writable.getWriter();
        w.write(new TextEncoder().encode(str)); w.close();
        const bytes = new Uint8Array(await new Response(cs.readable).arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
    async function base64ToGunzip(b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const ds = new DecompressionStream('gzip');
        const w = ds.writable.getWriter();
        w.write(bytes); w.close();
        return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
    }

    const CIRCUIT_KEY = 'pixelogic-pcb-circuit';
    const VIEW_KEY = 'pixelogic-pcb.view.v1';
    const COMPONENTS_KEY = 'pixelogic-pcb.components.v1';
    const GRID_VISIBLE_KEY = 'pixelogic-pcb.gridVisible.v1';

    function loadGridVisiblePrefs() {
        try {
            const raw = JSON.parse(localStorage.getItem(GRID_VISIBLE_KEY) || 'null');
            if (raw && typeof raw.build === 'boolean' && typeof raw.interact === 'boolean') {
                gridVisibleBuild = raw.build;
                gridVisibleInteract = raw.interact;
            }
        } catch (e) { }
    }
    function saveGridVisiblePrefs() {
        try { localStorage.setItem(GRID_VISIBLE_KEY, JSON.stringify({ build: gridVisibleBuild, interact: gridVisibleInteract })); } catch (e) { }
    }
    // Applies (and reflects in the toggle button) whichever preference
    // matches the given tool mode - called on every tool switch so entering
    // Interact / leaving it always shows the right grid state.
    //
    // A campaign level overrides all of it and keeps the grid on. The boards
    // there are small, deliberately tight, and read as graph paper you are
    // solving a puzzle on; every cell counts, and counting them is easier with
    // the lines drawn. The toggle is disabled rather than silently ignored.
    function applyGridVisibleForMode(mode) {
        const visible = gameLevel ? true : (mode === 'interact' ? gridVisibleInteract : gridVisibleBuild);
        V.setGridVisible(visible);
        gridToggleBtn.setAttribute('aria-pressed', String(visible));
        gridToggleBtn.disabled = !!gameLevel;
        gridToggleBtn.title = gameLevel
            ? 'Always on while you are solving a level'
            : 'Remembered separately for build vs. Interact';
    }

    // ---- Autosave (debounced) ----
    // Every edit schedules a save, so the circuit survives reloads without a
    // manual Save button; Export/Import remain for sharing between browsers.
    let saveTimer = null;
    // The sandbox circuit and each level's attempt are stored separately, so
    // switching between them never overwrites the other. Writes go wherever
    // the board currently belongs.
    function persistCircuit() {
        if (gameLevel) G.saveCircuit(gameLevel.id, M.serialize());
        else { try { localStorage.setItem(CIRCUIT_KEY, M.serialize()); } catch (e) { } }
    }
    function scheduleSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { persistCircuit(); saveTimer = null; }, 300);
    }
    // Anything that swaps the board out has to land the pending write first,
    // or a debounced save fires after the swap and writes the new board into
    // the old board's slot.
    function flushSave() {
        if (!saveTimer) return;
        clearTimeout(saveTimer);
        saveTimer = null;
        persistCircuit();
    }

    // ---- View (zoom/pan) persistence ----
    let viewSaveTimer = null;
    function scheduleViewSave() {
        if (viewSaveTimer) clearTimeout(viewSaveTimer);
        viewSaveTimer = setTimeout(() => {
            try { localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: V.zoom, panX: V.panX, panY: V.panY })); } catch (e) { }
            viewSaveTimer = null;
        }, 300);
    }
    function loadView() {
        try {
            const raw = localStorage.getItem(VIEW_KEY);
            if (!raw) return false;
            const v = JSON.parse(raw);
            if (typeof v.zoom !== 'number' || typeof v.panX !== 'number' || typeof v.panY !== 'number') return false;
            V.setZoom(v.zoom);
            V.pan(v.panX - V.panX, v.panY - V.panY);
            return true;
        } catch (e) { return false; }
    }

    // ---- Undo / redo ----
    // Snapshots hold only circuit structure (charge stripped), so running
    // the simulation between edits never adds undo steps. A "batch" groups
    // one continuous gesture (a whole drag-paint stroke, one paste, one
    // delete) into a single step: the pre-edit snapshot is pushed when the
    // batch first opens and the batch closes at the gesture's end.
    const undoStack = [];
    const redoStack = [];
    const UNDO_LIMIT = 100;
    let undoBatchOpen = false;

    // How many columns/rows the grid has grown off its left and top edges
    // since the app started. Cell coordinates shift by this whenever
    // expandForBorder() adds space, so it's what lets an undo tell "the grid
    // moved under the drawing" apart from "the user panned".
    const gridOrigin = { x: 0, y: 0 };

    // Each entry snapshots the circuit and that origin — NOT the pan or zoom.
    // Undo used to restore the pan outright, which meant any panning or
    // zooming you did after an edit was thrown away the moment you undid it:
    // the view jumped, which is jarring and never what undo was asked to do.
    // Recording the origin instead is enough to keep the drawing visually
    // still across an undo that shrinks the grid, while leaving the view
    // exactly where you put it.
    function snapshotEntry() {
        return { snap: M.getStructuralSnapshot(), originX: gridOrigin.x, originY: gridOrigin.y };
    }
    function beginUndoBatch() {
        if (undoBatchOpen) return;
        undoBatchOpen = true;
        undoStack.push(snapshotEntry());
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
        updateActionButtons();
    }
    function endUndoBatch() { undoBatchOpen = false; }

    function restoreEntry(e) {
        M.restoreStructuralSnapshot(e.snap);
        // Restoring a differently-sized grid re-lays the cells at the
        // snapshot's coordinates, so shift the pan by exactly the difference
        // in origin — the drawing stays put on screen and the zoom, and any
        // panning done since, are left alone.
        const cs = M.CELL_SIZE * V.zoom;
        const dx = (gridOrigin.x - e.originX) * cs, dy = (gridOrigin.y - e.originY) * cs;
        if (dx || dy) V.pan(dx, dy);
        gridOrigin.x = e.originX;
        gridOrigin.y = e.originY;
    }
    function undo() {
        if (!undoStack.length) return;
        redoStack.push(snapshotEntry());
        restoreEntry(undoStack.pop());
        endUndoBatch();
        setArrangeSel([]); // the highlighted objects may not be there anymore
        afterEdit();
    }
    function redo() {
        if (!redoStack.length) return;
        undoStack.push(snapshotEntry());
        restoreEntry(redoStack.pop());
        endUndoBatch();
        setArrangeSel([]);
        afterEdit();
    }

    function afterEdit() {
        updateActionButtons();
        V.drawGrid();
        scheduleSave();
    }

    function updateActionButtons() {
        copyBtn.disabled = !selection;
        cutBtn.disabled = !selection;
        // In Rearrange, Rotate acts on the grabbed object, not the region
        // selection (which has no highlight in that mode anyway).
        rotateBtn.disabled = drawMode === 'rearrange' ? !arrangeSel.length : !selection;
        mirrorBtn.disabled = !selection;
        pasteBtn.disabled = !clipboard;
        saveComponentBtn.disabled = !clipboard;
        undoBtn.disabled = !undoStack.length;
        redoBtn.disabled = !redoStack.length;

        // The selection actions live on a bar that floats over the canvas
        // only while there is something for them to act on, rather than
        // sitting permanently greyed out in the chrome. The condition mirrors
        // what the canvas itself highlights (see setDrawMode), so the buttons
        // appear exactly when their target is visible. Save… rides along with
        // them: you reach for it right after a Copy, while the selection that
        // was copied is still live.
        const hasTarget = (drawMode === 'select' && !!selection)
            || (drawMode === 'paste' && !!floatBase)
            || (drawMode === 'rearrange' && arrangeSel.length > 0);
        selectionActionsEl.classList.toggle('open', hasTarget);
    }

    // ---- Selection / clipboard ----
    function setSelection(sel) {
        selection = sel;
        V.setSelection((drawMode === 'select' || drawMode === 'paste') ? selection : null);
        updateActionButtons();
    }

    function doCopy() {
        if (!selection) return;
        clipboard = M.copyRegion(selection.x0, selection.y0, selection.x1, selection.y1);
        updateActionButtons();
        flashStatus('Copied');
    }
    function deleteSelectionCells() {
        if (!selection) return;
        beginUndoBatch();
        M.clearRegion(selection.x0, selection.y0, selection.x1, selection.y1);
        endUndoBatch();
        afterEdit();
    }
    function doCut() {
        if (!selection) return;
        doCopy();
        deleteSelectionCells();
    }
    // ---- Floating paste ----
    // Selecting Paste stamps the clip right away, at the viewport center (or
    // under the cursor, if it's already hovering the grid), and leaves it
    // "floating": draggable, and not yet a permanent edit. Each drag redraws
    // it at the new spot by restoring the pre-float snapshot and re-pasting,
    // rather than mutating the grid incrementally, so the whole float —
    // however many times it gets dragged — collapses into the single undo
    // step opened by beginUndoBatch here. It becomes permanent (and the grid
    // auto-expands if it landed on an edge) when the tool changes or the user
    // taps outside it on the canvas.
    function viewportCenterAnchor() {
        const c = V.screenToCell(V.canvas.width / 2, V.canvas.height / 2);
        return {
            x: Math.max(0, Math.min(Math.max(0, M.GRID_W - clipboard.w), c.x - Math.floor(clipboard.w / 2))),
            y: Math.max(0, Math.min(Math.max(0, M.GRID_H - clipboard.h), c.y - Math.floor(clipboard.h / 2))),
        };
    }
    // If dragging the float grew the grid (applyExpansion), floatBase — the
    // pre-float snapshot the next stampFloat will restore — has to grow and
    // shift the same way, or the next restore would shrink the grid back
    // down and undo the expansion. Mirrors resizeGrid's own offset-copy.
    function expandFloatBase(g) {
        if (!g.left && !g.top && !g.right && !g.bottom) return;
        const oldW = floatBase.w, oldH = floatBase.h;
        const newW = oldW + g.left + g.right, newH = oldH + g.top + g.bottom;
        const data = new Uint8Array(newW * newH);
        for (let y = 0; y < oldH; y++)
            for (let x = 0; x < oldW; x++)
                data[(y + g.top) * newW + (x + g.left)] = floatBase.data[y * oldW + x];
        floatBase = { w: newW, h: newH, data };
        floatPos = { x: floatPos.x + g.left, y: floatPos.y + g.top };
    }
    function stampFloat() {
        M.restoreStructuralSnapshot(floatBase);
        M.pasteRegion(clipboard, floatPos.x, floatPos.y); // may clip against the not-yet-grown grid
        // Grow the grid immediately if the float reaches the border — waiting
        // until commit is too late, the grid would already be back to this
        // size by the next stampFloat. Then re-paste: growing just now may
        // have made room for the part the first paste above had to clip off.
        expandFloatBase(applyExpansion());
        M.pasteRegion(clipboard, floatPos.x, floatPos.y);
        setSelection({
            x0: floatPos.x, y0: floatPos.y,
            x1: Math.min(M.GRID_W - 1, floatPos.x + clipboard.w - 1),
            y1: Math.min(M.GRID_H - 1, floatPos.y + clipboard.h - 1),
        });
        V.drawGrid();
    }
    function enterPasteFloat() {
        if (!clipboard) return;
        beginUndoBatch();
        floatBase = undoStack[undoStack.length - 1].snap;
        floatPos = (lastHoveredCell && M.inBounds(lastHoveredCell.x, lastHoveredCell.y))
            ? { x: lastHoveredCell.x, y: lastHoveredCell.y } : viewportCenterAnchor();
        stampFloat();
    }
    // stampFloat already keeps the grid size, floatBase, and selection in
    // sync on every move (including the last one before this runs), so
    // there's nothing left to reconcile here.
    function commitPasteFloat() {
        if (!floatBase) return;
        endUndoBatch();
        floatBase = null;
        afterEdit();
    }
    function doRotate() {
        if (drawMode === 'rearrange') { rotateArrangeSelected(); return; }
        if (!selection) return;
        beginUndoBatch();
        const r = M.rotateRegionCW(selection.x0, selection.y0, selection.x1, selection.y1);
        endUndoBatch();
        setSelection(r);
        afterEdit();
    }

    // ---- Rearrange (whole-object drag / rotate, single or multi) ----
    // Pressing on a mux/wire/pad/source in Rearrange grabs the whole object
    // (M.objectAt); dragging restamps it live by restoring the pre-grab
    // snapshot and re-applying the cumulative move (the floating-paste
    // pattern), so however long the drag wanders it collapses into one undo
    // step and one final set of rerouted wires. Release commits; the
    // selection survives so R can keep rotating it in place.
    //
    // Selecting more than one: drag from empty space for a rubber band
    // (mouse or one finger — the gesture that works everywhere), Ctrl/Cmd-
    // click to add or remove one, or press and hold on touch to do the same.
    // Dragging any member then moves the whole group rigidly.
    const objKey = (o) => Math.min(...o.cells.map(([x, y]) => M.idx(x, y)));
    function setArrangeSel(objs) {
        arrangeSel = objs || [];
        const flat = [];
        for (const o of arrangeSel) for (const c of o.cells) flat.push(c);
        V.setObjectHighlight(flat.length ? flat : null);
        updateActionButtons();
    }
    function selHasCell(x, y) {
        const i = M.idx(x, y);
        return arrangeSel.some((o) => o.cells.some(([cx, cy]) => M.idx(cx, cy) === i));
    }
    function toggleInSel(obj) {
        const k = objKey(obj);
        const rest = arrangeSel.filter((o) => objKey(o) !== k);
        setArrangeSel(rest.length === arrangeSel.length ? arrangeSel.concat([obj]) : rest);
        V.drawGrid();
    }
    // Everything the band touches, deduped — intersecting rather than fully
    // enclosing, which is much easier to hit on a phone.
    function selectInBand(r) {
        const seen = new Map();
        for (let y = r.y0; y <= r.y1; y++) {
            for (let x = r.x0; x <= r.x1; x++) {
                const o = M.objectAt(x, y);
                if (o && !seen.has(objKey(o))) seen.set(objKey(o), o);
            }
        }
        setArrangeSel([...seen.values()]);
    }
    // Re-derive the selection from where the cells actually ended up, so a
    // dropped group stays selected (and stays rotatable) at its new spot.
    function selFromMoved(objs, g) {
        return objs.map((o) => ({
            cells: (g && (g.left || g.top)) ? o.cells.map(([x, y]) => [x + g.left, y + g.top]) : o.cells,
        }));
    }

    // Rotation usually needs a little room: once turned, the pins face new
    // directions and the wires have to come in differently, so the turn often
    // does not fit exactly where the object stands even though it fits a cell
    // or two over. Rather than refuse outright, try the nearest positions
    // too — nudging is far less disruptive than making the user clear space
    // by hand. Nearest-first, and among equals the one with the smaller total
    // shift.
    function nudgeOffsets(radius) {
        const out = [];
        for (let dx = -radius; dx <= radius; dx++)
            for (let dy = -radius; dy <= radius; dy++) out.push([dx, dy]);
        return out.sort((a, b) =>
            (Math.max(Math.abs(a[0]), Math.abs(a[1])) - Math.max(Math.abs(b[0]), Math.abs(b[1]))) ||
            (Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1]))));
    }
    // Try a move, falling back to nearby offsets when it won't fit.
    function moveWithNudge(objs, dx, dy, rot, radius) {
        for (const [ox, oy] of nudgeOffsets(radius)) {
            const res = M.moveObjects(objs, dx + ox, dy + oy, rot);
            if (res.ok) return { res, nudged: ox !== 0 || oy !== 0 };
        }
        return { res: { ok: false }, nudged: false };
    }

    function clearLongPress() {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }

    function flashUnrouted(n) {
        if (n) flashStatus(n === 1 ? '1 connection could not be rerouted' : `${n} connections could not be rerouted`);
    }

    function restampArrange() {
        const a = arrange;
        M.restoreStructuralSnapshot(a.base);
        // The batch opens only once a real move happens (a plain click
        // shouldn't leave a no-op undo step), and only right after the base
        // restore, so the snapshot it captures is exactly the pre-drag grid.
        if (!a.moved) { beginUndoBatch(); a.moved = true; }
        // A small nudge only when the exact spot won't take it — enough to
        // let a mid-drag rotation land, without the object wandering off the
        // pointer whenever it fits where it is asked to go.
        let res = M.moveObjects(a.objs, a.dx, a.dy, a.rot);
        if (!res.ok) res = moveWithNudge(a.objs, a.dx, a.dy, a.rot, 1).res;
        if (res.ok) a.last = { dx: a.dx, dy: a.dy, rot: a.rot };
        else res = M.moveObjects(a.objs, a.last.dx, a.last.dy, a.last.rot); // blocked: stay at the last spot that fit
        a.cur = res.objects;
        a.unrouted = res.unrouted || 0;
        setArrangeSel(a.cur);
        V.drawGrid();
    }

    function commitArrange() {
        if (!arrange) return;
        const a = arrange;
        arrange = null;
        if (!a.moved) return; // plain click: the object just stays selected
        const noop = a.last.dx === 0 && a.last.dy === 0 && a.last.rot % 4 === 0;
        endUndoBatch();
        if (noop) { undoStack.pop(); updateActionButtons(); return; } // drag ended back where it started
        const g = applyExpansion(); // dropped on the border: grow to keep the 1-cell margin
        setArrangeSel(selFromMoved(a.cur, g));
        flashUnrouted(a.unrouted);
        afterEdit();
    }

    // Roll a drag back entirely (Escape, or a second finger landing turned
    // the gesture into pan/zoom): restore the pre-grab grid and drop the
    // undo step the drag had opened.
    function abortArrange() {
        if (!arrange) return;
        const a = arrange;
        arrange = null;
        if (a.moved) {
            M.restoreStructuralSnapshot(a.base);
            endUndoBatch();
            undoStack.pop();
            updateActionButtons();
            scheduleSave();
        }
        setArrangeSel(a.objs);
        V.drawGrid();
    }

    function rotateArrangeSelected() {
        if (arrange) { // mid-drag: fold the turn into the live drag
            arrange.rot = (arrange.rot + 1) % 4;
            restampArrange();
            return;
        }
        if (!arrangeSel.length) return;
        beginUndoBatch();
        const { res, nudged } = moveWithNudge(arrangeSel, 0, 0, 1, 3);
        endUndoBatch();
        if (!res.ok) {
            undoStack.pop(); // nothing changed — drop the no-op undo step
            updateActionButtons();
            flashStatus('No room to rotate — move things apart');
            return;
        }
        const g = applyExpansion();
        setArrangeSel(selFromMoved(res.objects, g));
        if (nudged) flashStatus('Rotated (nudged to fit)');
        afterEdit();
    }
    function doMirror() {
        if (!selection) return;
        beginUndoBatch();
        M.mirrorRegionH(selection.x0, selection.y0, selection.x1, selection.y1);
        endUndoBatch();
        afterEdit();
    }

    // ---- Saved components ----
    // A component is a named, localStorage-persisted clipboard clip. Save
    // names the current clipboard; Load sets it back as the clipboard and
    // switches to Paste, ready to stamp.
    function loadComponentList() {
        try {
            const list = JSON.parse(localStorage.getItem(COMPONENTS_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }
    function saveComponentList(list) {
        try { localStorage.setItem(COMPONENTS_KEY, JSON.stringify(list)); } catch (e) { }
    }
    function doSaveComponent() {
        if (!clipboard) return;
        const name = (window.prompt('Name this component:', '') || '').trim();
        if (!name) return;
        const list = loadComponentList();
        const existing = list.findIndex((c) => c.name === name);
        if (existing >= 0) {
            if (!window.confirm(`A component named "${name}" already exists. Overwrite it?`)) return;
            list.splice(existing, 1);
        }
        list.push({ name, w: clipboard.w, h: clipboard.h, data: Array.from(clipboard.data) });
        saveComponentList(list);
        flashStatus(`Saved "${name}"`);
    }
    function loadComponentIntoClipboard(comp) {
        clipboard = { w: comp.w, h: comp.h, data: Uint8Array.from(comp.data) };
        updateActionButtons();
        closeComponents();
        setDrawMode('paste');
    }
    function deleteComponent(name) {
        if (!window.confirm(`Delete component "${name}"?`)) return;
        saveComponentList(loadComponentList().filter((c) => c.name !== name));
        renderComponentsList();
    }
    function renderComponentsList() {
        const list = loadComponentList();
        componentsListEl.innerHTML = '';
        componentsEmptyEl.style.display = list.length ? 'none' : 'block';
        for (const comp of list) {
            const row = document.createElement('div');
            row.className = 'component-row';
            const label = document.createElement('span');
            label.className = 'component-label';
            label.textContent = `${comp.name} (${comp.w}×${comp.h})`;
            label.title = label.textContent;
            const loadRowBtn = document.createElement('button');
            loadRowBtn.className = 'tool-btn';
            loadRowBtn.textContent = 'Load';
            loadRowBtn.addEventListener('click', () => loadComponentIntoClipboard(comp));
            const delRowBtn = document.createElement('button');
            delRowBtn.className = 'tool-btn danger';
            delRowBtn.textContent = 'Delete';
            delRowBtn.addEventListener('click', () => deleteComponent(comp.name));
            row.append(label, loadRowBtn, delRowBtn);
            componentsListEl.appendChild(row);
        }
    }
    function openComponents() {
        renderComponentsList();
        componentsPanel.classList.add('open');
        componentsBackdrop.classList.add('open');
    }
    function closeComponents() {
        componentsPanel.classList.remove('open');
        componentsBackdrop.classList.remove('open');
    }

    // ---- Overflow menu ----
    function setMenuOpen(open) {
        menuPanel.classList.toggle('open', open);
        menuBackdrop.classList.toggle('open', open);
        menuBtn.setAttribute('aria-expanded', String(open));
    }

    // ---- Tools / painting ----
    function setRunning(v) {
        running = v;
        playPauseBtn.textContent = running ? '⏸' : '▶';
        playPauseBtn.setAttribute('aria-pressed', String(running));
    }

    function setDrawMode(mode) {
        // Leaving Paste while a clip is still floating commits it in place.
        if (floatBase && mode !== 'paste') commitPasteFloat();
        // A tool switch mid-drag (keyboard) drops the grabbed object where
        // it is; leaving Rearrange also clears its highlight.
        if (arrange) commitArrange();
        if (mode !== 'rearrange' && arrangeSel.length) setArrangeSel([]);
        drawMode = mode;
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            const on = btn.dataset.tool === mode;
            btn.classList.toggle('selected', on);
            // The rail scrolls (sideways on a phone, vertically in the wide
            // rail on a short screen), so a tool picked by keyboard could
            // otherwise become the active one while sitting off-screen.
            if (on) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
        // The overlay only shows state relevant to the active tool: the
        // selection highlight in Select and Paste (the floating clip). The
        // selection itself survives tool switches (Ctrl+C still works),
        // only its highlight goes away.
        if (mode === 'paste' && clipboard) {
            enterPasteFloat(); // pastes immediately and selects/highlights it
        } else {
            V.setSelection(mode === 'select' ? selection : null);
        }
        // In the sandbox, build modes pause the simulation and Interact
        // resumes it. In a level the simulation just runs, whatever tool is
        // held: you want to see charge move into the piece you have only half
        // finished, and having a tool change quietly stop the board was the
        // single most confusing thing about building in one. Play/pause still
        // works by hand, for when you want to freeze a state and look at it.
        if (!gameLevel) setRunning(mode === 'interact');
        applyGridVisibleForMode(mode);
        // Rotate's target and the floating action bar both depend on the
        // mode, not just on the selection, so they have to be re-evaluated
        // on every tool switch.
        updateActionButtons();
        V.drawGrid();
    }

    // Painting skips cells that are already the target color, so a stroke
    // over existing wires neither resets their charge nor opens a pointless
    // undo step.
    function paintAt(sx, sy, color) {
        const { x, y } = V.screenToCell(sx, sy);
        if (!M.inBounds(x, y)) return;
        if (M.colorOfCell(M.getCell(x, y)) === color) return;
        beginUndoBatch();
        M.paintCell(x, y, color);
        applyExpansion();
        V.drawGrid();
        scheduleSave();
    }

    // Grow the grid if the edit touched the border, and shift the view the
    // opposite way so the existing drawing stays put on screen. Returns the
    // {left, top, right, bottom} added.
    function applyExpansion() {
        // A campaign board is a fixed size. Growing it would slide every cell
        // — including the locked I/O pads the verifier addresses by
        // coordinate — and the bounded workspace is part of the puzzle anyway.
        if (gameLevel) return { left: 0, top: 0, right: 0, bottom: 0 };
        const g = M.expandForBorder();
        if (g.left || g.top) {
            V.compensateExpansion(g.left, g.top);
            gridOrigin.x += g.left;
            gridOrigin.y += g.top;
        }
        return g;
    }

    function setupCanvasEvents() {
        const canvas = V.canvas;

        // Pointer Events unify mouse, pen and touch. Touch adds two things
        // the mouse path can't do on a phone: a single finger draws/selects/
        // pastes (there's no hover, so paste is a direct tap), and two
        // fingers pan + pinch-zoom. Once a second finger lands we abandon any
        // in-progress single-finger stroke and stay in gesture mode until
        // every finger lifts, so a pinch never leaves a stray drawn line.
        const activeTouches = new Map(); // pointerId -> {x, y}, touch pointers only
        let touchGesture = false;
        let lastMid = null, lastDist = 0;

        function pointerPos(e) {
            const rect = canvas.getBoundingClientRect();
            return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
        }

        function beginStroke(sx, sy, erase, opts) {
            const c = V.screenToCell(sx, sy);
            const o = opts || {};
            // Touching the board ends any verification replay: it is driving
            // the inputs, and two things fighting over them helps nobody.
            abortReplay();
            // A level's I/O pads are locked, so no tool can paint them —
            // which frees the press to mean the only thing left that it could
            // usefully mean. Flipping an input to watch what the circuit does
            // is half of building one, and reaching for the Interact tool
            // every time to do it was pure ceremony.
            if (gameLevel && !erase && M.isLocked(c.x, c.y) && drawMode !== 'interact') {
                if (M.setSwitch(c.x, c.y, true)) {
                    pressedSwitch = { x: c.x, y: c.y };
                    interactPending = { x: c.x, y: c.y, sx, sy, panning: false, wasSwitch: true };
                    V.drawGrid();
                    return;
                }
                if (M.toggleAt(c.x, c.y)) { V.drawGrid(); return; }
            }
            if (drawMode === 'interact') {
                // Not an edit, so no undo batch. A momentary switch presses and
                // holds (released on pointer-up); a toggle flips and stays.
                // Either can still turn into a pan if the pointer moves before
                // release (see the interactPending check in pointermove).
                if (M.inBounds(c.x, c.y)) {
                    interactPending = { x: c.x, y: c.y, sx, sy, panning: false };
                    if (M.setSwitch(c.x, c.y, true)) { pressedSwitch = { x: c.x, y: c.y }; interactPending.wasSwitch = true; V.drawGrid(); }
                    else if (M.toggleAt(c.x, c.y)) { interactPending.wasToggle = true; V.drawGrid(); }
                }
            } else if (drawMode === 'select') {
                if (!M.inBounds(c.x, c.y)) return;
                selecting = true;
                selectStart = c;
                setSelection({ x0: c.x, y0: c.y, x1: c.x, y1: c.y });
                V.drawGrid();
            } else if (drawMode === 'rearrange') {
                const obj = M.inBounds(c.x, c.y) ? M.objectAt(c.x, c.y) : null;
                // Empty space starts a rubber band. It doubles as "clear the
                // selection": a tap that never moves ends with an empty band.
                if (!obj) {
                    if (!M.inBounds(c.x, c.y)) { setArrangeSel([]); V.drawGrid(); return; }
                    band = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
                    V.setSelection(band);
                    V.drawGrid();
                    return;
                }
                if (o.toggle) { toggleInSel(obj); return; } // Ctrl/Cmd-click
                // Pressing something already selected drags the whole group;
                // pressing anything else selects just it first.
                if (!selHasCell(c.x, c.y)) setArrangeSel([obj]);
                arrange = {
                    objs: arrangeSel, base: M.getStructuralSnapshot(),
                    grabX: c.x, grabY: c.y, dx: 0, dy: 0, rot: 0,
                    last: { dx: 0, dy: 0, rot: 0 }, cur: arrangeSel, unrouted: 0, moved: false,
                };
                // Touch has no modifier key, so a press-and-hold adds or
                // removes this one object instead of dragging.
                if (o.isTouch) {
                    longPressTimer = setTimeout(() => {
                        longPressTimer = null;
                        arrange = null;   // nothing moved yet, so nothing to roll back
                        toggleInSel(obj);
                    }, LONG_PRESS_MS);
                }
                V.drawGrid();
            } else if (drawMode === 'paste') {
                if (!floatBase) return;
                const inFloat = c.x >= floatPos.x && c.x <= floatPos.x + clipboard.w - 1 &&
                    c.y >= floatPos.y && c.y <= floatPos.y + clipboard.h - 1;
                if (inFloat) {
                    floatDragging = true;
                    floatDragStart = { cellX: c.x, cellY: c.y, origX: floatPos.x, origY: floatPos.y };
                } else {
                    // Tapping elsewhere on the canvas drops the float in place.
                    commitPasteFloat();
                    setDrawMode('select');
                }
            } else {
                // Paint mode. Right button (mouse) always erases.
                painting = true;
                strokeColor = erase ? 'insulator' : drawMode;
                paintAt(sx, sy, strokeColor);
            }
        }

        function endStroke() {
            clearLongPress();
            if (band) {
                const r = band;
                band = null;
                V.setSelection(null);
                // A band that never grew is a tap on empty space: deselect.
                if (r.x1 === r.x0 && r.y1 === r.y0 && !M.objectAt(r.x0, r.y0)) setArrangeSel([]);
                else selectInBand(r);
                V.drawGrid();
            }
            if (arrange) commitArrange();
            painting = false;
            selecting = false;
            panning = false;
            lastPanPos = null;
            floatDragging = false;
            interactPending = null;
            strokeColor = null;
            if (pressedSwitch) { M.setSwitch(pressedSwitch.x, pressedSwitch.y, false); pressedSwitch = null; V.drawGrid(); }
            endUndoBatch();
        }

        // A second finger landing means the user wanted a two-finger gesture,
        // not to draw — so undo the dot the first finger's touchdown just
        // painted (its pre-stroke snapshot is still the open undo batch's top)
        // rather than leaving a stray mark. Nothing to roll back for select/
        // paste, which aren't mid-paint here.
        function abortStroke() {
            clearLongPress();
            if (band) { band = null; V.setSelection(null); }
            abortArrange();
            if (painting && undoBatchOpen && undoStack.length) {
                restoreEntry(undoStack.pop());
                V.drawGrid();
                scheduleSave();
                updateActionButtons();
            }
            endStroke();
        }

        function beginGesture() {
            const pts = [...activeTouches.values()];
            lastMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        }

        // Incremental: each move applies the change since the last one — pan
        // by the midpoint's shift, zoom about that midpoint by the ratio the
        // fingers spread. No absolute anchor bookkeeping needed.
        function updateGesture() {
            const pts = [...activeTouches.values()];
            const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
            const rect = canvas.getBoundingClientRect();
            V.pan(midX - lastMid.x, midY - lastMid.y);
            zoomAt(midX - rect.left, midY - rect.top, dist / lastDist);
            lastMid = { x: midX, y: midY };
            lastDist = dist;
            scheduleViewSave();
            V.drawGrid();
        }

        canvas.addEventListener('pointerdown', (e) => {
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
            if (e.pointerType === 'touch') {
                e.preventDefault();
                activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (activeTouches.size >= 2) {
                    abortStroke();        // abandon + roll back any single-finger draw
                    touchGesture = true;
                    beginGesture();
                    return;
                }
                if (touchGesture) return; // still settling from a prior gesture
                const { sx, sy } = pointerPos(e);
                beginStroke(sx, sy, false, { isTouch: true });
                return;
            }
            // mouse / pen
            if (e.button === 1 || (e.shiftKey && !(drawMode === 'rearrange' && (e.ctrlKey || e.metaKey)))) {
                panning = true;
                lastPanPos = { x: e.clientX, y: e.clientY };
                return;
            }
            if ((drawMode === 'select' || drawMode === 'paste' || drawMode === 'rearrange') && e.button !== 0) return;
            const { sx, sy } = pointerPos(e);
            beginStroke(sx, sy, e.button === 2, { toggle: e.ctrlKey || e.metaKey });
        });

        canvas.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'touch') {
                if (activeTouches.has(e.pointerId)) activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (touchGesture) { if (activeTouches.size >= 2) updateGesture(); return; }
            }
            const { sx, sy } = pointerPos(e);
            // A press-and-hold in Interact turns into a pan once the pointer
            // has moved far enough — cancels whatever switch/toggle the
            // touchdown triggered (a toggle flip is undone by flipping it
            // back) so a drag-to-pan gesture doesn't also leave an interaction
            // behind.
            if (interactPending && !interactPending.panning) {
                const dist = Math.hypot(sx - interactPending.sx, sy - interactPending.sy);
                if (dist > INTERACT_PAN_THRESHOLD) {
                    if (interactPending.wasSwitch) { M.setSwitch(interactPending.x, interactPending.y, false); pressedSwitch = null; }
                    if (interactPending.wasToggle) M.toggleAt(interactPending.x, interactPending.y);
                    interactPending.panning = true;
                    panning = true;
                    lastPanPos = { x: e.clientX, y: e.clientY };
                    V.drawGrid();
                }
            }
            if (panning && lastPanPos) {
                V.pan(e.clientX - lastPanPos.x, e.clientY - lastPanPos.y);
                lastPanPos = { x: e.clientX, y: e.clientY };
                scheduleViewSave();
                V.drawGrid();
                return;
            }
            if (e.pointerType !== 'touch') updateCellInfo(sx, sy);
            if (band) {
                const c = V.screenToCell(sx, sy);
                band.x1 = Math.max(0, Math.min(M.GRID_W - 1, c.x));
                band.y1 = Math.max(0, Math.min(M.GRID_H - 1, c.y));
                V.setSelection({
                    x0: Math.min(band.x0, band.x1), y0: Math.min(band.y0, band.y1),
                    x1: Math.max(band.x0, band.x1), y1: Math.max(band.y0, band.y1),
                });
                V.drawGrid();
                return;
            }
            if (arrange) {
                const c = V.screenToCell(sx, sy);
                if (c.x - arrange.grabX !== arrange.dx || c.y - arrange.grabY !== arrange.dy) {
                    clearLongPress(); // it's a drag, not a hold
                    arrange.dx = c.x - arrange.grabX;
                    arrange.dy = c.y - arrange.grabY;
                    restampArrange();
                }
                return;
            }
            if (selecting && selectStart) {
                const c = V.screenToCell(sx, sy);
                const cx = Math.max(0, Math.min(M.GRID_W - 1, c.x));
                const cy = Math.max(0, Math.min(M.GRID_H - 1, c.y));
                setSelection({
                    x0: Math.min(selectStart.x, cx), y0: Math.min(selectStart.y, cy),
                    x1: Math.max(selectStart.x, cx), y1: Math.max(selectStart.y, cy),
                });
                V.drawGrid();
                return;
            }
            if (painting) {
                paintAt(sx, sy, strokeColor);
                return;
            }
            if (floatDragging) {
                const c = V.screenToCell(sx, sy);
                const nx = floatDragStart.origX + (c.x - floatDragStart.cellX);
                const ny = floatDragStart.origY + (c.y - floatDragStart.cellY);
                if (nx !== floatPos.x || ny !== floatPos.y) {
                    floatPos = { x: nx, y: ny };
                    stampFloat();
                }
                return;
            }
        });

        function onPointerEnd(e) {
            if (e.pointerType === 'touch') {
                activeTouches.delete(e.pointerId);
                if (activeTouches.size >= 2) { beginGesture(); return; } // e.g. 3->2 fingers
                if (activeTouches.size === 0) touchGesture = false;
                // One finger still down after a gesture stays inert until all
                // lift, so it can't start a stray stroke.
            }
            endStroke();
        }
        canvas.addEventListener('pointerup', onPointerEnd);
        canvas.addEventListener('pointercancel', onPointerEnd);
        window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') endStroke(); });

        canvas.addEventListener('pointerleave', (e) => {
            if (e.pointerType !== 'mouse') return;
            document.getElementById('cellInfo').textContent = '';
            lastHoveredCell = null;
        });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Scroll pans (so two-finger trackpad scrolling just works);
        // Ctrl+scroll — which is also what a trackpad pinch reports — zooms
        // about the cursor. Zoom is proportional to the scroll delta, so a
        // trackpad's stream of small deltas gives a smooth glide instead of
        // compounding a flat 10% per event.
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                const rect = canvas.getBoundingClientRect();
                zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.004, -e.deltaY));
            } else {
                V.pan(-e.deltaX, -e.deltaY);
            }
            scheduleViewSave();
            V.drawGrid();
        }, { passive: false });
    }

    // Zoom about a fixed screen point, keeping whatever is under it exactly
    // in place. Uses fractional cell coordinates — anchoring on the floored
    // cell (screenToCell) would make each zoom step also jump by up to a
    // cell.
    function zoomAt(sx, sy, factor) {
        const cs0 = M.CELL_SIZE * V.zoom;
        const fx = (sx - V.panX) / cs0, fy = (sy - V.panY) / cs0;
        V.setZoom(V.zoom * factor);
        const cs1 = M.CELL_SIZE * V.zoom;
        V.pan(sx - fx * cs1 - V.panX, sy - fy * cs1 - V.panY);
        updateZoomLabel();
    }

    function zoomAtCenter(factor) {
        zoomAt(V.canvas.width / 2, V.canvas.height / 2, factor);
        scheduleViewSave();
        V.drawGrid();
    }

    function updateCellInfo(sx, sy) {
        const { x, y } = V.screenToCell(sx, sy);
        const cellInfo = document.getElementById('cellInfo');
        if (!M.inBounds(x, y)) { cellInfo.textContent = ''; lastHoveredCell = null; return; }
        lastHoveredCell = { x, y };
        const id = M.getCell(x, y);
        const role = M.roles[M.idx(x, y)];
        let label = M.colorOfCell(id);
        if (role) label += ` (${role.kind})`;
        cellInfo.textContent = `(${x},${y}) ${label}`;
    }

    function updateZoomLabel() {
        zoomValueEl.textContent = Math.round(V.zoom * 100) + '%';
    }

    function setupToolbar() {
        loadGridVisiblePrefs();
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => setDrawMode(btn.dataset.tool));
        });
        setDrawMode('conductor');

        gridToggleBtn.addEventListener('click', () => {
            if (drawMode === 'interact') gridVisibleInteract = !gridVisibleInteract;
            else gridVisibleBuild = !gridVisibleBuild;
            applyGridVisibleForMode(drawMode);
            saveGridVisiblePrefs();
            V.drawGrid();
        });

        // Overflow menu: everything you reach for occasionally (components,
        // import/export, clear/reset, fullscreen) lives here instead of in a
        // permanent row of buttons, which is what let the top bar become a
        // single line that never wraps at any width.
        menuBtn.addEventListener('click', () => setMenuOpen(!menuPanel.classList.contains('open')));
        menuBackdrop.addEventListener('click', () => setMenuOpen(false));
        // Every item does its thing and dismisses, the way a menu should.
        menuPanel.querySelectorAll('.menu-item').forEach((item) => {
            item.addEventListener('click', () => setMenuOpen(false));
        });

        // Fullscreen: an explicit toggle. Auto-fullscreen on first tap used to
        // fire here too and was more nuisance than help — installed, the app
        // is already chrome-free via the manifest's standalone display, so
        // this is only for a plain browser tab, and only when asked for.
        const FS = window.PixelogicFullscreen;
        if (FS && FS.supported) {
            fullscreenBtn.addEventListener('click', () => FS.toggle());
            const syncFullscreenBtn = () => {
                const on = FS.isActive();
                fullscreenBtn.setAttribute('aria-pressed', String(on));
                fullscreenBtn.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
            };
            document.addEventListener('fullscreenchange', syncFullscreenBtn);
            document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);
            syncFullscreenBtn();
        } else {
            fullscreenBtn.style.display = 'none';
        }

        playPauseBtn.addEventListener('click', () => setRunning(!running));
        document.getElementById('stepBtn').addEventListener('click', () => {
            M.stepSimulation();
            V.drawGrid();
        });
        document.getElementById('clearBtn').addEventListener('click', () => {
            if (!window.confirm('Clear the entire grid?')) return;
            beginUndoBatch();
            M.clearGrid();
            endUndoBatch();
            setSelection(null);
            afterEdit();
        });
        document.getElementById('resetChargesBtn').addEventListener('click', () => {
            M.resetCharges();
            V.drawGrid();
            scheduleSave();
        });
        document.getElementById('zoomInBtn').addEventListener('click', () => zoomAtCenter(1.2));
        document.getElementById('zoomOutBtn').addEventListener('click', () => zoomAtCenter(1 / 1.2));
        document.getElementById('fitBtn').addEventListener('click', () => { V.fitToWindow(); updateZoomLabel(); scheduleViewSave(); V.drawGrid(); });

        copyBtn.addEventListener('click', doCopy);
        cutBtn.addEventListener('click', doCut);
        rotateBtn.addEventListener('click', doRotate);
        mirrorBtn.addEventListener('click', doMirror);
        undoBtn.addEventListener('click', undo);
        redoBtn.addEventListener('click', redo);
        saveComponentBtn.addEventListener('click', doSaveComponent);
        componentsBtn.addEventListener('click', openComponents);
        componentsCloseBtn.addEventListener('click', closeComponents);
        componentsBackdrop.addEventListener('click', closeComponents);

        intervalSlider.value = String(sliderPosForTps(DEFAULT_TPS));
        intervalSlider.addEventListener('input', updateIntervalFromSlider);
        updateIntervalFromSlider();

        document.getElementById('exportBtn').addEventListener('click', async () => {
            // The raw JSON is mostly zeros; gzip+base64 shrinks it to a short
            // token (prefixed PXLZ1: so import can tell the two apart). Falls
            // back to raw JSON if the browser lacks CompressionStream.
            const json = M.serialize();
            let text = json;
            try { if (window.CompressionStream) text = 'PXLZ1:' + await gzipToBase64(json); } catch (e) { text = json; }
            // navigator.clipboard only exists in a secure context — on a phone
            // hitting a LAN IP over plain HTTP it's undefined, so fall back to a
            // prompt the user can select-and-copy from.
            const fallback = () => window.prompt('Circuit text — select all and copy:', text);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => flashStatus('Copied to clipboard'), fallback);
            } else {
                fallback();
            }
        });
        document.getElementById('importBtn').addEventListener('click', async () => {
            let text = window.prompt('Paste exported circuit text:');
            if (!text) return;
            text = text.trim();
            if (text.startsWith('PXLZ1:')) {
                try { text = await base64ToGunzip(text.slice(6)); } catch (e) { flashStatus('Invalid data'); return; }
            }
            beginUndoBatch();
            const ok = M.deserialize(text);
            endUndoBatch();
            if (ok) {
                // An imported grid brings its own coordinate frame, and the
                // view is refit to it, so the origin starts over from here.
                gridOrigin.x = 0;
                gridOrigin.y = 0;
                V.fitToWindow(); updateZoomLabel();
                afterEdit();
                flashStatus('Imported');
            } else {
                // The failed attempt pushed a snapshot identical to the
                // current grid — drop it rather than leave a no-op undo step.
                undoStack.pop();
                updateActionButtons();
                flashStatus('Invalid data');
            }
        });
    }

    let statusTimer = null;
    function flashStatus(msg) {
        statusEl.textContent = msg;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1500);
    }

    // The slider's own max is the resolution: it's fine-grained (1000 steps)
    // so that a whole-number target rate like DEFAULT_TPS lands on it exactly
    // instead of a step either side of it.
    function updateIntervalFromSlider() {
        const v = Number(intervalSlider.value);
        const tps = MIN_TPS * Math.pow(MAX_TPS / MIN_TPS, v / Number(intervalSlider.max));
        tickIntervalMs = 1000 / tps;
        intervalValueEl.textContent = `${Math.round(tps)} tps`;
    }
    // The scale is exponential, so the position for a given rate is derived
    // rather than hard-coded — changing DEFAULT_TPS is enough.
    function sliderPosForTps(tps) {
        return Math.round(Number(intervalSlider.max) * Math.log(tps / MIN_TPS) / Math.log(MAX_TPS / MIN_TPS));
    }

    // A tick interval faster than one frame (~16ms at 60Hz) can't be reached by
    // stepping at most once per requestAnimationFrame callback, so this steps
    // in a catch-up loop, running as many ticks as the elapsed time calls for
    // (capped, so a backgrounded/throttled tab can't stall the page catching
    // up on a huge backlog once it resumes).
    const MAX_STEPS_PER_FRAME = 1000;
    function tickLoop(now) {
        if (running) {
            let steps = 0;
            while (now - lastTick >= tickIntervalMs && steps < MAX_STEPS_PER_FRAME) {
                lastTick += tickIntervalMs;
                M.stepSimulation();
                steps++;
            }
            if (now - lastTick >= tickIntervalMs) lastTick = now; // drop any remaining backlog
            if (steps > 0) V.drawGrid();
        } else {
            lastTick = now;
        }
        requestAnimationFrame(tickLoop);
    }

    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); doCopy(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { e.preventDefault(); doCut(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            e.preventDefault();
            if (clipboard) setDrawMode('paste'); // pastes immediately, floating and draggable
            return;
        }

        if (e.key === 'Escape') {
            // Dismissing an open overlay is all Escape does — deselecting
            // under it would be a second, unasked-for action.
            if (menuPanel.classList.contains('open')) { setMenuOpen(false); return; }
            if (levelsPanel.classList.contains('open')) { closeLevels(); return; }
            closeComponents();
            if (arrange) abortArrange();          // mid-drag: put the object back
            else if (arrangeSel.length) { setArrangeSel([]); V.drawGrid(); }
            if (selection) { setSelection(null); V.drawGrid(); }
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (selection) deleteSelectionCells();
            else document.getElementById('clearBtn').click();
            return;
        }

        if (e.key.startsWith('Arrow')) {
            e.preventDefault();
            const step = 80;
            if (e.key === 'ArrowLeft') V.pan(step, 0);
            else if (e.key === 'ArrowRight') V.pan(-step, 0);
            else if (e.key === 'ArrowUp') V.pan(0, step);
            else V.pan(0, -step);
            scheduleViewSave();
            V.drawGrid();
            return;
        }
        if (e.key === '+' || e.key === '=') { zoomAtCenter(1.2); return; }
        if (e.key === '-') { zoomAtCenter(1 / 1.2); return; }

        if (e.key === ' ') { e.preventDefault(); document.getElementById('stepBtn').click(); }
        else if (e.key === 'p' || e.key === 'P') setRunning(!running);
        // Digits follow the rail's order top-to-bottom. Erase sits second,
        // next to Conductor, because reaching for it is as constant as
        // reaching for wire.
        else if (e.key === '1') setDrawMode('conductor');
        else if (e.key === '2') setDrawMode('insulator');
        else if (e.key === '3') setDrawMode('gold');
        else if (e.key === '4') setDrawMode('gray');
        else if (e.key === '5') setDrawMode('pos');
        else if (e.key === '6') setDrawMode('neg');
        else if (e.key === '7') setDrawMode('led');
        else if (e.key === '8') setDrawMode('toggle');
        else if (e.key === '9') setDrawMode('switch');
        else if (e.key === 'i' || e.key === 'I') setDrawMode('interact');
        else if (e.key === 's' || e.key === 'S') setDrawMode('select');
        else if (e.key === 'a' || e.key === 'A') setDrawMode('rearrange');
        else if ((e.key === 'v' || e.key === 'V') && clipboard) setDrawMode('paste');
        else if (e.key === 'r' || e.key === 'R') doRotate();
        else if (e.key === 'm' || e.key === 'M') doMirror();
        else if (e.key === 'f' || e.key === 'F') { V.fitToWindow(); updateZoomLabel(); scheduleViewSave(); V.drawGrid(); }
        else if (e.key === 'g' || e.key === 'G') { if (!gridToggleBtn.disabled) gridToggleBtn.click(); }
        else if ((e.key === 'h' || e.key === 'H') && gameLevel) setCollapsed(!levelBarCollapsed);
    });

    // ---- Campaign ----------------------------------------------------------
    //
    // Entering a level swaps the whole board: the sandbox circuit is written
    // back to its own key, the level's board (a saved attempt, or a fresh one)
    // is loaded with its pads locked, and the editing history starts over —
    // an undo across a board swap would restore the previous level's circuit
    // into this one's grid.
    function resetHistory() {
        undoStack.length = 0;
        redoStack.length = 0;
        endUndoBatch();
        setSelection(null);
        setArrangeSel([]);
        gridOrigin.x = 0;
        gridOrigin.y = 0;
        updateActionButtons();
    }

    // The level bar floats over the canvas, so the view has to know how much
    // of the foot it hides. Called whenever the bar appears, collapses, or
    // grows a result table under it.
    function syncViewInset() {
        V.setViewInset(gameLevel && levelBar.classList.contains('open')
            ? levelBar.offsetHeight + 16 : 0);
    }

    // The level bar's height moves around — collapsing, opening a hint, a
    // result table appearing under it — and each move changes how much of the
    // canvas is actually visible. Re-frame afterwards, but only for a view
    // that was already framed: if the player has zoomed in on some corner,
    // yanking them back out to the whole board every time the bar twitches is
    // worse than a bit of the board sitting behind it.
    function reframeAfter(change) {
        const wasFramed = Math.abs(V.zoom - V.minZoom) < 1e-6;
        change();
        syncViewInset();
        if (wasFramed) V.fitToWindow(); else V.clampView();
        updateZoomLabel();
        V.drawGrid();
    }

    function showBoard() {
        syncViewInset();
        V.fitToWindow();
        updateZoomLabel();
        scheduleViewSave();
        V.drawGrid();
    }

    function enterLevel(id) {
        const level = G.getLevel(id);
        if (!level || !G.isUnlocked(id, gameProgress)) return;
        abortReplay();
        flushSave();
        gameLevel = level;
        G.loadBoard(level, G.loadCircuit(id));
        V.setLabels(G.padLabels(level));
        gameProgress.current = id;
        gameProgress.mode = 'campaign';
        G.saveProgress(gameProgress);
        resetHistory();
        setLevelResult(null);
        setHintOpen(false);
        updateLevelBar();
        closeLevels();
        // Build tools, not Interact: you arrive at a level to draw in it.
        setDrawMode('conductor');
        showBoard();
    }

    function exitToSandbox() {
        abortReplay();
        flushSave();
        gameLevel = null;
        M.setLockedCells([]);
        V.setLabels([]);
        // `current` is kept, not cleared: it is where the Sandbox toggle
        // brings you back to.
        gameProgress.mode = 'sandbox';
        G.saveProgress(gameProgress);
        const saved = localStorage.getItem(CIRCUIT_KEY);
        if (saved) M.deserialize(saved); else M.clearGrid();
        resetHistory();
        updateLevelBar();
        closeLevels();
        setDrawMode('conductor');
        showBoard();
    }

    function updateLevelBar() {
        levelBar.classList.toggle('open', !!gameLevel);
        document.getElementById('app').classList.toggle('in-level', !!gameLevel);
        if (!gameLevel) { syncViewInset(); return; }
        levelTitleEl.textContent = gameLevel.subtitle
            ? `${gameLevel.title} — ${gameLevel.subtitle}` : gameLevel.title;
        levelBriefEl.textContent = gameLevel.brief;
        levelStepsEl.innerHTML = (gameLevel.steps || [])
            .map((s) => `<li>${s}</li>`).join('');
        levelHintEl.textContent = gameLevel.hint || '';
        hintBtn.style.display = gameLevel.hint ? '' : 'none';
        applyCollapsed();
    }

    // Collapsing leaves the title row and the buttons and hides the rest. The
    // brief is worth reading once and then in the way — the board underneath is
    // the thing — so the preference sticks across levels and reloads.
    function applyCollapsed() {
        levelBar.classList.toggle('collapsed', levelBarCollapsed);
        levelCollapseBtn.setAttribute('aria-expanded', String(!levelBarCollapsed));
        levelCollapseBtn.innerHTML = levelBarCollapsed ? '&#x25B4;' : '&#x25BE;';
        levelCollapseBtn.title = levelBarCollapsed ? 'Show the level text (H)' : 'Minimize the level text (H)';
        syncViewInset();
    }

    function setCollapsed(v) {
        reframeAfter(() => {
            levelBarCollapsed = v;
            try { localStorage.setItem(LEVEL_BAR_KEY, JSON.stringify(v)); } catch (e) { }
            applyCollapsed();
        });
    }

    function setHintOpen(open) {
        reframeAfter(() => {
            levelHintEl.classList.toggle('open', open);
            hintBtn.setAttribute('aria-pressed', String(open));
        });
    }

    // ---- Verification ----
    // Renders one of three outcomes: solved, a specific failing row, or a
    // circuit that never settled. The failing row is shown as expected-vs-got
    // per output bit — "wrong" on its own tells you nothing you can act on.
    function setLevelResult(html) {
        levelResultEl.innerHTML = html || '';
        levelResultEl.classList.toggle('open', !!html);
    }

    const bitList = (names, vals) => names.map((n) => `${n}=${vals[n] & 1}`).join(' ');

    function failureHtml(level, failure, total) {
        const rows = level.outputs.map((name) => {
            const want = failure.expected[name] & 1, got = failure.actual[name] & 1;
            return `<tr><td>${name}</td><td class="bits">${want}</td>`
                + `<td class="bits${want === got ? '' : ' wrong'}">${got}</td></tr>`;
        }).join('');
        // In a sequential level the inputs alone say nothing — the same vector
        // legitimately gives different answers at different points in the run —
        // so the step number is the part that locates the fault.
        const where = failure.step === undefined
            ? 'these inputs'
            : `step ${failure.step + 1} of ${total}, inputs`;
        const why = failure.settled
            ? `Wrong output at ${where}:`
            : `Something is still oscillating at ${where} — the board never came to rest:`;
        return `<div class="result-line result-fail">Not yet.</div>`
            + `<div class="result-note">${why} <strong>${bitList(level.inputs, failure.inputs)}</strong></div>`
            + `<table class="result-table"><tr><th>out</th><th>want</th><th>got</th></tr>${rows}</table>`
            + (level.sequential
                ? '<div class="result-note">A storage level is judged as one run: the board is '
                + 'reset once and then walked through every step in order.</div>' : '');
    }

    // Solving a level puts the circuit on the components shelf under the
    // level's name, which is how the next level gets built by pasting rather
    // than by drawing it all again. An existing component of that name is left
    // alone: it may be a better one the player saved by hand.
    function shelveSolution(level) {
        const clip = G.solutionClip(level);
        if (!clip) return false;
        const list = loadComponentList();
        if (list.some((c) => c.name === level.title)) return false;
        list.push({ name: level.title, w: clip.w, h: clip.h, data: Array.from(clip.data) });
        saveComponentList(list);
        return true;
    }

    // ---- Verify: the verdict, then the demonstration ------------------------
    //
    // Two passes, and the split is the point. `G.verify` decides in a few
    // milliseconds; announcing that and stopping is what made this
    // anticlimactic — you build a circuit and a word appears. So the verdict
    // and the full table come first (instant, and correct even if the run is
    // interrupted), and then the SAME vectors are driven through the board
    // again slowly, letting charge actually travel, with the table filling in
    // row by row underneath.
    //
    // A failing run stops at the offending row and leaves the board standing
    // in that state, inputs and all. That is the most useful thing it can do:
    // the circuit is sitting there getting the wrong answer, and you can look
    // at where the charge went.
    let replayTimer = null;

    function abortReplay() {
        if (!replayTimer) return;
        cancelAnimationFrame(replayTimer);
        replayTimer = null;
        levelResultEl.classList.remove('running');
    }

    // The truth table, all rows up front: inputs, what is wanted, and a slot
    // for what the board actually does, filled as the replay reaches each row.
    function tableHtml(level, cases) {
        const head = level.inputs.map((n) => `<th>${n}</th>`).join('')
            + '<th class="sep">→</th>'
            + level.outputs.map((n) => `<th>${n}</th>`).join('')
            + '<th></th>';
        const rows = cases.map((c, i) => {
            const ins = level.inputs.map((n) => `<td class="bits">${c.inputs[n] & 1}</td>`).join('');
            const outs = level.outputs.map((n) => `<td class="bits">${c.expected[n] & 1}</td>`).join('');
            return `<tr data-row="${i}"><td class="idx">${level.sequential ? i + 1 : ''}</td>`
                + `${ins}<td class="sep"></td>${outs}<td class="mark"></td></tr>`;
        }).join('');
        return `<table class="result-table truth"><tr><th class="idx"></th>${head}</tr>${rows}</table>`;
    }

    function markRow(i, state) {
        const tr = levelResultEl.querySelector(`tr[data-row="${i}"]`);
        if (!tr) return;
        tr.className = state;                       // 'active' | 'ok' | 'bad'
        const mark = tr.querySelector('.mark');
        if (mark) mark.textContent = state === 'ok' ? '✓' : state === 'bad' ? '✗' : '';
        if (state === 'active') tr.scrollIntoView({ block: 'nearest' });
    }

    // How many simulation ticks to run per animation frame. Small vector sets
    // get the slow, watchable version; a fifty-row table would take a minute
    // at that rate, so bigger ones speed up rather than being cut short.
    const replayRate = (n) => (n <= 8 ? 1 : n <= 20 ? 3 : 8);

    function startReplay(level, result, onDone) {
        const r = G.replay(level);
        const rate = replayRate(result.cases.length);
        const holdFrames = result.cases.length <= 20 ? 10 : 3;
        let hold = 0, started = false;
        r.start();
        levelResultEl.classList.add('running');

        const frame = () => {
            replayTimer = requestAnimationFrame(frame);
            if (hold > 0) { hold--; return; }
            if (!started || hold === 0) {
                if (!started) { started = true; r.begin(0); markRow(0, 'active'); }
            }
            let settled = false;
            for (let i = 0; i < rate && !settled; i++) settled = r.tick();
            V.drawGrid();
            if (!settled) return;

            const c = result.cases[r.index];
            markRow(r.index, c && c.ok ? 'ok' : 'bad');
            // Stop where it went wrong, board and all — see above.
            if (c && !c.ok) { abortReplay(); onDone(false); return; }
            if (r.index + 1 >= result.cases.length) { abortReplay(); onDone(true); return; }
            r.begin(r.index + 1);
            markRow(r.index, 'active');
            hold = holdFrames;
        };
        replayTimer = requestAnimationFrame(frame);
    }

    function doVerify() {
        if (!gameLevel) return;
        abortReplay();
        const level = gameLevel;
        const total = level.script ? level.script.length : undefined;

        // The verdict, off-screen and instant. The board is restored exactly,
        // so the replay below starts from the circuit as the player left it.
        const result = G.verify(level);
        const header = result.passed
            ? ''
            : failureHtml(level, result.failure, total || result.cases.length);
        reframeAfter(() => setLevelResult(header + tableHtml(level, result.cases)));

        startReplay(level, result, (passed) => {
            if (!passed) return;    // the failure header is already showing
            const firstTime = !gameProgress.completed[level.id];
            gameProgress.completed[level.id] = true;
            G.saveProgress(gameProgress);
            const shelved = shelveSolution(level);
            const next = G.nextLevel(level.id);
            const notes = [level.sequential
                ? `Held through all ${result.cases.length} steps.`
                : `Passed all ${result.cases.length} test cases.`];
            if (shelved) notes.push(`Saved as the component “${level.title}”.`);
            reframeAfter(() => {
                setLevelResult(`<div class="result-line result-pass">Solved${firstTime ? '' : ' (again)'}.</div>`
                    + `<div class="result-note">${notes.join(' ')}</div>`
                    + (next ? `<div class="result-note"><button class="tool-btn primary" id="nextLevelBtn">Next: ${next.title}</button></div>`
                        : '<div class="result-note">That is the last level built so far — see the Campaign panel for what comes next.</div>')
                    + tableHtml(level, result.cases));
                for (let i = 0; i < result.cases.length; i++) markRow(i, 'ok');
            });
            const nextBtn = document.getElementById('nextLevelBtn');
            if (nextBtn) nextBtn.addEventListener('click', () => enterLevel(next.id));
        });
    }

    // ---- Level browser ----
    function renderLevels() {
        levelsListEl.innerHTML = '';
        for (const chapter of G.CHAPTERS) {
            const section = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'chapter-title';
            title.textContent = chapter.title;
            const blurb = document.createElement('div');
            blurb.className = 'chapter-blurb';
            blurb.textContent = chapter.blurb;
            section.append(title, blurb);

            const levels = G.levelsIn(chapter.id);
            if (levels.length) {
                const list = document.createElement('div');
                list.className = 'chapter-levels';
                for (const level of levels) {
                    const done = !!gameProgress.completed[level.id];
                    const open = G.isUnlocked(level.id, gameProgress);
                    const row = document.createElement('button');
                    row.className = 'level-row' + (gameLevel && gameLevel.id === level.id ? ' current' : '');
                    row.disabled = !open;
                    row.title = open ? level.brief : 'Solve the level before it to unlock this one';
                    const status = document.createElement('span');
                    status.className = 'level-status' + (done ? ' done' : '');
                    status.textContent = done ? '✓' : (open ? '·' : '🔒');
                    const name = document.createElement('span');
                    name.className = 'level-row-title';
                    name.textContent = level.title;
                    const sub = document.createElement('span');
                    sub.className = 'level-row-sub';
                    sub.textContent = level.subtitle || '';
                    row.append(status, name, sub);
                    row.addEventListener('click', () => enterLevel(level.id));
                    list.appendChild(row);
                }
                section.appendChild(list);
            }
            if (chapter.roadmap) {
                const strip = document.createElement('div');
                strip.className = 'roadmap';
                for (const item of chapter.roadmap) {
                    const chip = document.createElement('span');
                    chip.textContent = item;
                    strip.appendChild(chip);
                }
                section.appendChild(strip);
            }
            levelsListEl.appendChild(section);
        }
        sandboxBtn.disabled = !gameLevel;
    }

    function openLevels() {
        renderLevels();
        levelsPanel.classList.add('open');
        levelsBackdrop.classList.add('open');
    }
    function closeLevels() {
        levelsPanel.classList.remove('open');
        levelsBackdrop.classList.remove('open');
    }

    // The campaign is the app; the sandbox is the side door. This flips
    // between them and remembers which one you were in.
    function toggleSandbox() {
        setMenuOpen(false);
        if (gameLevel) { exitToSandbox(); return; }
        const resume = gameProgress.current && G.getLevel(gameProgress.current);
        if (resume && G.isUnlocked(resume.id, gameProgress)) enterLevel(resume.id);
        else openLevels();
    }

    function setupCampaign() {
        campaignBtn.addEventListener('click', () => { setMenuOpen(false); openLevels(); });
        levelsCloseBtn.addEventListener('click', closeLevels);
        levelsBackdrop.addEventListener('click', closeLevels);
        levelsBtn.addEventListener('click', openLevels);
        sandboxBtn.addEventListener('click', exitToSandbox);
        sandboxToggleBtn.addEventListener('click', toggleSandbox);
        verifyBtn.addEventListener('click', doVerify);
        levelCollapseBtn.addEventListener('click', () => setCollapsed(!levelBarCollapsed));
        hintBtn.addEventListener('click', () => setHintOpen(!levelHintEl.classList.contains('open')));
        resetProgressBtn.addEventListener('click', () => {
            if (!window.confirm('Forget which levels are solved, and discard every level circuit? '
                + 'Your sandbox and saved components are untouched.')) return;
            for (const level of G.LEVELS) G.clearCircuit(level.id);
            gameProgress = { completed: {}, current: null };
            G.saveProgress(gameProgress);
            if (gameLevel) exitToSandbox(); else renderLevels();
        });
    }

    window.addEventListener('resize', () => {
        syncViewInset();
        V.clampView();          // the old zoom/pan may no longer be legal
        updateZoomLabel();
        V.drawGrid();
    });

    function init() {
        setupToolbar();
        setupCanvasEvents();
        setupCampaign();
        // The campaign is the app's front door. A first-time visitor lands in
        // the tutorial level rather than on an empty board with a rail of
        // tools and no indication of what any of it is for; a returning one
        // lands wherever they left off, sandbox included.
        const resume = gameProgress.mode === 'sandbox' ? null
            : G.getLevel(gameProgress.current) || G.LEVELS[0];
        if (resume && G.isUnlocked(resume.id, gameProgress)) {
            gameLevel = resume;
            gameProgress.current = resume.id;
            G.loadBoard(resume, G.loadCircuit(resume.id));
            V.setLabels(G.padLabels(resume));
            updateLevelBar();
            setRunning(true);
        } else {
            const saved = localStorage.getItem(CIRCUIT_KEY);
            if (saved) M.deserialize(saved);
        }
        applyGridVisibleForMode(drawMode);
        V.resizeCanvas();
        // A restored viewport belongs to whichever board was on screen; after
        // resuming into a level, fit that level's board instead.
        syncViewInset();
        if (gameLevel || !loadView()) V.fitToWindow();
        else V.clampView();     // a saved sandbox view predates these limits
        updateZoomLabel();
        updateActionButtons();
        V.drawGrid();
        requestAnimationFrame(tickLoop);
    }

    document.addEventListener('DOMContentLoaded', init);

    // Minimal read-only hook for e2e tests: a floating paste's rectangle
    // isn't otherwise observable from outside (its landing spot depends on
    // cursor hover / viewport size), so tests need this to find where to
    // grab it and drag it into place.
    window.PixelogicUI = {
        getFloatRect() { return floatBase ? { x0: floatPos.x, y0: floatPos.y, w: clipboard.w, h: clipboard.h } : null; },
        // Rearrange's selection isn't observable from the DOM, so tests need
        // this to assert what a band/modifier-click actually picked up.
        getArrangeSelection() { return arrangeSel.map((o) => o.cells.map(([x, y]) => [x, y])); },
    };
})(window);

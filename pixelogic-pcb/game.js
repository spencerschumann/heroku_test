(function (window) {
    // game.js - the campaign: a nandgame-style ladder of levels that starts at
    // a single inverter and climbs toward a machine that can run Tetris.
    //
    // Everything here is layered *on top of* the sandbox editor rather than
    // wired into it. A level is:
    //
    //   - a board of a fixed size, carrying input pads (toggles) down its left
    //     edge and output pads (LEDs) down its right edge. Those pads are
    //     LOCKED (model.js's lock mask), so no paint stroke, paste, clear or
    //     Rearrange drag can move them - which is what lets the verifier keep
    //     addressing them by coordinate for the life of the level;
    //   - a truth function over named bits, from which the test vectors are
    //     generated (exhaustively when the input space is small, sampled with
    //     the corner cases pinned when it isn't) - or, for a storage level, an
    //     ordered script plus a step function, since the answer there depends
    //     on what came before;
    //   - a verifier that drives the input pads, runs the simulation until the
    //     board stops changing, and reads the LEDs back.
    //
    // The campaign is deliberately data-only: adding a level is adding an entry
    // to LEVELS, not writing code. That matters because the ladder above the
    // shipped chapters (ALU, RAM, CPU, Tetris) is long.
    const M = window.PixelogicModel;

    // ===== Bit helpers used by the truth functions =====
    // A bus is just named bits, MSB first: 'A3','A2','A1','A0'. A width-1 bus
    // is the bare name ('D', not 'D0'), so a one-bit level and a four-bit one
    // can share the same generators.
    const busNames = (name, width) => {
        if (width === 1) return [name];
        const out = [];
        for (let i = width - 1; i >= 0; i--) out.push(name + i);
        return out;
    };
    // Read a bus out of a bit-valued object as a number.
    const busVal = (v, name, width) => {
        if (width === 1) return v[name] & 1;
        let n = 0;
        for (let i = width - 1; i >= 0; i--) n = (n << 1) | (v[name + i] & 1);
        return n;
    };
    // Spread a number back across a bus's named bits.
    const busBits = (name, width, n) => {
        if (width === 1) return { [name]: n & 1 };
        const out = {};
        for (let i = 0; i < width; i++) out[name + i] = (n >> i) & 1;
        return out;
    };

    // ===== Sequential test scripts =====
    //
    // A storage level is not a truth table — the answer depends on what came
    // before — so it carries an ordered script of input vectors instead, and
    // its `step` says what the outputs must be after each one, given what they
    // were before.
    //
    // This walk is what a latch has to survive: load a value with the enable
    // high, drop the enable, then CHANGE THE DATA while disabled. The last of
    // those three is the whole property being tested — a circuit that merely
    // passes its input through gets the first two right every time.
    function loadHoldScript(dataName, width, enableName) {
        const mask = (1 << width) - 1;
        const values = width === 1 ? [1, 0, 1, 1, 0] : [0b1010, 0b0101, 0b1111, 0b0000, 0b1001];
        const out = [];
        for (const v of values) {
            out.push({ ...busBits(dataName, width, v), [enableName]: 1 });
            out.push({ ...busBits(dataName, width, v), [enableName]: 0 });
            out.push({ ...busBits(dataName, width, ~v & mask), [enableName]: 0 });
        }
        return out;
    }

    // ===== Levels =====
    //
    // Each level: {id, chapter, title, subtitle, brief, hint, inputs, outputs,
    // truth, w, minH, settle}. `truth` maps an object of input bits to an
    // object of output bits; every declared output must be assigned.
    //
    // A storage level instead sets `sequential: true` and carries `script`
    // (ordered input vectors) and `step(inputs, prev)`, where `prev` is the
    // outputs after the previous step. The two forms are exclusive.
    const LEVELS = [
        {
            id: 'not', chapter: 'logic', title: 'Inverter', subtitle: 'NOT',
            brief: 'Light the lamp when the switch is OFF, and only then.',
            hint: 'One mux does it. Its control is the input; wire +V to the pin '
                + 'behind the UNwired control corner and −V to the pin behind the '
                + 'wired one, then take COM to the output.',
            inputs: ['A'], outputs: ['Q'], w: 30,
            truth: (v) => ({ Q: v.A ? 0 : 1 }),
        },
        {
            id: 'and', chapter: 'logic', title: 'And', subtitle: 'A · B',
            brief: 'Light the lamp only when both switches are ON.',
            hint: 'A mux is a switch: let A choose between B and −V. When A is off '
                + 'the output is pulled down; when A is on it follows B.',
            inputs: ['A', 'B'], outputs: ['Q'], w: 40,
            truth: (v) => ({ Q: v.A & v.B }),
        },
        {
            id: 'or', chapter: 'logic', title: 'Or', subtitle: 'A + B',
            brief: 'Light the lamp when either switch is ON.',
            hint: 'The mirror of And: let A choose between +V and B.',
            inputs: ['A', 'B'], outputs: ['Q'], w: 40,
            truth: (v) => ({ Q: v.A | v.B }),
        },
        {
            id: 'xor', chapter: 'logic', title: 'Exclusive or', subtitle: 'A ⊕ B',
            brief: 'Light the lamp when the switches disagree.',
            hint: 'A chooses between B and NOT B — so you need the inverter you '
                + 'already built, plus one more mux to select with.',
            inputs: ['A', 'B'], outputs: ['Q'], w: 44, minH: 30,
            truth: (v) => ({ Q: v.A ^ v.B }),
        },

        {
            id: 'half-adder', chapter: 'arith', title: 'Half adder', subtitle: 'S, C',
            brief: 'Add two bits. S is the sum bit, C the carry out.',
            hint: 'S is A ⊕ B and C is A · B — both already on your shelf. '
                + 'Open Components and paste them in.',
            inputs: ['A', 'B'], outputs: ['S', 'C'], w: 52, minH: 30,
            truth: (v) => ({ S: v.A ^ v.B, C: v.A & v.B }),
        },
        {
            id: 'full-adder', chapter: 'arith', title: 'Full adder', subtitle: 'A + B + Cin',
            brief: 'Add three bits: two operands and a carry in.',
            hint: 'Two half adders and an Or. The first adds A and B, the second '
                + 'adds Cin to that sum; either carry out sets Cout.',
            inputs: ['A', 'B', 'Cin'], outputs: ['S', 'Cout'], w: 46, minH: 20,
            truth: (v) => {
                const n = v.A + v.B + v.Cin;
                return { S: n & 1, Cout: n > 1 ? 1 : 0 };
            },
        },
        {
            id: 'adder4', chapter: 'arith', title: '4-bit adder', subtitle: 'A + B',
            brief: 'Add two 4-bit numbers. Bit 3 is the most significant; Cout is '
                + 'the carry out of the top bit.',
            hint: 'Four full adders in a row, each one’s Cout feeding the next '
                + 'one’s Cin. The bottom adder’s Cin is tied to −V.',
            inputs: [...busNames('A', 4), ...busNames('B', 4)],
            outputs: [...busNames('S', 4), 'Cout'],
            w: 62, minH: 30,
            truth: (v) => {
                const n = busVal(v, 'A', 4) + busVal(v, 'B', 4);
                return { ...busBits('S', 4, n & 15), Cout: n > 15 ? 1 : 0 };
            },
        },
        {
            id: 'inc4', chapter: 'arith', title: '4-bit incrementer', subtitle: 'A + 1',
            brief: 'Add one to a 4-bit number. The top carry out wraps to Cout.',
            hint: 'You could paste the 4-bit adder and tie B to 1 — but a chain of '
                + 'half adders is far smaller, since one operand is a constant.',
            inputs: busNames('A', 4), outputs: [...busNames('S', 4), 'Cout'],
            w: 50, minH: 24,
            truth: (v) => {
                const n = busVal(v, 'A', 4) + 1;
                return { ...busBits('S', 4, n & 15), Cout: n > 15 ? 1 : 0 };
            },
        },

        {
            id: 'select4', chapter: 'control', title: '4-bit selector', subtitle: 'SEL ? A : B',
            brief: 'Pass A through when SEL is ON, B when it is OFF.',
            hint: 'One mux per bit, all four sharing the same control signal. '
                + 'This is the mux you have been using, widened to a bus.',
            inputs: ['SEL', ...busNames('A', 4), ...busNames('B', 4)],
            outputs: busNames('Q', 4), w: 54, minH: 28,
            truth: (v) => busBits('Q', 4, v.SEL ? busVal(v, 'A', 4) : busVal(v, 'B', 4)),
        },
        {
            id: 'zero4', chapter: 'control', title: 'Zero detector', subtitle: 'A = 0',
            brief: 'Light the lamp when every input bit is OFF. This is the flag a '
                + 'processor branches on.',
            hint: 'Or the four bits together, then invert. A tree of Ors is shallower '
                + 'than a chain, though either passes.',
            inputs: busNames('A', 4), outputs: ['Z'], w: 44, minH: 22,
            truth: (v) => ({ Z: busVal(v, 'A', 4) === 0 ? 1 : 0 }),
        },
        {
            id: 'negate4', chapter: 'control', title: 'Two’s complement', subtitle: '−A',
            brief: 'Negate a 4-bit number: invert every bit, then add one.',
            hint: 'Four inverters feeding the incrementer you already built.',
            inputs: busNames('A', 4), outputs: busNames('Q', 4), w: 54, minH: 24,
            truth: (v) => busBits('Q', 4, (-busVal(v, 'A', 4)) & 15),
        },

        // Storage. These levels carry a `script` and a `step` instead of a
        // `truth`: the answer depends on what came before, so the board is
        // reset once and then walked through the script in order.
        {
            id: 'd-latch', chapter: 'memory', title: 'D latch', subtitle: 'follow, then hold',
            brief: 'While E is ON, Q follows D. When E goes OFF, Q keeps whatever it '
                + 'was holding — even if D changes afterwards.',
            hint: 'Feed Q back in. A mux picks between the new D and the latch’s own '
                + 'output, under the control of E: enabled it takes D, disabled it '
                + 'takes itself, which is what makes it remember. You will want an '
                + 'inverter in the loop.',
            sequential: true,
            inputs: ['D', 'E'], outputs: ['Q'], w: 44, minH: 26,
            script: loadHoldScript('D', 1, 'E'),
            step: (v, prev) => ({ Q: v.E ? v.D : prev.Q }),
        },
        {
            id: 'register4', chapter: 'memory', title: '4-bit register', subtitle: 'store a number',
            brief: 'Four latches sharing one enable: load D into Q while E is ON, hold '
                + 'the stored number when E goes OFF.',
            hint: 'Paste the D latch four times and run E to all of them. This is the '
                + 'first thing in the campaign that is genuinely just copies.',
            sequential: true,
            inputs: [...busNames('D', 4), 'E'], outputs: busNames('Q', 4), w: 62, minH: 34,
            script: loadHoldScript('D', 4, 'E'),
            step: (v, prev) => (v.E ? busBits('Q', 4, busVal(v, 'D', 4)) : { ...prev }),
        },
    ];

    // Chapters group the ladder in the level browser. `roadmap` chapters have
    // no levels yet - they are the stated destination (a CPU that runs Tetris),
    // shown so the shipped chapters read as the first rungs of a ladder rather
    // than as the whole thing.
    const CHAPTERS = [
        {
            id: 'logic', title: 'Logic',
            blurb: 'Everything is built from one part: a mux, wired as a relay. '
                + 'Start by making it behave like the gates you know.',
        },
        {
            id: 'arith', title: 'Arithmetic',
            blurb: 'Gates become adders. From here on, each level is mostly a '
                + 'matter of pasting in what you already built.',
        },
        {
            id: 'control', title: 'Selection & flags',
            blurb: 'Choosing between buses and testing them — the pieces an '
                + 'instruction decoder and an ALU are assembled from.',
        },
        {
            id: 'memory', title: 'Memory',
            blurb: 'A circuit that feeds its own output back can remember. From here '
                + 'the answer depends on what came before, so these levels are '
                + 'checked as a sequence rather than a truth table.',
        },
        {
            id: 'machine', title: 'The machine', roadmap: [
                'Register file', 'Arithmetic logic unit', 'Random-access memory',
                'Program counter', 'Instruction decoder', 'Processor',
                'Video output', 'Tetris',
            ],
            blurb: 'Where this is going.',
        },
    ];

    const levelById = new Map(LEVELS.map((l) => [l.id, l]));
    const getLevel = (id) => levelById.get(id) || null;
    const levelIndex = (id) => LEVELS.findIndex((l) => l.id === id);
    const levelsIn = (chapterId) => LEVELS.filter((l) => l.chapter === chapterId);

    // ===== Board layout =====
    //
    // Pads run down the two edges, one cell each, a blank row between them, and
    // an extra blank row wherever the bus name changes so A3..A0 reads as a
    // group distinct from B3..B0. Both columns are centered vertically, so a
    // level with 9 inputs and 5 outputs still looks balanced.
    const stem = (name) => name.replace(/\d+$/, '');

    function rowsFor(names) {
        const out = [];
        let row = 0;
        names.forEach((name, i) => {
            if (i > 0) row += stem(name) === stem(names[i - 1]) ? 2 : 3;
            out.push({ name, row });
        });
        return { rows: out, span: (out.length ? out[out.length - 1].row : 0) + 1 };
    }

    // The full geometry of a level's board: size, where each named pad sits,
    // and where the player's free build area is. Pure - it reads nothing from
    // the model - so the UI, the verifier and the tests all agree on it.
    // A board is never smaller than this regardless of pad count: two rows of
    // mux plus room to route above and below is the smallest thing anyone can
    // actually build in, and a 1-input level would otherwise get a 5-row slot.
    const MIN_BOARD_H = 22;

    function layout(level) {
        const inL = rowsFor(level.inputs), outL = rowsFor(level.outputs);
        const w = level.w || 40;
        const h = Math.max(level.minH || 0, MIN_BOARD_H, Math.max(inL.span, outL.span) + 4);
        const place = (side, l, x) => l.rows.map(({ name, row }) => ({
            name, side, x, y: Math.floor((h - l.span) / 2) + row,
        }));
        const inputs = place('in', inL, 1);
        const outputs = place('out', outL, w - 2);
        return {
            w, h, inputs, outputs,
            pads: [...inputs, ...outputs],
            // Everything between the two pad columns: what gets saved as a
            // reusable component when the level is solved.
            build: { x0: 2, y0: 0, x1: w - 3, y1: h - 1 },
        };
    }

    // Lay a level's board into the model: right size, empty, pads placed and
    // locked. Any existing circuit is replaced, so callers save first.
    function applyBoard(level) {
        const g = layout(level);
        M.setLockedCells([]);          // paintCell refuses locked cells
        M.deserialize(JSON.stringify({ w: g.w, h: g.h, cells: new Array(g.w * g.h).fill(0) }));
        for (const p of g.inputs) M.paintCell(p.x, p.y, 'toggle');
        for (const p of g.outputs) M.paintCell(p.x, p.y, 'led');
        M.setLockedCells(g.pads.map((p) => [p.x, p.y]));
        return g;
    }

    // Restore a saved attempt. The pads are re-placed and re-locked from the
    // layout afterwards, so a save made by an older version of a level (or a
    // hand-edited one) can never leave the board without its terminals.
    function loadBoard(level, serialized) {
        const g = layout(level);
        M.setLockedCells([]);
        if (!serialized || !M.deserialize(serialized)) return applyBoard(level);
        if (M.GRID_W !== g.w || M.GRID_H !== g.h) return applyBoard(level);
        for (const p of g.inputs) if (M.colorOfCell(M.getCell(p.x, p.y)) !== 'toggle') M.paintCell(p.x, p.y, 'toggle');
        for (const p of g.outputs) if (M.colorOfCell(M.getCell(p.x, p.y)) !== 'led') M.paintCell(p.x, p.y, 'led');
        M.setLockedCells(g.pads.map((p) => [p.x, p.y]));
        return g;
    }

    // Labels for view.js to draw beside each pad, outside the build area.
    function padLabels(level) {
        const g = layout(level);
        return g.pads.map((p) => ({ x: p.x, y: p.y, text: p.name, side: p.side === 'in' ? 'left' : 'right' }));
    }

    // ===== Test vectors =====
    //
    // Exhaustive while the input space is small enough to be worth watching;
    // beyond that a fixed sample, with the cases that actually catch bugs
    // pinned in front: all-zero, all-one, one-hot and one-cold (which walk a
    // carry the length of a ripple chain). The sampler is a plain LCG so a
    // level's vectors are identical every run - a level that passes must not
    // then fail on a re-verify.
    const EXHAUSTIVE_LIMIT = 6; // 2^6 = 64 vectors
    const SAMPLE_COUNT = 40;

    function vectorsFor(level) {
        // A sequential level's vectors are its script, in order: they are a
        // history, not a set, and reordering or sampling them would destroy
        // the very thing being tested.
        if (level.sequential) return level.script;
        const names = level.inputs, n = names.length;
        const toObj = (mask) => {
            const v = {};
            names.forEach((name, i) => { v[name] = (mask >> i) & 1; });
            return v;
        };
        if (n <= EXHAUSTIVE_LIMIT) {
            const out = [];
            for (let mask = 0; mask < (1 << n); mask++) out.push(toObj(mask));
            return out;
        }
        const masks = [0, (1 << n) - 1];
        for (let i = 0; i < n; i++) { masks.push(1 << i); masks.push(((1 << n) - 1) ^ (1 << i)); }
        let seed = 0x9e3779b9;
        for (let i = 0; i < SAMPLE_COUNT; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            masks.push(seed % (1 << n));
        }
        return [...new Set(masks)].map(toObj);
    }

    // ===== Verification =====
    //
    // Each vector is judged from a cold start: charges reset, inputs set, then
    // the board is stepped until it stops changing. Resetting between vectors
    // is what makes a pass mean "this circuit computes the function" rather
    // than "this circuit computes the function given the order I happened to
    // test it in" - a mux feedback loop can hold state whether or not the
    // player meant it to.
    //
    // "Stops changing" is compared over the raw cells, live charge included, so
    // a circuit still propagating is never read early. A circuit that never
    // settles (a ring oscillator) fails with that stated, rather than being
    // sampled at an arbitrary tick.
    const settleBudget = (level) => level.settle || Math.max(600, (layout(level).w + layout(level).h) * 14);

    function settle(maxTicks) {
        let prev = M.copyCells();
        for (let t = 1; t <= maxTicks; t++) {
            M.stepSimulation();
            const cur = M.copyCells();
            let same = true;
            for (let i = 0; i < cur.length; i++) if (cur[i] !== prev[i]) { same = false; break; }
            if (same) return { settled: true, ticks: t };
            prev = cur;
        }
        return { settled: false, ticks: maxTicks };
    }

    // Drive the input pads to one vector and let the board come to rest.
    // Settling before reading is not just about correctness of the reading: a
    // storage circuit changed faster than it settles can be driven into
    // oscillation, exactly as real logic has a maximum clock rate, so "hold
    // each step until the board is quiet" is also the contract the levels are
    // written against.
    function applyVector(g, level, v, budget) {
        for (const p of g.inputs) M.setToggle(p.x, p.y, !!v[p.name]);
        const s = settle(budget);
        const got = {};
        for (const p of g.outputs) got[p.name] = M.ledIsOn(M.getCell(p.x, p.y)) ? 1 : 0;
        return { got, settled: s.settled, ticks: s.ticks };
    }

    const matches = (level, got, want) => level.outputs.every((name) => got[name] === (want[name] & 1));

    // Runs the level's vectors against whatever is currently on the board and
    // restores the board's exact prior state (charge included) afterwards, so
    // verifying is never destructive to a circuit the player is mid-way
    // through debugging. Returns the first failure plus a full case list, so
    // the UI can show a truth table with the wrong row marked.
    function verify(level, opts) {
        const g = layout(level);
        const budget = (opts && opts.settle) || settleBudget(level);
        const saved = M.serialize();
        const savedLocks = M.lockedCells();
        const cases = [];
        let failure = null;
        const record = (entry) => {
            cases.push(entry);
            if (!entry.ok && !failure) failure = entry;
        };
        try {
            if (level.sequential) {
                // ONE reset, at the start; the whole point is that what came
                // before is carried forward. A cold board has every lamp off,
                // which is the defined starting state the scripts assume.
                M.resetCharges();
                settle(budget);
                let prev = {};
                for (const name of level.outputs) prev[name] = 0;
                level.script.forEach((v, i) => {
                    const r = applyVector(g, level, v, budget);
                    const want = level.step(v, prev);
                    record({
                        step: i, inputs: v, expected: want, actual: r.got,
                        ok: r.settled && matches(level, r.got, want),
                        ticks: r.ticks, settled: r.settled,
                    });
                    // The next step is judged against what the circuit ACTUALLY
                    // did, not against what it should have done: once it has
                    // gone wrong, reporting every later step as a failure too
                    // buries the one that matters.
                    prev = r.got;
                });
            } else {
                // Every vector from a cold start. A mux feedback loop can hold
                // state whether or not the player meant it to, so testing
                // without a reset would make a pass mean "computes this given
                // the order I happened to test in".
                for (const v of vectorsFor(level)) {
                    M.resetCharges();
                    const r = applyVector(g, level, v, budget);
                    const want = level.truth(v);
                    record({
                        inputs: v, expected: want, actual: r.got,
                        ok: r.settled && matches(level, r.got, want),
                        ticks: r.ticks, settled: r.settled,
                    });
                }
            }
        } finally {
            M.deserialize(saved);
            M.setLockedCells(savedLocks);
        }
        return { passed: !failure, cases, failure, level: level.id };
    }

    // ===== Solved-level components =====
    //
    // Solving a level puts the circuit on the shelf under the level's name, so
    // the next level is built by pasting it rather than by drawing it again -
    // the whole point of the ladder. Only the build area is taken (the pads
    // belong to the level, not to the component) and it is trimmed to what was
    // actually drawn.
    function solutionClip(level) {
        const g = layout(level);
        let x0 = g.build.x1, y0 = g.build.y1, x1 = g.build.x0, y1 = g.build.y0, any = false;
        for (let y = g.build.y0; y <= g.build.y1; y++)
            for (let x = g.build.x0; x <= g.build.x1; x++) {
                if (M.colorOfCell(M.getCell(x, y)) === 'insulator') continue;
                any = true;
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        return any ? M.copyRegion(x0, y0, x1, y1) : null;
    }

    // ===== Progress =====
    const PROGRESS_KEY = 'pixelogic-pcb.game.v1';
    const circuitKey = (id) => 'pixelogic-pcb.game.circuit.' + id;

    function loadProgress() {
        try {
            const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null');
            if (raw && typeof raw === 'object' && raw.completed && typeof raw.completed === 'object')
                return { completed: raw.completed, current: raw.current || null };
        } catch (e) { }
        return { completed: {}, current: null };
    }
    function saveProgress(p) {
        try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (e) { }
    }
    // The first level is always open, and solving a level opens the next one.
    // Nothing further back is ever re-locked, so a completed campaign stays
    // fully browsable.
    function isUnlocked(id, progress) {
        const i = levelIndex(id);
        if (i < 0) return false;
        if (i === 0) return true;
        return !!progress.completed[LEVELS[i - 1].id];
    }
    function nextLevel(id) {
        const i = levelIndex(id);
        return i >= 0 && i + 1 < LEVELS.length ? LEVELS[i + 1] : null;
    }

    function saveCircuit(id, serialized) {
        try { localStorage.setItem(circuitKey(id), serialized); } catch (e) { }
    }
    function loadCircuit(id) {
        try { return localStorage.getItem(circuitKey(id)); } catch (e) { return null; }
    }
    function clearCircuit(id) {
        try { localStorage.removeItem(circuitKey(id)); } catch (e) { }
    }

    window.PixelogicGame = {
        LEVELS, CHAPTERS,
        getLevel, levelIndex, levelsIn, nextLevel,
        layout, applyBoard, loadBoard, padLabels,
        vectorsFor, verify, settle, settleBudget, solutionClip, loadHoldScript,
        loadProgress, saveProgress, isUnlocked,
        saveCircuit, loadCircuit, clearCircuit,
        busNames, busVal, busBits,
    };
})(window);

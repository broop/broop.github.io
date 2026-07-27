// ============================================================
// et-ui.js - DOM wiring shared by the exercise pages.
//
// Covers the parts that were copy-pasted into every app: the piano
// boot sequence, the qwerty-hancock keyboard with its note-stop
// bookkeeping, melody scheduling with timer cleanup, the capture-phase
// keyboard shortcuts with the input-field guard, and the
// feedback/status/stats elements.
//
// Requires tiul-piano.js. qwerty-hancock is optional - keyboard() is a
// no-op if the library is not on the page.
// ============================================================

const ETUI = (function () {

    function $(id) {
        return document.getElementById(id);
    }

    // ---- status / feedback / stats ----

    function setText(el, msg) {
        if (el) el.textContent = msg;
    }

    function setFeedback(el, msg, type) {
        if (!el) return;
        el.textContent = msg;
        el.className = 'feedback ' + (type || '');
    }

    function clearFeedback(el) {
        setFeedback(el, '', '');
    }

    // els: { correct, wrong, played, ... } -> element ids or elements
    function bindStats(els) {
        const resolved = {};
        Object.keys(els).forEach(function (k) {
            resolved[k] = typeof els[k] === 'string' ? $(els[k]) : els[k];
        });
        return function update(state) {
            Object.keys(resolved).forEach(function (k) {
                if (resolved[k] && state[k] !== undefined) {
                    resolved[k].textContent = state[k];
                }
            });
        };
    }

    // ---- checkbox groups ----

    // A row of toggles over a list of option objects, each carrying its own
    // `on` flag. Guards against switching everything off, and can swap in a
    // different option list (quartal's voicings change with the note count).
    //
    //   const group = ETUI.checkGroup('qualityChecks', {
    //       items: QUALITIES,
    //       label: q => q.label,
    //       feedback: el.feedback,
    //       onChange: () => { ... }
    //   });
    //   group.active()          -> the enabled options
    //   group.render(newItems)  -> rebuild with a different list
    function checkGroup(container, opts) {
        const host = typeof container === 'string' ? $(container) : container;
        const o = opts || {};
        const labelFor = o.label || (item => String(item));
        let items = o.items || [];

        function render(newItems) {
            if (newItems) items = newItems;
            host.innerHTML = '';

            items.forEach(function (item) {
                const label = document.createElement('label');
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = !!item.on;

                box.addEventListener('change', function () {
                    item.on = box.checked;

                    // Never leave the drill with nothing to draw from.
                    if (!items.some(i => i.on)) {
                        item.on = true;
                        box.checked = true;
                        if (o.feedback) {
                            setFeedback(o.feedback, o.guardMessage
                                || 'At least one option has to stay enabled.', 'info');
                        }
                        return;
                    }
                    if (o.onChange) o.onChange(item);
                });

                label.appendChild(box);
                label.appendChild(document.createTextNode(labelFor(item)));
                host.appendChild(label);
                item._box = box;
            });
        }

        render();

        return {
            render: render,
            items: function () { return items; },
            active: function () { return items.filter(i => i.on); }
        };
    }

    // ---- playback ----

    let melodyTimers = [];

    function stopMelody() {
        melodyTimers.forEach(clearTimeout);
        melodyTimers = [];
    }

    function playChord(midis, duration) {
        stopMelody();
        TiulPiano.stopAll();
        TiulPiano.playChord(midis, duration);
    }

    // Play notes in sequence. Returns nothing; call stopMelody() to cancel.
    function playMelody(midis, opts) {
        const o = opts || {};
        const stepMs = o.stepMs || 550;
        const dur = o.duration || 0.8;
        stopMelody();
        TiulPiano.stopAll();
        midis.forEach(function (midi, i) {
            melodyTimers.push(setTimeout(function () {
                TiulPiano.play(midi, dur);
            }, i * stepMs));
        });
    }

    // Bottom to top and back down, skipping the repeat of the top note.
    // This is what SeventhTrainer.melodic() does in 7ths_v2.py.
    function playMelodyUpDown(midis, opts) {
        const sorted = midis.slice().sort((a, b) => a - b);
        const down = sorted.slice(0, -1).reverse();
        playMelody(sorted.concat(down), opts);
    }

    // ---- keyboard shortcuts ----

    // Capture phase so these fire before qwerty-hancock treats the key as
    // a piano note, and never while the user is typing a guess.
    function shortcuts(map) {
        const upper = {};
        Object.keys(map).forEach(function (k) { upper[k.toUpperCase()] = map[k]; });

        document.addEventListener('keydown', function (e) {
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            const handler = upper[e.key.toUpperCase()];
            if (handler) {
                e.preventDefault();
                e.stopImmediatePropagation();
                handler();
            }
        }, true);
    }

    // Wire a guess field so Enter submits and keystrokes never leak out
    // to the shortcut handler or the piano keyboard.
    function guessField(input, onSubmit) {
        if (!input) return;
        input.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') onSubmit(input.value);
        });
        input.addEventListener('keyup', function (e) { e.stopPropagation(); });
    }

    // ---- piano keyboard ----

    // Releasing a key lets the note ring for this long before it stops,
    // instead of cutting off the sample the instant the mouse comes up.
    const DEFAULT_RELEASE_MS = 1000;

    function keyboard(elementId, opts) {
        if (typeof QwertyHancock === 'undefined') return null;
        const o = opts || {};
        const releaseMs = o.releaseMs === undefined ? DEFAULT_RELEASE_MS : o.releaseMs;
        const fade = o.fade === undefined ? 0 : o.fade;   // hard cut by default
        const kb = new QwertyHancock({
            id: elementId,
            width: o.width || 850,
            height: o.height || 150,
            octaves: o.octaves || 4,
            startNote: o.startNote || 'C3',
            whiteKeyColour: '#ffffff',
            blackKeyColour: '#333333',
            activeColour: '#4a7aed',
            borderColour: '#e5e9f2'
        });

        const stops = {};
        const releaseTimers = {};

        function cut(note) {
            if (releaseTimers[note]) {
                clearTimeout(releaseTimers[note]);
                delete releaseTimers[note];
            }
            if (stops[note]) {
                stops[note]();
                delete stops[note];
            }
        }

        kb.keyDown = function (note) {
            if (!TiulPiano.isReady()) return;
            cut(note);   // retrigger cleanly if the key is still ringing
            stops[note] = TiulPiano.playNote(note, 10, { fade: fade });
        };

        kb.keyUp = function (note) {
            if (!stops[note]) return;
            if (releaseMs <= 0) {
                cut(note);
                return;
            }
            // Hand the stop function to a timer so the note decays naturally.
            const stop = stops[note];
            delete stops[note];
            releaseTimers[note] = setTimeout(function () {
                delete releaseTimers[note];
                stop();
            }, releaseMs);
        };

        return kb;
    }

    // ---- boot ----

    // opts: { status, enable: [elements], keyboard: elementId, range: [lo, hi], onReady }
    function boot(opts) {
        const o = opts || {};
        const statusEl = typeof o.status === 'string' ? $(o.status) : o.status;

        setText(statusEl, 'Loading piano samples...');

        TiulPiano.init(
            function () {
                (o.enable || []).forEach(function (el) {
                    const node = typeof el === 'string' ? $(el) : el;
                    if (node) node.disabled = false;
                });
                if (o.keyboard) keyboard(o.keyboard, o.keyboardOptions);
                setText(statusEl, o.readyMessage || 'Ready.');
                if (o.onReady) o.onReady();
            },
            function (e) {
                setText(statusEl, 'Error loading piano: ' + e.message);
                console.error(e);
            },
            o.range ? { range: o.range } : undefined
        );
    }

    return {
        $: $,
        setText: setText,
        setFeedback: setFeedback,
        clearFeedback: clearFeedback,
        bindStats: bindStats,
        checkGroup: checkGroup,
        stopMelody: stopMelody,
        playChord: playChord,
        playMelody: playMelody,
        playMelodyUpDown: playMelodyUpDown,
        shortcuts: shortcuts,
        guessField: guessField,
        keyboard: keyboard,
        boot: boot
    };
})();

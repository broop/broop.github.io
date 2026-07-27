// ============================================================
// et-drill.js - the exercise loop, extracted from the pattern
// repeated across tiul.html, chromatic_clusters.html, chord_colors.html
// and the rest.
//
// Pure logic, no DOM. Pages supply four hooks and get back a session
// object that owns the current item and the running counts.
//
//   const drill = ETDrill.create({
//       generate: ()            => item,      // required
//       play:     (item, mode)  => void,      // required
//       describe: (item)        => string,    // reveal text
//       check:    (raw, item)   => { correct, message }
//   });
//
//   drill.next()      new item + play it
//   drill.replay()    play the current item again
//   drill.reveal()    describe() for the current item
//   drill.submit(raw) check() + counter bookkeeping
// ============================================================

const ETDrill = (function () {

    function create(config) {
        if (!config || typeof config.generate !== 'function') {
            throw new Error('ETDrill.create requires a generate() hook');
        }

        const state = {
            current: null,
            played: 0,
            correct: 0,
            wrong: 0,
            answered: false   // guards double-counting a second guess on one item
        };

        // Generate on demand so Play works before the first Next press,
        // the way chromatic_clusters.html's ensureCluster() does.
        function ensure() {
            if (state.current === null) {
                state.current = config.generate();
            }
            return state.current;
        }

        function play(mode) {
            const item = ensure();
            if (config.play) config.play(item, mode || 'harmonic');
            state.played++;
            return item;
        }

        function next() {
            state.current = config.generate();
            state.answered = false;
            if (config.play) config.play(state.current, 'harmonic');
            state.played++;
            return state.current;
        }

        function replay(mode) {
            return play(mode);
        }

        function reveal() {
            const item = state.current;
            if (item === null) return null;
            state.answered = true;   // a revealed item no longer scores
            return config.describe ? config.describe(item) : '';
        }

        function submit(raw) {
            if (state.current === null) {
                return { correct: false, message: 'Nothing played yet.', scored: false };
            }
            if (!config.check) {
                return { correct: false, message: 'This exercise has no answer check.', scored: false };
            }

            const result = config.check(raw, state.current) || {};

            // Malformed input is feedback, not a wrong answer.
            if (result.invalid) {
                return { correct: false, message: result.message || 'Could not read that.', scored: false };
            }

            if (!state.answered) {
                if (result.correct) state.correct++;
                else state.wrong++;
                state.answered = true;
            }

            return { correct: !!result.correct, message: result.message || '', scored: true };
        }

        function reset() {
            state.current = null;
            state.played = 0;
            state.correct = 0;
            state.wrong = 0;
            state.answered = false;
        }

        return {
            state: state,
            current: function () { return state.current; },
            ensure: ensure,
            next: next,
            play: play,
            replay: replay,
            reveal: reveal,
            submit: submit,
            reset: reset
        };
    }

    return { create: create };
})();

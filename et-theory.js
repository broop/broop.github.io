// ============================================================
// et-theory.js - music21 replacement for pitch and chord work
//
// Namespaced under ET so it cannot collide with the globals the
// existing apps define in tiul-constants.js.
//
// Spelling convention matches the Python side (music21):
//   '-' is flat, '#' is sharp, doubles allowed ('b--' = B double flat).
//   Input parsing also accepts 'b' for flat so users can type "Eb".
//
// Chords are built from (letterStep, semitones) pairs measured from
// the root, which produces correct spelling by construction - no
// equivalent of music21's simplifyEnharmonics is needed.
// ============================================================

const ET = (function () {
    const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const LETTER_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // ---- names ----

    // Parse "c", "e-", "b--", "F#", "Eb", optionally with an octave: "C4", "e-3".
    // Returns { letter, acc, octave|null, name } where acc is signed semitones.
    function parseName(raw) {
        if (!raw) return null;
        const m = /^\s*([A-Ga-g])([#\-b]*)(-?\d+)?\s*$/.exec(raw);
        if (!m) return null;
        const letter = m[1].toUpperCase();

        // The accidental group is ambiguous: in "Eb" the b is a flat, but a
        // trailing "-3" is an octave. The regex already split the octave off,
        // so everything left here is accidental.
        let acc = 0;
        for (const ch of m[2]) {
            if (ch === '#') acc++;
            else if (ch === '-' || ch === 'b' || ch === 'B') acc--;
        }
        const octave = m[3] === undefined ? null : parseInt(m[3], 10);
        return { letter, acc, octave, name: spell(letter, acc) };
    }

    function spell(letter, acc) {
        if (acc > 0) return letter + '#'.repeat(acc);
        if (acc < 0) return letter + '-'.repeat(-acc);
        return letter;
    }

    function nameToMidi(raw, defaultOctave) {
        const p = parseName(raw);
        if (!p) return null;
        const oct = p.octave !== null ? p.octave : (defaultOctave === undefined ? 4 : defaultOctave);
        return (oct + 1) * 12 + LETTER_SEMI[p.letter] + p.acc;
    }

    // Sharp-spelled name, e.g. 61 -> "C#4". Matches midiToSoundfontName in
    // tiul-constants.js; duplicated here so pages can load et-theory alone.
    function midiToName(midi) {
        return SHARP_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
    }

    function pitchClass(midi) {
        return ((midi % 12) + 12) % 12;
    }

    // ---- guess parsing ----

    // "C E- G B" or "c,eb,g,b" -> [0, 3, 7, 11], or null if any token is junk.
    function parsePitchClasses(raw) {
        const tokens = (raw || '').trim().split(/[\s,]+/).filter(t => t.length > 0);
        if (tokens.length === 0) return null;
        const out = [];
        for (const t of tokens) {
            const p = parseName(t);
            if (!p) return null;
            out.push(pitchClass(LETTER_SEMI[p.letter] + p.acc));
        }
        return out;
    }

    // ---- chord construction ----

    // Each interval is [letterStep, semitones] from the root.
    const INTERVALS = {
        UNISON: [0, 0],
        MIN_3: [2, 3], MAJ_3: [2, 4],
        DIM_5: [4, 6], PERF_5: [4, 7], AUG_5: [4, 8],
        DIM_7: [6, 9], MIN_7: [6, 10], MAJ_7: [6, 11],
        PERF_4: [3, 5], AUG_4: [3, 6],
        MIN_6: [5, 8], MAJ_6: [5, 9]
    };

    // Build a spelled chord from a root. Returns notes sorted low -> high,
    // each { letter, acc, name, octave, midi, fullName }.
    function buildChord(rootName, rootOctave, intervals) {
        const root = parseName(rootName);
        if (!root) return [];
        const rootMidi = (rootOctave + 1) * 12 + LETTER_SEMI[root.letter] + root.acc;
        const rootLetterIdx = LETTERS.indexOf(root.letter);

        return intervals.map(function (iv) {
            const midi = rootMidi + iv[1];
            const letter = LETTERS[(rootLetterIdx + iv[0]) % 7];

            // Accidental is whatever it takes to reach this pitch from the
            // natural form of that letter, normalized to the nearest window
            // so we get "B--" rather than "B" + 10 sharps.
            let acc = pitchClass(midi) - LETTER_SEMI[letter];
            acc = ((acc + 6) % 12 + 12) % 12 - 6;

            const octave = Math.floor((midi - acc) / 12) - 1;
            const name = spell(letter, acc);
            return { letter, acc, name, octave, midi, fullName: name + octave };
        });
    }

    // Move the n lowest notes up an octave - music21's chord.inversion(n).
    function invert(notes, n) {
        let out = notes.slice().sort((a, b) => a.midi - b.midi);
        for (let i = 0; i < n; i++) {
            const low = out[0];
            out = out.slice(1).concat([{
                letter: low.letter, acc: low.acc, name: low.name,
                octave: low.octave + 1, midi: low.midi + 12,
                fullName: low.name + (low.octave + 1)
            }]);
            out.sort((a, b) => a.midi - b.midi);
        }
        return out;
    }

    // Port of Seventh.closed_position: pull everything within an octave of the bass.
    function closedPosition(notes) {
        const sorted = notes.slice().sort((a, b) => a.midi - b.midi);
        const bass = sorted[0].midi;
        return sorted.map(function (n) {
            let midi = n.midi;
            while (midi - bass > 12) midi -= 12;
            while (midi < bass) midi += 12;
            return retune(n, midi);
        }).sort((a, b) => a.midi - b.midi);
    }

    // Port of Seventh.open_position: bass and soprano stay, inner voices up an octave.
    function openPosition(notes) {
        const sorted = notes.slice().sort((a, b) => a.midi - b.midi);
        if (sorted.length < 4) return sorted;
        const out = sorted.slice();
        out[1] = retune(out[1], out[1].midi + 12);
        out[2] = retune(out[2], out[2].midi + 12);
        return out.sort((a, b) => a.midi - b.midi);
    }

    // Same spelling, new octave.
    function retune(note, midi) {
        const octave = note.octave + Math.round((midi - note.midi) / 12);
        return {
            letter: note.letter, acc: note.acc, name: note.name,
            octave: octave, midi: midi, fullName: note.name + octave
        };
    }

    function transpose(notes, semitones) {
        return notes.map(n => retune(n, n.midi + semitones));
    }

    // Shift a chord by whole octaves into [lo, hi], preserving spelling.
    //
    // Naive "while too high, drop an octave; while too low, raise one" fails
    // when a chord sits closer to one edge than the other - dropping it puts
    // the bass under the floor, so the second loop lifts it straight back
    // out the top. This picks the octave with the least total overflow
    // instead, preferring the smallest shift on a tie, and leaves wide
    // voicings as close to fitting as they can get.
    function fitToRange(notes, lo, hi) {
        const midis = notes.map(n => n.midi);
        const bottom = Math.min.apply(null, midis);
        const top = Math.max.apply(null, midis);

        let best = 0;
        let bestCost = Infinity;
        // 0, -1, +1, -2, +2 ... so the smallest move wins a tie.
        for (let step = 0; step <= 4; step++) {
            const candidates = step === 0 ? [0] : [-step, step];
            for (let ci = 0; ci < candidates.length; ci++) {
                const k = candidates[ci];
                const cost = Math.max(0, lo - (bottom + 12 * k))
                    + Math.max(0, (top + 12 * k) - hi);
                if (cost < bestCost) {
                    bestCost = cost;
                    best = k;
                }
            }
        }

        return best === 0 ? notes : transpose(notes, 12 * best);
    }

    // ---- intervals (for position.html / matzav) ----

    const GENERIC = ['unison', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'octave'];
    const PERFECT_STEPS = [0, 3, 4, 7];

    // Diatonic staff position, counting C as 0 of its octave so that the
    // index increments across a C boundary the same way octave numbers do.
    function diatonicIndex(note) {
        return note.octave * 7 + LETTERS.indexOf(note.letter);
    }

    // Quality + generic name between two spelled notes, e.g. "minor seventh".
    function intervalName(low, high) {
        const letterSteps = diatonicIndex(high) - diatonicIndex(low);
        const semis = high.midi - low.midi;
        const simpleSteps = ((letterSteps % 7) + 7) % 7;
        const octaves = Math.floor(letterSteps / 7);
        const naturalSemis = [0, 2, 4, 5, 7, 9, 11][simpleSteps];
        const diff = semis - (octaves * 12 + naturalSemis);
        const isPerfect = PERFECT_STEPS.indexOf(simpleSteps) !== -1;

        let quality;
        if (diff === 0) quality = isPerfect ? 'perfect' : 'major';
        else if (diff === -1) quality = isPerfect ? 'diminished' : 'minor';
        else if (diff === -2) quality = 'diminished';
        else if (diff === 1) quality = 'augmented';
        else quality = diff > 0 ? 'augmented' : 'diminished';

        const generic = letterSteps >= 7 && simpleSteps === 0 ? 'octave' : GENERIC[simpleSteps];
        return quality + ' ' + generic;
    }

    const QUALITY_ABBREV = {
        perfect: 'P', major: 'M', minor: 'm', diminished: 'd', augmented: 'A'
    };

    // music21's semiSimpleName: compound intervals reduce to their simple
    // form, but a perfect octave stays an octave rather than collapsing to a
    // unison. This is what HPlayer.position() reports as the matzav.
    //   C4 -> E5  is a major tenth, reported as M3
    //   C4 -> C5  stays P8
    function semiSimple(low, high) {
        const letterSteps = diatonicIndex(high) - diatonicIndex(low);
        const semis = high.midi - low.midi;
        const simpleSteps = ((letterSteps % 7) + 7) % 7;
        const octaves = Math.floor(letterSteps / 7);
        const naturalSemis = [0, 2, 4, 5, 7, 9, 11][simpleSteps];
        const diff = semis - (octaves * 12 + naturalSemis);
        const isPerfect = PERFECT_STEPS.indexOf(simpleSteps) !== -1;

        let quality;
        if (diff === 0) quality = isPerfect ? 'perfect' : 'major';
        else if (diff === -1) quality = isPerfect ? 'diminished' : 'minor';
        else if (diff < -1) quality = 'diminished';
        else quality = 'augmented';

        // 0 steps means unison at the same octave, otherwise an octave.
        const number = simpleSteps === 0 ? (letterSteps === 0 ? 1 : 8) : simpleSteps + 1;

        return {
            number: number,
            quality: quality,
            name: QUALITY_ABBREV[quality] + number,
            longName: quality + ' ' + (number === 8 ? 'octave' : GENERIC[simpleSteps])
        };
    }

    // ---- misc ----

    function randInt(maxExclusive) {
        return Math.floor(Math.random() * maxExclusive);
    }

    function choice(arr) {
        return arr[randInt(arr.length)];
    }

    function shuffled(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = randInt(i + 1);
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    return {
        LETTERS: LETTERS,
        LETTER_SEMI: LETTER_SEMI,
        INTERVALS: INTERVALS,
        parseName: parseName,
        spell: spell,
        nameToMidi: nameToMidi,
        midiToName: midiToName,
        pitchClass: pitchClass,
        parsePitchClasses: parsePitchClasses,
        buildChord: buildChord,
        invert: invert,
        closedPosition: closedPosition,
        openPosition: openPosition,
        transpose: transpose,
        fitToRange: fitToRange,
        retune: retune,
        diatonicIndex: diatonicIndex,
        intervalName: intervalName,
        semiSimple: semiSimple,
        randInt: randInt,
        choice: choice,
        shuffled: shuffled
    };
})();
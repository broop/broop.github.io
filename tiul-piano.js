// ============================================================
// Centralized piano player using local piano_sounds/1..88.mp3
// File 1.mp3 = A0 (MIDI 21), File 88.mp3 = C8 (MIDI 108)
//
// API:
//   TiulPiano.init(onReady, onError)  - load audio context, preload buffers
//   TiulPiano.play(midi, duration)    - play a MIDI note, returns stop function
//   TiulPiano.playNote(name, dur)     - play by soundfont-style name e.g. "C4"
//   TiulPiano.playChord(midis, dur)   - play multiple MIDI notes simultaneously
//   TiulPiano.stopAll()               - stop all currently playing notes
//   TiulPiano.isReady()               - true once samples are loaded
// ============================================================

const TiulPiano = (function () {
    const SOUNDS_PATH = 'piano_sounds/';
    const MIDI_MIN = 21;  // A0 = file 1.mp3
    const MIDI_MAX = 108; // C8 = file 88.mp3
    const TOTAL_FILES = 88;

    let audioCtx = null;
    let buffers = {};      // midi number -> AudioBuffer
    let pending = {};      // midi number -> in-flight fetch for out-of-range notes
    let activeNodes = [];  // currently playing source nodes
    let ready = false;

    // Note name -> semitone offset (for parsing "C#4" style names)
    const NOTE_TO_SEMI = {
        'C': 0, 'C#': 1, 'DB': 1, 'D': 2, 'D#': 3, 'EB': 3,
        'E': 4, 'F': 5, 'F#': 6, 'GB': 6, 'G': 7, 'G#': 8,
        'AB': 8, 'A': 9, 'A#': 10, 'BB': 10, 'B': 11
    };

    function noteNameToMidi(name) {
        // Parse "C4", "C#4", "Db3", "A0" etc.
        const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
        if (!m) return null;
        const letter = m[1].toUpperCase();
        const acc = m[2] === '#' ? '#' : (m[2] === 'b' ? 'B' : '');
        const octave = parseInt(m[3], 10);
        const semi = NOTE_TO_SEMI[letter + acc];
        if (semi === undefined) return null;
        return (octave + 1) * 12 + semi;
    }

    function midiToFileNum(midi) {
        const fileNum = midi - MIDI_MIN + 1;
        if (fileNum < 1 || fileNum > TOTAL_FILES) return null;
        return fileNum;
    }

    function resumeCtx() {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    async function loadBuffer(fileNum) {
        const url = SOUNDS_PATH + fileNum + '.mp3';
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        return await audioCtx.decodeAudioData(arrayBuffer);
    }

    // ---- Public API ----

    // options.range = [lowMidi, highMidi] preloads only that span instead of
    // all 88 samples (~2 MB). Notes outside the span still play - they are
    // fetched on demand by play(). Omit options for the original behaviour.
    async function init(onReady, onError, options) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            const range = (options && options.range) || [MIDI_MIN, MIDI_MAX];
            const lo = Math.max(MIDI_MIN, range[0]);
            const hi = Math.min(MIDI_MAX, range[1]);

            const promises = [];
            for (let midi = lo; midi <= hi; midi++) {
                const fileNum = midiToFileNum(midi);
                if (fileNum === null) continue;
                promises.push(
                    loadBuffer(fileNum).then(buf => { buffers[midi] = buf; })
                );
            }

            await Promise.all(promises);
            ready = true;
            if (onReady) onReady();
        } catch (e) {
            if (onError) onError(e);
        }
    }

    function isReady() {
        return ready;
    }

    function stopAll() {
        activeNodes.forEach(node => {
            try { node.stop(); } catch (e) {}
        });
        activeNodes = [];
    }

    // options.fade = seconds of fade-out applied both when `duration` runs
    // out and when the returned stop function is called. Defaults to 0.05.
    // Pass 0 for a hard cut - be aware that stopping a sample while it still
    // has amplitude can produce an audible click.
    function play(midi, duration, options) {
        if (!ready || !audioCtx) return null;
        resumeCtx();

        const fade = (options && options.fade !== undefined) ? options.fade : 0.05;

        const buf = buffers[midi];
        if (!buf) {
            // Outside the preloaded range: fetch it now and play once it lands.
            const fileNum = midiToFileNum(midi);
            if (fileNum !== null && !pending[midi]) {
                pending[midi] = loadBuffer(fileNum)
                    .then(b => { buffers[midi] = b; delete pending[midi]; })
                    .catch(() => { delete pending[midi]; });
            }
            return null;
        }

        const source = audioCtx.createBufferSource();
        source.buffer = buf;

        // Create gain node for fade-out at end of duration
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(1, audioCtx.currentTime);

        source.connect(gain);
        gain.connect(audioCtx.destination);
        source.start(0);

        activeNodes.push(source);

        // Auto-stop after duration, with a fade unless one was waived
        if (duration && duration > 0) {
            const stopTime = audioCtx.currentTime + duration;
            if (fade > 0) {
                gain.gain.setValueAtTime(1, stopTime - fade);
                gain.gain.linearRampToValueAtTime(0, stopTime);
                source.stop(stopTime + 0.01);
            } else {
                source.stop(stopTime);
            }
        }

        // Clean up from activeNodes when done
        source.onended = function () {
            const idx = activeNodes.indexOf(source);
            if (idx !== -1) activeNodes.splice(idx, 1);
        };

        return function stopFn() {
            try {
                if (fade > 0) {
                    gain.gain.cancelScheduledValues(audioCtx.currentTime);
                    gain.gain.setValueAtTime(gain.gain.value, audioCtx.currentTime);
                    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + fade);
                    source.stop(audioCtx.currentTime + fade + 0.01);
                } else {
                    source.stop();
                }
            } catch (e) {}
        };
    }

    function playNote(name, duration, options) {
        const midi = noteNameToMidi(name);
        if (midi === null) return null;
        return play(midi, duration, options);
    }

    function playChord(midis, duration) {
        const stops = [];
        midis.forEach(midi => {
            const s = play(midi, duration);
            if (s) stops.push(s);
        });
        return function stopChord() {
            stops.forEach(s => s());
        };
    }

    return {
        init: init,
        isReady: isReady,
        play: play,
        playNote: playNote,
        playChord: playChord,
        stopAll: stopAll,
        noteNameToMidi: noteNameToMidi
    };
})();

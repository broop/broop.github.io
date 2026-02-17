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

    async function init(onReady, onError) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            // Preload all 88 samples in parallel
            const promises = [];
            for (let i = 1; i <= TOTAL_FILES; i++) {
                const midi = MIDI_MIN + i - 1;
                promises.push(
                    loadBuffer(i).then(buf => { buffers[midi] = buf; })
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

    function play(midi, duration) {
        if (!ready || !audioCtx) return null;
        resumeCtx();

        const buf = buffers[midi];
        if (!buf) return null;

        const source = audioCtx.createBufferSource();
        source.buffer = buf;

        // Create gain node for fade-out at end of duration
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(1, audioCtx.currentTime);

        source.connect(gain);
        gain.connect(audioCtx.destination);
        source.start(0);

        activeNodes.push(source);

        // Auto-stop after duration with short fade
        if (duration && duration > 0) {
            const fadeTime = 0.05;
            const stopTime = audioCtx.currentTime + duration;
            gain.gain.setValueAtTime(1, stopTime - fadeTime);
            gain.gain.linearRampToValueAtTime(0, stopTime);
            source.stop(stopTime + 0.01);
        }

        // Clean up from activeNodes when done
        source.onended = function () {
            const idx = activeNodes.indexOf(source);
            if (idx !== -1) activeNodes.splice(idx, 1);
        };

        return function stopFn() {
            try {
                gain.gain.cancelScheduledValues(audioCtx.currentTime);
                gain.gain.setValueAtTime(gain.gain.value, audioCtx.currentTime);
                gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
                source.stop(audioCtx.currentTime + 0.06);
            } catch (e) {}
        };
    }

    function playNote(name, duration) {
        const midi = noteNameToMidi(name);
        if (midi === null) return null;
        return play(midi, duration);
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

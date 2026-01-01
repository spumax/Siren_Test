// ========================================
// SPUMAX Sirenen-Erkennung Testprojekt
// Version 2: Oberton-Analyse
// ========================================

// Konfiguration
const CONFIG = {
    sampleRate: 44100,
    fftSize: 4096,
    minFrequency: 300,    // Sirenen-Bereich: 300 Hz
    maxFrequency: 3000,   // bis 3000 Hz
    learnDuration: 5000,  // 5 Sekunden lernen
    smoothingFactor: 0.8, // Spektrum-Glättung
    numHarmonics: 5,      // Anzahl Obertöne zu analysieren (1., 2., 3., 4., 5.)
};

// State
let audioContext = null;
let analyser = null;
let microphone = null;
let isRunning = false;
let isLearning = false;
let learnedSignature = null;  // { harmonicRatios: [1, 0.5, 0.3, ...], sampleCount: N }
let tolerance = 50;       // 50% Toleranz
let minMagnitude = 10;    // Mindest-Magnitude
let animationId = null;

// Gelernte Signatur-Daten
let learningData = [];
let learningStartTime = 0;

// DOM Elemente
const startBtn = document.getElementById('startBtn');
const learnBtn = document.getElementById('learnBtn');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const frequencyValue = document.getElementById('frequencyValue');
const detectionStatus = document.getElementById('detectionStatus');
const spectrumCanvas = document.getElementById('spectrumCanvas');
const signatureCanvas = document.getElementById('signatureCanvas');
const signatureStatus = document.getElementById('signatureStatus');
const toleranceValue = document.getElementById('toleranceValue');
const magnitudeValue = document.getElementById('magnitudeValue');
const debugText = document.getElementById('debugText');

const spectrumCtx = spectrumCanvas.getContext('2d');
const signatureCtx = signatureCanvas.getContext('2d');

// ========================================
// Audio Setup
// ========================================

async function startAudio() {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: CONFIG.sampleRate
        });
        
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });
        
        microphone = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = CONFIG.fftSize;
        analyser.smoothingTimeConstant = CONFIG.smoothingFactor;
        
        microphone.connect(analyser);
        
        isRunning = true;
        updateStatus('active', 'Mikrofon aktiv');
        startBtn.classList.add('active');
        startBtn.innerHTML = '<span class="btn-icon">⏹️</span>STOP';
        learnBtn.disabled = false;
        
        log('Audio gestartet: ' + CONFIG.sampleRate + ' Hz, FFT: ' + CONFIG.fftSize);
        
        // Start processing loop
        processAudio();
        
    } catch (error) {
        log('Fehler: ' + error.message);
        updateStatus('', 'Fehler: ' + error.message);
    }
}

function stopAudio() {
    if (microphone) {
        microphone.disconnect();
        microphone = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    
    isRunning = false;
    isLearning = false;
    
    updateStatus('', 'Mikrofon aus');
    startBtn.classList.remove('active');
    startBtn.innerHTML = '<span class="btn-icon">🎤</span>START';
    learnBtn.disabled = true;
    learnBtn.classList.remove('learning');
    
    frequencyValue.textContent = '---';
    detectionStatus.textContent = 'Keine Erkennung';
    detectionStatus.className = 'detection-status';
    
    clearCanvas(spectrumCtx, spectrumCanvas);
    log('Audio gestoppt');
}

// ========================================
// Audio Processing
// ========================================

function processAudio() {
    if (!isRunning) return;
    
    const bufferLength = analyser.frequencyBinCount;
    const frequencyData = new Float32Array(bufferLength);
    analyser.getFloatFrequencyData(frequencyData);
    
    // Konvertiere dB zu linearer Skala (0-100)
    const spectrum = convertToLinear(frequencyData);
    
    // Finde Grundfrequenz (lautester Peak im Bereich)
    const { frequency: fundamentalFreq, magnitude, binIndex } = findFundamental(spectrum);
    
    // Analysiere Obertöne
    const harmonics = analyzeHarmonics(spectrum, fundamentalFreq);
    
    // Zeichne Spektrum mit Oberton-Markierungen
    drawSpectrum(spectrum, fundamentalFreq, harmonics);
    
    // Lernen oder Erkennen
    if (isLearning) {
        collectLearningData(harmonics, fundamentalFreq, magnitude);
    } else if (learnedSignature) {
        // Erkenne Sirene anhand Oberton-Verhältnisse
        const match = matchHarmonics(harmonics, magnitude);
        updateDetection(fundamentalFreq, magnitude, match, harmonics);
    } else {
        // Keine Signatur - zeige nur Frequenz und Obertöne
        if (magnitude > minMagnitude) {
            frequencyValue.textContent = Math.round(fundamentalFreq);
            detectionStatus.textContent = 'Keine Signatur gelernt';
            detectionStatus.className = 'detection-status';
            log(`F0: ${Math.round(fundamentalFreq)} Hz | Obertöne: ${harmonics.ratios.map(r => r.toFixed(2)).join(', ')}`);
        } else {
            frequencyValue.textContent = '---';
            detectionStatus.textContent = 'Signal zu schwach';
            detectionStatus.className = 'detection-status';
        }
    }
    
    animationId = requestAnimationFrame(processAudio);
}

// Konvertiere dB zu linearer Skala
function convertToLinear(dbData) {
    const linear = new Float32Array(dbData.length);
    for (let i = 0; i < dbData.length; i++) {
        // dB zu linear: normalisiert auf 0-100
        const db = dbData[i];
        linear[i] = Math.max(0, Math.pow(10, (db + 100) / 40) * 10);
    }
    return linear;
}

// Finde Grundfrequenz (stärkster Peak im Bereich)
function findFundamental(spectrum) {
    const binSize = CONFIG.sampleRate / CONFIG.fftSize;
    const minBin = Math.floor(CONFIG.minFrequency / binSize);
    const maxBin = Math.ceil(CONFIG.maxFrequency / binSize);
    
    let maxMagnitude = 0;
    let dominantBin = minBin;
    
    for (let i = minBin; i <= maxBin && i < spectrum.length; i++) {
        if (spectrum[i] > maxMagnitude) {
            maxMagnitude = spectrum[i];
            dominantBin = i;
        }
    }
    
    // Parabolische Interpolation für genauere Frequenz
    let frequency = dominantBin * binSize;
    if (dominantBin > 0 && dominantBin < spectrum.length - 1) {
        const y0 = spectrum[dominantBin - 1];
        const y1 = spectrum[dominantBin];
        const y2 = spectrum[dominantBin + 1];
        if (y0 - 2 * y1 + y2 !== 0) {
            const delta = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2);
            frequency = (dominantBin + delta) * binSize;
        }
    }
    
    return { 
        frequency: Math.max(0, frequency), 
        magnitude: maxMagnitude,
        binIndex: dominantBin
    };
}

// ========================================
// Oberton-Analyse (Kernfunktion!)
// ========================================

function analyzeHarmonics(spectrum, fundamentalFreq) {
    const binSize = CONFIG.sampleRate / CONFIG.fftSize;
    const fundamentalBin = Math.round(fundamentalFreq / binSize);
    const fundamentalMag = spectrum[fundamentalBin] || 1;
    
    // Sammle Oberton-Stärken
    const harmonicMagnitudes = [fundamentalMag]; // Index 0 = Grundton
    const harmonicFreqs = [fundamentalFreq];
    
    for (let h = 2; h <= CONFIG.numHarmonics + 1; h++) {
        const harmonicFreq = fundamentalFreq * h;
        const harmonicBin = Math.round(harmonicFreq / binSize);
        
        // Suche Peak in Umgebung (±3 Bins für Ungenauigkeiten)
        let maxMag = 0;
        let peakBin = harmonicBin;
        for (let offset = -3; offset <= 3; offset++) {
            const bin = harmonicBin + offset;
            if (bin >= 0 && bin < spectrum.length && spectrum[bin] > maxMag) {
                maxMag = spectrum[bin];
                peakBin = bin;
            }
        }
        
        harmonicMagnitudes.push(maxMag);
        harmonicFreqs.push(peakBin * binSize);
    }
    
    // Berechne Verhältnisse relativ zum Grundton
    const ratios = harmonicMagnitudes.map(m => m / fundamentalMag);
    
    return {
        magnitudes: harmonicMagnitudes,
        frequencies: harmonicFreqs,
        ratios: ratios  // [1.0, ratio2, ratio3, ratio4, ...]
    };
}

// ========================================
// Signatur Lernen
// ========================================

function startLearning() {
    if (!isRunning) return;
    
    isLearning = true;
    learningData = [];
    learningStartTime = Date.now();
    
    learnBtn.classList.add('learning');
    learnBtn.innerHTML = '<span class="btn-icon">⏳</span>LERNT...';
    updateStatus('listening', 'Sirene aufnehmen...');
    
    log('Lernphase gestartet - bitte Sirene aktivieren');
    
    // Fortschrittsanzeige
    updateLearningProgress();
}

function collectLearningData(harmonics, frequency, magnitude) {
    const elapsed = Date.now() - learningStartTime;
    
    // Nur starke Signale im gültigen Frequenzbereich sammeln
    if (magnitude > minMagnitude && 
        frequency >= CONFIG.minFrequency && 
        frequency <= CONFIG.maxFrequency) {
        
        learningData.push({
            ratios: [...harmonics.ratios],
            frequency: frequency,
            magnitude: magnitude,
            time: elapsed
        });
    }
    
    // Nach 5 Sekunden beenden
    if (elapsed >= CONFIG.learnDuration) {
        finishLearning();
    }
}

function updateLearningProgress() {
    if (!isLearning) return;
    
    const elapsed = Date.now() - learningStartTime;
    const progress = Math.min(100, (elapsed / CONFIG.learnDuration) * 100);
    
    // Update debug
    const samples = learningData.length;
    debugText.textContent = `Lernen: ${progress.toFixed(0)}% - ${samples} Samples`;
    
    if (isLearning) {
        setTimeout(updateLearningProgress, 100);
    }
}

function finishLearning() {
    isLearning = false;
    learnBtn.classList.remove('learning');
    learnBtn.innerHTML = '<span class="btn-icon">📚</span>LERNEN';
    updateStatus('active', 'Mikrofon aktiv');
    
    if (learningData.length < 10) {
        log('Zu wenige Samples (' + learningData.length + ') - bitte erneut versuchen');
        signatureStatus.textContent = 'Lernen fehlgeschlagen (zu wenig Signal)';
        signatureStatus.className = 'signature-status';
        return;
    }
    
    // Berechne durchschnittliche Oberton-Verhältnisse
    const avgRatios = calculateAverageRatios(learningData);
    
    learnedSignature = {
        harmonicRatios: avgRatios,
        sampleCount: learningData.length,
        timestamp: Date.now()
    };
    
    // Zeichne Signatur (Oberton-Verhältnisse als Balken)
    drawSignature(avgRatios);
    
    signatureStatus.textContent = `✓ Signatur gelernt (${learningData.length} Samples)`;
    signatureStatus.className = 'signature-status active';
    
    log('Oberton-Verhältnisse: ' + avgRatios.map(r => r.toFixed(2)).join(', '));
}

function calculateAverageRatios(data) {
    if (data.length === 0) return [];
    
    const numHarmonics = data[0].ratios.length;
    const sum = new Array(numHarmonics).fill(0);
    
    for (const sample of data) {
        for (let i = 0; i < numHarmonics; i++) {
            sum[i] += sample.ratios[i];
        }
    }
    
    return sum.map(v => v / data.length);
}

// ========================================
// Signatur Matching (Oberton-Vergleich)
// ========================================

function matchHarmonics(currentHarmonics, magnitude) {
    if (!learnedSignature || magnitude < minMagnitude) {
        return { matched: false, similarity: 0, details: 'Signal zu schwach' };
    }
    
    const currentRatios = currentHarmonics.ratios;
    const learnedRatios = learnedSignature.harmonicRatios;
    
    // Berechne Ähnlichkeit der Oberton-Verhältnisse
    // Wir vergleichen ab Index 1 (Obertöne), Index 0 ist immer 1.0 (Grundton)
    let totalDiff = 0;
    let comparisons = 0;
    const diffs = [];
    
    for (let i = 1; i < Math.min(currentRatios.length, learnedRatios.length); i++) {
        const learned = learnedRatios[i];
        const current = currentRatios[i];
        
        // Relative Differenz
        const diff = Math.abs(learned - current) / Math.max(learned, 0.1);
        diffs.push(diff);
        totalDiff += diff;
        comparisons++;
    }
    
    // Durchschnittliche Abweichung
    const avgDiff = comparisons > 0 ? totalDiff / comparisons : 1;
    
    // Ähnlichkeit: 0% = komplett anders, 100% = identisch
    const similarity = Math.max(0, 1 - avgDiff) * 100;
    
    // Schwellwert basierend auf Toleranz
    const threshold = 100 - tolerance;
    const matched = similarity >= threshold;
    
    return { 
        matched, 
        similarity,
        details: `Obertöne: ${diffs.map(d => (d * 100).toFixed(0) + '%').join(', ')}`
    };
}

// ========================================
// UI Updates
// ========================================

function updateDetection(frequency, magnitude, match, harmonics) {
    if (magnitude < minMagnitude) {
        frequencyValue.textContent = '---';
        detectionStatus.textContent = 'Signal zu schwach';
        detectionStatus.className = 'detection-status';
        return;
    }
    
    frequencyValue.textContent = Math.round(frequency);
    
    if (match.matched) {
        detectionStatus.textContent = `✓ SIRENE (${match.similarity.toFixed(0)}%)`;
        detectionStatus.className = 'detection-status detected';
        log(`MATCH! ${Math.round(frequency)} Hz | Ähnlichkeit: ${match.similarity.toFixed(1)}%`);
    } else {
        detectionStatus.textContent = `✗ Nicht erkannt (${match.similarity.toFixed(0)}%)`;
        detectionStatus.className = 'detection-status not-detected';
    }
}

function updateStatus(state, text) {
    statusIndicator.className = 'status-indicator ' + state;
    statusText.textContent = text;
}

function log(message) {
    const time = new Date().toLocaleTimeString();
    debugText.textContent = `[${time}] ${message}`;
    console.log(message);
}

// ========================================
// Canvas Drawing
// ========================================

function drawSpectrum(spectrum, fundamentalFreq, harmonics) {
    const width = spectrumCanvas.width;
    const height = spectrumCanvas.height;
    
    spectrumCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    spectrumCtx.fillRect(0, 0, width, height);
    
    const binSize = CONFIG.sampleRate / CONFIG.fftSize;
    const minBin = Math.floor(CONFIG.minFrequency / binSize);
    const maxBin = Math.ceil(CONFIG.maxFrequency / binSize);
    const numBins = maxBin - minBin;
    
    const barWidth = width / numBins;
    
    // Berechne Oberton-Positionen
    const harmonicBins = harmonics.frequencies.map(f => Math.round(f / binSize));
    
    for (let i = 0; i < numBins; i++) {
        const bin = minBin + i;
        const value = spectrum[bin] || 0;
        const barHeight = Math.min(height, (value / 50) * height);
        
        const x = i * barWidth;
        const y = height - barHeight;
        
        // Farbe: Gelb für Grundton, Cyan für Obertöne, Grau sonst
        const fundamentalBin = Math.round(fundamentalFreq / binSize);
        
        if (Math.abs(bin - fundamentalBin) <= 1) {
            // Grundton
            spectrumCtx.fillStyle = '#ffcc00';
        } else if (harmonicBins.slice(1).some(hb => Math.abs(bin - hb) <= 1)) {
            // Oberton
            spectrumCtx.fillStyle = '#00ccff';
        } else {
            spectrumCtx.fillStyle = '#444';
        }
        
        spectrumCtx.fillRect(x, y, barWidth - 1, barHeight);
    }
    
    // Beschriftung für Obertöne
    spectrumCtx.fillStyle = '#888';
    spectrumCtx.font = '10px sans-serif';
    
    const f0Bin = Math.round(fundamentalFreq / binSize);
    const f0X = (f0Bin - minBin) * barWidth;
    if (f0X > 0 && f0X < width - 20) {
        spectrumCtx.fillText('F0', f0X, 12);
    }
    
    for (let h = 2; h <= CONFIG.numHarmonics + 1; h++) {
        const hBin = Math.round((fundamentalFreq * h) / binSize);
        const hX = (hBin - minBin) * barWidth;
        if (hX > 0 && hX < width - 20) {
            spectrumCtx.fillText(`${h}x`, hX, 12);
        }
    }
    
    // Schwellwert-Linie
    const thresholdY = height - (minMagnitude / 50) * height;
    spectrumCtx.strokeStyle = '#ffaa00';
    spectrumCtx.setLineDash([5, 5]);
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(0, thresholdY);
    spectrumCtx.lineTo(width, thresholdY);
    spectrumCtx.stroke();
    spectrumCtx.setLineDash([]);
}

function drawSignature(ratios) {
    const width = signatureCanvas.width;
    const height = signatureCanvas.height;
    
    signatureCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    signatureCtx.fillRect(0, 0, width, height);
    
    if (!ratios || ratios.length === 0) return;
    
    const barWidth = (width - 40) / ratios.length;
    const maxRatio = Math.max(...ratios);
    
    // Beschriftung
    signatureCtx.fillStyle = '#666';
    signatureCtx.font = '10px sans-serif';
    
    for (let i = 0; i < ratios.length; i++) {
        const value = ratios[i] / maxRatio;
        const barHeight = value * (height - 25);
        
        const x = 20 + i * barWidth;
        const y = height - 15 - barHeight;
        
        // Farbe: Gelb für Grundton, Cyan für Obertöne
        signatureCtx.fillStyle = i === 0 ? '#ffcc00' : '#00ccff';
        signatureCtx.fillRect(x, y, barWidth - 4, barHeight);
        
        // Beschriftung
        signatureCtx.fillStyle = '#888';
        const label = i === 0 ? 'F0' : `${i + 1}x`;
        signatureCtx.fillText(label, x + 2, height - 3);
        
        // Prozentwert
        signatureCtx.fillText((ratios[i] * 100).toFixed(0) + '%', x + 2, y - 3);
    }
}

function clearCanvas(ctx, canvas) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ========================================
// Event Listeners
// ========================================

startBtn.addEventListener('click', () => {
    if (isRunning) {
        stopAudio();
    } else {
        startAudio();
    }
});

learnBtn.addEventListener('click', () => {
    if (!isLearning) {
        startLearning();
    }
});

document.getElementById('tolMinus').addEventListener('click', () => {
    tolerance = Math.max(10, tolerance - 10);
    toleranceValue.textContent = tolerance;
});

document.getElementById('tolPlus').addEventListener('click', () => {
    tolerance = Math.min(90, tolerance + 10);
    toleranceValue.textContent = tolerance;
});

document.getElementById('magMinus').addEventListener('click', () => {
    minMagnitude = Math.max(1, minMagnitude - 2);
    magnitudeValue.textContent = minMagnitude;
});

document.getElementById('magPlus').addEventListener('click', () => {
    minMagnitude = Math.min(50, minMagnitude + 2);
    magnitudeValue.textContent = minMagnitude;
});

// ========================================
// Init
// ========================================

// Canvas Größe anpassen
function resizeCanvases() {
    const container = document.querySelector('.spectrum-container');
    if (container) {
        spectrumCanvas.width = container.clientWidth - 20;
    }
    
    const sigBox = document.querySelector('.signature-box');
    if (sigBox) {
        signatureCanvas.width = sigBox.clientWidth - 30;
    }
}

window.addEventListener('resize', resizeCanvases);
resizeCanvases();

// Initial clear
clearCanvas(spectrumCtx, spectrumCanvas);
clearCanvas(signatureCtx, signatureCanvas);

log('v2: Oberton-Analyse - START drücken');

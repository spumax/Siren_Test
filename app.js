// ========================================
// SPUMAX Sirenen-Erkennung Testprojekt
// ========================================

// Konfiguration
const CONFIG = {
    sampleRate: 44100,
    fftSize: 4096,
    minFrequency: 300,    // Sirenen-Bereich: 300 Hz
    maxFrequency: 3000,   // bis 3000 Hz
    learnDuration: 5000,  // 5 Sekunden lernen
    smoothingFactor: 0.8, // Spektrum-Glättung
};

// State
let audioContext = null;
let analyser = null;
let microphone = null;
let isRunning = false;
let isLearning = false;
let learnedSignature = null;
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
    
    // Konvertiere dB zu linearer Skala (0-1)
    const spectrum = convertToLinear(frequencyData);
    
    // Finde dominante Frequenz im Sirenen-Bereich
    const { frequency, magnitude, binIndex } = findDominantFrequency(spectrum);
    
    // Zeichne Spektrum
    drawSpectrum(spectrum, binIndex);
    
    // Lernen oder Erkennen
    if (isLearning) {
        collectLearningData(spectrum, frequency, magnitude);
    } else if (learnedSignature) {
        // Erkenne Sirene
        const match = matchSignature(spectrum, magnitude);
        updateDetection(frequency, magnitude, match);
    } else {
        // Keine Signatur - zeige nur Frequenz
        if (magnitude > minMagnitude) {
            frequencyValue.textContent = Math.round(frequency);
            detectionStatus.textContent = 'Keine Signatur gelernt';
            detectionStatus.className = 'detection-status';
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
        // dB zu linear: 10^(dB/20), normalisiert auf 0-100
        const db = dbData[i];
        linear[i] = Math.max(0, Math.pow(10, (db + 100) / 40) * 10);
    }
    return linear;
}

// Finde dominante Frequenz im Bereich
function findDominantFrequency(spectrum) {
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

function collectLearningData(spectrum, frequency, magnitude) {
    const elapsed = Date.now() - learningStartTime;
    
    // Nur starke Signale sammeln
    if (magnitude > minMagnitude) {
        // Extrahiere relevanten Bereich des Spektrums
        const binSize = CONFIG.sampleRate / CONFIG.fftSize;
        const minBin = Math.floor(CONFIG.minFrequency / binSize);
        const maxBin = Math.ceil(CONFIG.maxFrequency / binSize);
        
        const relevantSpectrum = Array.from(spectrum.slice(minBin, maxBin));
        
        learningData.push({
            spectrum: relevantSpectrum,
            frequency: frequency,
            magnitude: magnitude,
            time: elapsed
        });
    }
    
    // Fortschritt aktualisieren
    const progress = Math.min(100, (elapsed / CONFIG.learnDuration) * 100);
    
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
        signatureStatus.textContent = 'Lernen fehlgeschlagen';
        signatureStatus.className = 'signature-status';
        return;
    }
    
    // Berechne durchschnittliches Spektrum
    const avgSpectrum = calculateAverageSpectrum(learningData);
    
    // Normalisiere auf 0-1
    const maxVal = Math.max(...avgSpectrum);
    const normalizedSpectrum = avgSpectrum.map(v => v / maxVal);
    
    learnedSignature = {
        spectrum: normalizedSpectrum,
        sampleCount: learningData.length,
        timestamp: Date.now()
    };
    
    // Zeichne Signatur
    drawSignature(normalizedSpectrum);
    
    signatureStatus.textContent = `✓ Signatur gelernt (${learningData.length} Samples)`;
    signatureStatus.className = 'signature-status active';
    
    log('Signatur gelernt: ' + learningData.length + ' Samples');
}

function calculateAverageSpectrum(data) {
    if (data.length === 0) return [];
    
    const length = data[0].spectrum.length;
    const sum = new Array(length).fill(0);
    
    for (const sample of data) {
        for (let i = 0; i < length; i++) {
            sum[i] += sample.spectrum[i];
        }
    }
    
    return sum.map(v => v / data.length);
}

// ========================================
// Signatur Matching
// ========================================

function matchSignature(currentSpectrum, magnitude) {
    if (!learnedSignature || magnitude < minMagnitude) {
        return { matched: false, correlation: 0 };
    }
    
    // Extrahiere relevanten Bereich
    const binSize = CONFIG.sampleRate / CONFIG.fftSize;
    const minBin = Math.floor(CONFIG.minFrequency / binSize);
    const maxBin = Math.ceil(CONFIG.maxFrequency / binSize);
    
    const currentRelevant = Array.from(currentSpectrum.slice(minBin, maxBin));
    
    // Normalisiere aktuelles Spektrum
    const maxVal = Math.max(...currentRelevant);
    if (maxVal === 0) return { matched: false, correlation: 0 };
    
    const normalizedCurrent = currentRelevant.map(v => v / maxVal);
    
    // Berechne Korrelation
    const correlation = calculateCorrelation(
        normalizedCurrent, 
        learnedSignature.spectrum
    );
    
    // Schwellwert basierend auf Toleranz
    const threshold = 1 - (tolerance / 100);
    const matched = correlation >= threshold;
    
    return { matched, correlation };
}

function calculateCorrelation(a, b) {
    if (a.length !== b.length) {
        // Bei unterschiedlicher Länge: kürzeres Array verwenden
        const minLen = Math.min(a.length, b.length);
        a = a.slice(0, minLen);
        b = b.slice(0, minLen);
    }
    
    // Pearson Korrelation
    const n = a.length;
    let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
    
    for (let i = 0; i < n; i++) {
        sumA += a[i];
        sumB += b[i];
        sumAB += a[i] * b[i];
        sumA2 += a[i] * a[i];
        sumB2 += b[i] * b[i];
    }
    
    const numerator = n * sumAB - sumA * sumB;
    const denominator = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
    
    if (denominator === 0) return 0;
    
    return Math.max(0, numerator / denominator);
}

// ========================================
// UI Updates
// ========================================

function updateDetection(frequency, magnitude, match) {
    if (magnitude < minMagnitude) {
        frequencyValue.textContent = '---';
        detectionStatus.textContent = 'Signal zu schwach';
        detectionStatus.className = 'detection-status';
        return;
    }
    
    frequencyValue.textContent = Math.round(frequency);
    
    if (match.matched) {
        detectionStatus.textContent = `✓ SIRENE (${(match.correlation * 100).toFixed(0)}%)`;
        detectionStatus.className = 'detection-status detected';
    } else {
        detectionStatus.textContent = `✗ Nicht erkannt (${(match.correlation * 100).toFixed(0)}%)`;
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

function drawSpectrum(spectrum, peakBin) {
    const width = spectrumCanvas.width;
    const height = spectrumCanvas.height;
    
    spectrumCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    spectrumCtx.fillRect(0, 0, width, height);
    
    const binSize = CONFIG.sampleRate / CONFIG.fftSize;
    const minBin = Math.floor(CONFIG.minFrequency / binSize);
    const maxBin = Math.ceil(CONFIG.maxFrequency / binSize);
    const numBins = maxBin - minBin;
    
    const barWidth = width / numBins;
    
    for (let i = 0; i < numBins; i++) {
        const bin = minBin + i;
        const value = spectrum[bin] || 0;
        const barHeight = Math.min(height, (value / 50) * height);
        
        const x = i * barWidth;
        const y = height - barHeight;
        
        // Farbe: rot für Peak, grün für Match-Bereich
        if (bin === peakBin) {
            spectrumCtx.fillStyle = '#ff4444';
        } else if (learnedSignature && value > minMagnitude) {
            spectrumCtx.fillStyle = '#44ff44';
        } else {
            spectrumCtx.fillStyle = '#666';
        }
        
        spectrumCtx.fillRect(x, y, barWidth - 1, barHeight);
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

function drawSignature(spectrum) {
    const width = signatureCanvas.width;
    const height = signatureCanvas.height;
    
    signatureCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    signatureCtx.fillRect(0, 0, width, height);
    
    if (!spectrum || spectrum.length === 0) return;
    
    const barWidth = width / spectrum.length;
    
    for (let i = 0; i < spectrum.length; i++) {
        const value = spectrum[i];
        const barHeight = value * height * 0.9;
        
        const x = i * barWidth;
        const y = height - barHeight;
        
        spectrumCtx.fillStyle = '#44ff44';
        signatureCtx.fillStyle = `rgba(68, 255, 68, ${0.3 + value * 0.7})`;
        signatureCtx.fillRect(x, y, barWidth - 1, barHeight);
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

log('Bereit - START drücken um zu beginnen');


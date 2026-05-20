// --- SYNC GRAPH ENGINE ---
export const SYNC_GRAPH = {
    rangeMs: 50,
    historyLength: 180,
    sampleIntervalMs: 45,
    insets: { left: 0, right: 18, top: 6, bottom: 6 },
    labels: { xInset: 6, positiveOffsetY: 12, zeroOffsetY: 1, negativeOffsetY: -12 },
    strokeWidthPx: 2.5,
    endpointRadiusPx: 4.5,
    lineShadowBlurPx: 16,
    pointShadowBlurPx: 14,
};
export const TONE_COLORS = {
    "sync-idle": [239, 225, 187],
    "sync-good": [245, 255, 246],
    "sync-warn": [255, 224, 130],
    "sync-bad": [255, 154, 146],
};
export const SYNC_CLASSES = ["sync-good", "sync-warn", "sync-bad", "sync-idle"];

export function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
export function rgba(color, alpha) { return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`; }

export function applySyncToneClass(element, tone) {
    if (element) {
        element.classList.remove(...SYNC_CLASSES);
        element.classList.add(tone);
    }
}

export function formatSyncValue(syncMs) {
    const normalizedSyncMs = Math.abs(syncMs) < 0.05 ? 0 : syncMs;
    return `${normalizedSyncMs.toFixed(1)} ms`;
}

export function getSyncTone(syncMs) {
    const absSyncMs = Math.abs(syncMs);
    if (absSyncMs < 10) return "sync-good";
    if (absSyncMs <= 25) return "sync-warn";
    return "sync-bad";
}

export function createSyncGraph({ canvas, shell }) {
    let animationFrame = null;
    let lastSampleAtMs = 0;
    let history = [];
    let currentSyncMs = null;
    let currentTone = "sync-idle";
    const resetThresholdMs = SYNC_GRAPH.sampleIntervalMs * SYNC_GRAPH.historyLength;

    function clearHistory() {
        history = [];
        lastSampleAtMs = 0;
    }

    function getContext() {
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const dpr = window.devicePixelRatio || 1;
        const width = rect.width;
        const height = rect.height;
        const pixelWidth = Math.round(width * dpr);
        const pixelHeight = Math.round(height * dpr);

        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, width, height };
    }

    function getMetrics(width, height) {
        const { left, right, top, bottom } = SYNC_GRAPH.insets;
        return { width, height, left, right, top, bottom, plotWidth: width - left - right, plotHeight: height - top - bottom };
    }

    function getX(index, historyLength, metrics) {
        const ageFromNewest = historyLength - 1 - index;
        const ratio = ageFromNewest / Math.max(SYNC_GRAPH.historyLength - 1, 1);
        return metrics.width - metrics.right - ratio * metrics.plotWidth;
    }

    function getY(syncMs, metrics) {
        const clamped = clamp(syncMs, -SYNC_GRAPH.rangeMs, SYNC_GRAPH.rangeMs);
        const ratio = (SYNC_GRAPH.rangeMs - clamped) / (SYNC_GRAPH.rangeMs * 2);
        return metrics.top + ratio * metrics.plotHeight;
    }

    function getGridLines() {
        const max = SYNC_GRAPH.rangeMs;
        const half = max / 2;
        return [
            { value: max, label: String(max), alpha: 0.16, dash: [] },
            { value: half, label: null, alpha: 0.08, dash: [4, 6] },
            { value: 0, label: "0", alpha: 0.22, dash: [] },
            { value: -half, label: null, alpha: 0.08, dash: [4, 6] },
            { value: -max, label: String(-max), alpha: 0.16, dash: [] },
        ];
    }

    function getLabelOffsetY(value) {
        if (value > 0) return SYNC_GRAPH.labels.positiveOffsetY;
        if (value < 0) return SYNC_GRAPH.labels.negativeOffsetY;
        return SYNC_GRAPH.labels.zeroOffsetY;
    }

    function drawGrid(ctx, metrics) {
        const lines = getGridLines();
        ctx.save();
        ctx.font = '11px "SF Mono", "Monaco", "Menlo", monospace';
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";

        for (const line of lines) {
            const y = getY(line.value, metrics);
            ctx.beginPath();
            ctx.setLineDash(line.dash);
            ctx.moveTo(metrics.left, y);
            ctx.lineTo(metrics.width - metrics.right, y);
            ctx.strokeStyle = `rgba(255, 255, 255, ${line.alpha})`;
            ctx.lineWidth = line.value === 0 ? 1.2 : 1;
            ctx.stroke();

            if (line.label !== null) {
                const labelY = clamp(y + getLabelOffsetY(line.value), 12, metrics.height - 12);
                ctx.fillStyle = "rgba(255, 255, 255, 0.46)";
                ctx.fillText(line.label, metrics.width - SYNC_GRAPH.labels.xInset, labelY);
            }
        }
        ctx.restore();
    }

    function traceSmoothLine(ctx, points) {
        if (points.length === 0) return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        if (points.length === 1) return;
        for (let i = 1; i < points.length - 1; i += 1) {
            const midX = (points[i].x + points[i + 1].x) / 2;
            const midY = (points[i].y + points[i + 1].y) / 2;
            ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
        }
        const lastPoint = points[points.length - 1];
        ctx.quadraticCurveTo(lastPoint.x, lastPoint.y, lastPoint.x, lastPoint.y);
    }

    function getSegments(metrics) {
        const segments = [];
        let currentSegment = [];
        for (let i = 0; i < history.length; i += 1) {
            const sample = history[i];
            if (typeof sample.syncMs !== "number") {
                if (currentSegment.length > 0) { segments.push(currentSegment); currentSegment = []; }
                continue;
            }
            currentSegment.push({ x: getX(i, history.length, metrics), y: getY(sample.syncMs, metrics) });
        }
        if (currentSegment.length > 0) segments.push(currentSegment);
        return segments;
    }

    function drawLine(ctx, metrics) {
        const segments = getSegments(metrics);
        if (segments.length === 0) return;

        const toneColor = TONE_COLORS[currentTone] ?? TONE_COLORS["sync-idle"];
        const strokeGradient = ctx.createLinearGradient(metrics.left, 0, metrics.width - metrics.right, 0);
        strokeGradient.addColorStop(0, rgba(toneColor, 0.12));
        strokeGradient.addColorStop(0.7, rgba(toneColor, 0.58));
        strokeGradient.addColorStop(1, rgba(toneColor, 0.98));

        ctx.save();
        ctx.lineWidth = SYNC_GRAPH.strokeWidthPx;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = strokeGradient;
        ctx.shadowBlur = SYNC_GRAPH.lineShadowBlurPx;
        ctx.shadowColor = rgba(toneColor, 0.28);

        for (const segment of segments) {
            traceSmoothLine(ctx, segment);
            ctx.stroke();
        }
        ctx.restore();

        const lastSegment = segments[segments.length - 1];
        const lastPoint = lastSegment[lastSegment.length - 1];
        if (!lastPoint) return;
        ctx.save();
        ctx.beginPath();
        ctx.arc(lastPoint.x, lastPoint.y, SYNC_GRAPH.endpointRadiusPx, 0, Math.PI * 2);
        ctx.fillStyle = rgba(toneColor, 0.98);
        ctx.shadowBlur = SYNC_GRAPH.pointShadowBlurPx;
        ctx.shadowColor = rgba(toneColor, 0.42);
        ctx.fill();
        ctx.restore();
    }

    function draw() {
        const graph = getContext();
        if (!graph) return;
        const { ctx, width, height } = graph;
        const metrics = getMetrics(width, height);
        ctx.clearRect(0, 0, width, height);
        drawGrid(ctx, metrics);
        drawLine(ctx, metrics);
    }

    function sampleHistory() {
        history.push({ syncMs: currentSyncMs });
        if (history.length > SYNC_GRAPH.historyLength) history.shift();
    }

    function loop(timestampMs) {
        if (lastSampleAtMs === 0) { lastSampleAtMs = timestampMs; sampleHistory(); }
        const elapsedMs = timestampMs - lastSampleAtMs;
        if (elapsedMs > resetThresholdMs) {
            clearHistory();
            lastSampleAtMs = timestampMs;
            sampleHistory();
        } else {
            while (timestampMs - lastSampleAtMs >= SYNC_GRAPH.sampleIntervalMs) {
                lastSampleAtMs += SYNC_GRAPH.sampleIntervalMs;
                sampleHistory();
            }
        }
        draw();
        animationFrame = window.requestAnimationFrame(loop);
    }

    return {
        start() {
            if (animationFrame !== null) return;
            draw();
            animationFrame = window.requestAnimationFrame(loop);
        },
        stop() {
            if (animationFrame === null) return;
            window.cancelAnimationFrame(animationFrame);
            animationFrame = null;
        },
        reset() { clearHistory(); draw(); },
        updateSample({ syncMs, tone }) {
            currentSyncMs = syncMs;
            currentTone = tone;
            applySyncToneClass(shell, tone);
            if (animationFrame === null) draw();
        },
    };
}

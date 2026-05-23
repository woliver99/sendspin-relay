const MAX_LOG_LINES = 500;

window._rawLogs = [];
try {
    const saved = localStorage.getItem('sendspinDebugLogs');
    if (saved) {
        window._rawLogs = JSON.parse(saved);
        if (!Array.isArray(window._rawLogs)) window._rawLogs = [];
    }
} catch (e) {
    window._rawLogs = [];
}

const timeStr = new Date().toISOString().split('T')[1].slice(0, -1);
window._rawLogs.push(`\n=== NEW SESSION [${timeStr}] ===\n`);

// Intercept console logs silently in the background
['log', 'warn', 'error', 'info'].forEach(method => {
    const original = console[method];
    console[method] = function (...args) {
        const parsed = args.map(a => {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch (e) { return String(a); }
        });

        // Add a timestamp to make debugging sync issues easier
        const time = new Date().toISOString().split('T')[1].slice(0, -1);
        window._rawLogs.push(`[${time}] [${method.toUpperCase()}] ${parsed.join(' ')}`);

        // Cap arrays so JSON.stringify remains performant and local storage isn't exhausted
        if (window._rawLogs.length > MAX_LOG_LINES) {
            window._rawLogs = window._rawLogs.slice(window._rawLogs.length - MAX_LOG_LINES);
        }

        try {
            localStorage.setItem('sendspinDebugLogs', JSON.stringify(window._rawLogs));
        } catch (e) { }

        original.apply(console, args);
    };
});

window.clearDebugLogs = function () {
    window._rawLogs = [];
    try { localStorage.removeItem('sendspinDebugLogs'); } catch (e) { }
    console.log("Logs manually cleared.");
};

// Dedicated copy function
window.copyDebugLogs = function () {
    const text = window._rawLogs.join('\n');

    if (!text) {
        alert('No logs generated yet.');
        return;
    }

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(() => alert(`Copied ${window._rawLogs.length} logs to clipboard!`))
            .catch(() => alert('Copy failed.'));
    } else {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert(`Copied ${window._rawLogs.length} logs to clipboard!`);
    }
};
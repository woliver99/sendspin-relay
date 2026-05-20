window._rawLogs = [];

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

        original.apply(console, args);
    };
});

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
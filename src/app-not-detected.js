"use strict";
// Shown by the background worker when it can't reach the Mic Drop app.
// Re-check regularly while the page is visible, so it updates by itself once
// Mic Drop is opened or updated.
const APP_STATUS_RECHECK_INTERVAL_MS = 3000;
const checkActions = document.getElementById('check-actions');
const checkAgainButton = document.getElementById('check-again');
const checkStatus = document.getElementById('check-status');
function showAppStatus(status) {
    for (const id of ['connected', 'notDetected']) {
        const section = document.getElementById(id === 'notDetected' ? 'not-detected' : id);
        if (section) {
            section.hidden = id !== status;
        }
    }
    if (checkActions) {
        checkActions.hidden = status === 'connected';
    }
    document.title = {
        connected: 'Mic Drop is connected',
        notDetected: 'Mic Drop app not detected',
    }[status];
}
// How many checks are waiting for the worker. Regular re-checks skip a turn
// while one is, but "Check again" always goes ahead: the worker shares one scan
// between overlapping checks.
let appStatusChecksInFlight = 0;
async function requestAppStatus(showProgress) {
    // Without `chrome.runtime`, this page isn't running inside the extension (eg.
    // it was opened straight from disk) and can't ask the worker anything, so
    // say so once rather than failing every few seconds.
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
        clearInterval(appStatusRecheckInterval);
        console.warn('[Mic Drop] Can’t check for the app: this page isn’t running inside the extension.');
        if (checkAgainButton && checkStatus) {
            checkAgainButton.disabled = true;
            checkStatus.textContent = 'Can’t reach the Mic Drop extension from this page.';
        }
        return;
    }
    if (appStatusChecksInFlight > 0 && !showProgress) {
        return;
    }
    appStatusChecksInFlight++;
    if (showProgress && checkAgainButton && checkStatus) {
        checkAgainButton.disabled = true;
        checkStatus.textContent = 'Checking…';
    }
    try {
        // Only "Check again" restarts the background worker's scan for the app.
        const status = (await chrome.runtime.sendMessage({
            restart: showProgress,
            type: 'checkAppStatus',
        }));
        showAppStatus(status);
        if (showProgress && checkStatus && status !== 'connected') {
            checkStatus.textContent = 'Still can’t find Mic Drop.';
        }
        if (status === 'connected') {
            clearInterval(appStatusRecheckInterval);
        }
    }
    catch (error) {
        // The worker is restarting; the next check will try again.
        console.warn('[Mic Drop] Couldn’t check for the app:', error);
        if (showProgress && checkStatus) {
            checkStatus.textContent = 'Couldn’t check; try again in a moment.';
        }
    }
    finally {
        appStatusChecksInFlight--;
        if (showProgress && checkAgainButton) {
            checkAgainButton.disabled = false;
        }
    }
}
showAppStatus('notDetected');
checkAgainButton?.addEventListener('click', () => requestAppStatus(true));
const appStatusRecheckInterval = setInterval(() => {
    if (document.visibilityState === 'visible') {
        requestAppStatus(false);
    }
}, APP_STATUS_RECHECK_INTERVAL_MS);
//# sourceMappingURL=app-not-detected.js.map
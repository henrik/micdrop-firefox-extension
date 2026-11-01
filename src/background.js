"use strict";
const WS_PORT_START = 13400;
const WS_PORT_END = 13420;
const WS_PORT_RETRIES = 4;
const WS_PORT_RETRY_DELAY_MS = 10_000;
const RECONNECT_DELAY_MS = 3000;
// When checking whether the app is available, how long to wait for each port
// to open. Once a few connections have failed (eg. while the app isn't
// running), Chrome holds back every new WebSocket connection for a random 1–5
// seconds, including the one to the app, so allow longer than that.
const APP_CHECK_PORT_TIMEOUT_MS = 6000;
// How long a WebSocket server has to reply to `requestSync` before it's
// treated as not being Mic Drop (another app, or a version of Mic Drop too old
// for this extension).
const HANDSHAKE_TIMEOUT_MS = 2000;
// Stored in session storage once the "app not detected" page has been shown,
// so it's opened at most once per browser session.
const APP_NOT_DETECTED_PAGE_SHOWN_KEY = 'appNotDetectedPageShown';
let socket = null;
let reconnectTimer = null;
// Set while `connect` is scanning ports, so overlapping calls (eg. a poll
// from every Meet tab) don't each start their own scan.
let connecting = false;
// Incremented to abandon an in-progress scan (eg. so "Check again" can start
// over from the first port); each scan stops once it no longer matches.
let scanGeneration = 0;
// Set when a Meet tab asks for the app's mute state before the WebSocket is
// open; the request is sent as soon as the connection is established.
let pendingMuteStateRequest = false;
/**
 * On installation (or update), check a few things and show the appropriate
 * page if we detect any issues:
 *
 * - If not on macOS, show an "Unsupported" page (on installation only).
 * - If the Mic Drop app can't be reached (not installed, not running, or too
 *   old to reply to `requestSync`), show an "App not detected" page with info on how to fix it.
 */
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    const info = await chrome.runtime.getPlatformInfo();
    if (info.os !== 'mac') {
        console.warn('This extension is only supported on macOS.');
        // Open an "Unsupported" page, once: not again after every update.
        if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
            chrome.tabs.create({ url: 'unsupported.html' });
        }
        return;
    }
    if (reason === chrome.runtime.OnInstalledReason.INSTALL ||
        reason === chrome.runtime.OnInstalledReason.UPDATE) {
        showAppNotDetectedPageIfNeeded();
    }
});
// All ports opened by content scripts. Keeping at least one port open prevents
// the service worker from being suspended while a Meet tab is active.
const contentPorts = new Set();
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// Open a WebSocket on a single port and check it's Mic Drop: it must reply to
// `requestSync` with its mute state. Rejects if the port errors, doesn't open
// in time (when `timeoutMs` is given), or doesn't answer like Mic Drop. The
// reply is returned so it can be passed on to Meet tabs once connected.
function openSocket(portNumber, timeoutMs) {
    return new Promise((resolve, reject) => {
        const candidate = new WebSocket(`ws://localhost:${portNumber}`);
        let handshakeTimeout;
        const fail = (reason) => {
            clearTimeout(openTimeout);
            clearTimeout(handshakeTimeout);
            candidate.removeEventListener('message', onMessage);
            candidate.close();
            reject(new Error(`Port ${portNumber} ${reason}`));
        };
        const openTimeout = timeoutMs === undefined ? undefined : setTimeout(() => fail('timed out'), timeoutMs);
        const onMessage = (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            }
            catch {
                return;
            }
            if (message.type !== 'syncMuteFromMacApp') {
                return;
            }
            clearTimeout(handshakeTimeout);
            candidate.removeEventListener('message', onMessage);
            resolve({ reply: message, websocket: candidate });
        };
        candidate.addEventListener('open', () => {
            clearTimeout(openTimeout);
            candidate.addEventListener('message', onMessage);
            handshakeTimeout = setTimeout(() => fail('isn’t Mic Drop'), HANDSHAKE_TIMEOUT_MS);
            candidate.send(JSON.stringify({ type: 'requestSync' }));
        });
        candidate.addEventListener('error', () => fail('unavailable'));
    });
}
// Try connecting to a single port up to WS_PORT_RETRIES times, waiting
// WS_PORT_RETRY_DELAY_MS between each attempt.
async function tryPort(portNumber, generation) {
    for (let attempt = 0; attempt < WS_PORT_RETRIES; attempt++) {
        if (generation !== scanGeneration) {
            throw new Error('Port scan restarted');
        }
        try {
            return await openSocket(portNumber);
        }
        catch {
            if (attempt < WS_PORT_RETRIES - 1) {
                console.log(`[Mic Drop] Port ${portNumber} attempt ${attempt + 1}/${WS_PORT_RETRIES} failed — retrying in ${WS_PORT_RETRY_DELAY_MS / 1000}s`);
                await delay(WS_PORT_RETRY_DELAY_MS);
            }
        }
    }
    throw new Error(`Port ${portNumber} failed after ${WS_PORT_RETRIES} attempts`);
}
// Try each port in range sequentially, retrying each one WS_PORT_RETRIES times
// before moving on. Rejects if no port in the range responds.
async function findAvailablePort(generation, portNumber = WS_PORT_START) {
    if (generation !== scanGeneration) {
        throw new Error('Port scan restarted');
    }
    if (portNumber > WS_PORT_END) {
        throw new Error(`No available WebSocket server found in port range ${WS_PORT_START}–${WS_PORT_END}`);
    }
    try {
        return await tryPort(portNumber, generation);
    }
    catch {
        return findAvailablePort(generation, portNumber + 1);
    }
}
// Try every port in range once, all at the same time and without retries, so
// a missing app is noticed within a few seconds rather than after
// `findAvailablePort`'s long retry cycle. (Chrome holds back each attempt for
// up to 5 seconds, so trying the ports one after another can take a minute.)
async function findAppQuickly() {
    const attempts = [];
    for (let portNumber = WS_PORT_START; portNumber <= WS_PORT_END; portNumber++) {
        attempts.push(openSocket(portNumber, APP_CHECK_PORT_TIMEOUT_MS));
    }
    try {
        const connection = await Promise.any(attempts);
        // Close any other copy of the app that answers too (eg. a development
        // build running alongside the App Store one).
        for (const attempt of attempts) {
            attempt.then(({ websocket }) => {
                if (websocket !== connection.websocket) {
                    websocket.close();
                }
            }, () => { });
        }
        return connection;
    }
    catch {
        // No port answered like Mic Drop.
        return null;
    }
}
function isSocketOpen() {
    return socket?.readyState === WebSocket.OPEN;
}
// Forward a message from the Mac app to all active Meet tabs.
function forwardToTabs(message) {
    for (const port of contentPorts) {
        port.postMessage(message);
    }
}
// Use `websocket` as the connection to the app, unless another one was
// established in the meantime (eg. by `checkAppStatus` while `connect` was
// still scanning).
function attachSocket({ reply, websocket }) {
    if (isSocketOpen()) {
        websocket.close();
        return;
    }
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    socket = websocket;
    console.log('[Mic Drop] Connected to', websocket.url);
    websocket.addEventListener('message', (event) => {
        // Forward messages from the Mac app to all active Meet tabs.
        let message;
        try {
            message = JSON.parse(event.data);
        }
        catch {
            message = { raw: event.data };
        }
        if (message.type !== 'syncMuteFromMacApp') {
            console.log('[Mic Drop] Message from app:', message);
        }
        forwardToTabs(message);
    });
    // Pass on the app's reply to the handshake, so Meet tabs start in sync.
    forwardToTabs(reply);
    websocket.addEventListener('close', () => {
        // A replaced or duplicate socket closing doesn't affect the current one.
        if (socket !== websocket) {
            return;
        }
        console.log('[Mic Drop] WebSocket closed — reconnecting in', RECONNECT_DELAY_MS, 'ms');
        socket = null;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
    if (pendingMuteStateRequest) {
        pendingMuteStateRequest = false;
        sendToApp({ type: 'requestMuteState' });
    }
}
async function connect() {
    if (connecting || isSocketOpen() || socket?.readyState === WebSocket.CONNECTING) {
        return;
    }
    if (reconnectTimer !== null)
        clearTimeout(reconnectTimer);
    connecting = true;
    const generation = scanGeneration;
    try {
        attachSocket(await findAvailablePort(generation));
    }
    catch (err) {
        // A newer scan has taken over; leave reconnecting to it.
        if (generation !== scanGeneration) {
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[Mic Drop]', message, '— retrying in', RECONNECT_DELAY_MS, 'ms');
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
    finally {
        if (generation === scanGeneration) {
            connecting = false;
        }
    }
}
// Abandon any in-progress (or scheduled) scan and look for the app again,
// starting from the first port.
async function restartConnect() {
    scanGeneration++;
    connecting = false;
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    await connect();
}
// Shared by overlapping checks (eg. the "app not detected" page's regular
// re-checks), so they wait for one scan rather than each starting their own.
let appStatusCheck = null;
// Check whether the Mic Drop app is running (and new enough to answer
// `requestSync`), connecting to it if it isn't connected already.
//
// A check that's already running is shared, unless `fresh` is set: "Check
// again" is usually clicked just after opening the app, which a check that
// started earlier could have missed.
function checkAppStatus({ fresh = false } = {}) {
    if (fresh || !appStatusCheck) {
        const check = (async () => {
            if (!isSocketOpen()) {
                const connection = await findAppQuickly();
                if (!connection) {
                    return 'notDetected';
                }
                attachSocket(connection);
            }
            return 'connected';
        })().finally(() => {
            if (appStatusCheck === check) {
                appStatusCheck = null;
            }
        });
        appStatusCheck = check;
    }
    return appStatusCheck;
}
// Shared by overlapping calls (eg. several Meet tabs connecting at once) so
// the page is only opened once.
let appNotDetectedPageCheck = null;
// Open the "app not detected" page if the app can't be reached, at most once
// per browser session so it doesn't keep interrupting meetings.
function showAppNotDetectedPageIfNeeded() {
    appNotDetectedPageCheck ??= checkAppAndShowPage().finally(() => {
        appNotDetectedPageCheck = null;
    });
    return appNotDetectedPageCheck;
}
async function checkAppAndShowPage() {
    const stored = await chrome.storage.session.get(APP_NOT_DETECTED_PAGE_SHOWN_KEY);
    if (stored[APP_NOT_DETECTED_PAGE_SHOWN_KEY]) {
        return;
    }
    const status = await checkAppStatus();
    if (status === 'connected') {
        return;
    }
    console.warn('[Mic Drop] Mic Drop app not available:', status);
    await chrome.storage.session.set({ [APP_NOT_DETECTED_PAGE_SHOWN_KEY]: true });
    chrome.tabs.create({ url: 'app-not-detected.html' });
}
// Sent by the "app not detected" page to re-check the app. `restart` is set
// by its "Check again" button, which also restarts the background scan from
// the first port (rather than leaving it partway through its retries).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { restart, type } = message;
    if (type !== 'checkAppStatus') {
        return false;
    }
    checkAppStatus({ fresh: restart })
        .catch((error) => {
        // Always answer, so the page doesn't wait for a reply that never comes.
        console.warn('[Mic Drop] Couldn’t check for the app:', error);
        return isSocketOpen() ? 'connected' : 'notDetected';
    })
        .then((status) => {
        if (restart && !isSocketOpen()) {
            restartConnect();
        }
        sendResponse(status);
    });
    return true;
});
function sendToApp(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        connect();
        return;
    }
    console.log('[Mic Drop] Sending message to app:', message);
    socket.send(JSON.stringify(message));
}
// Route messages while content scripts are connected. Content scripts send a
// `keepAlive` message every 20 seconds, which keeps this worker running while
// a Meet tab is open.
chrome.runtime.onConnect.addListener((port) => {
    console.log('[Mic Drop] Content script attempting to connect:', port);
    if (port.name !== 'mic-drop-content') {
        console.warn('[Mic Drop] Unexpected content script connection:', port);
        return;
    }
    contentPorts.add(port);
    connect();
    showAppNotDetectedPageIfNeeded();
    port.onMessage.addListener((message) => {
        const { type } = message;
        // Sent regularly by content scripts purely to keep this worker alive.
        // Also use it to ping the app, which reconnects the WebSocket if it has
        // dropped.
        if (type === 'keepAlive') {
            sendToApp({ type: 'ping' });
            return;
        }
        // Sent several times a second while Meet is open; the app replies with
        // `syncMuteFromMacApp`. Sent directly rather than via `sendToApp` to
        // keep it out of the log. Polls made while disconnected are dropped
        // since the next one follows shortly.
        if (type === 'requestSync') {
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'requestSync' }));
            }
            else {
                connect();
            }
            return;
        }
        console.log('[Mic Drop] Message from content script:', message);
        if (type === 'setMuteFromChrome') {
            sendToApp(message);
        }
        else if (type === 'requestMuteState') {
            if (socket?.readyState === WebSocket.OPEN) {
                sendToApp({ type: 'requestMuteState' });
            }
            else {
                pendingMuteStateRequest = true;
                connect();
            }
        }
    });
    port.onDisconnect.addListener(() => {
        contentPorts.delete(port);
    });
});
//# sourceMappingURL=background.js.map
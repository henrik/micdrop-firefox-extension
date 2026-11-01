"use strict";
// While Meet is open, ask the app for its mute state every `syncIntervalMs`
// and make Meet match it. When the user changes Meet themselves, stop syncing
// for up to `syncPauseMs` so the app has time to catch up instead of Meet
// being reverted. The app overrides both defaults via its remote config.
const DEFAULT_SYNC_INTERVAL_MS = 500;
const DEFAULT_SYNC_PAUSE_MS = 1000;
// How long to wait for Meet to reflect a click we made before allowing
// another one. Meet updates `data-is-muted` asynchronously, so clicking again
// before it does would toggle Meet back.
const CLICK_SETTLE_TIMEOUT_MS = 1000;
let syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;
let syncPauseMs = DEFAULT_SYNC_PAUSE_MS;
// A click we made that Meet hasn't reflected yet.
let pendingClick = null;
// Set when the user changes Meet's mute state; `mute` is the state they chose.
let syncPause = null;
function isSyncPaused() {
    if (syncPause && Date.now() >= syncPause.until) {
        syncPause = null;
    }
    return syncPause !== null;
}
const MUTE_BUTTON_SELECTOR = '[data-is-muted]';
// Meet also puts `data-is-muted` on its camera button (it reads "muted" while
// the camera is off), so a button only counts as the microphone button once
// its icon says so. Icons are named ligatures, the same in every language.
// (Look at every icon in the button: Meet has changed how they're nested.)
const MIC_ICON_NAMES = new Set(['mic', 'mic_off']);
// How long to wait for Meet to render a mute button's icon before deciding
// whether it's the microphone button.
const MIC_ICON_RENDER_DELAY_MS = 70;
// Returns whether `button` is Meet's microphone button (rather than, say, the
// camera button), or `null` if its icon hasn't been rendered yet.
function isMicButton(button) {
    let hasIcon = false;
    for (const icon of button.getElementsByTagName('i')) {
        const name = icon.textContent?.trim();
        if (!name) {
            continue;
        }
        if (MIC_ICON_NAMES.has(name)) {
            return true;
        }
        hasIcon = true;
    }
    return hasIcon ? false : null;
}
// The microphone button most recently rendered by Meet (see
// `requestMuteStateIfNewMuteButton`).
let lastSeenMuteButton = null;
// Find Meet's microphone button, skipping its camera button (and any button
// whose icon hasn't been rendered yet).
function findMicButton() {
    for (const button of document.querySelectorAll(MUTE_BUTTON_SELECTOR)) {
        if (isMicButton(button)) {
            return button;
        }
    }
    return null;
}
// Meet's toolbar comes after the participant list and chat in the DOM, so
// searching for the mute button walks most of the page. Reuse the last one
// seen while Meet is still showing it.
function findMuteButton() {
    if (lastSeenMuteButton?.isConnected && lastSeenMuteButton.hasAttribute('data-is-muted')) {
        return lastSeenMuteButton;
    }
    return findMicButton();
}
// Click Meet's mute button (at most once until Meet reflects the click) if
// its state doesn't match `mute`.
function applyAppMuteState(mute) {
    const muteButtonInGoogleMeet = findMuteButton();
    if (!muteButtonInGoogleMeet || getMuteState(muteButtonInGoogleMeet) === mute) {
        return;
    }
    if (pendingClick && Date.now() < pendingClick.until) {
        return;
    }
    console.log('[Mic Drop] Setting Google Meet to', mute ? 'muted' : 'live', 'to match Mic Drop.');
    pendingClick = { mute, until: Date.now() + CLICK_SETTLE_TIMEOUT_MS };
    muteButtonInGoogleMeet.click();
}
function updateSyncConfig(payload) {
    const isValidDuration = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
    if (isValidDuration(payload?.syncPauseMs)) {
        syncPauseMs = payload.syncPauseMs;
    }
    if (isValidDuration(payload?.syncIntervalMs) && payload.syncIntervalMs !== syncIntervalMs) {
        syncIntervalMs = payload.syncIntervalMs;
        startSyncTimer();
    }
}
function handleMessageFromBackground(message) {
    updateSyncConfig(message.payload);
    if (typeof message.payload?.mute !== 'boolean') {
        return;
    }
    const { mute } = message.payload;
    switch (message.type) {
        // The app's mute state was changed (eg. with its shortcut): this is
        // newer than any change made in Meet, so it always wins.
        case 'setMuteFromMacApp':
            console.log('[Mic Drop] Received mute state from Mac app:', mute);
            syncPause = null;
            applyAppMuteState(mute);
            break;
        // Sent in reply to `requestSync` and shortly after the app's mute
        // state changes.
        case 'syncMuteFromMacApp':
            if (isSyncPaused()) {
                // Once the app reflects the user's change in Meet, resume syncing.
                if (syncPause?.mute === mute) {
                    syncPause = null;
                }
                return;
            }
            applyAppMuteState(mute);
            break;
        // Reply to `requestMuteState`, sent when a meeting begins. Only ever
        // mute Meet to match the app; never unmute someone automatically.
        case 'muteStateFromMacApp':
            if (mute && !isSyncPaused()) {
                applyAppMuteState(true);
            }
            break;
    }
}
// Chrome stops an extension's service worker after ~30 seconds without
// events; an open port alone doesn't count. Sending a message over the port
// resets that timer, so ping the worker regularly while Meet is open.
const KEEP_ALIVE_INTERVAL_MS = 20_000;
const PORT_RECONNECT_DELAY_MS = 1000;
let port = connectToBackground();
function connectToBackground() {
    const newPort = chrome.runtime.connect({ name: 'mic-drop-content' });
    newPort.onMessage.addListener(handleMessageFromBackground);
    // If the worker is stopped anyway (eg. Chrome restarts it), reconnect:
    // connecting wakes the worker back up.
    newPort.onDisconnect.addListener(() => {
        setTimeout(() => {
            // The extension was reloaded or updated; this content script is
            // orphaned and can no longer talk to the extension.
            if (!chrome.runtime?.id) {
                clearInterval(keepAliveInterval);
                clearInterval(syncTimer);
                return;
            }
            console.log('[Mic Drop] Reconnecting to background service worker.');
            port = connectToBackground();
            // The app's state may have changed while disconnected.
            if (findMuteButton()) {
                port.postMessage({ type: 'requestMuteState' });
            }
        }, PORT_RECONNECT_DELAY_MS);
    });
    return newPort;
}
const keepAliveInterval = setInterval(() => {
    try {
        port.postMessage({ type: 'keepAlive' });
    }
    catch {
        // The port is disconnected; `onDisconnect` handles reconnecting.
    }
}, KEEP_ALIVE_INTERVAL_MS);
let syncTimer;
function startSyncTimer() {
    clearInterval(syncTimer);
    // Keep polling while paused: replies are ignored then, but one matching the
    // user's change in Meet confirms the app caught up and ends the pause early.
    syncTimer = setInterval(() => {
        if (!findMuteButton()) {
            return;
        }
        try {
            port.postMessage({ type: 'requestSync' });
        }
        catch {
            // The port is disconnected; `onDisconnect` handles reconnecting.
        }
    }, syncIntervalMs);
}
startSyncTimer();
function getMuteState(element) {
    const value = element.getAttribute('data-is-muted');
    // Treat the string "true" or empty-string presence as muted; absence or "false" as live.
    return value === 'true' || value === '';
}
// Send a mute state chosen in Meet to the app, pausing the background sync
// until the app reflects it (or `syncPauseMs` passes) so Meet isn't reverted
// to the app's previous state in the meantime.
function reportMuteState(mute) {
    syncPause = { mute, until: Date.now() + syncPauseMs };
    pendingClick = null;
    port.postMessage({ payload: { from: 'Google Meet', mute }, type: 'setMuteFromChrome' });
    console.log('[Mic Drop] Mute state changed in Google Meet:', mute ? 'muted' : 'live');
}
function handleMuteStateChange(element) {
    const mute = getMuteState(element);
    // Meet reflecting a click we made to match the app; the app already has
    // this state, and reporting it back could flip the app if Meet ended up
    // somewhere unexpected.
    if (pendingClick && Date.now() < pendingClick.until) {
        if (pendingClick.mute === mute) {
            pendingClick = null;
        }
        else {
            // Firefox port: Meet can ignore a click made while its pre-join page is still loading, then report its old state. Don't take that as the user's choice; the background sync clicks again once `pendingClick` expires.
            console.log('[Mic Drop] Google Meet reported', mute ? 'muted' : 'live', 'despite our click; will retry.');
        }
        return;
    }
    reportMuteState(mute);
}
function handleMuteAttributeChange(button) {
    const isMic = isMicButton(button);
    if (isMic === null) {
        setTimeout(() => {
            if (isMicButton(button) && button.hasAttribute('data-is-muted')) {
                handleMuteStateChange(button);
            }
        }, MIC_ICON_RENDER_DELAY_MS);
        return;
    }
    if (isMic) {
        handleMuteStateChange(button);
    }
}
// Watch the entire document for changes to `data-is-muted`. Google Meet
// renders the button dynamically so we can't rely on querying for it upfront.
// Only the mutated elements are inspected, never the whole document.
const muteStateObserver = new MutationObserver((mutations) => {
    const changedButtons = new Set();
    for (const mutation of mutations) {
        const button = mutation.target;
        if (!button.hasAttribute('data-is-muted')) {
            continue;
        }
        // An element that just gained the attribute is a newly rendered mute
        // button rather than a change in mute state.
        if (mutation.oldValue === null) {
            requestMuteStateIfNewMuteButton();
        }
        else {
            changedButtons.add(button);
        }
    }
    for (const button of changedButtons) {
        handleMuteAttributeChange(button);
    }
});
muteStateObserver.observe(document.documentElement, {
    attributeFilter: ['data-is-muted'],
    attributeOldValue: true,
    attributes: true,
    subtree: true,
});
// Google Meet renders a new mute button when a meeting begins (and on the
// pre-join screen). Whenever a new one appears, bring Meet and the app in line
// without ever unmuting anyone: if Meet starts muted, mute the app to match;
// otherwise ask the app for its mute state so Meet can be muted if Mic Drop
// already is. The background sync takes over from there.
function requestMuteStateIfNewMuteButton() {
    const muteButton = findMicButton();
    if (muteButton === null || muteButton === lastSeenMuteButton) {
        return;
    }
    lastSeenMuteButton = muteButton;
    if (getMuteState(muteButton)) {
        console.log('[Mic Drop] Google Meet mute button appeared muted; muting Mic Drop to match.');
        reportMuteState(true);
        return;
    }
    console.log('[Mic Drop] Google Meet mute button appeared; requesting mute state from app.');
    port.postMessage({ type: 'requestMuteState' });
}
// Hide the container of Google Meet's "exclamation" warning icon. CSS can't
// match on text content, so watch for it here instead. The icon's text can
// change on an existing element, so containers are unhidden if their icon no
// longer reads "exclamation".
const EXCLAMATION_ICON_SELECTOR = 'div[jscontroller] > div > div > div > i';
const HIDDEN_BY_MIC_DROP_ATTRIBUTE = 'data-mic-drop-hidden';
// How often to check for changes while the tab is hidden, when
// `requestAnimationFrame` doesn't run.
const HIDDEN_TAB_CHECK_DELAY_MS = 250;
const hiddenExclamationContainers = new Set();
// Icons added or changed since the last check.
const changedIcons = new Set();
let muteButtonMayHaveAppeared = false;
let domChangeCheckScheduled = false;
function updateExclamationIcon(icon) {
    const container = icon.parentElement;
    if (!container ||
        hiddenExclamationContainers.has(container) ||
        icon.textContent?.trim() !== 'exclamation' ||
        !icon.matches(EXCLAMATION_ICON_SELECTOR)) {
        return;
    }
    container.style.setProperty('display', 'none', 'important');
    container.setAttribute(HIDDEN_BY_MIC_DROP_ATTRIBUTE, '');
    hiddenExclamationContainers.add(container);
}
function unhideStaleExclamationContainers() {
    for (const container of hiddenExclamationContainers) {
        if (!container.isConnected) {
            hiddenExclamationContainers.delete(container);
            continue;
        }
        const icon = container.querySelector(':scope > i');
        if (icon?.textContent?.trim() !== 'exclamation') {
            container.style.removeProperty('display');
            container.removeAttribute(HIDDEN_BY_MIC_DROP_ATTRIBUTE);
            hiddenExclamationContainers.delete(container);
        }
    }
}
function checkDomChanges() {
    domChangeCheckScheduled = false;
    unhideStaleExclamationContainers();
    for (const icon of changedIcons) {
        updateExclamationIcon(icon);
        // Meet can render a mute button before its icon, and only the icon
        // tells the microphone button from the camera button, so look again
        // once a mute button's icon appears or changes.
        if (!muteButtonMayHaveAppeared) {
            const muteButton = icon.closest(MUTE_BUTTON_SELECTOR);
            if (muteButton && muteButton !== lastSeenMuteButton) {
                muteButtonMayHaveAppeared = true;
            }
        }
    }
    changedIcons.clear();
    if (muteButtonMayHaveAppeared) {
        muteButtonMayHaveAppeared = false;
        requestMuteStateIfNewMuteButton();
    }
}
function collectChangedIcons(node) {
    if (!(node instanceof Element)) {
        return;
    }
    if (node.tagName === 'I') {
        changedIcons.add(node);
    }
    for (const icon of node.getElementsByTagName('i')) {
        changedIcons.add(icon);
    }
}
// Meet mutates its DOM constantly, and more so the more people are in a
// meeting, so only look at what changed (never rescan the whole document) and
// coalesce checks to once per frame (before paint, so the icon never flashes
// on screen).
const domChangeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
            const parent = mutation.target.parentElement;
            if (parent?.tagName === 'I') {
                changedIcons.add(parent);
            }
            continue;
        }
        // The icon's text node was replaced.
        if (mutation.target.tagName === 'I') {
            changedIcons.add(mutation.target);
        }
        for (const node of mutation.addedNodes) {
            collectChangedIcons(node);
            if (!muteButtonMayHaveAppeared &&
                node instanceof Element &&
                (node.matches(MUTE_BUTTON_SELECTOR) || node.querySelector(MUTE_BUTTON_SELECTOR))) {
                muteButtonMayHaveAppeared = true;
            }
        }
        // A removed icon may leave a hidden container with nothing to hide.
        if (mutation.removedNodes.length > 0 && hiddenExclamationContainers.size > 0) {
            scheduleDomChangeCheck();
        }
    }
    if (changedIcons.size > 0 || muteButtonMayHaveAppeared) {
        scheduleDomChangeCheck();
    }
});
function scheduleDomChangeCheck() {
    if (domChangeCheckScheduled) {
        return;
    }
    domChangeCheckScheduled = true;
    if (document.hidden) {
        setTimeout(checkDomChanges, HIDDEN_TAB_CHECK_DELAY_MS);
    }
    else {
        requestAnimationFrame(checkDomChanges);
    }
}
// `requestAnimationFrame` callbacks don't run in hidden tabs; check now rather
// than letting changes pile up until the tab is shown again.
document.addEventListener('visibilitychange', () => {
    if (document.hidden && domChangeCheckScheduled) {
        checkDomChanges();
    }
});
domChangeObserver.observe(document.documentElement, {
    characterData: true,
    childList: true,
    subtree: true,
});
for (const icon of document.querySelectorAll(EXCLAMATION_ICON_SELECTOR)) {
    updateExclamationIcon(icon);
}
requestMuteStateIfNewMuteButton();
//# sourceMappingURL=content.js.map
"use strict";
// Local test workaround: the Mic Drop app only accepts WebSocket connections from the Chrome extension's origin and answers Firefox's `moz-extension://…` origin with 400 Bad Request. Present the Chrome origin on the handshake until the app accepts Firefox too.
const CHROME_EXTENSION_ORIGIN = 'chrome-extension://nmhilhflkmmhmcighoickfgdlfeklgbe';
browser.webRequest.onBeforeSendHeaders.addListener(
  ({ url, requestHeaders }) => {
    for (const header of requestHeaders) {
      if (header.name.toLowerCase() === 'origin') {
        header.value = CHROME_EXTENSION_ORIGIN;
      }
    }
    console.log('[Mic Drop] Rewrote Origin for', url);
    return { requestHeaders };
  },
  // Firefox may report WebSocket handshakes with an `http://` URL, so match both.
  { urls: ['ws://localhost/*', 'http://localhost/*'], types: ['websocket'] },
  ['blocking', 'requestHeaders'],
);

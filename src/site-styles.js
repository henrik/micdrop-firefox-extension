"use strict";
// CSS overrides injected into web pages, keyed by exact hostname.
//
// To style a new site, add an entry here AND add its URL pattern to the
// `site-styles.js` content script `matches` in manifest.json (and to
// `host_permissions`), otherwise this script never runs on that site.
//
// The <style> tag is moved to the end of <head> once the page has parsed, so
// these rules override the page's own stylesheets.
const SITE_STYLES = {
    'meet.google.com': `
    [data-back-to-cancel],
    [data-is-muted] > span > i > span > svg {
      display: none !important;
    }
  `,
};
const STYLE_ELEMENT_ID = 'mic-drop-site-styles';
function injectSiteStyles() {
    const css = SITE_STYLES[window.location.hostname];
    if (css === undefined || document.getElementById(STYLE_ELEMENT_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = css;
    // At `document_start` there's no <head> yet, so attach to the root element
    // to apply the styles before the first paint.
    (document.head ?? document.documentElement).append(style);
    // Once the document has parsed, move the tag after the page's own
    // stylesheets so equal-specificity overrides take effect.
    document.addEventListener('DOMContentLoaded', () => {
        document.head?.append(style);
    }, { once: true });
}
injectSiteStyles();
//# sourceMappingURL=site-styles.js.map
"use strict";
function getOSName() {
    const userAgent = navigator.userAgent;
    if (userAgent.includes('CrOS'))
        return 'ChromeOS';
    if (userAgent.includes('Win'))
        return 'Windows';
    if (userAgent.includes('Android'))
        return 'Android';
    if (userAgent.includes('Linux'))
        return 'Linux';
    return 'a different operating system';
}
const osNameElement = document.getElementById('os-name');
if (osNameElement) {
    osNameElement.textContent = getOSName();
}
//# sourceMappingURL=unsupported.js.map
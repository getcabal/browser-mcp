/**
 * Per-profile deployment configuration. The packager stamps a copy of this
 * file for each fleet profile with locked=true. Only the unstamped development
 * build permits chrome.storage.local overrides from the options page.
 */
export default Object.freeze({ "port": 19889, "profile": null, "locked": false });

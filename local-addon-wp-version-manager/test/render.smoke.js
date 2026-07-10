/* Render the compiled WordPressVersionManager in jsdom exactly how Local drives it,
 * run effects, and surface the real error + stack. Run: node test/render.smoke.js */
const fs = require('fs');
const log = (s) => fs.writeSync(1, s + '\n'); // unbuffered so nothing is lost on hang/kill
setTimeout(() => { log('TIMEOUT-GUARD fired — event loop still busy; exiting.'); process.exit(3); }, 15000).unref();
const Module = require('module');

// --- stub the host-injected @getflywheel/local/renderer (not present outside Local) ---
const mockResponses = {
	'wp-version-manager:get-available-versions': {
		versions: [
			{ version: 'nightly', status: 'nightly' },
			{ version: '7.0', status: 'latest' },
			{ version: '6.5.2', status: 'insecure' },
			{ version: '4.9.8', status: 'insecure' },
		],
		error: null,
	},
	'wp-version-manager:get-current-version': { version: '7.0', error: null },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === '@getflywheel/local/renderer') {
		return { ipcAsync: async (channel) => mockResponses[channel] ?? {} };
	}
	return origLoad.call(this, request, parent, isMain);
};

// --- jsdom DOM ---
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;

const React = require('react');
const ReactDOM = require('react-dom');
const { act } = require('react-dom/test-utils');
const { MemoryRouter } = require('react-router-dom');

const { registerWordPressVersionManager } = require('../lib/WordPressVersionManager');

// Emulate Local's renderer: inject host React + a hooks object, capture what the
// add-on registers into siteInfoUtilities, then render that exactly as Local would.
let registeredContent = null;
const fakeHooks = { addContent: (slot, fn) => { if (slot === 'siteInfoUtilities') registeredContent = fn; } };
registerWordPressVersionManager(React, fakeHooks);
if (!registeredContent) { log('FAIL: nothing registered into siteInfoUtilities'); process.exit(1); }

async function renderCase (label, site) {
	const container = document.createElement('div');
	document.body.appendChild(container);
	try {
		act(() => {
			ReactDOM.render(
				React.createElement(MemoryRouter, null, registeredContent(site)),
				container,
			);
		});
		// let effects + the mocked async ipc resolve, without async-act (which can hang)
		await new Promise((r) => setTimeout(r, 120));
		const txt = container.textContent || '';
		log(`  OK [${label}] rendered without throwing`);
		log(`      text: ${txt.slice(0, 90).replace(/\s+/g, ' ').trim()}`);
		log(`      has <select>: ${!!container.querySelector('select')}, options: ${container.querySelectorAll('option').length}`);
	} catch (err) {
		log(`  THREW [${label}]:`);
		log('    ' + String(err && err.stack || err).split('\n').slice(0, 10).join('\n    '));
		return false;
	}
	return true;
}

(async () => {
	log('Rendering the registered siteInfoUtilities content the way Local does:');
	// Local passes the site object to the addContent callback.
	const a = await renderCase('site provided', { id: 'abc', name: 'feeds-test' });
	// Defensive: undefined site should not crash.
	const b = await renderCase('site undefined', undefined);
	if (a && b) {
		log('\nBOTH RENDER PATHS OK');
		process.exit(0);
	} else {
		log('\nRENDER FAILED — see stack above');
		process.exit(1);
	}
})().catch((e) => { log('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });

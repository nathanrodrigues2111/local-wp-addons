// Mirror hub: a local WebSocket server that relays leader actions (clicks,
// inputs, navigation) to follower sites, plus the browser bridge injected
// into every participating site via a managed mu-plugin.
import path from 'path';
import http from 'http';
import fs from 'fs-extra';
import { WebSocketServer, WebSocket } from 'ws';
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';

export interface MirrorIssue {
	site: string;
	kind: string; // 'js-error' | 'replay-failed' | 'disconnected'
	detail: string;
	time: number;
}

export interface MirrorSession {
	port: number;
	leaderId: string;
	siteIds: string[];
	issues: MirrorIssue[];
	events: number;
	server: WebSocketServer;
	httpServer: http.Server;
	gridUrl: string;
}

let session: MirrorSession | null = null;

const muPath = (site: Local.Site) => path.join(
	LocalMain.formatHomePath(site.path), 'app', 'public', 'wp-content', 'mu-plugins', 'matrix-mirror.php',
);

/** The browser-side bridge. Serialized into the mu-plugin. */
function bridgeJs (port: number, role: string, label: string): string {
	return `
(function () {
	if (window.__matrixMirror) return;
	window.__matrixMirror = true;
	var ROLE = ${JSON.stringify(role)}, LABEL = ${JSON.stringify(label)};
	var ws;
	function send (o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {}
	}
	function selectorFor (el) {
		if (!el || el.nodeType !== 1) return null;
		if (el.id) return '#' + CSS.escape(el.id);
		var parts = [];
		var node = el;
		while (node && node.nodeType === 1 && parts.length < 6) {
			var part = node.tagName.toLowerCase();
			if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
			var sibs = node.parentElement ? Array.prototype.filter.call(node.parentElement.children, function (c) { return c.tagName === node.tagName; }) : [];
			if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
			parts.unshift(part);
			node = node.parentElement;
		}
		return parts.join(' > ');
	}
	function connect () {
		ws = new WebSocket('ws://127.0.0.1:${port}');
		ws.onopen = function () { send({ t: 'hello', role: ROLE, label: LABEL, path: location.pathname + location.search }); };
		ws.onmessage = function (m) {
			if (ROLE !== 'follower') return;
			var ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
			try {
				if (ev.t === 'nav') {
					var target = ev.path;
					if (location.pathname + location.search !== target) location.href = target;
				} else if (ev.t === 'click') {
					var el = document.querySelector(ev.sel);
					if (!el) return send({ t: 'issue', label: LABEL, kind: 'replay-failed', detail: 'click: selector not found: ' + ev.sel });
					el.click();
				} else if (ev.t === 'input') {
					var inp = document.querySelector(ev.sel);
					if (!inp) return send({ t: 'issue', label: LABEL, kind: 'replay-failed', detail: 'input: selector not found: ' + ev.sel });
					var proto = inp.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
					var setter = Object.getOwnPropertyDescriptor(proto, 'value');
					if (setter && setter.set) setter.set.call(inp, ev.value); else inp.value = ev.value;
					inp.dispatchEvent(new Event('input', { bubbles: true }));
					inp.dispatchEvent(new Event('change', { bubbles: true }));
				} else if (ev.t === 'scroll') {
					var maxF = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
					window.scrollTo(0, ev.ratio * maxF);
				}
			} catch (err) {
				send({ t: 'issue', label: LABEL, kind: 'replay-failed', detail: String(err).slice(0, 200) });
			}
		};
		ws.onclose = function () { setTimeout(connect, 1500); };
	}
	connect();
	window.addEventListener('error', function (e) {
		send({ t: 'issue', label: LABEL, kind: 'js-error', detail: String(e.message).slice(0, 300) + ' @ ' + (e.filename || '').split('/').slice(-1)[0] + ':' + e.lineno });
	});
	if (ROLE === 'leader') {
		// Proportional scroll mirroring (throttled, with a trailing send so the
		// final resting position always syncs).
		var scrollTimer = null, lastScrollSent = 0;
		function sendScroll () {
			var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
			send({ t: 'scroll', ratio: window.scrollY / max });
		}
		window.addEventListener('scroll', function () {
			var now = Date.now();
			if (now - lastScrollSent > 80) { lastScrollSent = now; sendScroll(); }
			clearTimeout(scrollTimer);
			scrollTimer = setTimeout(sendScroll, 120);
		}, { passive: true });
		document.addEventListener('click', function (e) {
			var sel = selectorFor(e.target.closest('a,button,input,select,textarea,[role=button],label') || e.target);
			if (sel) send({ t: 'click', sel: sel });
		}, true);
		document.addEventListener('change', function (e) {
			var el = e.target;
			if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
				if (el.type === 'password') return;
				var sel = selectorFor(el);
				if (sel) send({ t: 'input', sel: sel, value: el.value });
			}
		}, true);
		send({ t: 'nav', path: location.pathname + location.search });
	}
})();
`;
}

function muPlugin (port: number, role: string, label: string): string {
	const js = bridgeJs(port, role, label);
	return `<?php
/**
 * Plugin Name: Matrix Mirror bridge (managed by the Matrix Tester add-on)
 * Description: Mirrors interactions across test variant sites. Safe to delete.
 */
add_action( 'wp_footer', 'matrix_mirror_bridge', 99 );
add_action( 'admin_footer', 'matrix_mirror_bridge', 99 );
add_action( 'login_footer', 'matrix_mirror_bridge', 99 );
function matrix_mirror_bridge() {
	?><script>${js}</script><?php
}
`;
}

/** The split-screen grid page: every variant in one window, leader first. */
function gridPage (sites: { name: string; url: string; leader: boolean }[], port: number): string {
	const cols = sites.length <= 2 ? sites.length : 2;
	const panes = sites.map((s) => `
		<div class="pane${s.leader ? ' leader' : ''}" data-label="${s.name}">
			<div class="bar">
				<span class="dot"></span>
				<strong>${s.name}</strong>${s.leader ? ' — LEADER (drive this one)' : ''}
				<span class="issues" hidden>0 issues</span>
				<a href="${s.url}" target="_blank" title="Open in its own tab">↗</a>
			</div>
			<iframe src="${s.url}"></iframe>
		</div>`).join('');
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Matrix Tester — ${sites.length} variants</title>
<style>
	* { box-sizing: border-box; margin: 0; }
	html, body { height: 100%; background: #1d2327; font-family: system-ui, sans-serif; }
	.grid { display: grid; height: 100vh; gap: 4px; padding: 4px;
		grid-template-columns: repeat(${cols}, 1fr); grid-auto-rows: 1fr; }
	.pane { display: flex; flex-direction: column; border: 2px solid #3c434a; border-radius: 6px; overflow: hidden; background: #fff; }
	.pane.leader { border-color: #51bb7b; }
	.pane.has-issues { border-color: #e2574f; }
	.bar { display: flex; align-items: center; gap: 8px; padding: 5px 10px; background: #2c3338; color: #e0e0e0; font-size: 12px; }
	.pane.leader .bar { background: #1e3a2b; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: #51bb7b; }
	.issues { color: #ff8785; font-weight: 600; }
	.bar a { margin-left: auto; color: #9ec2ff; text-decoration: none; }
	iframe { flex: 1; width: 100%; border: 0; background: #fff; }
	#status { position: fixed; right: 10px; bottom: 8px; color: #9aa0a6; font-size: 11px; }
</style></head>
<body>
	<div class="grid">${panes}</div>
	<div id="status">connecting…</div>
	<script>
	(function () {
		var status = document.getElementById('status');
		function connect () {
			var ws = new WebSocket('ws://127.0.0.1:${port}');
			ws.onopen = function () { ws.send(JSON.stringify({ t: 'hello', role: 'observer', label: 'grid' })); status.textContent = 'mirroring live'; };
			ws.onmessage = function (m) {
				var ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
				if (ev.t === 'issue') {
					var pane = document.querySelector('.pane[data-label="' + (ev.label || '').replace(/"/g, '') + '"]');
					if (!pane) return;
					pane.classList.add('has-issues');
					var el = pane.querySelector('.issues');
					el.hidden = false;
					el.textContent = (parseInt(el.textContent, 10) || 0) + 1 + ' issue(s): ' + (ev.detail || '').slice(0, 60);
				}
			};
			ws.onclose = function () { status.textContent = 'session ended — close this window'; };
		}
		connect();
	})();
	</script>
</body></html>`;
}

export function getSession (): { active: boolean; port?: number; siteIds?: string[]; issues?: MirrorIssue[]; events?: number; gridUrl?: string } {
	if (!session) {
		return { active: false };
	}
	return {
		active: true,
		port: session.port,
		siteIds: session.siteIds,
		issues: session.issues.slice(-100),
		events: session.events,
		gridUrl: session.gridUrl,
	};
}

export async function startMirror (
	sites: Local.Site[],
	leader: Local.Site,
	onIssue: (issue: MirrorIssue) => void,
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<{ port: number; gridUrl: string }> {
	if (session) {
		await stopMirror(sites, logger);
	}

	// HTTP server hosts the split-screen grid page; the WS hub rides on it.
	const paneList = sites.map((s) => ({ name: s.name, url: `https://${s.domain}`, leader: s.id === leader.id }));
	const httpServer = http.createServer((req, res) => {
		if ((req.url || '').startsWith('/grid')) {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(gridPage(paneList, (httpServer.address() as any).port));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	const server = new WebSocketServer({ server: httpServer });
	// Stable port: pages from a previous session (old grid window, old tabs)
	// keep reconnecting to this port, so they come back alive when a new
	// session starts instead of pointing at a dead random port.
	const BASE_PORT = 39303;
	let bound = false;
	for (let candidate = BASE_PORT; candidate < BASE_PORT + 10 && !bound; candidate++) {
		// eslint-disable-next-line no-await-in-loop
		bound = await new Promise<boolean>((resolve) => {
			const onError = () => resolve(false);
			httpServer.once('error', onError);
			httpServer.listen(candidate, '127.0.0.1', () => {
				httpServer.removeListener('error', onError);
				resolve(true);
			});
		});
	}
	if (!bound) {
		throw new Error('Could not bind the mirror hub port (39303-39312 all busy).');
	}
	const port = (httpServer.address() as any).port;
	const gridUrl = `http://127.0.0.1:${port}/grid`;

	const sess: MirrorSession = {
		port, leaderId: leader.id, siteIds: sites.map((s) => s.id), issues: [], events: 0, server, httpServer, gridUrl,
	};
	session = sess;

	const followers = new Set<WebSocket>();
	const observers = new Set<WebSocket>();
	server.on('connection', (socket) => {
		let role = 'follower';
		socket.on('message', (raw) => {
			let msg: any;
			try {
				msg = JSON.parse(String(raw));
			} catch (err) {
				return;
			}
			if (msg.t === 'hello') {
				role = msg.role;
				if (role === 'follower') {
					followers.add(socket);
				} else if (role === 'observer') {
					observers.add(socket);
				} else if (msg.path) {
					// The leader's nav-on-load can't be sent before its socket opens,
					// so hello carries the path — broadcast it as a nav event.
					sess.events++;
					const nav = JSON.stringify({ t: 'nav', path: msg.path });
					for (const f of followers) {
						if (f.readyState === WebSocket.OPEN) {
							f.send(nav);
						}
					}
				}
				return;
			}
			if (msg.t === 'issue') {
				const issue: MirrorIssue = { site: msg.label, kind: msg.kind, detail: msg.detail, time: Date.now() };
				sess.issues.push(issue);
				onIssue(issue);
				const data = JSON.stringify(msg);
				for (const o of observers) {
					if (o.readyState === WebSocket.OPEN) {
						o.send(data);
					}
				}
				return;
			}
			// Leader action -> broadcast to followers.
			if (role === 'leader') {
				sess.events++;
				const data = JSON.stringify(msg);
				for (const f of followers) {
					if (f.readyState === WebSocket.OPEN) {
						f.send(data);
					}
				}
			}
		});
		socket.on('close', () => { followers.delete(socket); observers.delete(socket); });
	});

	// Install the bridge mu-plugin on every participating site.
	for (const site of sites) {
		const role = site.id === leader.id ? 'leader' : 'follower';
		await fs.outputFile(muPath(site), muPlugin(port, role, site.name));
	}

	logger.info(`Mirror hub on ws://127.0.0.1:${port} — leader ${leader.name}, ${sites.length - 1} follower(s). Grid: ${gridUrl}`);
	return { port, gridUrl };
}

export async function stopMirror (
	sites: Local.Site[],
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<MirrorIssue[]> {
	const issues = session ? session.issues : [];
	if (session) {
		try {
			session.server.close();
			session.httpServer.close();
		} catch (err) { /* fine */ }
		session = null;
	}
	for (const site of sites) {
		await fs.remove(muPath(site)).catch(() => undefined);
	}
	logger.info('Mirror stopped; bridges removed.');
	return issues;
}

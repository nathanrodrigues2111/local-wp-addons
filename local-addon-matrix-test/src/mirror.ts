// Mirror hub: a local WebSocket server that relays leader actions (clicks,
// inputs, navigation) to follower sites, plus the browser bridge injected
// into every participating site via a managed mu-plugin.
import path from 'path';
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

export function getSession (): { active: boolean; port?: number; siteIds?: string[]; issues?: MirrorIssue[]; events?: number } {
	if (!session) {
		return { active: false };
	}
	return {
		active: true,
		port: session.port,
		siteIds: session.siteIds,
		issues: session.issues.slice(-100),
		events: session.events,
	};
}

export async function startMirror (
	sites: Local.Site[],
	leader: Local.Site,
	onIssue: (issue: MirrorIssue) => void,
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<{ port: number }> {
	if (session) {
		await stopMirror(sites, logger);
	}

	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await new Promise<void>((resolve, reject) => {
		server.once('listening', () => resolve());
		server.once('error', reject);
	});
	const port = (server.address() as any).port;

	const sess: MirrorSession = { port, leaderId: leader.id, siteIds: sites.map((s) => s.id), issues: [], events: 0, server };
	session = sess;

	const followers = new Set<WebSocket>();
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
		socket.on('close', () => followers.delete(socket));
	});

	// Install the bridge mu-plugin on every participating site.
	for (const site of sites) {
		const role = site.id === leader.id ? 'leader' : 'follower';
		await fs.outputFile(muPath(site), muPlugin(port, role, site.name));
	}

	logger.info(`Mirror hub on ws://127.0.0.1:${port} — leader ${leader.name}, ${sites.length - 1} follower(s).`);
	return { port };
}

export async function stopMirror (
	sites: Local.Site[],
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<MirrorIssue[]> {
	const issues = session ? session.issues : [];
	if (session) {
		try {
			session.server.close();
		} catch (err) { /* fine */ }
		session = null;
	}
	for (const site of sites) {
		await fs.remove(muPath(site)).catch(() => undefined);
	}
	logger.info('Mirror stopped; bridges removed.');
	return issues;
}

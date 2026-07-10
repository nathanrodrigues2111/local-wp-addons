// Cloudflare quick-tunnel management: spawn `cloudflared tunnel --url ...`,
// parse the public trycloudflare.com URL, and (optionally) point WordPress's
// home/siteurl at the tunnel while it's active, restoring them on stop.
import { spawn, ChildProcess, execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';

export interface TunnelState {
	proc: ChildProcess;
	url: string;
	rewrite: boolean;
	originalHome?: string;
	originalSiteurl?: string;
}

export interface TunnelStatus {
	running: boolean;
	url: string | null;
	rewrite: boolean;
	binaryFound: boolean;
}

const tunnels = new Map<string, TunnelState>();

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** The site's own nginx HTTP port (bypasses Local's Host-routing router). */
function getSiteHttpPort (site: Local.Site): number | null {
	const services: any = (site as any).services || {};
	for (const key of Object.keys(services)) {
		const svc = services[key];
		if (svc?.role === 'http' && svc?.ports?.HTTP?.[0]) {
			return svc.ports.HTTP[0];
		}
	}
	return null;
}

/**
 * WordPress runs plain HTTP on the origin while the tunnel edge is HTTPS —
 * without this, WP would redirect-loop trying to "fix" the protocol. Standard
 * reverse-proxy shim: honor X-Forwarded-Proto from cloudflared.
 */
const MU_PLUGIN = `<?php
/**
 * Plugin Name: Cloudflare Tunnel HTTPS shim (managed by the Local add-on)
 * Description: Marks requests as HTTPS when they arrive via the tunnel edge.
 */
if ( isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && 'https' === $_SERVER['HTTP_X_FORWARDED_PROTO'] ) {
	$_SERVER['HTTPS'] = 'on';
}
`;

function muPluginPath (site: Local.Site): string {
	return path.join(
		LocalMain.formatHomePath(site.path),
		'app', 'public', 'wp-content', 'mu-plugins', 'cloudflare-tunnel-ssl.php',
	);
}

/**
 * Stop the site's nginx from writing absolute redirects with its local port
 * (e.g. /wp-admin -> host:10008/wp-admin/), which breaks them on the tunnel.
 * Appends the directives to a conf include inside the server block and
 * hot-reloads nginx. Local regenerates this conf on site start, but the
 * tunnel is stopped with the site anyway.
 */
async function fixNginxRedirects (
	site: Local.Site,
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
	if (process.platform === 'win32') {
		return; // no pkill; the trailing-slash case is a lesser evil than breaking here
	}
	try {
		// eslint-disable-next-line global-require
		const { app } = require('electron');
		const inc = path.join(app.getPath('userData'), 'run', site.id, 'conf', 'nginx', 'includes', 'restrictions.conf');
		if (!(await fs.pathExists(inc))) {
			return;
		}
		const current = await fs.readFile(inc, 'utf8');
		if (!current.includes('absolute_redirect')) {
			await fs.appendFile(
				inc,
				'\n# cloudflare-tunnel add-on: keep redirects relative so they work through the tunnel\n'
				+ 'absolute_redirect off;\nport_in_redirect off;\n',
			);
			execFileSync('pkill', ['-HUP', '-f', `nginx: master process.*${site.id}`]);
			logger.info(`Patched nginx redirects for ${site.id} (absolute_redirect off) and reloaded.`);
		}
	} catch (err: any) {
		logger.warn(`nginx redirect fixup failed (non-fatal): ${err?.message}`);
	}
}

/** Locate the cloudflared binary: common user/system paths, then PATH. */
export function findCloudflared (): string | null {
	const candidates = [
		path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
		'/usr/local/bin/cloudflared',
		'/usr/bin/cloudflared',
		'/opt/homebrew/bin/cloudflared',
		'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
	];
	for (const c of candidates) {
		try {
			if (fs.existsSync(c)) {
				return c;
			}
		} catch (err) { /* keep looking */ }
	}
	try {
		execFileSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared']);
		return 'cloudflared';
	} catch (err) {
		return null;
	}
}

export function getStatus (siteId: string): TunnelStatus {
	const t = tunnels.get(siteId);
	return {
		running: !!t && t.proc.exitCode === null,
		url: t?.url || null,
		rewrite: t?.rewrite || false,
		binaryFound: !!findCloudflared(),
	};
}

/** Start a quick tunnel for a site; resolves once the public URL is known. */
export interface StartResult {
	url: string;
	originalHome?: string;
	originalSiteurl?: string;
}

export async function startTunnel (
	wpCli: LocalMain.Services.WpCli,
	site: Local.Site,
	rewrite: boolean,
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<StartResult> {
	const existing = tunnels.get(site.id);
	if (existing && existing.proc.exitCode === null) {
		return { url: existing.url, originalHome: existing.originalHome, originalSiteurl: existing.originalSiteurl };
	}

	const bin = findCloudflared();
	if (!bin) {
		throw new Error(
			'cloudflared is not installed. Install it (e.g. `curl -L -o ~/.local/bin/cloudflared '
			+ 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 '
			+ '&& chmod +x ~/.local/bin/cloudflared`) and try again.',
		);
	}

	// Tunnel straight to the site's own nginx port, bypassing Local's router.
	// That lets WordPress see the real tunnel hostname (Host header passes
	// through), so $_SERVER-derived URLs (auth redirects, canonical redirects)
	// stay on the tunnel instead of leaking site.local:<port>.
	const httpPort = getSiteHttpPort(site);
	const target = httpPort ? `http://127.0.0.1:${httpPort}` : `http://${site.domain}`;
	const args = ['tunnel', '--url', target, '--no-autoupdate'];
	if (!httpPort) {
		// Fallback via the router, which routes by Host header.
		args.push('--http-host-header', site.domain);
	}
	logger.info(`Starting cloudflared quick tunnel -> ${target}`);
	const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

	const url = await new Promise<string>((resolve, reject) => {
		let buffer = '';
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error('Timed out waiting for the tunnel URL (30s). Check your internet connection.'));
		}, 30000);

		const onData = (chunk: Buffer) => {
			buffer += chunk.toString();
			const m = buffer.match(URL_RE);
			if (m) {
				clearTimeout(timer);
				resolve(m[0]);
			}
		};
		proc.stdout?.on('data', onData);
		proc.stderr?.on('data', onData);
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`cloudflared exited early (code ${code}). ${buffer.slice(-200)}`));
		});
		proc.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});

	const state: TunnelState = { proc, url, rewrite };

	// HTTPS shim so WP treats tunnel-edge requests as SSL (see MU_PLUGIN docblock).
	await fs.outputFile(muPluginPath(site), MU_PLUGIN);
	// Keep nginx redirects relative so /wp-admin -> /wp-admin/ works on the tunnel.
	await fixNginxRedirects(site, logger);

	if (rewrite) {
		// Point WordPress at the tunnel so redirects/OAuth callbacks use the public URL.
		state.originalHome = (await wpCli.run(site, ['option', 'get', 'home'])).trim();
		state.originalSiteurl = (await wpCli.run(site, ['option', 'get', 'siteurl'])).trim();
		// Never treat a leftover tunnel URL (crashed/killed session) as the original.
		if (/trycloudflare\.com/.test(state.originalHome)) {
			state.originalHome = `https://${site.domain}`;
		}
		if (/trycloudflare\.com/.test(state.originalSiteurl || '')) {
			state.originalSiteurl = state.originalHome;
		}
		await wpCli.run(site, ['option', 'update', 'home', url]);
		await wpCli.run(site, ['option', 'update', 'siteurl', url]);
		logger.info(`Rewrote home/siteurl to ${url} (was ${state.originalHome}).`);
	}

	tunnels.set(site.id, state);
	proc.on('exit', () => {
		if (tunnels.get(site.id) === state) {
			tunnels.delete(site.id);
		}
	});

	return { url, originalHome: state.originalHome, originalSiteurl: state.originalSiteurl };
}

/** Stop a site's tunnel and restore the original URLs if they were rewritten. */
export async function stopTunnel (
	wpCli: LocalMain.Services.WpCli,
	site: Local.Site,
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
	const state = tunnels.get(site.id);
	if (!state) {
		return;
	}
	tunnels.delete(site.id);

	try {
		state.proc.kill();
	} catch (err) { /* already dead */ }

	await fs.remove(muPluginPath(site)).catch(() => undefined);

	if (state.rewrite && state.originalHome) {
		try {
			await wpCli.run(site, ['option', 'update', 'home', state.originalHome]);
			await wpCli.run(site, ['option', 'update', 'siteurl', state.originalSiteurl || state.originalHome]);
			logger.info(`Restored home/siteurl to ${state.originalHome}.`);
		} catch (err: any) {
			logger.warn(`Could not restore site URLs (site stopped?): ${err?.message}`);
			throw new Error(
				`Tunnel stopped, but restoring the site URL failed — run: wp option update home ${state.originalHome} `
				+ `&& wp option update siteurl ${state.originalSiteurl || state.originalHome}`,
			);
		}
	}
}

/** Best-effort cleanup used when a site stops or Local quits. */
export function killAllTunnels (): void {
	for (const [, state] of tunnels) {
		try {
			state.proc.kill();
		} catch (err) { /* ignore */ }
	}
	tunnels.clear();
}

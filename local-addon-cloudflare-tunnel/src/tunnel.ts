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
export async function startTunnel (
	wpCli: LocalMain.Services.WpCli,
	site: Local.Site,
	rewrite: boolean,
	logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<string> {
	const existing = tunnels.get(site.id);
	if (existing && existing.proc.exitCode === null) {
		return existing.url;
	}

	const bin = findCloudflared();
	if (!bin) {
		throw new Error(
			'cloudflared is not installed. Install it (e.g. `curl -L -o ~/.local/bin/cloudflared '
			+ 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 '
			+ '&& chmod +x ~/.local/bin/cloudflared`) and try again.',
		);
	}

	const target = `http://${site.domain}`;
	logger.info(`Starting cloudflared quick tunnel -> ${target}`);
	// --http-host-header: Local's nginx router routes by Host header, so origin
	// requests must carry the site's own domain, not the trycloudflare hostname.
	const proc = spawn(
		bin,
		['tunnel', '--url', target, '--http-host-header', site.domain, '--no-autoupdate'],
		{ stdio: ['ignore', 'pipe', 'pipe'] },
	);

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

	if (rewrite) {
		// Point WordPress at the tunnel so redirects/OAuth callbacks use the public URL.
		state.originalHome = (await wpCli.run(site, ['option', 'get', 'home'])).trim();
		state.originalSiteurl = (await wpCli.run(site, ['option', 'get', 'siteurl'])).trim();
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

	return url;
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

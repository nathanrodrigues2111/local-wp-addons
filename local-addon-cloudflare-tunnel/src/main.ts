// Main-process entry for the Cloudflare Tunnel add-on.
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import { getStatus, startTunnel, stopTunnel, killAllTunnels } from './tunnel';

const ADDON_SLUG = 'cloudflare-tunnel';

export default function (context: LocalMain.AddonMainContext): void {
	const { wpCli, siteData, localLogger, siteProcessManager } = LocalMain.getServiceContainer().cradle;

	const logger = localLogger.child({
		thread: 'main',
		addon: ADDON_SLUG,
	});

	const assertRunning = (site: Local.Site) => {
		try {
			const status = String(siteProcessManager.getSiteStatus(site));
			if (status !== 'running') {
				throw new Error(`"${site.name}" is not running — start the site in Local, then try again.`);
			}
		} catch (err: any) {
			if (err?.message?.includes('is not running')) {
				throw err;
			}
		}
	};

	// Persist the pre-tunnel URLs in the site's Local config so they can be
	// restored even if Local quits or crashes while a tunnel is active.
	const saveOriginals = (siteId: string, originals: { home: string; siteurl: string } | null) => {
		siteData.updateSite(siteId, {
			id: siteId,
			cloudflareTunnel: originals,
		} as Partial<Local.SiteJSON>);
	};

	/** Restore saved URLs after a crash/quit that skipped the normal stop path. */
	const recoverSite = async (site: Local.Site) => {
		const saved = (siteData.getSite(site.id) as any)?.cloudflareTunnel;
		if (!saved?.home || getStatus(site.id).running) {
			return;
		}
		try {
			await wpCli.run(site, ['option', 'update', 'home', saved.home]);
			await wpCli.run(site, ['option', 'update', 'siteurl', saved.siteurl || saved.home]);
			saveOriginals(site.id, null);
			logger.info(`Recovered site URLs for ${site.id} -> ${saved.home} (stale tunnel rewrite).`);
		} catch (err: any) {
			logger.warn(`URL recovery failed for ${site.id}: ${err?.message}`);
		}
	};

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:status`, async (siteId: string) => getStatus(siteId));

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:start`, async (siteId: string, rewrite: boolean) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		assertRunning(site);
		const res = await startTunnel(wpCli, site, rewrite, logger);
		if (rewrite && res.originalHome) {
			saveOriginals(siteId, { home: res.originalHome, siteurl: res.originalSiteurl || res.originalHome });
		}
		return { url: res.url };
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:stop`, async (siteId: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		await stopTunnel(wpCli, site, logger);
		saveOriginals(siteId, null);
		return true;
	});

	// Auto-stop a site's tunnel (and restore its URLs) when the site stops.
	context.hooks.addAction('siteStopped', async (site: Local.Site) => {
		try {
			await stopTunnel(wpCli, site, logger);
			saveOriginals(site.id, null);
		} catch (err: any) {
			logger.warn(`Tunnel cleanup on siteStopped: ${err?.message}`);
		}
	});

	// When a site starts, undo any stale rewrite left by a crash/quit mid-tunnel.
	context.hooks.addAction('siteStarted', async (site: Local.Site) => {
		await recoverSite(site);
	});

	// Kill any leftover cloudflared processes when Local quits.
	context.electron.app.on('will-quit', () => killAllTunnels());
}

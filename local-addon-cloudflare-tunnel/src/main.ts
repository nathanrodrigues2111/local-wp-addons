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

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:status`, async (siteId: string) => getStatus(siteId));

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:start`, async (siteId: string, rewrite: boolean) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		assertRunning(site);
		const url = await startTunnel(wpCli, site, rewrite, logger);
		return { url };
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:stop`, async (siteId: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		await stopTunnel(wpCli, site, logger);
		return true;
	});

	// Auto-stop a site's tunnel (and restore its URLs) when the site stops.
	context.hooks.addAction('siteStopped', async (site: Local.Site) => {
		try {
			await stopTunnel(wpCli, site, logger);
		} catch (err: any) {
			logger.warn(`Tunnel cleanup on siteStopped: ${err?.message}`);
		}
	});

	// Kill any leftover cloudflared processes when Local quits.
	context.electron.app.on('will-quit', () => killAllTunnels());
}

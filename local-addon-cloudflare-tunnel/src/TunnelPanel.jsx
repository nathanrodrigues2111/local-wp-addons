// https://getflywheel.github.io/local-addon-api/modules/_local_renderer_.html
import * as LocalRenderer from '@getflywheel/local/renderer';

// https://github.com/getflywheel/local-components
import { Button, Text, TableListRow, TextButton } from '@getflywheel/local-components';

const SLUG = 'cloudflare-tunnel';

// Use Local's injected React instance (a bundled second copy breaks hooks).
let React;

/** Unwrap Local's ipcAsync rejection noise and return just the real message. */
function cleanError (err) {
	let msg = String(err?.message || err);
	const m = msg.match(/main thread error:\s*([\s\S]*?)(?:\s*Check out the error props.*)?$/i);
	if (m) {
		msg = m[1].trim();
	}
	return msg.replace(/^["']|["']$/g, '') || 'Something went wrong.';
}

export function registerCloudflareTunnel (_React, hooks) {
	React = _React;

	hooks.addContent('siteInfoUtilities', (site) => (
		<TableListRow key={SLUG} label="Cloudflare Tunnel">
			<TunnelPanel site={site} />
		</TableListRow>
	));
}

function TunnelPanel ({ site }) {
	const { useState, useEffect, useCallback } = React;

	const siteId = site?.id;

	const [status, setStatus] = useState({ running: false, url: null, binaryFound: true });
	const [rewrite, setRewrite] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);
	const [copied, setCopied] = useState(false);

	const refresh = useCallback(async () => {
		const s = await LocalRenderer.ipcAsync(`${SLUG}:status`, siteId);
		setStatus(s || { running: false, url: null, binaryFound: true });
	}, [siteId]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const start = async () => {
		setBusy(true);
		setError(null);
		try {
			await LocalRenderer.ipcAsync(`${SLUG}:start`, siteId, rewrite);
			await refresh();
		} catch (err) {
			setError(cleanError(err));
		} finally {
			setBusy(false);
		}
	};

	const stop = async () => {
		setBusy(true);
		setError(null);
		try {
			await LocalRenderer.ipcAsync(`${SLUG}:stop`, siteId);
			await refresh();
		} catch (err) {
			setError(cleanError(err));
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const copyUrl = () => {
		navigator.clipboard.writeText(status.url);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<div style={{ flex: '1' }}>
			<Text style={{ display: 'block', marginBottom: 12, opacity: 0.85 }}>
				Expose this site on a public <code>trycloudflare.com</code> URL — for OAuth
				callbacks, webhooks, or sharing work in progress. No Cloudflare account needed.
			</Text>

			{!status.binaryFound ? (
				<Text style={{ display: 'block', marginBottom: 12, color: '#e2574f' }}>
					cloudflared is not installed — see the add-on README for a one-line install.
				</Text>
			) : null}

			{status.running ? (
				<div>
					<div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
						<span style={{ width: 9, height: 9, borderRadius: '50%', background: '#51bb7b', display: 'inline-block' }} />
						<a
							href={status.url}
							target="_blank"
							rel="noreferrer"
							style={{ fontWeight: 600 }}
						>
							{status.url}
						</a>
						<TextButton onClick={copyUrl}>{copied ? 'Copied!' : 'Copy'}</TextButton>
						<Button disabled={busy} onClick={stop}>
							{busy ? 'Stopping…' : 'Stop tunnel'}
						</Button>
					</div>
					{status.rewrite ? (
						<Text style={{ display: 'block', marginTop: 8, fontSize: 12, opacity: 0.7 }}>
							WordPress home/siteurl point at the tunnel while it runs — they are restored on stop.
						</Text>
					) : null}
				</div>
			) : (
				<div>
					<label
						style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, cursor: 'pointer' }}
					>
						<input
							type="checkbox"
							checked={rewrite}
							disabled={busy}
							onChange={(e) => setRewrite(e.target.checked)}
						/>
						Point WordPress URLs at the tunnel while active (recommended for OAuth/webhooks)
					</label>
					<Button disabled={busy || !status.binaryFound} onClick={start}>
						{busy ? 'Starting…' : 'Start tunnel'}
					</Button>
				</div>
			)}

			{error ? (
				<Text style={{ display: 'block', marginTop: 12, color: '#b32d2e' }}>{error}</Text>
			) : null}
		</div>
	);
}

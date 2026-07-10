import { ipcRenderer } from 'electron';

// https://getflywheel.github.io/local-addon-api/modules/_local_renderer_.html
import * as LocalRenderer from '@getflywheel/local/renderer';

// https://github.com/getflywheel/local-components
import { Button, Title, Text, FlyModal, TableListRow, FlySelect, TextButton, ProgressBar } from '@getflywheel/local-components';

const SLUG = 'wp-version-manager';

// IMPORTANT: do not `import React from 'react'`. Local injects its own React instance
// into the renderer context; using a second (bundled) React makes hooks fail inside
// Local's render tree. We capture the host React in registerWordPressVersionManager().
let React;

/** Numeric, segment-by-segment version comparison. Returns <0, 0, or >0. */
function compareVersions (a, b) {
	const numeric = (s) => String(s).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
	const pa = numeric(a);
	const pb = numeric(b);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/** True when we can meaningfully compare a target against the installed version. */
function isComparable (target) {
	return /^\d+(\.\d+){0,2}$/.test(String(target || '').trim());
}

/** Unwrap Local's ipcAsync rejection noise and return just the real message. */
function cleanError (err) {
	let msg = String(err?.message || err);
	const m = msg.match(/main thread error:\s*([\s\S]*?)(?:\s*Check out the error props.*)?$/i);
	if (m) {
		msg = m[1].trim();
	}
	return msg.replace(/^["']|["']$/g, '') || 'Something went wrong.';
}

/**
 * Register the add-on UI. Called from renderer.js with Local's React + hooks.
 * Renders a "WordPress Version" row into the site's Tools tab (siteInfoUtilities),
 * which passes the current `site` object directly.
 */
export function registerWordPressVersionManager (_React, hooks) {
	React = _React;

	// Full panel in the site's Tools tab.
	hooks.addContent('siteInfoUtilities', (site) => (
		<TableListRow key={SLUG} label="WordPress Version">
			<WordPressVersionManager site={site} />
		</TableListRow>
	));

	// Replaces the static "WordPress version" row in the Overview table with a
	// PHP-version-style selector (the static row is hidden by the component).
	hooks.addContent('SiteInfoOverview_TableList', (site) => (
		<TableListRow key={`${SLUG}-overview`} label="WordPress version">
			<WordPressVersionManager site={site} compact />
		</TableListRow>
	));
}

function WordPressVersionManager ({ site, compact }) {
	const { useState, useEffect, useCallback } = React;

	const siteId = site?.id;

	const [current, setCurrent] = useState(null);
	const [versions, setVersions] = useState([]);
	const [selected, setSelected] = useState('');
	const [custom, setCustom] = useState('');
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);
	const [log, setLog] = useState('');
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [snapshotFirst, setSnapshotFirst] = useState(true);
	const [snapshots, setSnapshots] = useState([]);
	const [snapBusy, setSnapBusy] = useState(false);
	const [stage, setStage] = useState(null); // { step, total, label } while working

	// Progress events from the main process during switches/restores.
	useEffect(() => {
		const onProgress = (_event, p) => {
			if (p?.siteId === siteId) {
				setStage(p);
			}
		};
		ipcRenderer.on(`${SLUG}:progress`, onProgress);
		return () => ipcRenderer.removeListener(`${SLUG}:progress`, onProgress);
	}, [siteId]);

	const loadSnapshots = useCallback(async () => {
		const list = await LocalRenderer.ipcAsync(`${SLUG}:list-snapshots`, siteId);
		setSnapshots(Array.isArray(list) ? list : []);
	}, [siteId]);

	const loadCurrent = useCallback(async () => {
		const res = await LocalRenderer.ipcAsync(`${SLUG}:get-current-version`, siteId);
		if (res.error) {
			setError(res.error);
			return null;
		}
		setError(null);
		setCurrent(res.version);
		return res.version;
	}, [siteId]);

	useEffect(() => {
		let active = true;

		(async () => {
			setLoading(true);
			const [verRes, ver] = await Promise.all([
				LocalRenderer.ipcAsync(`${SLUG}:get-available-versions`),
				loadCurrent(),
			]);

			if (!active) {
				return;
			}

			if (verRes?.versions) {
				setVersions(verRes.versions);
			}
			if (verRes?.error && !ver) {
				setError((prev) => prev || verRes.error);
			}
			if (ver) {
				setSelected(ver);
			}
			setLoading(false);
			if (!compact) {
				loadSnapshots();
			}
		})();

		return () => {
			active = false;
		};
	}, [loadCurrent]);

	// In compact (Overview) mode, hide Local's built-in static "WordPress version"
	// row — ours (label + selector) visually replaces it, like the PHP version row.
	useEffect(() => {
		if (!compact || loading) {
			return;
		}
		document.querySelectorAll('.TableListRow').forEach((row) => {
			const label = row.querySelector('strong');
			if (!label || (label.textContent || '').trim() !== 'WordPress version') {
				return;
			}
			if (row.querySelector('[data-wpvm-row]')) {
				return; // this is our own row — leave it
			}
			row.style.display = 'none'; // Local's built-in static row
		});
	}, [compact, loading]);

	// A typed-in version/URL takes precedence over the dropdown selection.
	const target = (custom.trim() || selected).trim();

	const apply = async () => {
		setConfirmOpen(false);
		setBusy(true);
		setError(null);
		setLog('');

		try {
			const res = await LocalRenderer.ipcAsync(`${SLUG}:set-version`, siteId, target, snapshotFirst);
			setCurrent(res.newVersion);
			setSelected(res.newVersion);
			setCustom('');
			setLog((res.snapshot ? `Snapshot saved: ${res.snapshot}\n` : '') + (res.log || 'Done.'));
			loadSnapshots();
		} catch (err) {
			setError(cleanError(err));
		} finally {
			setBusy(false);
			setStage(null);
		}
	};

	const takeSnapshot = async () => {
		setSnapBusy(true);
		setError(null);
		try {
			await LocalRenderer.ipcAsync(`${SLUG}:create-snapshot`, siteId, 'manual');
			await loadSnapshots();
		} catch (err) {
			setError(cleanError(err));
		} finally {
			setSnapBusy(false);
		}
	};

	const restoreSnap = async (filename) => {
		setSnapBusy(true);
		setError(null);
		try {
			const res = await LocalRenderer.ipcAsync(`${SLUG}:restore-snapshot`, siteId, filename);
			setCurrent(res.newVersion);
			setSelected(res.newVersion);
			setLog(`Restored ${filename} — now on WordPress ${res.newVersion}.`);
		} catch (err) {
			setError(cleanError(err));
		} finally {
			setSnapBusy(false);
			setStage(null);
		}
	};

	const deleteSnap = async (filename) => {
		setSnapBusy(true);
		try {
			await LocalRenderer.ipcAsync(`${SLUG}:delete-snapshot`, siteId, filename);
			await loadSnapshots();
		} finally {
			setSnapBusy(false);
		}
	};

	const comparable = current && isComparable(target);
	const isDowngrade = comparable && compareVersions(target, current) < 0;
	const isSame = comparable && compareVersions(target, current) === 0;

	// Stepped progress bar shown while a switch/restore runs. Half-credit for
	// the in-flight stage so the bar visibly moves between IPC events.
	const renderProgress = (width = 280) => {
		const pct = stage ? Math.round(((stage.step - 0.5) / stage.total) * 100) : undefined;
		return (
			<div style={{ width, maxWidth: '100%' }}>
				<ProgressBar progress={pct} />
				<Text style={{ fontSize: 12, opacity: 0.8, marginTop: 4, display: 'block' }}>
					{stage ? `${stage.label} (step ${stage.step} of ${stage.total})` : 'Working…'}
				</Text>
			</div>
		);
	};

	const renderConfirm = () => (
		<FlyModal isOpen={confirmOpen} onRequestClose={() => setConfirmOpen(false)}>
			<div style={{ padding: '10px 40px 35px', maxWidth: 520, margin: '0 auto', textAlign: 'center' }}>
				<Title fontSize="xl" style={{ marginBottom: 20 }}>Change WordPress version?</Title>

				<div style={{ marginBottom: 14, fontSize: 15, lineHeight: 1.5 }}>
					Switch <strong>{site?.name}</strong> from <strong>{current}</strong> to{' '}
					<strong>{target}</strong>, then update the database.
				</div>

				<div
					style={{
						marginBottom: 20,
						fontSize: 13,
						lineHeight: 1.5,
						color: isDowngrade || !comparable ? '#e2574f' : undefined,
						opacity: isDowngrade || !comparable ? 1 : 0.75,
					}}
				>
					{isDowngrade
						? `Downgrading is not officially supported by WordPress and can break plugins or themes.`
						: isSame
							? `This re-installs the same version (${target}).`
							: comparable
								? `Upgrading from ${current} to ${target}.`
								: `Pre-release / nightly builds are for testing only.`}
				</div>

				<label
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						gap: 8,
						marginBottom: 24,
						fontSize: 13,
						cursor: 'pointer',
					}}
				>
					<input
						type="checkbox"
						checked={snapshotFirst}
						onChange={(e) => setSnapshotFirst(e.target.checked)}
					/>
					Take a database snapshot first (recommended)
				</label>

				<div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
					<Button onClick={apply}>Yes, change to {target}</Button>
					<Button className="Button--Ghost" onClick={() => setConfirmOpen(false)}>
						Cancel
					</Button>
				</div>
			</div>
		</FlyModal>
	);

	if (loading) {
		return <Text>Loading WordPress versions…</Text>;
	}

	// Compact variant for the Overview table, styled like the PHP version row:
	// native FlySelect + a green "Update" text link when the selection changes.
	if (compact) {
		const options = {};
		versions.forEach((v) => {
			let label = v.version;
			if (v.status === 'latest') label += ' — latest';
			if (v.status === 'beta') label += ' — beta / RC';
			if (v.status === 'nightly') label = 'nightly — bleeding edge';
			if (v.version === current) label += ' (installed)';
			options[v.version] = label;
		});

		return (
			<div data-wpvm-row style={{ display: 'flex', alignItems: 'center' }}>
				<FlySelect
					options={options}
					value={selected}
					disabled={busy || versions.length === 0}
					onChange={(value) => { setSelected(value); setCustom(''); }}
				/>
				{!isSame && target && !busy ? (
					<TextButton onClick={() => setConfirmOpen(true)}>Update</TextButton>
				) : null}
				{busy ? <div style={{ marginLeft: 12 }}>{renderProgress(220)}</div> : null}
				{error ? <Text style={{ marginLeft: 10, color: '#b32d2e' }}>{error}</Text> : null}
				{log && !error && !busy ? <Text style={{ marginLeft: 10, color: '#51bb7b' }}>Done — now on {current}.</Text> : null}
				{renderConfirm()}
			</div>
		);
	}

	return (
		<div style={{ flex: '1', overflowY: 'auto' }}>
			<Text style={{ marginBottom: 16 }}>
				Current version: <strong>{current || 'unknown'}</strong>
			</Text>

			<label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
				Switch to
			</label>
			<select
				value={selected}
				disabled={busy || versions.length === 0}
				onChange={(e) => {
					setSelected(e.target.value);
					setCustom('');
				}}
				style={{
					width: '100%',
					maxWidth: 360,
					padding: '8px 10px',
					borderRadius: 4,
					border: '1px solid #c3c4c7',
					marginBottom: 16,
				}}
			>
				{versions.map((v) => (
					<option key={v.version} value={v.version}>
						{v.version}
						{v.status === 'latest' ? ' — latest' : ''}
						{v.status === 'insecure' ? ' — insecure' : ''}
						{v.status === 'beta' ? ' — beta / RC' : ''}
						{v.status === 'nightly' ? ' — bleeding edge' : ''}
						{v.version === current ? ' (installed)' : ''}
					</option>
				))}
			</select>

			<label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
				…or enter any version / .zip URL
			</label>
			<input
				type="text"
				value={custom}
				disabled={busy}
				placeholder="e.g. 6.6-RC1, 4.9.8, nightly, or https://wordpress.org/…zip"
				onChange={(e) => setCustom(e.target.value)}
				style={{
					width: '100%',
					maxWidth: 360,
					padding: '8px 10px',
					borderRadius: 4,
					border: '1px solid #c3c4c7',
					marginBottom: 16,
				}}
			/>

			<div>
				<Button
					disabled={busy || !target || isSame}
					onClick={() => setConfirmOpen(true)}
				>
					{busy ? 'Applying…' : `Apply ${target || 'version'}`}
				</Button>
			</div>

			{busy || (snapBusy && stage) ? (
				<div style={{ marginTop: 16 }}>{renderProgress(360)}</div>
			) : null}

			{isDowngrade && !busy ? (
				<Text style={{ marginTop: 14, color: '#b32d2e' }}>
					⚠ Downgrades can break your site — back up before applying.
				</Text>
			) : null}

			{error ? (
				<div
					style={{
						marginTop: 20,
						padding: 12,
						background: '#fcf0f1',
						border: '1px solid #d63638',
						borderRadius: 4,
					}}
				>
					<Text style={{ color: '#b32d2e' }}>{error}</Text>
				</div>
			) : null}

			{log ? (
				<pre
					style={{
						marginTop: 20,
						padding: 12,
						background: '#1d2327',
						color: '#e0e0e0',
						borderRadius: 4,
						overflowX: 'auto',
						whiteSpace: 'pre-wrap',
						fontSize: 12,
					}}
				>
					{log}
				</pre>
			) : null}

			<div style={{ marginTop: 28, borderTop: '1px solid rgba(127,127,127,0.25)', paddingTop: 18 }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
					<strong>Database snapshots</strong>
					<TextButton disabled={snapBusy} onClick={takeSnapshot}>
						{snapBusy ? 'Working…' : '+ Take snapshot'}
					</TextButton>
				</div>
				{snapshots.length === 0 ? (
					<Text style={{ opacity: 0.7 }}>
						No snapshots yet. One is taken automatically before each version change
						(you can turn that off in the confirmation dialog).
					</Text>
				) : (
					<table style={{ width: '100%', maxWidth: 640, fontSize: 13, borderCollapse: 'collapse' }}>
						<tbody>
							{snapshots.map((s) => (
								<tr key={s.filename} style={{ borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
									<td style={{ padding: '6px 8px 6px 0' }}>
										{new Date(s.date).toLocaleString()}
									</td>
									<td style={{ padding: '6px 8px' }}>WP {s.wpVersion}</td>
									<td style={{ padding: '6px 8px', opacity: 0.7 }}>{s.note}</td>
									<td style={{ padding: '6px 8px', opacity: 0.7 }}>
										{(s.size / 1024 / 1024).toFixed(1)} MB
									</td>
									<td style={{ padding: '6px 0 6px 8px', whiteSpace: 'nowrap' }}>
										<TextButton disabled={snapBusy} onClick={() => restoreSnap(s.filename)}>
											Restore
										</TextButton>
										{' '}
										<TextButton
											disabled={snapBusy}
											style={{ color: '#e2574f' }}
											onClick={() => deleteSnap(s.filename)}
										>
											Delete
										</TextButton>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			{renderConfirm()}
		</div>
	);
}

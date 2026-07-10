/* Plain-Node smoke test for the pure version logic. Run: node test/versions.test.js */
const assert = require('assert');
const {
	compareVersions,
	buildUpdateArgs,
	fetchAllVersions,
	NIGHTLY_ZIP_URL,
} = require('../lib/versions');

let passed = 0;
function ok (label, cond) {
	assert.ok(cond, label);
	passed++;
	console.log(`  ✓ ${label}`);
}
function throws (label, fn) {
	assert.throws(fn, label);
	passed++;
	console.log(`  ✓ ${label}`);
}

(async () => {
	console.log('compareVersions:');
	ok('6.5 > 6.4.9', compareVersions('6.5', '6.4.9') > 0);
	ok('4.9.8 < 5.0', compareVersions('4.9.8', '5.0') < 0);
	ok('6.6 == 6.6.0', compareVersions('6.6', '6.6.0') === 0);
	ok('6.6-RC1 < 6.6 (pre-release sorts below final)', compareVersions('6.6-RC1', '6.6') < 0);

	console.log('buildUpdateArgs:');
	assert.deepStrictEqual(buildUpdateArgs('6.5.2'), ['core', 'update', '--version=6.5.2', '--force']);
	ok('stable -> --version=6.5.2 --force', true);
	assert.deepStrictEqual(buildUpdateArgs('6.6-RC1'), ['core', 'update', '--version=6.6-RC1', '--force']);
	ok('beta/RC -> --version=6.6-RC1 --force', true);
	assert.deepStrictEqual(buildUpdateArgs('4.9.8'), ['core', 'update', '--version=4.9.8', '--force']);
	ok('old version -> --version=4.9.8 --force', true);
	assert.deepStrictEqual(buildUpdateArgs('nightly'), ['core', 'update', NIGHTLY_ZIP_URL, '--force']);
	ok('nightly -> nightly zip url --force', true);
	assert.deepStrictEqual(
		buildUpdateArgs('https://wordpress.org/wordpress-6.6-beta2.zip'),
		['core', 'update', 'https://wordpress.org/wordpress-6.6-beta2.zip', '--force'],
	);
	ok('wordpress.org .zip URL -> passed through', true);
	throws('rejects non-wordpress.org URL', () => buildUpdateArgs('https://evil.example.com/wp.zip'));
	throws('rejects wordpress.org non-zip URL', () => buildUpdateArgs('https://wordpress.org/latest'));
	throws('rejects garbage version', () => buildUpdateArgs('not-a-version; rm -rf /'));

	console.log('fetchAllVersions (live WordPress.org):');
	const versions = await fetchAllVersions();
	ok(`returned ${versions.length} versions`, versions.length > 100);
	ok('first entry is nightly', versions[0].version === 'nightly' && versions[0].status === 'nightly');
	ok('includes a "latest" stable', versions.some((v) => v.status === 'latest'));
	ok('includes an old version (< 4.0, e.g. 3.x)', versions.some((v) => /^3\./.test(v.version)));
	const stable = versions.filter((v) => v.status !== 'nightly' && v.status !== 'beta');
	let sorted = true;
	for (let i = 1; i < stable.length; i++) {
		if (compareVersions(stable[i - 1].version, stable[i].version) < 0) { sorted = false; break; }
	}
	ok('stable versions sorted newest-first', sorted);
	const latest = versions.find((v) => v.status === 'latest');
	console.log(`     latest stable reported by WordPress.org: ${latest && latest.version}`);
	const beta = versions.find((v) => v.status === 'beta');
	console.log(`     current beta/RC: ${beta ? beta.version : '(none active right now)'}`);

	console.log(`\nALL ${passed} CHECKS PASSED`);
})().catch((err) => {
	console.error('\nTEST FAILED:', err);
	process.exit(1);
});

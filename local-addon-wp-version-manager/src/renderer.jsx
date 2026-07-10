import { registerWordPressVersionManager } from './WordPressVersionManager';

export default function (context) {
	// Local injects its own React + hooks. We pass them through so the add-on
	// uses the host React instance (a bundled second copy breaks hooks).
	const { React, hooks } = context;

	registerWordPressVersionManager(React, hooks);
}

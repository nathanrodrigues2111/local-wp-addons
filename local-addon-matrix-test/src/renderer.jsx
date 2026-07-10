import { registerMatrixTester } from './MatrixPanel';

export default function (context) {
	// Local injects its own React + hooks; using the host React keeps hooks working.
	const { React, hooks } = context;

	registerMatrixTester(React, hooks);
}

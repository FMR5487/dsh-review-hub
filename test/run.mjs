/**
 * The suite runner: every test file exports `cases`; this walks them in order and
 * prints PASS/FAIL per case. `node test/run.mjs`.
 */
import { rm } from 'node:fs/promises';
import { TMP_ROOT } from './helpers.mjs';
import * as units from './units.test.mjs';
import * as catalog from './catalog.test.mjs';
import * as store from './store.test.mjs';
import * as routes from './routes.test.mjs';
import * as review from './review.test.mjs';
import * as pipeline from './pipeline.test.mjs';
import * as client from './client.smoke.mjs';
import * as p3 from './p3.test.mjs';

const SUITES = [
	['units', units],
	['catalog', catalog],
	['store', store],
	['routes', routes],
	['review', review],
	['pipeline', pipeline],
	['client', client],
	['p3', p3],
];

await rm(TMP_ROOT, { recursive: true, force: true });

let passed = 0;
const failures = [];

for (const [label, suite] of SUITES) {
	for (const testCase of suite.cases ?? []) {
		const name = label + ': ' + testCase.name;
		try {
			await testCase.fn();
			passed += 1;
			console.log('PASS ' + name);
		} catch (error) {
			failures.push(name);
			console.log('FAIL ' + name + ': ' + (error instanceof Error ? error.message : String(error)));
		}
	}
}

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
for (const name of failures) console.log('  failed: ' + name);
if (failures.length > 0) process.exitCode = 1;

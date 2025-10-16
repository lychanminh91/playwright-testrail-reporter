// reporter.ts
import type {
	FullConfig,
	Suite,
	TestCase,
	TestResult,
	FullResult,
	Reporter,
  } from '@playwright/test/reporter';
  import TestRail from '../vendor/testrail/dist/TestRail';
  import logger from './logger';
  import extractCaseIds from './caseIdExtractor';
  
  /**
   * Mapping status within Playwright & TestRail
   * TestRail status_id: Passed(1), Blocked(2), Untested(3), Retest(4), Failed(5)
   * We use: passed(1), skipped(3), failed/timedOut/interrupted(5)
   */
  const StatusMap = new Map<TestResult['status'], number>([
	['failed', 5],
	['passed', 1],
	['skipped', 3],
	['timedOut', 5],
	['interrupted', 5],
  ]);
  
  /** Narrow env access with helpful errors for required vars */
  function getEnv(name: string, required = true): string | undefined {
	const v = process.env[name];
	if (required && (!v || !v.trim())) {
	  throw new Error(`Missing required env var: ${name}`);
	}
	return v;
  }
  
  export function getTestCaseName(testname: string): string[] | null {
	const testCaseIdRegex = /\bC(\d+)\b/g;
	const matches = testname.match(testCaseIdRegex);
	if (matches) {
	  matches.forEach((m) => {
		const id = parseInt(m.substring(1), 10);
		logger(`Matched Test Case ID: ${id}`);
	  });
	} else {
	  logger('No test case matches available');
	}
	return matches;
  }
  
  /** Payload shape for addResultsForCases */
  type ResultPayload = {
	case_id: number;
	status_id: number;
	comment?: string;
  };
  
  const executionDateTime = new Date().toString().slice(4, 25);
  
  // Build API client early so we fail-fast if required envs are missing
  const api = new TestRail({
	host: getEnv('TESTRAIL_HOST')!,
	username: getEnv('TESTRAIL_USERNAME')!,
	password: getEnv('TESTRAIL_PASSWORD')!,
  });
  
  const runName =
	`${getEnv('TESTRAIL_RUN_NAME') ?? 'Playwright Run'} - Created On ${executionDateTime}`;
  const projectId = parseInt(getEnv('TESTRAIL_PROJECT_ID')!, 10);
  const suiteId = parseInt(getEnv('TESTRAIL_SUITE_ID')!, 10);
  
  const testResults: ResultPayload[] = [];
  
  export class TestRailReporter implements Reporter {
	async onBegin(_config: FullConfig, _suite: Suite): Promise<void> {
	  if (!process.env.TESTRAIL_RUN_ID) {
		logger("No Existing 'TESTRAIL_RUN_ID' provided by user...");
		logger('Automatically creating a run...');
		await addTestRailRun(projectId);
	  } else {
		logger(
		  `Existing Test Run with ID ${process.env.TESTRAIL_RUN_ID} will be used.. ` +
			'Updating the Test Run with latest Test Cases'
		);
		await updateTestRailRun(parseInt(process.env.TESTRAIL_RUN_ID, 10));
	  }
	}
  
	onTestEnd(test: TestCase, result: TestResult): void {
	  logger(`Test Case Completed : ${test.title} Status : ${result.status}`);
  
	  const matches = getTestCaseName(test.title);
	  if (!matches) return;
  
	  for (const match of matches) {
		const caseId = parseInt(match.substring(1), 10);
  
		if (result.status !== 'skipped') {
		  const comment = setTestComment(result);
		  testResults.push({
			case_id: caseId,
			status_id: StatusMap.get(result.status)!,
			comment,
		  });
		}
	  }
	}
  
	async onEnd(_result: FullResult): Promise<void> {
	  const runId = parseInt(getEnv('TESTRAIL_RUN_ID')!, 10);
	  logger(`Updating test status for the following TestRail Run ID: ${runId}`);
	  await updateResultCases(runId, testResults);
	}
  
	onError(error: Error): void {
	  logger(error.message);
	}
  }
  
  /** Create TestRail Test Run ID */
  async function addTestRailRun(projectIdArg: number): Promise<void> {
	const caseIds = await extractCaseIds(getEnv('TESTS_DIRECTORY')!);
	// Optional visibility for debugging:
	// console.log('Case IDs:', caseIds);
  
	await api
	  .addRun(projectIdArg, {
		include_all: false,
		name: runName,
		case_ids: caseIds,
		suite_id: suiteId,
	  })
	  .then(
		(res) => {
		  logger(
			`New TestRail run has been created: ${getEnv('TESTRAIL_HOST')}` +
			  `/index.php?/runs/view/${res.id}`
		  );
		  process.env.TESTRAIL_RUN_ID = String(res.id);
		},
		(reason) => {
		  logger(`Failed to create new TestRail run: ${reason}`);
		}
	  );
  }
  
  /** Add Test Result for an individual case (not used in batch flow, but kept for parity) */
  async function addResultForSuite(
	runId: number,
	caseId: number,
	statusId: number,
	comment?: string
  ): Promise<void> {
	await api
	  .addResultForCase(runId, caseId, {
		status_id: statusId,
		comment,
	  })
	  .then(
		() => {
		  logger(`Updated status for caseId ${caseId} for runId ${runId}`);
		},
		(reason) => {
		  logger(`Failed to call Update Api due to ${JSON.stringify(reason)}`);
		}
	  );
  }
  
  /** Build a readable comment for the result */
  function setTestComment(result: TestResult): string {
	if (result.status === 'failed' || result.status === 'timedOut' || result.status === 'interrupted') {
	  // Playwright keeps the error under result.error; stringify defensively
	  return `Test Status is ${result.status} ${JSON.stringify(result.error ?? {})}`;
	}
	return `Test Passed within ${result.duration} ms`;
  }
  
  /** Batch update results */
  async function updateResultCases(runId: number, payload: ResultPayload[]): Promise<void> {
	if (!payload.length) {
	  logger('No results to update.');
	  return;
	}
  
	await api
	  .addResultsForCases(runId, { results: payload })
	  .then(
		() => {
		  logger(
			`Updated test results for Test Run: ${getEnv('TESTRAIL_HOST')}` +
			  `/index.php?/runs/view/${runId}`
		  );
		},
		(reason) => {
		  logger(`Failed to update test results: ${JSON.stringify(reason)}`);
		}
	  );
  }
  
  /** Update an existing run to the current set of case IDs */
  async function updateTestRailRun(runId: number): Promise<void> {
	const caseIds = await extractCaseIds(getEnv('TESTS_DIRECTORY')!);
	// console.log('Case IDs:', caseIds);
  
	await api
	  .updateRun(runId, {
		include_all: false,
		case_ids: caseIds,
	  })
	  .then(
		(res) => {
		  logger(
			`TestRail run has been updated: ${getEnv('TESTRAIL_HOST')}` +
			  `/index.php?/runs/view/${res.id}`
		  );
		},
		(reason) => {
		  logger(`Failed to update the TestRail run: ${reason}`);
		}
	  );
  }
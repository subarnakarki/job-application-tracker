import { LLMTestCase, SingleTurnParams } from 'deepeval/test-case';
import { expect, it } from 'vitest';
import { metrics, observer } from '../src/clients';
import { JUDGE_MODEL } from '../src/judge';

// E0 spike: one GEval metric on the Claude judge, to see a score and a reason come back. The writing
// suites (Phase E4) replace it with calibrated metrics.
const tone = metrics.gEval({
  name: 'Polite decline',
  criteria:
    'The reply turns down the meeting request politely and clearly, without making up a reason.',
  evaluationParams: [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
  threshold: 0.5,
});

it('grades a reply with the Claude judge', async () => {
  const testCase = new LLMTestCase({
    input: 'A recruiter asks for a call on Friday; the candidate has accepted another offer.',
    actualOutput:
      'Hi Sam, thank you for reaching out. I have accepted another offer, so I will pass on the call. ' +
      'I appreciate your time and wish you the best with the search.',
  });
  await observer.inCase('judge-smoke', () => expect(testCase).toPass([tone]));

  console.info('score:', tone.score, 'reason:', tone.reason);
  const calls = observer.callsFor('judge-smoke');
  console.info('observed:', JSON.stringify(calls, null, 2));
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => call.requestedModel === JUDGE_MODEL && call.error === null)).toBe(
    true,
  );
});

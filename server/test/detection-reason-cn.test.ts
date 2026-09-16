import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conciseDetectionReason,
  conciseRelayReason,
} from '../../components/detection-reason-cn-runtime.ts';

test('relay failure reasons are concise Chinese text', () => {
  assert.equal(conciseRelayReason(['RELAY:ALARM_RELAY_NOT_ACTUATED']), '火警继电器未动作');
  assert.equal(conciseRelayReason(['RELAY:FAULT_RELAY_STUCK_AFTER_RESET']), '故障继电器未复位');
  assert.equal(conciseRelayReason(['RELAY:FAULT_RELAY_ACTIVE_AT_BASELINE']), '故障反馈初始异常');
  assert.equal(
    conciseDetectionReason('RELAY_FUNCTIONAL_TEST_FAILED', ['RELAY:ALARM_RELAY_NOT_ACTUATED']),
    '火警继电器未动作',
  );
});

test('raw machine reason codes never leak through the display formatter', () => {
  assert.equal(conciseDetectionReason('SOFTWARE_VERSION_MISMATCH'), '软件版本不符');
  assert.equal(conciseDetectionReason('TEST_INVALID_RETEST_REQUIRED'), '测试链路异常');
  assert.equal(conciseDetectionReason('UNKNOWN_MACHINE_REASON_CODE'), '检测未通过');
  assert.equal(conciseDetectionReason('探测器故障'), '探测器故障');
});

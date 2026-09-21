export { preflight } from './preflight';
export { snapshotLive } from './snapshotLive';
export { research } from './research';
export { selectTopic } from './selectTopic';
export { requestAds } from './requestAds';
export { resolveAds } from './resolveAds';
export { generate } from './generate';
export { edit } from './edit';
export { placeAds } from './placeAds';
export { gate } from './gate';
export { awaitApproval } from './awaitApproval';
export { publishing } from './publishing';
export { reconcile } from './reconcile';
export { verify } from './verify';
export { record, statusForOutcome } from './record';

import { preflight } from './preflight';
import { snapshotLive } from './snapshotLive';
import { research } from './research';
import { selectTopic } from './selectTopic';
import { requestAds } from './requestAds';
import { resolveAds } from './resolveAds';
import { generate } from './generate';
import { edit } from './edit';
import { placeAds } from './placeAds';
import { gate } from './gate';
import { awaitApproval } from './awaitApproval';
import { publishing } from './publishing';
import { reconcile } from './reconcile';
import { verify } from './verify';
import { record } from './record';
import type { Step, StepHandler } from './types';

/** 단계 → 핸들러 표(설계 §5-1). 드라이버는 이 표만 본다. */
export const STEP_HANDLERS: Record<Step, StepHandler> = {
  PREFLIGHT: preflight,
  SNAPSHOT_LIVE: snapshotLive,
  RESEARCH: research,
  SELECT_TOPIC: selectTopic,
  REQUEST_ADS: requestAds,
  RESOLVE_ADS: resolveAds,
  GENERATE: generate,
  EDIT: edit,
  PLACE_ADS: placeAds,
  GATE: gate,
  AWAIT_APPROVAL: awaitApproval,
  PUBLISHING: publishing,
  RECONCILE: reconcile,
  VERIFY: verify,
  RECORD: record,
};

export function createStepRegistry(): Record<Step, StepHandler> {
  return { ...STEP_HANDLERS };
}

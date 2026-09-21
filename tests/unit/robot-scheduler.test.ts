import { describe, expect, it } from 'vitest';
import {
  FakeClock,
  RobotScheduler,
  computeSlots,
  hashSlot,
  nextSlotOfKind,
  slotJitterMs,
  type RobotSlotsConfig,
  type SlotSpec,
} from '../../src/robot/RobotScheduler';
import { WEEKLY_HARD_CAP } from '../../src/robot/policies';
import { kstIso } from '../../src/robot/kst';
import { createScenario, type Scenario } from './robot-helpers';

/**
 * RobotScheduler — 가짜 시계로 정시·지터·보정(catch-up)·놓친 슬롯·중복 틱을 검증한다.
 * 지터는 슬롯 문자열 해시라 재시작해도 같은 시각이어야 한다(설계 §5-6).
 */

const MINUTE = 60_000;
const PUBLISH_SLOTS: SlotSpec[] = [{ day: 'tue', time: '21:10' }];

function makeScheduler(
  scenario: Scenario,
  overrides: Partial<RobotSlotsConfig> = {},
): { scheduler: RobotScheduler; config: RobotSlotsConfig } {
  const config: RobotSlotsConfig = {
    enabled: true,
    mode: 'manual',
    slots: { plan: [], publish: PUBLISH_SLOTS },
    catchUpMinutes: { plan: 600, publish: 110 },
    jitterMinutes: 15,
    codeVersion: 'test-sha',
    ...overrides,
  };
  return {
    scheduler: new RobotScheduler({
      store: scenario.store,
      config,
      clock: scenario.clock,
      notifier: scenario.notify,
    }),
    config,
  };
}

/** 슬롯의 실제 예정 시각(지터 포함)을 구한다. */
function dueOf(scenario: Scenario, config: RobotSlotsConfig, kind: 'plan' | 'publish'): number {
  const [next] = computeSlots(scenario.clock.now(), config.slots, config.jitterMinutes, [0]).filter(
    (slot) => slot.kind === kind,
  );
  return next.dueMs;
}

describe('RobotScheduler — 지터', () => {
  it('지터는 슬롯마다 고정이고 재시작해도 같다(해시 기반)', () => {
    const slot = '2026-09-22T21:10:00+09:00';
    expect(hashSlot(slot)).toBe(hashSlot(slot));
    expect(slotJitterMs(slot, 15)).toBe(slotJitterMs(slot, 15));
    expect(slotJitterMs(slot, 15)).toBeLessThan(15 * MINUTE);
    expect(slotJitterMs(slot, 0)).toBe(0);

    const jitters = new Set(
      ['2026-09-22T21:10:00+09:00', '2026-09-26T21:10:00+09:00', '2026-09-29T21:10:00+09:00'].map(
        (s) => slotJitterMs(s, 15),
      ),
    );
    expect(jitters.size).toBeGreaterThan(1);

    // 같은 슬롯에 대해 두 인스턴스가 같은 시각을 계산한다(재시작 동일성).
    const a = computeSlots(
      new Date('2026-09-22T12:00:00+09:00'),
      { plan: [], publish: PUBLISH_SLOTS },
      15,
      [0],
    );
    const b = computeSlots(
      new Date('2026-09-22T12:00:00+09:00'),
      { plan: [], publish: PUBLISH_SLOTS },
      15,
      [0],
    );
    expect(a.map((s) => s.slot)).toEqual(b.map((s) => s.slot));
  });
});

describe('RobotScheduler — 슬롯 생성', () => {
  it('정시(틱 지연 1분 이내)면 trigger=schedule로 실행을 만든다', () => {
    const scenario = createScenario();
    const { scheduler, config } = makeScheduler(scenario);
    const due = dueOf(scenario, config, 'publish');
    scenario.clock.set(new Date(due + 30_000));

    const tick = scheduler.tick();
    expect(tick.created).toHaveLength(1);
    expect(tick.created[0].kind).toBe('publish');
    expect(tick.created[0].trigger).toBe('schedule');
    expect(tick.created[0].status).toBe('running');
    expect(Date.parse(tick.created[0].slot)).toBe(due);
  });

  it('창 안에서 늦게 깨어나면 trigger=catch-up', () => {
    const scenario = createScenario();
    const { scheduler, config } = makeScheduler(scenario);
    const due = dueOf(scenario, config, 'publish');
    scenario.clock.set(new Date(due + 30 * MINUTE));

    const tick = scheduler.tick();
    expect(tick.created).toHaveLength(1);
    expect(tick.created[0].trigger).toBe('catch-up');
  });

  it('창(110분)을 지나면 skipped-missed-slot 행을 남기고 알림을 보낸다', () => {
    const scenario = createScenario();
    const { scheduler, config } = makeScheduler(scenario);
    const due = dueOf(scenario, config, 'publish');
    scenario.clock.set(new Date(due + 120 * MINUTE));

    const tick = scheduler.tick();
    expect(tick.created).toHaveLength(0);
    expect(tick.missed).toHaveLength(1);
    expect(tick.missed[0].status).toBe('skipped');
    expect(tick.missed[0].outcome).toBe('skipped-missed-slot');
    expect(scenario.notify.messages.join(' ')).toContain('놓친 슬롯');
  });

  it('같은 슬롯을 여러 번 틱해도 실행은 정확히 1개다(UNIQUE(kind,slot))', () => {
    const scenario = createScenario();
    const { scheduler, config } = makeScheduler(scenario);
    const due = dueOf(scenario, config, 'publish');
    scenario.clock.set(new Date(due + 10_000));

    const first = scheduler.tick();
    const second = scheduler.tick();
    scenario.clock.advanceMs(30_000);
    const third = scheduler.tick();

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(third.created).toHaveLength(0);
    expect(scenario.store.listRuns(10)).toHaveLength(1);
  });

  it('기획과 발행이 겹치면 발행이 먼저이고 기획은 다음 틱으로 미룬다', () => {
    const scenario = createScenario();
    const { scheduler, config } = makeScheduler(scenario, {
      slots: { plan: [{ day: 'tue', time: '21:10' }], publish: [{ day: 'tue', time: '21:10' }] },
    });
    const due = dueOf(scenario, config, 'publish');
    scenario.clock.set(new Date(Math.max(due, dueOf(scenario, config, 'plan')) + 5_000));

    const tick = scheduler.tick();
    expect(tick.created.map((run) => run.kind)).toEqual(['publish']);
    expect(tick.deferred.map((slot) => slot.kind)).toEqual(['plan']);

    // 다음 틱(진행 중 실행이 끝난 뒤)에 기획이 만들어진다.
    scenario.store.updateRun(tick.created[0].id, { status: 'done', outcome: 'published' });
    const next = scheduler.tick();
    expect(next.created.map((run) => run.kind)).toEqual(['plan']);
  });

  it('주간 상한 3회를 넘기면 발행 슬롯을 skipped-weekly-cap으로 남긴다', () => {
    const scenario = createScenario();
    const { scheduler, config } = makeScheduler(scenario);
    const due = dueOf(scenario, config, 'publish');
    scenario.clock.set(new Date(due + 10_000));

    // 이번 주(KST 월-일)에 이미 3건 발행됨
    const weekStart = new Date(due - 24 * 60 * MINUTE);
    for (let i = 0; i < WEEKLY_HARD_CAP; i += 1) {
      const created = scenario.store.createRun({
        kind: 'publish',
        slot: `seed-${i}`,
        trigger: 'schedule',
        mode: 'manual',
        step: 'RECORD',
        startedAt: new Date(weekStart.getTime() + i * MINUTE),
      });
      scenario.store.updateRun(created.row.id, {
        status: 'done',
        outcome: 'published',
        finished_at: kstIso(new Date(due - 60 * MINUTE + i * MINUTE)),
      });
    }
    expect(scenario.store.countPublishedThisWeek(scenario.clock.now())).toBe(WEEKLY_HARD_CAP);

    const tick = scheduler.tick();
    expect(tick.created).toHaveLength(1);
    expect(tick.created[0].status).toBe('skipped');
    expect(tick.created[0].outcome).toBe('skipped-weekly-cap');
    expect(scenario.notify.messages.join(' ')).toContain('주간 상한');
  });

  it('비활성이면 슬롯 실행도 놓친 슬롯 기록도 만들지 않는다', () => {
    const scenario = createScenario();
    const { scheduler, config } = makeScheduler(scenario, { enabled: false });
    const due = dueOf(scenario, config, 'publish');
    scenario.clock.set(new Date(due + 120 * MINUTE));

    const tick = scheduler.tick();
    expect(tick.created).toHaveLength(0);
    expect(tick.missed).toHaveLength(0);
    expect(scenario.store.listRuns(10)).toHaveLength(0);
  });
});

describe('RobotScheduler — 다음 슬롯 표시', () => {
  it('nextSlots는 지터를 적용한 미래 슬롯을 순서대로 돌려준다', () => {
    const scenario = createScenario();
    const { scheduler, config } = makeScheduler(scenario, {
      slots: { plan: [{ day: 'mon', time: '21:00' }], publish: PUBLISH_SLOTS },
    });
    const next = scheduler.nextSlots(scenario.clock.now(), 3);
    expect(next.length).toBe(3);
    const times = next.map((slot) => Date.parse(slot.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[0]).toBeGreaterThanOrEqual(scenario.clock.now().getTime() - 1);

    // 계획의 publish_slot과 스케줄러가 만드는 슬롯 문자열이 같아야 계획이 슬롯에 붙는다.
    const picked = nextSlotOfKind(
      scenario.clock.now(),
      config.slots,
      config.jitterMinutes,
      'publish',
    );
    expect(picked).not.toBeNull();
    expect(next.some((slot) => slot.at === picked!.slot)).toBe(true);
  });

  it('수동 실행 슬롯은 manual- 접두사를 쓴다', () => {
    const scenario = createScenario();
    const { scheduler } = makeScheduler(scenario);
    expect(scheduler.manualSlot().startsWith('manual-')).toBe(true);
  });
});

describe('RobotScheduler — 시계 주입', () => {
  it('FakeClock은 시간을 진행시킨다', () => {
    const clock = new FakeClock(new Date('2026-09-22T21:10:00+09:00'));
    clock.advanceMs(MINUTE);
    expect(clock.now().getTime()).toBe(Date.parse('2026-09-22T21:11:00+09:00'));
  });
});

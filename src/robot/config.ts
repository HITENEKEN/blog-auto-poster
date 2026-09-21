import { getConfigManager } from '@core/config';
import { resolveApiBase } from './DashboardClient';
import { validateRobotConfig, type SlotSpec } from './policies';
import type { RunMode } from './RobotStore';

/**
 * `robot:` 설정 블록(설계 §6). 실제 값은 `config/development.yaml`(gitignore)에서 덮어쓴다.
 * 기동 시 검증(§6)에서 하나라도 어긋나면 `RobotConfigError`로 기동을 거부한다.
 */
export interface RobotImagesConfig {
  review: 'human' | 'vision' | 'drop';
}

export interface RobotAdsConfig {
  minAds: number;
  minBlocks: number;
  maxBlocks: number;
  firstAfterSection: number;
  minSectionGap: number;
  bundleSize: [number, number];
  showPrice: boolean;
}

export interface RobotConfig {
  enabled: boolean;
  mode: RunMode;
  dbPath: string;
  apiBase: string;
  categories: string[];
  slots: { plan: SlotSpec[]; publish: SlotSpec[] };
  catchUpMinutes: { plan: number; publish: number };
  jitterMinutes: number;
  approvalTimeoutMinutes: number;
  autoPromoteAfterPasses: number;
  llm: { maxCallsPerRun: number; timeoutSeconds: number };
  images: RobotImagesConfig;
  ads: RobotAdsConfig;
}

export class RobotConfigError extends Error {
  constructor(public readonly errors: string[]) {
    super(`robot 설정이 잘못되었습니다: ${errors.join(' / ')}`);
    this.name = 'RobotConfigError';
  }
}

export const ROBOT_CONFIG_DEFAULTS: RobotConfig = {
  enabled: false,
  mode: 'manual',
  dbPath: './data/robot.sqlite',
  apiBase: 'http://127.0.0.1:3002',
  categories: [],
  slots: {
    plan: [
      { day: 'mon', time: '21:00' },
      { day: 'thu', time: '21:00' },
    ],
    publish: [
      { day: 'tue', time: '21:10' },
      { day: 'sat', time: '21:10' },
    ],
  },
  catchUpMinutes: { plan: 600, publish: 110 },
  jitterMinutes: 15,
  approvalTimeoutMinutes: 120,
  autoPromoteAfterPasses: 4,
  llm: { maxCallsPerRun: 10, timeoutSeconds: 120 },
  images: { review: 'human' },
  ads: {
    minAds: 2,
    minBlocks: 2,
    maxBlocks: 4,
    firstAfterSection: 2,
    minSectionGap: 2,
    bundleSize: [2, 3],
    showPrice: false,
  },
};

type ConfigGetter = (key: string, defaultValue?: unknown) => unknown;

function pickSlotSpecs(value: unknown, fallback: SlotSpec[]): SlotSpec[] {
  if (!Array.isArray(value)) return fallback;
  const specs = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const day = String(record.day || '').toLowerCase();
      const time = String(record.time || '');
      if (!day || !/^\d{1,2}:\d{2}$/.test(time)) return null;
      return { day: day as SlotSpec['day'], time };
    })
    .filter((v): v is SlotSpec => v !== null);
  return specs.length ? specs : fallback;
}

const num = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
};

/** 설정 관리자에서 로봇 블록을 읽는다. 누락된 키는 기본값으로 채운다. */
export function resolveRobotConfig(get: ConfigGetter): RobotConfig {
  const defaults = ROBOT_CONFIG_DEFAULTS;
  const block = (get('robot') as Record<string, unknown>) || {};
  const llm = (block.llm as Record<string, unknown>) || {};
  const images = (block.images as Record<string, unknown>) || {};
  const ads = (block.ads as Record<string, unknown>) || {};
  const slots = (block.slots as Record<string, unknown>) || {};
  const catchUp = (block.catchUpMinutes as Record<string, unknown>) || {};
  const bundle = Array.isArray(ads.bundleSize) ? ads.bundleSize : defaults.ads.bundleSize;

  const review = String(images.review || defaults.images.review);
  const mode = String(block.mode || defaults.mode) === 'auto' ? 'auto' : 'manual';

  return {
    enabled: block.enabled === true,
    mode,
    dbPath: String(block.dbPath || defaults.dbPath),
    apiBase: process.env.BLOG_POSTER_ROBOT_API_BASE || String(block.apiBase || resolveApiBase()),
    categories: Array.isArray(block.categories) ? block.categories.map((c) => String(c)) : [],
    slots: {
      plan: pickSlotSpecs(slots.plan, defaults.slots.plan),
      publish: pickSlotSpecs(slots.publish, defaults.slots.publish),
    },
    catchUpMinutes: {
      plan: num(catchUp.plan, defaults.catchUpMinutes.plan),
      publish: num(catchUp.publish, defaults.catchUpMinutes.publish),
    },
    jitterMinutes: num(block.jitterMinutes, defaults.jitterMinutes),
    approvalTimeoutMinutes: num(block.approvalTimeoutMinutes, defaults.approvalTimeoutMinutes),
    autoPromoteAfterPasses: num(block.autoPromoteAfterPasses, defaults.autoPromoteAfterPasses),
    llm: {
      maxCallsPerRun: num(llm.maxCallsPerRun, defaults.llm.maxCallsPerRun),
      timeoutSeconds: num(llm.timeoutSeconds, defaults.llm.timeoutSeconds),
    },
    images: {
      review: review === 'vision' || review === 'drop' ? review : 'human',
    },
    ads: {
      minAds: num(ads.minAds, defaults.ads.minAds),
      minBlocks: num(ads.minBlocks, defaults.ads.minBlocks),
      maxBlocks: num(ads.maxBlocks, defaults.ads.maxBlocks),
      firstAfterSection: num(ads.firstAfterSection, defaults.ads.firstAfterSection),
      minSectionGap: num(ads.minSectionGap, defaults.ads.minSectionGap),
      bundleSize: [
        num(bundle[0], defaults.ads.bundleSize[0]),
        num(bundle[1], defaults.ads.bundleSize[1]),
      ],
      showPrice: ads.showPrice === true,
    },
  };
}

/** 프로덕션 로더 — 로드된 설정 관리자에서 읽고 검증까지 한다. */
export async function loadRobotConfig(): Promise<RobotConfig> {
  const manager = getConfigManager();
  // ConfigManager.load()는 멱등이므로 이미 로드된 경우 그대로 통과한다.
  await manager.load();
  return validateOrThrow(resolveRobotConfig((key, def) => manager.get(key, def)));
}

/** §6 검증: 실패 사유가 하나라도 있으면 기동 거부. */
export function validateOrThrow(config: RobotConfig): RobotConfig {
  const errors = validateRobotConfig({
    enabled: config.enabled,
    mode: config.mode,
    categories: config.categories,
    images: config.images,
    slots: config.slots,
    ads: config.ads,
  });
  if (errors.length) throw new RobotConfigError(errors);
  return config;
}

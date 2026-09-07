import * as fs from 'fs';
import * as path from 'path';
import type { CoupangWidgetKind, CoupangWidgetProps } from './CoupangWidgets';

/**
 * 사용자가 등록한 링크/배너 프리셋 저장소(이슈 #18).
 *
 * AI는 링크를 임의 생성하지 않고, 이 저장소에 사용자가 직접 등록한
 * 링크/배너만 본문에 배치한다(확정 방향). 드래프트가 파일 기반 저장인
 * 기존 아키텍처를 따라 JSON 파일로 저장한다.
 */

const PRESETS_FILE = path.resolve(process.cwd(), 'data', 'link-presets.json');

export interface LinkPreset {
  id: string;
  /** 관리용 이름 (예: "쿠팡 검색 위젯", "이벤트 배너") */
  label: string;
  kind: CoupangWidgetKind;
  props: CoupangWidgetProps;
  createdAt: string;
}

function ensureDataDir(): void {
  fs.mkdirSync(path.dirname(PRESETS_FILE), { recursive: true });
}

/** 프리셋 목록을 로드한다. 파일이 없으면 빈 배열. */
export function loadLinkPresets(filePath: string = PRESETS_FILE): LinkPreset[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is LinkPreset =>
        p != null &&
        typeof p === 'object' &&
        typeof (p as LinkPreset).id === 'string' &&
        typeof (p as LinkPreset).kind === 'string' &&
        (p as LinkPreset).props != null,
    );
  } catch {
    return [];
  }
}

/** 프리셋 목록을 저장한다. */
export function saveLinkPresets(presets: LinkPreset[], filePath: string = PRESETS_FILE): void {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(presets, null, 2));
}

/** 새 프리셋을 추가한다(id 자동 생성). */
export function addLinkPreset(
  input: { label: string; kind: CoupangWidgetKind; props: CoupangWidgetProps },
  filePath: string = PRESETS_FILE,
): LinkPreset {
  const presets = loadLinkPresets(filePath);
  const preset: LinkPreset = {
    id: `preset-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    label: input.label.trim() || input.kind,
    kind: input.kind,
    props: input.props,
    createdAt: new Date().toISOString(),
  };
  presets.push(preset);
  saveLinkPresets(presets, filePath);
  return preset;
}

/** 프리셋을 삭제한다. 삭제되면 true. */
export function deleteLinkPreset(id: string, filePath: string = PRESETS_FILE): boolean {
  const presets = loadLinkPresets(filePath);
  const next = presets.filter((p) => p.id !== id);
  if (next.length === presets.length) return false;
  saveLinkPresets(next, filePath);
  return true;
}

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '@core/logger';

const logger = getLogger('robot');

/**
 * 증거 패킷(스킬 §10, 설계 §2-3).
 *
 * ```
 * data/ops/runs/<runId>/
 *   run.json report.md live/ keyword/ draft/ publish/ verify/
 *   robot/steps.json     ← robot_steps 덤프
 *   ads/placement.json   ← 슬롯·상품·게이트 결과
 * ```
 *
 * `data/ops/publish-log.jsonl`에 **1줄** 추가한다(append-only). 같은 runId가 이미 있으면
 * 다시 쓰지 않는다(재시도·재기동 멱등). `rulesHash` 필드는 `codeVersion`(커밋 해시)으로
 * 대체한다 — 규칙이 코드로 옮겨 왔기 때문이다(설계 §2-3).
 *
 * 증거는 `/tmp`가 아니라 레포 하위에 남긴다(재부팅 시 소실 방지).
 */

export const PUBLISH_LOG_FILE = 'publish-log.jsonl';

export interface PublishLogEntry {
  runId: string;
  codeVersion: string | null;
  keyword: string | null;
  keywordDecision?: Record<string, unknown> | null;
  draftId: string | null;
  content?: Record<string, unknown>;
  images?: Record<string, unknown>;
  publish: Record<string, unknown>;
  verification?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  outcome: string;
  unresolved: string[];
}

export class EvidenceWriter {
  readonly dir: string;
  private readonly opsRoot: string;

  constructor(runId: string, opsRoot: string = path.resolve(process.cwd(), 'data', 'ops')) {
    this.opsRoot = opsRoot;
    this.dir = path.join(opsRoot, 'runs', runId);
  }

  static forRun(runId: string, opsRoot?: string): EvidenceWriter {
    return new EvidenceWriter(runId, opsRoot);
  }

  get publishLogPath(): string {
    return path.join(this.opsRoot, PUBLISH_LOG_FILE);
  }

  pathIn(relative: string): string {
    return path.join(this.dir, relative);
  }

  ensure(...subdirs: string[]): void {
    for (const dir of [this.dir, ...subdirs.map((s) => path.join(this.dir, s))]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  writeText(relative: string, content: string): string {
    const target = this.pathIn(relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
    return target;
  }

  writeJson(relative: string, value: unknown): string {
    return this.writeText(relative, `${JSON.stringify(value, null, 2)}\n`);
  }

  readText(relative: string): string | null {
    const target = this.pathIn(relative);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null;
  }

  exists(relative: string): boolean {
    return fs.existsSync(this.pathIn(relative));
  }

  /** 스킬 §10의 고정 하위 구조를 만든다. */
  init(): void {
    this.ensure('live', 'keyword', 'draft', 'publish', 'verify', 'robot', 'ads');
  }

  /** 이미 기록된 runId 집합(멱등 판정). */
  loggedRunIds(): Set<string> {
    if (!fs.existsSync(this.publishLogPath)) return new Set();
    const ids = new Set<string>();
    for (const line of fs.readFileSync(this.publishLogPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { runId?: string };
        if (parsed.runId) ids.add(parsed.runId);
      } catch {
        // 손상된 줄은 건너뛴다 — 기존 이력을 지우지 않는다.
      }
    }
    return ids;
  }

  /** `publish-log.jsonl`에 1줄 추가. 이미 있으면 false(추가하지 않음). */
  appendPublishLog(entry: PublishLogEntry): boolean {
    const logged = this.loggedRunIds();
    if (logged.has(entry.runId)) {
      logger.debug({ runId: entry.runId }, 'publish-log 항목이 이미 있습니다');
      return false;
    }
    fs.mkdirSync(path.dirname(this.publishLogPath), { recursive: true });
    fs.appendFileSync(this.publishLogPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    return true;
  }

  /** publish-log 전체(검증·테스트용). */
  readPublishLog(): PublishLogEntry[] {
    if (!fs.existsSync(this.publishLogPath)) return [];
    const entries: PublishLogEntry[] = [];
    for (const line of fs.readFileSync(this.publishLogPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as PublishLogEntry);
      } catch {
        // 무시
      }
    }
    return entries;
  }

  /** 한국어 운영 보고(스킬 §10 `report.md`). */
  writeReport(lines: string[]): string {
    return this.writeText('report.md', `${lines.join('\n')}\n`);
  }
}

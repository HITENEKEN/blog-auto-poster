/* eslint-disable no-console -- 일회성 진단 스크립트 */
/**
 * R5 Gemini 이미지 생성 실스모크 (일회성 검증 스크립트).
 * 실행: npx ts-node -r tsconfig-paths/register scripts/smoke-gemini-image.ts
 * 성공 시 output/images/ 에 실제 이미지 파일이 저장된다.
 */
import { getConfigManager } from '../src/core/config';
import { GeminiProvider, DEFAULT_GEMINI_IMAGE_MODEL } from '../src/content/ImageGenerator';
import * as fs from 'fs';
import * as path from 'path';

async function main(): Promise<void> {
  const cm = getConfigManager('config', process.env.NODE_ENV || 'development');
  await cm.load();
  const cfg = (cm.get('imageProviders.gemini') as Record<string, unknown>) || {};
  const apiKey = String(cfg.apiKey || '').trim();
  const configuredModel = String(cfg.model || '').trim();
  console.log(
    `apiKey present: ${!!apiKey} (len=${apiKey.length}), configured model: ${configuredModel}`,
  );

  if (!apiKey) {
    console.error('FAIL: no gemini apiKey in config');
    process.exit(1);
  }
  const candidates = [
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite-image',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image',
    configuredModel || DEFAULT_GEMINI_IMAGE_MODEL,
  ];

  const prompt =
    '무선 이어폰 충전 케이스를 나무 책상 위에 올려둔 실사 사진. 한국 쇼핑 블로그용, 밝은 자연광, 깔끔한 배경, 고해상도, 텍스트 없음.';

  for (const model of candidates) {
    const provider = new GeminiProvider({ apiKey, model, timeoutMs: 90_000 });
    const started = Date.now();
    try {
      const result = await provider.generate(prompt, { count: 1 });
      const dataUrl = result.urls[0] || '';
      const base64 = dataUrl.split(',')[1] || '';
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length < 1000) {
        throw new Error(`suspiciously small image: ${bytes.length} bytes`);
      }
      const ext = dataUrl.startsWith('data:image/jpeg') ? '.jpg' : '.png';
      const outPath = path.resolve(
        'output/images',
        `smoke_${model.replace(/[^a-z0-9.-]/gi, '_')}${ext}`,
      );
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, bytes);
      console.log(
        `SUCCESS model=${model} bytes=${bytes.length} file=${outPath} elapsed=${Date.now() - started}ms`,
      );
      process.exit(0);
    } catch (error) {
      console.log(
        `FAIL model=${model} elapsed=${Date.now() - started}ms error=${String(error).slice(0, 300)}`,
      );
    }
  }
  console.error('FAIL: all candidate models failed');
  process.exit(1);
}

main();

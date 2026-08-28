# Technical Fix Plan — blog-auto-poster (6 points)

> Scope: investigation + planning only. No code is implemented here. All proposals are grounded in the files/symbols cited below. Follow-up implementation should be done per-point, in dependency order (see §7).

## Repository facts established during research

- Web server entry: `scripts/start-web.js` → `dist/web/server` (`startWebServer`). Started with `env = process.env.NODE_ENV || 'development'`, `configDir = process.env.BLOG_POSTER_CONFIG_DIR || './config'`. So the active config file is `config/<env>.yaml` (= `config/development.yaml` if `NODE_ENV` unset), merged over `config/default.yaml` + `config/secrets.yaml` (see `src/core/config.ts:108-131`).
- Server is compiled by `npm run build` (= `tsc`, emits `dist/`). SPA is built in `src/web/client` via `npm run build` (writes `src/web/client/dist`), and served by `@fastify/static` from `src/web/client/dist` (`src/web/server/index.ts:106-109`).
- Platform registry (`src/platforms/registry.ts`) only knows `tistory`, `wordpress`, `youtube-shorts`. There is **no** `naver` / `naver-blog` adapter, yet all four templates declare `platforms: ["naver-blog", ...]` in their front-matter (`templates/*.hbs`).
- Auth is a single hardcoded admin check in `src/web/server/middleware/auth.ts` (`/api/auth/login` compares against `BLOG_POSTER_WEB_ADMIN_USERNAME`/`BLOG_POSTER_WEB_ADMIN_PASSWORD` env or defaults `admin`/`changeme`). JWT signed with `webConfig.jwtSecret` (`src/web/server/index.ts:101-104`).
- The `ConfigManager` (`src/core/config.ts`) supports in-memory `get/set/getAll` and `getPlatformConfig` etc., but has **no `save()`** method — settings cannot be written back to disk. There is **no** `GET`/`PUT /api/config` route; `src/web/client/src/pages/Settings.tsx` only reads/writes `localStorage` (`handleSave` at lines 65-76), so it never touches the server.
- Keyword data today comes from `src/intelligence/NaverApiHubProvider.ts` (`research()` + `searchBlog()`), reached via `/api/keywords/trending?q=<query>` and `/api/keywords/research`. A query (`q`) is **required** — there is no query-less "top keywords" feed. `Keywords.tsx` calls `/api/keywords/trending` with a user-typed `q`.
- Blog list endpoint `/api/blogs` iterates `platformRegistry.getInitializedAdapters()` only (`src/web/server/routes/index.ts:62-97`). At startup no platforms are enabled by default (`config/default.yaml` has all `platforms.*.enabled: false`), so the registry is empty and the Blogs tab always renders the empty state ("연동된 블로그가 없습니다", `Blogs.tsx:66-76`).
- Content pipeline: `PostAssembler.assemble()` (`src/content/PostAssembler.ts:41`) builds `templateData` via `prepareTemplateData(...)` then `templateEngine.render(template, templateData)`. Benchmark/competitor posts are **not** currently fed into templates.

---

## 1. Remove all login restrictions for local test (dev-only auth bypass)

### (a) Current behavior

`authMiddleware` (`src/web/server/middleware/auth.ts`) registers a `preHandler` hook that calls `request.jwtVerify()` on every non-public route and returns 401 on failure. Login at lines 44-67 checks a hardcoded username/password (defaults `admin`/`changeme`, overridable by env). There is no way to open login without knowing the password.

### (b) What's wrong / root cause

For local testing the user must enter credentials; there is no opt-out. The fix must be a **strictly opt-in** bypass that is off by default so production stays secure.

### (c) Proposed change

1. **Config flag + env.** Add under `web` in `config/default.yaml`:
   ```yaml
   web:
     # ...existing...
     auth:
       disabled: false # NEVER enable in production
   ```
   Add an env mapping in `src/core/config.ts` `applyEnvOverrides()` (mirror existing `envMappings` at lines 143-154):
   ```ts
   [`${this.envPrefix}WEB_AUTH_DISABLED`]: (v) => { this.config.web.auth.disabled = v === 'true'; },
   ```
   (Also accept `BLOG_POSTER_WEB_AUTH_DISABLED` — note the existing prefix is `BLOG_POSTER_`, so the var is `BLOG_POSTER_WEB_AUTH_DISABLED`.)
2. **Plumb the flag into auth.** Change `authMiddleware` signature to receive options:
   - `src/web/server/index.ts:130` → `await app.register(authMiddleware, { configManager });`
   - `src/web/server/middleware/auth.ts:21` → `export async function authMiddleware(app: FastifyInstance, opts: { configManager?: ConfigManager }): Promise<void>`
   - Compute `const authDisabled = process.env.BLOG_POSTER_WEB_AUTH_DISABLED === 'true' || opts?.configManager?.get('web.auth.disabled') === true;`
3. **Hook short-circuit.** In the `preHandler` hook (lines 28-41), if `authDisabled`, set `request.user = { userId: '1', username: 'local-admin', role: 'admin' }` and `return;` before `jwtVerify()`. This makes every protected route reachable without a token.
4. **Login still issues a token** (lines 44-67): when `authDisabled`, accept any `username`/`password` (or empty) and sign an admin JWT as today, so the client's `localStorage` token + refresh logic keeps working. Keep the normal branch for when the flag is off.
5. **Keep `isPublicRoute`** (lines 90-99) unchanged; refresh still works because `/api/auth/refresh` is public.

### (d) Acceptance criteria

- With `BLOG_POSTER_WEB_AUTH_DISABLED=true` (or `web.auth.disabled: true`), any credentials (or none) log in and issue an admin JWT; all `/api/*` routes are callable without a valid token.
- With the flag unset/false, behavior is identical to today (hardcoded admin, 401 on bad token). Production cannot be opened accidentally.

### (e) Risks / notes

- The bypass must be explicitly enabled; the plan forbids enabling it in `config/default.yaml` for production and recommends a deploy-time guard (e.g. refuse to boot with `auth.disabled` when `web.host` is not localhost, or log a loud warning).
- `requireRole` (`auth.ts:102-112`) still works because we set `role: 'admin'`.

---

## 2. Provide Top 20 blog keywords

### (a) Current behavior

`Keywords.tsx` (lines 67-87) calls `GET /api/keywords/trending?q=<query>&limit=N`. The server (`routes/index.ts:147-183`) requires `q`, builds a `NaverApiHubKeywordProvider` from `naver-api-hub` config, runs `research([q])` (returns `KeywordData[]` with `volume`, `competition`, `trend`, `related`) and `searchBlog(q)` for competitor posts. Results are shown ranked by `volume*(1-competition)` (`Keywords.tsx:89-91`). There is **no query-less top-20 feed** and nothing auto-loads on page open.

### (b) What's wrong / root cause (ambiguity — see OPEN QUESTIONS)

The user wants a "Top 20 blog keywords" surfaced. Interpreted default: a dedicated **Top-20 keyword list that loads without requiring the user to type a query**, sourced from the existing Naver API Hub researcher over a set of seed/category keywords. The data source (`NaverApiHubProvider.research`) and ranking formula already exist; only the query-less aggregation + UI surface are missing.

### (c) Proposed change

1. **New endpoint** `GET /api/keywords/top` in `src/web/server/routes/index.ts` (near the existing keyword routes, ~line 183):
   - Accept optional `?seeds=a,b,c&limit=20`. If `seeds` omitted, default to a configured seed list.
   - Recommended new config block in `config/default.yaml`:
     ```yaml
     keywords:
       topSeeds: ['무선청소기', '로봇청소기', '공기청정기', '가습기'] # mirrors scheduler seedKeywords
     ```
     (Reuse the scheduler job seed list at `default.yaml:101-103` if simpler; flag which you pick.)
   - For each seed call `NaverApiHubKeywordProvider.research([seed], { limit })` (reuse the provider construction already at lines 154-160/226-232), flatten, de-dupe by `keyword`, sort by `volume*(1-competition)` (same formula as line 256), return top `limit` (=20) as `{ keywords: KeywordData[], source: 'naver-api-hub' }`.
2. **UI surface** in `src/web/client/src/pages/Keywords.tsx`:
   - Add a state `topKeywords` and a `useEffect` that fetches `/api/keywords/top?limit=20` on mount (no user query needed).
   - Render a new card "📊 블로그 키워드 TOP 20" (reuse the existing table markup at lines 145-186) above/below the manual-search results, showing rank, keyword, volume, competition, trend, top related. Keep the existing manual search intact.
3. Optionally surface the same Top-20 on the Dashboard (`src/web/client/src/pages/Dashboard.tsx` if present) — out of scope unless desired.

### (d) Acceptance criteria

- Opening the Keywords page immediately shows a Top-20 keyword table without typing anything.
- Each row is a real `KeywordData` from Naver API Hub ranked by `volume*(1-competition)`; "TOP 20" is honored (`limit=20`).
- Manual search (existing) continues to work.

### (e) Risks / notes

- Requires `naver-api-hub` credentials (present in `config/secrets.yaml` today) — without them the endpoint returns an empty list + `error` (mirror lines 155-157).
- If the user instead meant "top 20 _competitor blog posts_ for a query", the existing `/api/keywords/:keyword/blogs` (lines 185-213) already returns blogs; in that case the UI change is just a "TOP 20 블로그" card. **Confirm intent (OPEN QUESTION Q1).**

---

## 3. Blogs tab does not work

### (a) Current behavior

`Blogs.tsx` fetches `GET /api/blogs` (`fetchBlogs`, lines 20-29) and renders `blogs`. The endpoint (`routes/index.ts:62-97`) iterates `platformRegistry.getInitializedAdapters()`.

### (b) What's wrong / root cause

The registry is populated only for platforms with `enabled: true` at startup (`src/web/server/index.ts:47-57`; all default to `false`). So `/api/blogs` returns `{ blogs: [] }` and the UI always shows the empty state. There is **no UI to create/enable a platform** (no "add blog" button; `Blogs.tsx` only links to `/settings`), and `Settings.tsx` doesn't persist anything (see §6). Net effect: you can never make the Blogs tab show a blog. (The earlier 500 was fixed by switching to `getInitializedAdapters()`; the _remaining_ breakage is the empty-registry + no-configure-flow problem, not a server crash.)

### (c) Proposed change

This point is **gated on §5 (Naver config + adapter) and §6 (Settings persistence)**. Additionally:

1. **Make `/api/blogs` reflect configured platforms, not just live instances.** Change `routes/index.ts:62-97` to iterate over the union of (a) `configManager`'s platform configs (`appConfig.platforms`) and (b) `platformRegistry.getAvailableAdapters()` (registry.ts:82). For each known platform name, show `connected` via `validateCredentials()` only when a config + adapter exist; otherwise `connected:false` with the config present. This makes the tab populate as soon as a platform is configured, even before a server restart re-initializes the adapter.
2. **Add an entry point in `Blogs.tsx`.** Add a "블로그 연동 추가/관리" button (top-right, next to the title at lines 59-64) that navigates to `/settings` (platforms tab) or, preferably, an inline "연동 추가" form. The empty state (lines 66-76) should also link to the new add flow.
3. After §5/§6 land, enabling a platform in Settings and saving persists to config; on next server start the adapter initializes and `/api/blogs` shows it connected. For zero-restart pickup, optionally call `platformRegistry.initialize(name, config)` inside the config `PUT` handler (§6) — recommended so Blogs updates without a restart.

### (d) Acceptance criteria

- After configuring ≥1 platform in Settings and saving, the Blogs tab lists that platform with correct connection status and categories (or a clear "연결 안됨" with reason).
- "Add/enable blog" is reachable from the Blogs tab.

### (e) Risks / notes

- Do **not** broaden `/api/blogs` error handling in a way that hides real initialization failures; keep the per-platform `try/catch` already at lines 70-76.
- Categories come from `adapter.getCategories()` (lines 71) — only meaningful once an adapter with credentials exists.

---

## 4. Rewrite blog templates to detailed, first-person "my experience" tone, benchmarking top posts

### (a) Current behavior

Four Handlebars templates in `templates/`: `coupang-product-review.hbs`, `coupang-buying-guide.hbs`, `coupang-comparison-guide.hbs`, `coupang-partner-review.hbs`. They are structured but generic/third-person marketing copy (e.g. product-review `상세 리뷰` section, `구매 가이드`). Benchmark/competitor posts are never injected.

### (b) What's wrong / root cause

Tone is impersonal; the user wants longer, first-person experience writing ("내가 직접 써본 후기") that mirrors the style/structure of top-ranking Naver blog posts. The competitor-fetch capability already exists (`NaverApiHubProvider.searchBlog`) but is never passed into the template data.

### (c) Proposed change (data flow + template rewrite)

**Data flow (wire benchmark posts into templates):**

1. In `src/content/PostAssembler.ts`, extend `AssembleOptions` with `benchmarkKeyword?: string` (default: derive from `affiliateData.name`/`categoryName`). In `prepareTemplateData` (line 52), lazily import `NaverApiHubProvider` (`src/intelligence/NaverApiHubProvider.ts`) and, when a benchmark keyword is available, call `provider.searchBlog(keyword, 10)`; map results to `topPosts: { title, bloggername, link, snippet }` and add to `templateData`. Guard with `try/catch` (network failure must not break post assembly).
2. Add `benchmarkPosts`/`topPosts` plus new optional narrative fields (`experienceIntro`, `realUsageStory`, `whyIChoseIt`) to the template `optionalFields` lists and to `TemplateData` usage. Because they are **optional**, existing generation (CLI/preview) keeps working when absent.

**Template rewrite (the 4 files):**

- Convert the lead and `상세 리뷰`/`고르는 법` sections to first-person Korean ("제가 직접 ~를 써보니", "솔직히 말씀드리면"). Lengthen with a personal narrative block.
- Add a new optional section that references benchmark posts, e.g.:
  ```hbs
  {{#if topPosts}}
    <section class='benchmarks'>
      <h2>다른 분들은 이렇게 쓰셨더라고요</h2>
      <ul>
        {{#each topPosts}}
          <li><a href='{{this.link}}' target='_blank' rel='noopener'>{{this.title}}</a>
            —
            {{this.bloggername}}</li>
        {{/each}}
      </ul>
      <p>상위 블로그들을 벤치마킹해 보니 공통적으로 강조하는 포인트는 … 였습니다. 저도 써보고 나서
        그 말에 충분히 공감했습니다.</p>
    </section>
  {{/if}}
  ```
- Keep all existing Handlebars helpers (`formatPrice`, `renderStars`, `seoKeywords`, etc. registered in `TemplateEngine.ts:41-129`) and the front-matter `requiredFields`/`seo`/`jsonLd` intact. Only add new `optionalFields` and lengthen copy; do **not** change `requiredFields` (would break validation in `TemplateEngine.validateTemplate`).
- Mirror the rewrite across all four templates for consistency; the buying-guide/comparison templates get a first-person "제가 ~를 골라본 경험" intro.

**Rendering/verify path:** the `/api/templates/:name/preview` route (`routes/index.ts:557-627`) compiles templates with sample data — extend its `defaults` (lines 569-608) with `topPosts`, `experienceIntro`, etc. so the preview exercises the new sections.

### (d) Acceptance criteria

- All four templates render longer, first-person copy; when `topPosts` is supplied they include the benchmark section.
- `TemplateEngine.validateTemplate` still passes (requiredFields unchanged); preview route renders without error.
- No change to the data contract for callers that don't supply the new optional fields.

### (e) Risks / notes

- "Benchmarking top blog posts" here means _structurally referencing_ top posts (titles/links/snippets) for tone alignment, not copying content (avoid plagiarism/SEO penalty). Recommend a note in the template or generator that benchmark text is inspiration only.
- Real LLM-driven tone rewriting would live in the content generator, not the static template; this plan keeps the template as the expression layer and feeds it benchmark context. If the user wants the _generator_ to paraphrase top posts, that's a larger §content change — flag as follow-up.

---

## 5. No field to specify which Naver blog ID to post to

### (a) Current behavior

`config/default.yaml` `platforms` defines `tistory`, `wordpress`, `youtube-shorts` — **no `naver`**. The registry (`src/platforms/registry.ts:14-16`) has no Naver adapter. Yet templates list `naver-blog` as a target platform. `Settings.tsx` platforms tab (lines 167-182) only renders `tistory`/`wordpress`/`youtube`. There is nowhere to enter a Naver blog ID.

### (b) What's wrong / root cause

Missing (i) a `naver` platform config schema incl. a `blogId` field, (ii) a UI input, and (iii) an adapter that consumes `blogId`. The user's immediate need is the **input + persistence**; the actual Naver posting adapter is a separate, larger piece (Naver blog write requires Naver OpenAPI app registration).

### (c) Proposed change

1. **Config schema.** Add to `config/default.yaml` `platforms`:
   ```yaml
   naver:
     enabled: false
     blogId: '' # Naver blog ID to post to (e.g. your-naver-blog)
     username: '' # Set via BLOG_POSTER_PLATFORMS_NAVER_USERNAME
     password: '' # Set via BLOG_POSTER_PLATFORMS_NAVER_PASSWORD
     clientId: '' # Naver OpenAPI (blog write) client id
     clientSecret: ''
     rateLimit:
       requestsPerMinute: 30
   ```
   Add env overrides in `src/core/config.ts` `applyPlatformEnvOverrides()` (lines 201-231) for `naver` (`blogId`, `username`, `password`, `clientId`, `clientSecret`).
2. **UI input.** In `src/web/client/src/pages/Settings.tsx` platforms tab (lines 167-182), add a `naver` card (mirror the tistory/wordpress rendering) including a `blogId` `Input` (label "네이버 블로그 ID"). This requires the `SettingsData.platforms` interface (lines 19-23) to gain a `naver: { blogId; username; password; clientId; clientSecret }` shape and `defaultSettings` (lines 39-43) to include it. Persisted via the §6 config PUT.
3. **Adapter (skeleton, flagged).** Add `src/platforms/naver/NaverAdapter.ts` implementing `PlatformAdapter` (interface in `src/core/interfaces.ts`), at minimum `getCategories()` (return [] or Naver categories), `validateCredentials()` (check `blogId` + credentials present), and a `publishPost()` that is clearly a scaffold (`throw new Error('Naver publish not yet implemented')` or a TODO with a real OpenAPI call stub). Register it in `src/platforms/registry.ts:14-16` via `adapterRegistry.set('naver', NaverAdapter)`. This makes `naver` appear in `getAvailableAdapters()` so §3's improved `/api/blogs` lists it. **The full posting implementation is recommended as a separate follow-up** (OPEN QUESTION Q2).
4. **Consumption point.** When the Naver adapter is completed, `blogId` is read via `configManager.getPlatformConfig('naver').blogId` inside the adapter (mirror how TistoryAdapter reads its config in `src/platforms/tistory/TistoryAdapter.ts`).

### (d) Acceptance criteria

- Settings → platforms shows a Naver section with a "네이버 블로그 ID" field; saving persists `platforms.naver.blogId` to config (verifiable via `GET /api/config` after §6).
- `naver` appears in `platformRegistry.getAvailableAdapters()` (after skeleton registered).
- (Full posting is a follow-up; not required for this ticket's acceptance unless Q2 says otherwise.)

### (e) Risks / notes

- Do not silently break the templates' `platforms: ["naver-blog", ...]` — either rename the template platform key to `naver` to match the new adapter name, or keep `naver-blog` and register the adapter under `naver-blog`. **Recommend registering the adapter as `naver` and updating the four templates' front-matter `platforms` arrays to use `naver`** for consistency. This is a trivial front-matter edit, call it out during implementation.
- Naver blog write API requires an approved Naver Developers application (blog write scope). Real posting cannot be tested without those credentials — hence the scaffold recommendation.

---

## 6. Settings page does not work

### (a) Current behavior

`Settings.tsx` `handleSave` (lines 65-76) writes only to `localStorage` (`blog-poster-settings`) and toasts success. There is **no GET** to load server config and **no PUT** to persist it (the only config-writing route is `PUT /api/scheduler/config` at `routes/index.ts:425-435`, which writes only `scheduler`). So nothing the user edits affects the running system → "doesn't work."

### (b) What's wrong / root cause

Settings is a UI-only stub with no backend binding. Two gaps: (1) no `GET /api/config` to hydrate the form, (2) no `PUT /api/config` to persist + no `ConfigManager.save()`.

### (c) Proposed change

1. **`ConfigManager.save()`** in `src/core/config.ts`: add
   ```ts
   async save(): Promise<void> {
     const yamlStr = yaml.dump(this.config, { skipInvalid: true });
     fs.writeFileSync(this.configPath, yamlStr, 'utf-8');
   }
   ```
   (`configPath` = `config/<env>.yaml`; created on first save. Note `this.config` is the merged config, so secrets from `secrets.yaml` would be written here too — acceptable for local test; see note.)
2. **`GET /api/config`** in `routes/index.ts` (add near top, ~line 21): return `configManager.getAll()` with secret-like fields masked to `'***'` (reuse the masking approach from `/api/blogs` line 92: `password`, `appPassword`, `apiKey`, `apiSecret`, `clientSecret`, `refreshToken`, `accessToken`). Exclude raw `keywordProviders` secrets if desired.
3. **`PUT /api/config`** in `routes/index.ts`:
   ```ts
   app.put('/api/config', async (request) => {
     const body = request.body as Record<string, any>;
     // Merge, skipping '***' sentinels so masked GET values aren't written back
     const merge = (target: any, src: any) => {
       /* deep merge, skip '***' strings */
     };
     merge(this.config /* via configManager */, body);
     configManager.save?.(); // or configManager.set per-section
     return { success: true };
   });
   ```
   Because `GET` masks secrets to `'***'`, the client would otherwise echo `'***'` back and wipe real secrets — so the merge **skips any string strictly equal to `'***'`** (keeps the server's existing value). This makes PUT safe for partial edits.
4. **Wire `Settings.tsx`:** replace `localStorage` usage with API calls.
   - On mount (`useEffect`, lines 57-63): `GET /api/config` → map server config into `SettingsData` (map `platforms.tistory/blogName`, `platforms.naver.blogId`, `affiliates.coupang.apiKey`, etc.). Keep `defaultSettings` as fallback when a section is absent.
   - `handleSave(section)` (lines 65-76): `PUT /api/config` with the changed section payload; on success `toast` as today. Remove the `localStorage` write (or keep as optimistic cache only).
   - Add the `naver` fields from §5 to the interface/defaults so the Naver card saves.
5. After a successful save of `platforms`, optionally call `platformRegistry.initialize(name, config)` for each enabled platform so changes take effect without a full restart (supports §3).

### (d) Acceptance criteria

- Opening Settings shows the **server's** current config (not blank defaults).
- Editing any field and saving persists to `config/<env>.yaml` (verify by `GET /api/config` or reading the file); a server restart reflects the change.
- Secrets masked on read are never overwritten with `'***'` on save.

### (e) Risks / notes

- Writing the merged config to `<env>.yaml` will duplicate secrets (from `secrets.yaml`) into that file. For a local-test setup this is fine; document it. If stricter separation is wanted, exclude `keywordProviders`/secret blobs from the PUT payload on the client side.
- `ConfigManager.save()` writes synchronously; fine for low-frequency Settings saves. Wrap in try/catch and surface errors as a toast.

---

## 7. Implementation order & verification

**Recommended order (dependencies):**

1. §1 auth bypass (standalone, unblocks manual testing of everything else).
2. §6 Settings GET/PUT + `ConfigManager.save()` (unblocks persistence).
3. §5 Naver config schema + UI field + adapter skeleton (unblocks Blogs population).
4. §3 Blogs tab (`/api/blogs` over configured platforms + add entry point).
5. §2 Top-20 keywords endpoint + UI.
6. §4 Template rewrite + benchmark data flow.

**Build / restart steps (every server OR client change):**

- Server (TS): `npm run build` at repo root → `tsc` emits `dist/`.
- Client (React): `cd src/web/client && npm run build` → writes `src/web/client/dist`.
- Restart: `pm2 restart blog-auto-poster-web` (process is PM2-managed, port 3002). For config-driven changes that should apply at startup (platform init), a restart is required unless you also call `platformRegistry.initialize` in the PUT handler (recommended in §3/§6).

**How to verify (note pre-existing client type errors):**

- The client `build` script is `tsc && vite build`; the repo has pre-existing _unrelated_ client type errors but `tsc` still emits (and `vite build` produces the SPA). Do not treat those unrelated errors as regressions. Server `npm run build` = `tsc` and emits `dist/` even with the `@ts-nocheck` files present.
- §1: set `BLOG_POSTER_WEB_AUTH_DISABLED=true`, rebuild+restart, confirm login with empty creds succeeds and `/api/blogs` is callable without a token.
- §6: `GET /api/config` returns masked config; `PUT /api/config` then `GET` reflects the change; file `config/<env>.yaml` updated.
- §5: Settings shows Naver `blogId`; after save, `GET /api/config` includes `platforms.naver.blogId`.
- §3: after enabling a platform via Settings, Blogs tab lists it (with or without restart depending on §6 init call).
- §2: Keywords page loads a Top-20 table on open.
- §4: `/api/templates/:name/preview` renders the rewritten template with the extended sample data (incl. `topPosts`).

---

## OPEN QUESTIONS / ambiguities (user to confirm)

- **Q1 (§2):** "블로그 키워드 TOP 20" — do you mean (A) a query-less Top-20 keyword list aggregated from seed keywords via Naver API Hub (my default plan), or (B) Top-20 _competitor blog posts_ for a given query (the `/api/keywords/:keyword/blogs` data already exists; only UI surfacing needed)? Plan assumes (A).
- **Q2 (§5):** Should this ticket include a **fully working Naver blog posting adapter** (requires a Naver Developers app with blog-write scope + real credentials, not testable here), or is the **config schema + UI field + persistence + adapter skeleton** sufficient for now, with real posting as a separate follow-up? Plan assumes the latter (scaffold), to keep scope minimal.
- **Q3 (§4):** "벤치마킹" — is structurally referencing top posts (titles/links/snippets for tone) enough, or do you want the **content generator** to paraphrase/rewrite top posts with an LLM? Plan covers template-level referencing only; LLM paraphrasing is a larger §content change.
- **Q4 (§1):** Confirm the bypass env var name `BLOG_POSTER_WEB_AUTH_DISABLED` (matches existing `BLOG_POSTER_` prefix) and that it must stay **off in production** — plan enforces this.
- **Q5 (§6):** Is it acceptable that saving Settings writes the merged config (including secrets from `secrets.yaml`) into `config/<env>.yaml`? If not, we'll exclude secret blobs from the client PUT payload.

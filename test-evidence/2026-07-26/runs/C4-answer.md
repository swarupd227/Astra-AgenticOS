I'll start by orienting myself across the codebase and loading the mandatory standards simultaneously.Good. Now let me read the `package.json` for the framework version and scripts, then scan for the Angular entry point, routing, and module markers simultaneously.Interesting — no `@NgModule`. This is a standalone Angular 21 app. Let me search for the app config, bootstrap, and routing with Angular standalone patterns.Now let me read the key structural files in parallel — main, app config/routes, app component, and the core auth/layout:Now let me gather the templates, services, and profile feature:I now have a comprehensive picture. Let me compose and save the full architecture report.Here is a full summary of what I found. The artifact is saved; here are the most important things to act on.

---

## What I mapped

**Angular 21.2.12, fully standalone, zoneless.** No `@NgModule` anywhere. Bootstrap is `bootstrapApplication` in `main.ts`. Every route is lazy-loaded via `loadComponent` / `loadChildren`. Six root-singleton services, three functional HTTP interceptors, and `signal()` / `BehaviorSubject` for state.

### Component tree (depth-4 maximum)
```
AppComponent
├── HeaderComponent          ← reads UserService.authState$ / currentUser$
├── <router-outlet>
│   ├── HomeComponent → ArticleListComponent → ArticlePreviewComponent
│   │                                             ├── ArticleMetaComponent
│   │                                             └── FavoriteButtonComponent
│   ├── AuthComponent
│   ├── SettingsComponent
│   ├── ProfileComponent → FollowButtonComponent + <router-outlet>
│   ├── EditorComponent
│   └── ArticleComponent → ArticleMetaComponent, FollowButton, FavoriteButton, ArticleCommentComponent ×N
└── FooterComponent
```

---

## Top things a reviewer must confirm before it ships

### 🔴 Security — GLD-STD-001@1 (Mandatory)

| # | Issue | Location |
|---|---|---|
| **S-1** | `window.__conduit_debug__` exposes the raw JWT and auth state unconditionally — **in every build, including production**. This is a `GLD-STD-001@1 §2` violation. Must be removed or gated behind `isDevMode()`. | `app.config.ts:40` |
| **S-2** | The API base URL `https://api.realworld.show/api` is **hard-coded in source**. There is no `environment.ts` or build-time injection. Violates 12-factor config and `GLD-STD-001@1 §2.1`. | `api.interceptor.ts:4` |
| **S-3** | Confirm `DomSanitizer.sanitize(SecurityContext.HTML, …)` remains the only path for markdown-to-HTML and `bypassSecurityTrust*` is never introduced. | `markdown.pipe.ts:12` |

### 🟠 Accessibility — No `aria-*` or `<label>` exists anywhere in the codebase

- **All form inputs** across Auth, Settings, Editor, and the comment form rely on `placeholder` only — `placeholder` disappears on typing and is not a substitute for a `<label>`. This affects every interactive screen. `(auth.component.html:20-46, settings.component.html:12-59, editor.component.html:10-47, article.component.html:98-103)`
- **Two clickable `<i>` icons** — tag removal in the editor (`editor.component.html:51`) and comment deletion (`article-comment.component.ts:33`) — are not buttons, are not keyboard-reachable, and have no accessible label. Users who navigate by keyboard or screen reader cannot perform these actions.
- **All user avatar `<img>` elements** lack `alt` text (5 locations). Logo images are fine.
- **Pagination buttons** have no `aria-label="Page N"` and no `aria-current="page"`.

### 🟡 Correctness

- **`deleteArticle()` has no error handler** — `isDeleting` is set to `true` and never reset if the HTTP call fails, permanently disabling the Delete button. (`article.component.ts:107-119`)
- **`ArticleListComponent.runQuery()` has no `catchError`** — a failed query leaves the component stuck in `LOADING` state with no error message.
- **`@ts-ignore`** in `ArticlesService` silently bypasses type safety on query-filter construction. (`articles.service.ts:17`)
- **`UntypedFormGroup`** declared but backed by a typed `FormGroup<ArticleForm>` in `EditorComponent` — loses compile-time guarantees. (`editor.component.ts:25`)

### 🟡 Operability — GLD-CHK-001@1

- Bootstrap errors go to `console.error` only — confirm an error monitoring tool captures these in production.
- The `UserService` retry loop is **infinite** (exponential back-off capped at 16 s, retries forever). Confirm this is acceptable under the threat model.
- Review `e2e/DISABLED_TESTS.md` — no skipped security test should hide a known gap.

### 🟡 Data — GLD-CHK-001@1

- JWT is stored in `localStorage` (readable by any XSS). Confirm the threat model accepts this and CSP headers are set server-side.
- The markdown sanitization pipeline should be covered by at least one test.

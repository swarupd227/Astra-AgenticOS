I'll start by gathering everything I need in parallel: the organisational standards catalogue, the auth service code, and a Semgrep security scan.`AuthService` wasn't found by symbol search. Let me search more broadly for auth-related files and read both mandatory standards simultaneously.Now I have the standards. The auth files are clearly in `src/app/core/auth/`. Let me read all the key auth files in parallel.Good. Now let me read the interceptors and the auth component template, plus look for any TypeScript standard in the golden repo or project instructions.Now let me check for a TypeScript/Angular coding standard in the project's `.github/instructions/` and look for any spec files for the auth service.I now have a thorough picture of the entire auth layer. There is no `.github/instructions/` TypeScript standard in this repo, but the task asks to review against "our organisation's TypeScript coding standard". The two mandatory Golden Repository standards (`GLD-STD-009@1` and `GLD-STD-010@1`) are the only organisational standards available to me — there is no separate TypeScript style standard in the catalogue. I'll apply those fully, plus Angular/TypeScript best-practice analysis grounded in the actual code. Let me compile and save the review.# Code Review — Auth Service Layer

> **Note on the "TypeScript coding standard" brief:** The Golden Repository catalogue contains exactly two items — both mandatory OWASP standards (`GLD-STD-009@1`, `GLD-STD-010@1`). No separate organisational TypeScript style standard was found there or in `.github/instructions/`. Both mandatory standards have been applied in full below. If a TypeScript/Angular style guide exists but hasn't yet been published to the Golden Repository, please add it there and re-run this review.

---

## Findings (sorted by severity)

---

### [HIGH] JWT stored in `localStorage` — XSS-accessible, violates `GLD-STD-010@1` — `jwt.service.ts:6–10`

**Observed** in `jwt.service.ts`:

```typescript
getToken(): string {
  return window.localStorage['jwtToken'];   // readable by any JS on the origin
}
saveToken(token: string): void {
  window.localStorage['jwtToken'] = token; // written in plaintext
}
```

**Risk:** `GLD-STD-010@1` §2.12 explicitly states: *"Do not store tokens in insecure locations like local storage in a browser. Use secure, HTTP-only cookies or appropriate secure storage mechanisms."* Any same-origin XSS — including in a third-party script — gives an attacker the bearer token silently and completely. HTTP-only cookies are immune to this because the JS API cannot read them.

**Fix:** Use an HTTP-only `SameSite=Strict; Secure` cookie (preferred, requires API cooperation), or at minimum an in-memory store that doesn't survive a page reload:

```typescript
@Injectable({ providedIn: 'root' })
export class JwtService {
  private token: string | null = null;

  getToken(): string | null  { return this.token; }
  saveToken(token: string): void  { this.token = token; }
  destroyToken(): void { this.token = null; }
}
```

---

### [HIGH] Debug interface exposes live bearer token on `window` in all environments — `app.config.ts:33–44`

**Observed** — `setupDebugInterface` is called unconditionally from the production `initAuth` app initializer:

```typescript
window.__conduit_debug__ = {
  getToken: () => jwtService.getToken(),  // live bearer token
  getCurrentUser: () => currentUser,       // full User object
};
```

**Risk (`GLD-STD-010@1` §2.5):** In production, `window.__conduit_debug__.getToken()` is callable from the browser console or any injected script. This compounds the `localStorage` risk — even if storage is hardened, the token remains globally accessible at runtime. No environment/build flag guards this call (**Observed** — `search_code` for `production|NODE_ENV` returned zero matches in this codebase).

**Fix:** Gate on a build-time environment flag:

```typescript
import { environment } from '../environments/environment';

export function initAuth(jwtService: JwtService, userService: UserService) {
  return () => {
    if (!environment.production) {
      setupDebugInterface(jwtService, userService);
    }
    // ...
  };
}
```
`environment.ts` files do not currently exist in the repo and must be created.

---

### [HIGH] Zero security-event logging across the entire auth layer — violates `GLD-STD-009@1`

**Observed** — `search_code` for `console.log|console.error|console.warn` returned **zero matches** across all auth files. No logger service exists in the codebase.

**Risk (`GLD-STD-009@1` "Which events to log" — MANDATORY):** The standard requires *always* logging authentication successes and failures, session management events, and authorisation failures. The following are currently completely invisible:

| Event | Code location |
|---|---|
| Successful login/registration | `user.service.ts:setAuth` |
| Logout | `user.service.ts:purgeAuth` |
| Token invalid on startup (401 on `GET /user`) | `user.service.ts:handleAuthError` |
| Mid-session token expiry (401 on other endpoints) | `error.interceptor.ts:40–41` |
| Server unavailability / retry entering backoff | `user.service.ts:setAuthUnavailable` |

Brute-force, credential-stuffing, and session-hijacking attacks cannot be detected at the application layer.

**Fix:** Introduce a structured `LoggingService`. **Never log the token value or passwords** (`GLD-STD-009@1` "Data to exclude"):

```typescript
// Correct — log the event, not the secret
this.loggingService.securityEvent('AUTH_SUCCESS', { username: user.username });
this.loggingService.securityEvent('AUTH_FAILURE', { status: err.status, reason: 'invalid_token' });
this.loggingService.securityEvent('SESSION_PURGED', { trigger: 'mid_session_401' });
```

---

### [MEDIUM] `getToken()` return type is `string` but returns `undefined` when absent — `jwt.service.ts:5`

**Observed** — the spec file explicitly tests this contradiction at line 57–59:

```typescript
it('should return undefined when no token exists', () => {
  const token = service.getToken();
  expect(token).toBeUndefined(); // contradicts declared return type: string
});
```

Bracket access on `localStorage` returns `undefined` for a missing key (the typed `getItem()` returns `null`). TypeScript misses this because bracket access on `localStorage` yields `any`.

**Fix:**
```typescript
getToken(): string | null {
  return window.localStorage.getItem('jwtToken'); // null when absent, typed correctly
}
```

---

### [MEDIUM] Bracket notation used instead of the typed `Storage` API — `jwt.service.ts:6, 10`

**Observed:**
```typescript
window.localStorage['jwtToken']           // bypasses Storage interface typing → any
window.localStorage['jwtToken'] = token;  // bypasses Storage interface typing → any
```

`getItem` / `setItem` are the spec-compliant typed APIs. Note that `destroyToken` already correctly uses `removeItem` (line 14) — the two write/read operations should match.

**Fix:** Use `getItem('jwtToken')` and `setItem('jwtToken', token)` consistently.

---

### [MEDIUM] Profile routes carry no `canActivate` guard — `app.routes.ts:38–41`

**Observed:**
```typescript
{
  path: 'profile',
  loadChildren: () => import('./features/profile/profile.routes'),
  // no canActivate — unlike /settings and /editor
},
```

`/settings` and `/editor` routes correctly use `canActivate: [requireAuth]`. The profile child routes are unknown without reading `profile.routes`; if any require authentication (the `follow-button.component.ts` does check `isAuthenticated` before acting, but the component still renders), unauthenticated users reach those views unguarded.

**Fix:** Audit `profile.routes` and add `canActivate: [requireAuth]` to any child route requiring authentication. If the profile view is intentionally public, add an explicit comment stating this.

---

### [MEDIUM] Email input uses `type="text"`, no email-format validator — `auth.component.html:32–36`, `auth.component.ts:35`

**Observed:**
```html
<input type="text" formControlName="email" ... />
```
```typescript
email: new FormControl('', { validators: [Validators.required], nonNullable: true })
// missing: Validators.email
```

`type="email"` provides native format validation, correct mobile keyboard, and password-manager hints. Without `Validators.email`, any non-empty string (including clearly invalid values) passes the form and is submitted to the API.

**Fix:**
```html
<input type="email" formControlName="email" ... />
```
```typescript
validators: [Validators.required, Validators.email]
```

---

### [MEDIUM] `shareReplay(1)` is placed before `catchError` — replayed errors bypass error handling — `user.service.ts:94–96`

**Observed:**
```typescript
return this.http.get<{ user: User }>('/user').pipe(
  tap({ next: ..., error: (err) => this.handleAuthError(err) }),
  shareReplay(1),    // replays errors to late subscribers before...
  catchError(() => EMPTY),  // ...this can catch them
);
```

`shareReplay` replays the last emission (including errors) to new subscribers. `catchError` is downstream of the replay, so replayed errors bypass it. The retry path at `user.service.ts:143` — `this.getCurrentUser().subscribe()` — creates a new subscription that receives the replayed error uncaught, producing an unhandled RxJS error in the console.

**Fix:** Swap the order:
```typescript
return this.http.get<{ user: User }>('/user').pipe(
  tap({ next: ..., error: (err) => this.handleAuthError(err) }),
  catchError(() => EMPTY),
  shareReplay(1),
);
```

---

### [LOW] `destroyRef` is implicitly `public` — `auth.component.ts:27`

**Observed:**
```typescript
destroyRef = inject(DestroyRef);  // public by default
```

`DestroyRef` is an Angular internal; exposing it on the component's public API breaks encapsulation.

**Fix:** `private readonly destroyRef = inject(DestroyRef);`

---

### [LOW] `authType` and `title` lack access modifiers — `auth.component.ts:22–23`

**Observed:**
```typescript
authType = '';  // public mutable by default
title = '';
```

Both are set once in `ngOnInit` and read by the template. In Angular 14+, `protected` is the correct visibility for template-bound members that should not be part of the external API.

**Fix:** `protected authType = '';` / `protected title = '';`

---

### [LOW] Pending `retrySubscription` not cancelled on service destroy — `user.service.ts:140`

**Observed** — `UserService` implements no `OnDestroy`. `cancelRetry()` is called on `setAuth`/`purgeAuth`, but not on service teardown, leaving a pending `timer` subscription in `unavailable` state at app shutdown. Low practical risk in production (browser tab close), but causes timer fire-after-destroy in tests.

**Fix:** Implement `ngOnDestroy(): void { this.cancelRetry(); }`

---

### [LOW] Two untracked subscriptions in `setupDebugInterface` — `app.config.ts:37–38`

**Observed** — subscriptions to `userService.authState` and `userService.currentUser` are never stored or cancelled. Harmless in practice (both services are root singletons), but inconsistent with the `takeUntilDestroyed` pattern used throughout the rest of the codebase.

**Fix:** Once guarded behind `!environment.production` (see HIGH finding #2), this is moot in production builds. In debug builds, accept the lifetime or use a `Subject`-based teardown.

---

### [LOW] `any` typed mocks in test files — `user.service.spec.ts:20–21`, `jwt.service.spec.ts:10`

**Observed:**
```typescript
let jwtService: any;
let router: any;
let localStorageSpy: any;
```

`any` disables type checking on mocks; a signature change in the real service will not break the mock, allowing tests to silently test stale behaviour.

**Fix:** Use typed partials or vitest's typed mock helpers:
```typescript
let jwtService: Pick<JwtService, 'saveToken' | 'destroyToken' | 'getToken'>;
```

---

## Positive Notes

- **State-machine design is excellent.** The four-state `AuthState` model (`loading | authenticated | unauthenticated | unavailable`) with documented transitions, 4XX vs 5XX discrimination, and capped exponential-backoff retry is exactly the right architecture for resilience.
- **Interceptor separation of concerns is clean.** Each interceptor does one thing; the skip condition for `/user` in `errorInterceptor` is documented and correct.
- **No hard-coded secrets found.** The API base URL is a public demo endpoint, not a credential — `GLD-STD-010@1` satisfied for this point.
- **`distinctUntilChanged` on public observables** prevents redundant change detection cycles.
- **`nonNullable: true` on all `FormControl`s** eliminates the `string | null` ambiguity common in Angular reactive forms.
- **`ChangeDetectionStrategy.OnPush`** on `AuthComponent` is correct for a zoneless app.
- **`void` prefix on floating `router.navigate()` Promises** — correctly suppresses linting warnings without silently swallowing errors.
- **Test coverage is substantial.** `jwt.service.spec.ts` includes lifecycle, edge cases, and a dedicated security-considerations suite. `user.service.spec.ts` covers all methods, success and error paths, and the `shareReplay` multicasting behaviour.

---

## Summary & Recommendation

**Decision: REQUEST CHANGES — 3 HIGHs must be resolved before merge.**

| # | File | Severity | Finding |
|---|------|----------|---------|
| F1 | `jwt.service.ts:6–10` | **HIGH** | JWT in `localStorage` (`GLD-STD-010@1`) |
| F2 | `app.config.ts:33–44` | **HIGH** | Debug token interface active in production (`GLD-STD-010@1`) |
| F3 | All auth files | **HIGH** | Zero security-event logging (`GLD-STD-009@1`) |
| F4 | `jwt.service.ts:5` | MEDIUM | Wrong return type — `string` vs `string \| null` |
| F5 | `jwt.service.ts:6,10` | MEDIUM | Untyped bracket-accessor vs `Storage` API |
| F6 | `app.routes.ts:38–41` | MEDIUM | Profile routes may lack auth guard |
| F7 | `auth.component.html:32–36` | MEDIUM | `type="text"` on email input; no `Validators.email` |
| F8 | `user.service.ts:94–96` | MEDIUM | `shareReplay` before `catchError` — replayed errors escape handler |
| F9 | `auth.component.ts:27` | LOW | `destroyRef` implicitly public |
| F10 | `auth.component.ts:22–23` | LOW | `authType`/`title` lack access modifiers |
| F11 | `user.service.ts:140` | LOW | `retrySubscription` not cancelled on destroy |
| F12 | `app.config.ts:37–38` | LOW | Untracked debug subscriptions |
| F13 | `*.spec.ts` | LOW | `any`-typed mocks |

The review has been saved to `artifacts/review-auth-service.md`. Would you like me to produce fix snippets for any specific finding, or check the `profile.routes` file to resolve the ambiguity in F6?

Good start. Now let me read the key source files and map the component tree.I now have everything I need. Let me compile the full report.Here is the full findings summary, now saved as `frontend-architecture-react-realworld.md`.

---

## Framework & entry points

**React 16.3 / Redux 3.6**, bootstrapped via Create React App (`react-scripts` 1.1.1). `src/index.js` mounts a `<Provider>` → `<ConnectedRouter>` → `<App>`. All 8 routes are declared in `App.js` and rendered with `<Switch>`. There is no hooks usage; the entire component layer is class-based.

---

## Component & state map (highlights)

The tree has **10 levels** at its deepest (`App → Article → CommentContainer → CommentList → Comment → DeleteButton`). Sixteen of 26 source files are Redux-connected. Eight Redux slices (`common`, `auth`, `article`, `articleList`, `editor`, `home`, `profile`, `settings`) are combined in `src/reducer.js`. The sole async mechanism is a hand-rolled `promiseMiddleware` in `src/middleware.js` that resolves action payloads and re-dispatches.

---

## Structural risks (GLD-STD-008@1)

| ID | Finding | File(s) |
|---|---|---|
| **SR-1 High** | **7 components use `componentWillMount`; 3 use `componentWillReceiveProps`** — both were marked `UNSAFE_` in React 16.3 and removed in React 18. All data-fetching hangs on them. | `App.js:42`, `Editor.js:83`, `Settings.js:41`, `Home/index.js:31`, `Article/index.js:22`, `Profile.js:78`, `ProfileFavorites.js:19` |
| **SR-2 Medium** | `App.js` imports the Redux store singleton directly (`import { store } from '../store'`) and calls `store.dispatch(push(…))` at line 37, bypassing `connect`. Untestable in isolation. | `App.js:15,37` |
| **SR-3 Medium** | `ProfileFavorites extends Profile` — React discourage component inheritance. The `render()` method is invisible in ProfileFavorites; `Profile` exports its internals solely to enable this. | `ProfileFavorites.js:18`, `Profile.js:170` |
| **SR-4 Low–Medium** | Six uses of `Object.assign` where spread is required (GLD-STD-008@1 §3.8). Two are correctness bugs: `Editor.js:66` mutates the `article` argument; `Settings.js:43` directly mutates `this.state`. | `agent.js:45`, `Editor.js:66`, `Settings.js:25,32,43,54` |
| **SR-5 Low** | `const` declared inside `case` arms without block `{}` — lexical-scoping risk across fall-through arms. | `reducers/common.js:40`, `reducers/article.js:27` |
| **SR-7 Low** | `console.log('RESULT', res)` and `console.log('ERROR', error)` fire unconditionally in production. The raw API response may include user tokens. | `middleware.js:23,33` |

---

## Accessibility findings (all observed)

| ID | Severity | Issue | File(s) |
|---|---|---|---|
| **A11Y-1** | **High** | Every `<input>` / `<textarea>` in all five forms uses only `placeholder`; zero `<label>` elements exist anywhere. Placeholders are not accessible names. WCAG 1.3.1 / 4.1.2. | `Login.js`, `Register.js`, `Editor.js`, `Settings.js`, `CommentInput.js` |
| **A11Y-2** | **High** | Clickable `<i>` icons with no `role`, no `tabIndex`, no accessible name — keyboard/screen reader inaccessible. | `DeleteButton.js:20`, `Editor.js:149` |
| **A11Y-3** | Medium | `<a href="">` used as interactive button in 5 places (tabs, tags, pagination) with `ev.preventDefault()`. Routes to page root on JS failure; should be `<button>` or carry real `href`. | `MainView.js:16,35,51`, `Tags.js:18`, `ListPagination.js:46` |
| **A11Y-4** | Medium | `<nav>` in `ListPagination` has no `aria-label`. Multiple landmarks on a page are indistinguishable to AT users. | `ListPagination.js:30` |
| **A11Y-5** | Medium | `dangerouslySetInnerHTML` renders article body. `marked`'s `sanitize: true` was deprecated and is unreliable in newer patch versions. | `Article/index.js:38,60` |

---

## Performance smells (all Unverified — no profiler run)

| ID | Mechanism |
|---|---|
| **P-1** | No `React.lazy` / `Suspense`. All 8 route components are eagerly imported in `App.js:7–13`, forming a single JS chunk. |
| **P-2** | Inline closures created inside `.map()` on every render: `Tags.js:11`, `ListPagination.js:36`, `Editor.js:51`. |
| **P-3** | Tag strings used as `key` in article and preview lists — unstable if tags are mutable or duplicated. |
| **P-4** | `middleware.js:24` — `action.payload = res` mutates the in-flight action object. |
| **P-5** | `mapStateToProps` spreads entire state slices (`...state.home`, `...state.articleList`, etc.) with no `reselect` memoisation, causing broad re-renders on any slice change. |

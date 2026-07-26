I'll start by gathering all the context I need in parallel: the organisational checklist, the codebase structure, and a Semgrep scan.Good. Now let me read the full checklist and pull all the key source files in parallel.Now let me read all the key source files in parallel.Now let me read the remaining source files in parallel.Now let me check the remaining files — the lib root, Cargo.toml, and a few remaining cmd files.Now let me check the `clients` module structure and look for `#[derive(Debug)]` coverage and the `into_iter` naming issue more carefully.Now let me check the documentation example in the client for `set_expires` (there's a potential doc bug), and the `BlockingSubscriber` re-export, and search for `impl IntoIterator`.Now let me check the doc examples for correctness and look for `Subscriber` re-export gap.I now have everything I need. Let me compile the full review.# Code Review — `mini-redis` Public API Surface

**Checklist applied:** `GLD-CHK-002@1` — Rust API Guidelines Checklist
**All findings verified by `read_file` / `search_code`; Semgrep was unavailable in this environment.**

---

## Findings (sorted by severity)

---

### [HIGH] Wrong assertion in `set_expires` doc-example — `src/clients/client.rs:238`
**Rules:** C-EXAMPLE, C-FAILURE

The example explicitly waits for the TTL to expire, then asserts the value `is_some()` — the opposite of the intended post-condition.
```rust
// current (wrong):
assert!(val.is_some());

// fix:
assert!(val.is_none());
```
**Risk:** The example is semantically inverted. It teaches callers the wrong TTL behaviour and would panic if run against a real server under `cargo test --doc`.

---

### [HIGH] `BlockingSubscriber` and `Subscriber` are not re-exported from the crate root — `src/lib.rs:29`
**Rules:** C-HIDDEN

**Observed:** `BlockingClient::subscribe` returns `crate::Result<BlockingSubscriber>` (`blocking_client.rs:205`), but `BlockingSubscriber` appears in neither `clients/mod.rs` re-exports nor `lib.rs`. `Subscriber` has the same gap at the crate root.
```rust
// lib.rs:29 — current
pub use clients::{BlockingClient, BufferedClient, Client};

// fix
pub use clients::{BlockingClient, BlockingSubscriber, BufferedClient, Client, Subscriber};
```
**Risk:** Callers cannot name the return type of `subscribe()` without reaching into internal module paths (`mini_redis::clients::blocking_client::BlockingSubscriber`). This is a hard usability break — every public function's return type must be reachable from a stable pub path.

---

### [MEDIUM] `into_iter` method without `IntoIterator` impl — `src/clients/blocking_client.rs:230`
**Rules:** C-ITER, C-CONV-TRAITS

**Observed:** `BlockingSubscriber::into_iter` is a plain method, not a trait implementation. `for msg in subscriber` therefore does not compile.
```rust
// fix: implement the trait
impl IntoIterator for BlockingSubscriber {
    type Item = crate::Result<Message>;
    type IntoIter = SubscriberIterator; // already exists, just make it pub or named
    fn into_iter(self) -> Self::IntoIter { … }
}
```

---

### [MEDIUM] `Get::new` / `Set::new` use `impl ToString` instead of `impl Into<String>` — `src/cmd/get.rs:19`, `src/cmd/set.rs:37`
**Rules:** C-GENERIC, C-CALLER-CONTROL

`ToString` is a wider bound than necessary (it applies to every `Display` type) and always allocates. `Into<String>` is the idiomatic bound and avoids a redundant allocation when the caller already owns a `String`.
```rust
// fix
pub fn new(key: impl Into<String>) -> Get { Get { key: key.into() } }
```

---

### [MEDIUM] `Set::value()` returns `&Bytes` instead of `&[u8]` — `src/cmd/set.rs:51`
**Rules:** C-CALLER-CONTROL

Returning `&Bytes` leaks the concrete storage type. Most callers only need `&[u8]` (bytes content); those who need a cheap clone should get `Bytes` by value (it is ref-counted). Neither use case is well-served by `&Bytes`.
```rust
pub fn value(&self) -> &[u8] { &self.value }   // for inspection
// or: pub fn value(&self) -> Bytes { self.value.clone() }  // for cheap ownership
```

---

### [MEDIUM] `Client`, `Subscriber`, `BlockingClient`, `BlockingSubscriber` lack `Debug` — multiple files
**Rule:** C-DEBUG

None of the four primary public client handles derive or implement `Debug` (confirmed by searching all `#[derive(Debug)]` occurrences). `tokio::runtime::Runtime` does implement `Debug`, so derives will propagate cleanly.
```rust
#[derive(Debug)]
pub struct Client { … }
// repeat for Subscriber, BlockingClient, BlockingSubscriber
```

---

### [MEDIUM] `Message` has fully public fields with no `#[non_exhaustive]` — `src/clients/client.rs:49`
**Rule:** C-STRUCT-PRIVATE

```rust
pub struct Message {
    pub channel: String,
    pub content: Bytes,     // adding any field here is a breaking change
}
```
Adding a future field (e.g. `timestamp`, `pattern`) will break any downstream code that constructs `Message { channel: …, content: … }` literally.
```rust
#[non_exhaustive]          // ← add this
pub struct Message { … }
```

---

### [MEDIUM] `BufferedClient::buffer` is a non-idiomatic constructor name — `src/clients/buffered_client.rs:67`
**Rule:** C-CTOR

`buffer` reads as a verb, not a constructor. The convention is `new` for the primary constructor; alternative named constructors should signal *how* they differ from `new` (e.g. `from_client`, `wrap`).
```rust
// fix
pub fn new(client: Client) -> BufferedClient { … }
```

---

### [MEDIUM] `frame::Error` name collides with `std::io::Error` in scope — `src/frame.rs:23`
**Rule:** C-GOOD-ERR, C-WORD-ORDER

`mini_redis::frame::Error` forces callers who import both to alias one. The codebase itself already uses `ParseError` in `parse.rs` to avoid this pattern.
**Fix:** Rename to `FrameError`.

---

### [LOW] `Frame::parse` panics via `unimplemented!()` with no `# Panics` doc — `src/frame.rs:175`
**Rule:** C-FAILURE

```rust
_ => unimplemented!(),   // public fn with an undocumented panic path
```
Preferred fix: return an `Err` variant instead. At minimum, add a `# Panics` doc section.

---

### [LOW] `documentation` URL in `Cargo.toml` points to previous version — `Cargo.toml:8`
**Rule:** C-METADATA

```toml
version = "0.4.1"
documentation = "https://docs.rs/mini-redis/0.4.0/mini-redis/"  # stale
```
**Fix:** `documentation = "https://docs.rs/mini-redis/latest/mini_redis/"`

---

### [LOW] `Cargo.toml` missing `homepage`, `keywords`, `categories` — `Cargo.toml:1-13`
**Rule:** C-METADATA
```toml
homepage   = "https://github.com/tokio-rs/mini-redis"
keywords   = ["redis", "tokio", "async", "client", "server"]
categories = ["network-programming", "asynchronous"]
```

---

### [LOW] "Unsubscribe *to*" in two doc comments — `src/clients/client.rs:458`, `src/clients/blocking_client.rs:242`
Wrong preposition. Fix: **"Unsubscribe *from* a list of channels"**.

---

## Positive Notes

- **Typestate pub/sub transition** (`Client` → `Subscriber` by consuming `self`) is an excellent, idiomatic use of C-CUSTOM-TYPE — misuse is impossible at compile time.
- **`pub(crate)` discipline is solid.** All server-side methods (`apply`, `parse_frames`, `into_frame`) are correctly hidden from library consumers.
- **`frame::Error` properly implements `std::error::Error`, `Display`, and four `From` conversions**, satisfying the core of C-GOOD-ERR.
- **All `cmd` types derive `Debug`** and have private fields — C-DEBUG and C-STRUCT-PRIVATE are met for the command layer.
- **`Connection::new` is a canonical C-CTOR constructor** — static, inherent, returns `Self` with no surprises.
- **`BufferedClient` is `Clone`** via its `Sender` wrapper — the right design for a shared-handle actor-pattern client.
- **`#[instrument(skip(self))]` throughout** the async client methods produces useful tracing spans without leaking internals.

---

## Summary & Recommendation

**Verdict: Request Changes**

| Severity | Count | Headline |
|----------|-------|---------|
| **HIGH** | 2 | Missing crate-root re-exports; wrong doc assertion |
| **MEDIUM** | 6 | No `Debug` on 4 client types; `into_iter` without `IntoIterator`; `impl ToString`; `&Bytes` getter; `Message` not future-proof; `buffer` constructor name; `frame::Error` naming |
| **LOW** | 4 | Doc URL stale; missing Cargo metadata; wording; undocumented panic |

The two HIGH items should be fixed before the next release — one is a usability break (users cannot name a return type), the other is an incorrect doc example. The MEDIUM items are real API quality issues that will be hard to fix after stabilisation.

The review has been saved to `artifacts/review-mini-redis-api.md`.

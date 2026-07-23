# ASTRA AgenticOS — release notes

## 2026-07-23 — "Add your own code" release

The headline: **you no longer need access to the server to point ASTRA at a codebase**, and nothing
you add disappears any more.

### 1. New — upload a `.zip` of your code  ⭐

There is now a third way to add a project: **Project menu → New project → Upload .zip**.

1. In Windows Explorer, right-click your solution folder → **Send to → Compressed (zipped) folder**
2. Drag the `.zip` onto the drop zone (or click to browse)
3. Optionally set **Sub-folder to index** (e.g. `src`) → **Create & index**

- Works from any PC — nothing to install, no server access needed
- Up to **300 MB**. Exclude `bin/`, `obj/` and `packages/` — they are build output, are not indexed,
  and are usually most of the size
- A single wrapper folder (which Windows and GitHub's "Download ZIP" both add) is handled
  automatically, so `src` still means `src`
- Uploaded code is extracted and indexed on the server and goes nowhere else

### 2. Fixed — "cannot add a project" (both reported errors)

**Local folder said `Folder not found: /app/ui/C:\Sandbox`.**
ASTRA is hosted on a Linux server, so a Windows path from your own PC was being misread as a relative
path. Two things changed: the error now explains the real problem, and the **hosted app no longer
offers "Local folder" as a starting option at all** — because a shared server genuinely cannot see
your laptop. Use **Upload .zip** or **Git repository** instead.

**Git said `could not read Username ... No such device or address`.**
That was a private repository: git was silently waiting for a password prompt that can never appear
in a container. Now:

- **Private repos are supported** — paste a personal access token (GitHub, GitLab or Azure DevOps)
  into the new **Access token** field. It is used only for the clone, then discarded: never written to
  disk, never stored with the project, never shown again. Leave blank for public repos.
- Failures say what to do — private-vs-typo, expired token, unreachable host, and wrong sub-folder all
  have their own message
- A failed attempt no longer leaves a half-created project behind, and **your typed values are kept**
  so a retry doesn't mean re-entering the URL and token

### 3. Fixed — your work now survives restarts

Previously every restart or redeploy wiped **projects, conversation history, generated artifacts and
cloned repos**. All of it is now stored on persistent storage. Verified: three repositories survived a
full rebuild and redeploy intact.

*(One-off: because state moved to durable storage, anything added before this release needed re-adding.
That has been done — eShopOnWeb, AutoMapper and Serilog are loaded.)*

### 4. Fixed — cramped header on smaller screens

On narrower windows the top bar wrapped onto three lines and the status pill broke apart. It now stays
on one line from 360 px upward, shortening the project name rather than pushing the row wider.

### Known limitations

- **No sign-in.** Anyone with the URL can use the app and spend the API budget. Restrict by IP or add
  Entra ID sign-in before wider rollout.
- The bundled **nopCommerce demo** shows as *unavailable* in the cloud — its source is not shipped in
  the image. Expected; use an uploaded or cloned project.

---

For step-by-step instructions see [`USER-MANUAL.md`](USER-MANUAL.md) §5 (adding projects) and §15
(troubleshooting).

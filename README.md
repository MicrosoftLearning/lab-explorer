# Lab Explorer

A single-page, client-side-filterable catalogue of every hands-on lab exercise across the
MicrosoftLearning lab repositories.

**➡ <https://microsoftlearning.github.io/lab-explorer/>**

Individual lab repos already publish their own exercises via GitHub Pages, but each one can
only see its own content. Lab Explorer indexes the lab front matter from *many* repos into a
single `data/labs.json` and renders a searchable, cross-repo catalogue on top of it.

---

## What it does

A nightly GitHub Actions run walks every repo listed in [`repos.yml`](repos.yml), reads the YAML
front matter from `Instructions/**/*.md`, normalizes it, and writes `data/labs.json`. The static
site loads that file and does all filtering in the browser.

Filters — free-text search, course/repo, level, duration, status and topic — are fully
combinable, show live counts, and are reflected in the URL so a filtered view is shareable and
survives a reload.

```
repos.yml  ──►  scripts/build-index.mjs  ──►  data/labs.json  ──►  index.html + assets/
  (config)         (GitHub REST + raw)           (index)             (static site)
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `repos.yml` | The list of repos to index. **This is the only file you need to touch to add a course.** |
| `scripts/build-index.mjs` | The indexer. Produces `data/labs.json`. |
| `scripts/serve.mjs` | Zero-dependency static server for local preview. |
| `data/labs.json` | The generated index. Checked in so the site works locally and on first deploy. |
| `index.html`, `assets/` | The site. Plain HTML/CSS/JS — no framework, no front-end build step. |
| `.github/workflows/pages.yml` | Builds the index and deploys to GitHub Pages. |

## Adding a repo

Append an entry to `repos.yml` and open a PR:

```yaml
repos:
  - repo: MicrosoftLearning/mslearn-ai-something   # owner/name (required)
    title: Something with AI                       # display name in the UI (required)
    branch: main                                   # optional; defaults to the repo's default branch
```

Requirements for the repo being added:

- It must be **public**.
- Its exercises must live under `Instructions/` as markdown with a `lab:` front matter block.
  The folder name doesn't matter — `Instructions/Exercises`, `Instructions/Labs`,
  `Instructions/exercises` and `Instructions/Consolidated` are all picked up.

Once merged, the next daily run picks it up. To publish immediately, run the
**Build and deploy Lab Explorer** workflow manually from the Actions tab.

## The lab front matter it reads

```yaml
---
lab:
  title: Prepare for an AI development project
  description: Learn how to organize AI resources in a Microsoft Foundry project.
  level: 200
  duration: 30
  islab: true
  status: 'released'
  primarytopics:
    - Microsoft Foundry
    - Visual Studio Code
---
```

The parser is deliberately tolerant, because the real-world data is inconsistent:

- Indentation (2- vs 4-space) and quoting styles vary — a real YAML parser is used, not regex.
- `duration` may be `30`, `'30'` or `30 minutes`; all normalize to the number `30`.
- `level`, `duration`, `status` and `primarytopics` are frequently missing and simply become
  `null` / `[]`.
- A file is treated as a lab if it has a `lab:` block with a title and `islab` is not explicitly
  `false`. Files without a `lab:` block (READMEs, index pages) are skipped silently.
- Localized siblings such as `01-lab.ja-jp.md` are ignored.
- Repo-specific extras (`type`, `id`, `order`, `parent`, `section`, `difficulty`, `access`,
  `concepts`, …) are preserved under `extra` rather than dropped. `concepts` additionally feeds
  the topic facet, since `primarytopics` alone is sparse.

### Normalized record

```json
{
  "id": "mslearn-ai-vision/Instructions/Exercises/01-gen-ai-vision.md",
  "repo": "mslearn-ai-vision",
  "repoTitle": "Azure AI Vision",
  "title": "Develop a vision-enabled chat app",
  "description": "Use Azure AI Foundry to build a generative AI app that supports image input.",
  "level": 300,
  "duration": 30,
  "status": "released",
  "topics": ["Microsoft Foundry"],
  "path": "Instructions/Exercises/01-gen-ai-vision.md",
  "sourceUrl": "https://github.com/MicrosoftLearning/mslearn-ai-vision/blob/main/Instructions/Exercises/01-gen-ai-vision.md",
  "hostedUrl": "https://microsoftlearning.github.io/mslearn-ai-vision/Instructions/Exercises/01-gen-ai-vision.html",
  "extra": {}
}
```

`hostedUrl` is derived from the repo's GitHub Pages convention, so it is a best guess.
`sourceUrl` always points at the file on GitHub and is guaranteed to resolve — card titles link
to the hosted page, and every card also carries a small **source** link.

The JSON envelope also carries `generated_at`, `lab_count` and per-repo counts, which the UI
uses to show index freshness in the footer.

## Running it locally

```bash
npm install

# Optional but recommended - avoids anonymous GitHub API rate limits.
export GITHUB_TOKEN=$(gh auth token)      # PowerShell: $env:GITHUB_TOKEN = (gh auth token)

npm run build     # regenerates data/labs.json
npm run serve     # http://localhost:8080
```

The indexer prints a per-repo summary and a warning count. It is resilient by design: a repo
that can't be reached, a missing branch or an unparsable file is logged and skipped rather than
failing the build. It only exits non-zero if it would otherwise publish an *empty* index.

You need a web server — opening `index.html` from the filesystem won't work, because the page
fetches `./data/labs.json`. Any static server will do (`npx serve`, `python -m http.server`).

## Deployment and the daily refresh

`.github/workflows/pages.yml` runs on push to `main`, on `workflow_dispatch`, and daily at
05:17 UTC. It installs dependencies, runs the indexer (authenticated with the workflow's
`GITHUB_TOKEN`), stages the static files into `_site/`, and publishes with
`actions/upload-pages-artifact` + `actions/deploy-pages`.

The daily schedule is what keeps the catalogue current: when an upstream repo adds or edits a
lab, it shows up here within a day without anyone touching this repo.

> Pages is configured with **build type: GitHub Actions**. There is no Jekyll build and no
> branch-based Pages source. All asset paths in the site are relative (`./assets/…`,
> `./data/labs.json`) so everything resolves correctly under the `/lab-explorer/` subpath.

The generated `data/labs.json` is committed to the repo as well. That's mildly redundant with
the workflow, but it means local preview works straight after a clone and the very first deploy
has data before the first scheduled run.

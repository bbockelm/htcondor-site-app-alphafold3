# HTCondor site app template

A starting point for a custom job submission interface served by an HTCondor access point, to your group, at your site.

Clone it with **Use this template** on GitHub. It already works: pick a pipeline, drop files — or tick the box to use example data — submit, watch the jobs run, and read the results in the page. Delete the parts you do not want rather than assembling the parts you do.

```
make dev      # dev server on :5173, proxying to an API server
make check    # lint, typecheck, test, build
make bundle   # dist/<name>.zip + .sha256 — the thing you deploy
make e2e      # the real API server in Docker, driven through a browser
```

## What you are building

A **site app** is static files — HTML, CSS and JavaScript — served by the access point's own API server, under `/site/<id>/`, to the groups an operator names. Because it is served from the same origin as the API, the user's existing session cookie is already there: your app calls `/api/v1/...` and is authenticated. There is no login to build, no token to store, no OAuth client to register.

You get the queue, the submit path, file transfer, job output and the rest of the API. You bring the interface and the knowledge of what your lab actually runs.

## Getting started

1. **Use this template**, then clone your copy.
2. Edit `app.yaml` — the name and description your users see.
3. Copy `web/src/pipelines/wordfreq/` to a directory of your own — this is the part that is about your science. Everything else is scaffolding.
4. Add it to `web/src/pipelines/index.ts`, and delete the pipelines you do not want.
5. `make check`, then `make bundle`.

Point the dev server at a real API server:

```
make dev API=https://your-access-point.example.edu
```

Or run one locally with `htcondor-api --demo`, which brings up a personal HTCondor and a login you can use.

## Deploying

```
make bundle
scp dist/myapp.zip dist/myapp.zip.sha256 ap.example.edu:/etc/condor/webapps/
```

The bundle's **file name is the app's id**, so `myapp.zip` is served at `/site/myapp/`. Renaming the file deploys the same build as a second, independent app — which is how you stage a new version alongside the running one.

Your operator writes one file beside it, once:

```yaml
# /etc/condor/webapps/myapp.yaml
groups: [smith_lab]    # who may see it. Required; the bundle cannot set this.
home: true             # land these users here instead of the dashboard
enabled: true
```

A bundle with no policy file beside it is not served at all. That is deliberate: who may see your app is the site's decision, never the bundle's, so forgetting the file fails closed rather than publishing your work to the whole pool.

The server notices the new file and reloads it. There is no restart.

`make bundle` is reproducible — the same source produces the same bytes and the same digest — so an operator can rebuild from your tagged commit and confirm that what is deployed is what you shipped.

## Worked examples

Three of them, in the app itself, behind the pipeline picker. Pick one in the running demo to see it; read `web/src/pipelines/<name>/` to see how it is built.

| Pipeline | What it does | Worth reading for |
| --- | --- | --- |
| `pipelines/wordfreq` | Counts word frequencies in a dropped text file | **Start here.** The whole arc with nothing science-specific in the way — and an awk program generated in the browser, so no user text ever reaches the submit file |
| `pipelines/astro` | Statistics and rendered previews from FITS images, with astropy | Getting a **binary** result — a picture — back to the page, and a job whose program is generated and uploaded rather than inlined |
| `pipelines/blast` | Searches many query files against one database | **The DAG trick.** A large shared input uploaded *once* instead of once per job |

A pipeline is five things: what files it takes (one labelled slot per kind, so a reference database and a pile of queries are not one pile), what controls it offers, what submit file it produces, how its results read, and what to run for someone who has no data of their own. The interface is in `web/src/pipelines/types.ts`. Everything else — identity, the file pickers, submit-then-upload-then-poll, the job list, rendering the results under a finished job — is the shell, and you do not have to touch it.

Building your own is adding a directory and one line in `web/src/pipelines/index.ts`. Deleting the ones you do not want is deleting their line.

## What not to do

The short version of `AGENTS.md`, which you should read before writing code:

- No CDN scripts, fonts or images. The server sends `default-src 'self'` and will block them.
- Never hardcode `/site/myapp/`. Read `window.__HTCONDOR_APP__.base`.
- No `groups` in `app.yaml` — who may see the app is set in the access point's configuration. No secrets anywhere in the bundle; it is public to everyone in its groups.
- Do not invent API endpoints. Check `/openapi.json` on a running server.

## Layout

| Path | What it is |
|---|---|
| `app.yaml` | Name and description. Not groups, not id. |
| `web/src/pipelines/` | **Your science lives here.** One directory per pipeline, plus the interface they implement. |
| `web/src/lib/submit.ts` | Escaping, naming and sizing, shared by every pipeline. A mistake here is a security bug. |
| `web/src/lib/api.ts` | Typed API client. Extend it rather than calling `fetch` directly. |
| `web/src/lib/htcondor.ts` | Mount point and identity, from the server. |
| `web/src/app.tsx` | The shell: identity, file pickers, submit, job list, results. Usually left alone. |
| `e2e/` | Playwright, against a real server. |
| `AGENTS.md` | Read before writing code, by a person or an assistant. |

# AlphaFold3, as a site app

A web interface for running AlphaFold3 on an HTCondor access point: paste a sequence or drop a spreadsheet of them, and get back predicted structures.

It is a [site app](https://github.com/bbockelm/htcondor-site-app-template) — static files served by the access point's own API server, to the groups an operator names, from a zip an operator drops in place. The user's session cookie is already there, so there is no login to build and no token to manage.

```
make dev      # dev server on :5173, proxying to an API server
make check    # lint, typecheck, test, build
make bundle   # dist/<name>.zip + .sha256 — the thing you deploy
make e2e      # the real API server in Docker, driven through a browser
```

## What it runs

AlphaFold3 is two workflows, not one, and that shape is why this app submits a DAG:

| Stage | Where | Reads | Writes |
|---|---|---|---|
| Alignments | CPU, on a machine that holds the ~650 GB of reference databases | `fold_input.json` | `<job>.data_pipeline.tar.gz` |
| Structure | One GPU, sized from the job's token count | that tarball, and the model weights | `<job>.inference_pipeline.tar.gz` |

One edge per job, from its alignments to its structure. Nothing is uploaded between the stages: the tarball is written into the workflow's own directory on the access point and the second node reads it from there. The alignments are the slow half and they are reusable, so a run with no model weights stops after the first stage — which is a real way to use AlphaFold3 rather than a degraded one.

The per-job `fold_input.json` is generated in the browser, by a port of `scripts/generate-job-directories.py` from the two published tutorials. `web/src/pipelines/alphafold3/foldinput.test.ts` checks it against files that script actually wrote: AlphaFold3 reads that file, so a difference between the tutorial's output and this app's is a difference in the science.

## Before it will run anything

**One line decides everything site-specific**, at the bottom of `web/src/pipelines/alphafold3/site.ts`:

```ts
export const SITE: SiteConfig = NONE;   // -> CHTC, or OSPOOL
```

The shipped default is `NONE`, which is not a working configuration. It submits, the jobs run, and every one of them reports that the machine it landed on has no AlphaFold3 — in words, on the results page. That is deliberate: a container no execute point can fetch, or a requirement no machine satisfies, does not fail, it *holds* or it sits idle, and nothing in a web interface can tell the user why.

So configuring this is a deployment step with a check in front of it. On the access point:

```
condor_status -constraint 'HasAlphafold3 =?= true' -af Machine | wc -l
```

If that is zero, the alignment stage will queue for ever and this app cannot help; talk to the pool's facilitators before changing the line.

Then put three files somewhere the access point's jobs can read — object storage, or a path on the access point itself:

| File | Where it comes from |
|---|---|
| `data_pipeline.sh` | `CHTC/tutorial-CHTC-AF3` or `osg-htc/tutorial-OSPool-AF3`, `scripts/` |
| `inference_pipeline.sh` | the same |
| `af3.bin.zst` | **you**, from Google DeepMind |

Set `toolsBase` on the preset to the directory holding the first two. The weights are the user's own and go in the form, not in the bundle.

### The model weights

AlphaFold3's trained parameters are licensed from Google DeepMind to named researchers on request, and **may not be redistributed**. They are not in this repository, they are not in the bundle, they are not in the example data, and there is nowhere in this interface to upload them.

What the form takes is a *location*: a path on the access point, or a URL its jobs can fetch. The file never passes through a browser — it is two to four gigabytes, and a browser is the wrong way to move it even once.

That works because this is a DAG. The node jobs are submitted by DAGMan **on the access point**, so `transfer_input_files` reads the access point's own disk; an ordinary job submitted through this API spools its inputs from a server that shares no filesystem with the access point, and an absolute path there would name nothing.

## Assumptions, and what has not been checked

This app was written for **ap2001** (a CHTC access point) from the two published tutorials. These are the things it assumes and could not verify from here:

- That some execute points visible to the pool advertise `HasAlphafold3` and carry the databases at `/alphafold3`. CHTC publishes a tutorial saying they do; this has not been checked against a live `condor_status`. **Check it before switching the preset.**
- That the pool can fetch `osdf:///osg-public/containers/alphafold3-custom-v6.sif`. CHTC documents `osdf://` as the normal way to name a container image, and `.sif` makes HTCondor add `TARGET.HasSIF` to the requirements by itself.
- That CHTC's GPU slots publish the per-device memory `gpus_minimum_memory` prunes on. CHTC's own documentation tells users to set it, which only works if they do.
- That the two wrapper scripts behave as their tutorials describe. This app calls them; it does not reimplement them, and it does not ship them.
- The `CHTC` preset also carries `+WantGPULab = true`, `+GPUJobLength = "short"` and `want_ospool = true`, which are CHTC's and not AlphaFold3's. A CHTC GPU job without `+WantGPULab` matches nothing at all, and nothing says so.

Site apps are served by the HTCondor HTTP API server. At the time of writing that is enabled on CHTC's **development** API server and not on the production one.

## Deploying

```
make bundle
scp dist/htcondor-site-app-alphafold3.zip* ap.example.edu:/etc/condor/webapps/
```

The bundle's file name is the app's id, so the zip above is served at `/site/htcondor-site-app-alphafold3/`. Your operator writes one file beside it, once:

```yaml
# /etc/condor/webapps/htcondor-site-app-alphafold3.yaml
groups: [your_lab]
enabled: true
```

A bundle with no policy file beside it is not served at all — who may see it is the site's decision, never the bundle's.

## Layout

| Path | What it is |
|---|---|
| `web/src/pipelines/alphafold3/site.ts` | **The one file an operator edits.** What this access point provides. |
| `web/src/pipelines/alphafold3/foldinput.ts` | `fold_input.json`, token counts and the GPU estimate — a port of the tutorial's script |
| `web/src/pipelines/alphafold3/manifest.ts` | Reading the CSV, and every refusal |
| `web/src/pipelines/alphafold3/af3.ts` | The two submit files and the two runner scripts |
| `web/src/pipelines/alphafold3/dag.ts` | The graph, and the edge between the stages |
| `web/src/pipelines/alphafold3/Results.tsx` | What came back, read out of the workflow's shared sandbox |
| `web/src/lib/` | The shell: API client, submit-file escaping, tar reading |
| `AGENTS.md` | Read before writing code, by a person or an assistant |

## Credit

The workflow, the wrapper scripts, the manifest format and the GPU sizing are from the OSPool and CHTC AlphaFold3 tutorials — [osg-htc/tutorial-OSPool-AF3](https://github.com/osg-htc/tutorial-OSPool-AF3) and [CHTC/tutorial-CHTC-AF3](https://github.com/CHTC/tutorial-CHTC-AF3). This app is an interface to them; it is not a fork of them, and nothing of theirs is copied into this repository.

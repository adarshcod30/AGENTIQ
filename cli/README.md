# AGENTIQ CLI

Scan a project folder on your own machine with AGENTIQ, from the terminal. The
CLI talks to the same hosted API as the web app, so a scan you start here also
shows up in your dashboard.

## What it does

You point it at a folder. It reads the source (skipping `node_modules`, build
output, and binaries), uploads it, and runs an assessment: route discovery and
the static security scans. The uploaded code is never run on the server, so the
functional-test phase is skipped, the same as scanning a public GitHub repo.

The code never leaves your machine except as this upload, and only the files
that pass the filters are sent.

## Requirements

Node 18.17 or newer. No install step and no dependencies to pull.

## Use it

From a clone of this repo:

```bash
# 1. Sign in with your AGENTIQ account (saved to ~/.agentiq/config.json)
node cli/bin/agentiq.js login

# 2. Scan a folder and wait for the report
node cli/bin/agentiq.js scan ./my-project
```

Prefer a short command? Install it once, globally:

```bash
npm install -g ./cli    # then just: agentiq scan ./my-project
```

## Commands

| Command | What it does |
| --- | --- |
| `agentiq login` | Sign in with email and password. `--token <t>` saves a token instead; `--api <url>` points at a different backend. |
| `agentiq scan [dir]` | Upload and scan a folder (default: the current one). `--name` sets the project name; `--no-wait` starts the scan and prints the dashboard link instead of waiting. |
| `agentiq whoami` | Show the signed-in account. |
| `agentiq logout` | Forget the saved token. |

## Configuration

| Variable | Purpose |
| --- | --- |
| `AGENTIQ_API` | API base URL. Defaults to the hosted backend. |
| `AGENTIQ_WEB` | Web app base, used to build the dashboard link. |
| `AGENTIQ_PASSWORD` | Non-interactive password for `login` (for CI). |

## Example

```
$ agentiq scan ./my-project
Uploading 42 files from ./my-project (18 skipped)...
Project my-project created.
Assessment 66f0... started.
discovering scanning analyzing reporting
Assessment COMPLETE
Security findings: 1 medium, 2 low
Readiness: ready to deploy
  warning: missing-security-headers: Express app without helmet
Full report: https://.../assessments/66f0...
```

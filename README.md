# Local API Check

**Offline, git-native API testing for VS Code — no account, no cloud sync.**
Write requests in a plain text file in your repo, click to send them, and turn any request into a pass/fail check that runs as a suite.

> _Screenshot / GIF placeholder — a `.api` file with the "▶ Send Request" and "✓ Run Check" CodeLenses, and the output channel showing "3 passed, 1 failed"._

## Why

Your API requests are part of your codebase. They should live next to it, diff in code review, and branch with your feature work — not in a cloud workspace behind a login.

- **100% offline.** The only network traffic is the requests you write and run yourself. No telemetry, no account, no sync.
- **Git-native.** Requests are plain `.api` files. Environments are plain JSON. Review them in a PR like any other file.
- **Checks, not just requests.** An `expect:` block turns a request into a regression test you can run across the whole workspace.
- **Secret-aware.** Paste a token in by accident and you get a nudge plus a one-click fix, not a committed credential.

## Quick start

**1. Create a file ending in `.api`:**

```
### Get a todo
GET {{base_url}}/todos/1
Accept: application/json

expect:
  status: 200
  json_has: ["id", "title"]
```

**2. Set your variables** in `.api-env/local.json` (created for you the first time):

```json
{
  "base_url": "https://jsonplaceholder.typicode.com"
}
```

**3. Run it.** Click **▶ Send Request** above the block to see the full response, or **✓ Run Check** to assert the `expect:` block. The status bar shows the active environment — click it to switch.

**4. Run the suite.** `Local API Check: Run All Checks in File`, or `Run All Checks in Workspace` to run every check in every `.api` file:

```
✓ Todo exists [env: local] — 200 in 214 ms
    GET https://jsonplaceholder.typicode.com/todos/1
✗ Missing todo [env: local] — 404 in 190 ms
    GET https://jsonplaceholder.typicode.com/todos/does-not-exist
    ✗ expected status 200, got 404 Not Found
    ✗ key "id" is missing from the response body — body is an empty object

────────────────────────────────────────────────────────────────
3 passed, 1 failed  (examples/checks.api)
```

## The `.api` format

```
### Create user
POST {{base_url}}/users
Authorization: Bearer {{auth_token}}
Content-Type: application/json

{
  "name": "Test User",
  "email": "test@example.com"
}

expect:
  status: 201
  json_has: ["id"]
```

- Each request starts with `### <name>`.
- The next non-blank line is `METHOD URL` (the method is optional — it defaults to `GET`).
- `Name: value` lines directly under it are headers.
- Everything after the blank line is the body, up to the optional `expect:` block.
- Lines starting with `#` are comments.

### Expectations

The vocabulary is deliberately small:

| Assertion   | Example                          | Passes when                                                     |
| ----------- | -------------------------------- | --------------------------------------------------------------- |
| `status`    | `status: 200`                    | The response status matches exactly.                             |
| `json_has`  | `json_has: ["id", "user.email"]` | The body parses as JSON and every key exists (dot paths and array indexes work: `items.0.id`). |

A request without an `expect:` block is just a request — it is skipped by the check runners.

## Environments

A project has an `.api-env/` folder; each file is a flat JSON object of variables:

```
.api-env/
  local.json          committed — shared, non-secret defaults
  staging.json        committed
  staging.local.json  git-ignored — real secrets
  .gitignore          created for you, ignores *.local.json
```

`{{name}}` is substituted in the URL, headers and body from the active environment. Anything unresolved is reported instead of being sent silently. Keys starting with `_` (like `_comment`) are notes, not variables.

The bundled `.api-env/.gitignore` keeps `*.local.json` out of git. If you would rather manage it from the repo root, add this to your top-level `.gitignore` instead:

```gitignore
.api-env/*.local.json
```

## Secret protection

When you save a `.api` file, it is scanned for things that look like credentials typed in where a `{{variable}}` belongs — bearer and basic auth, API-key headers, `api_key=` in a URL or form body, secrets in a JSON body, and vendor prefixes like `sk-`, `ghp_`, `AIza`, `xoxb-`, `AKIA`.

You get a warning and a quick fix that moves the value into your active environment file and replaces it with `{{auth_token}}` in place. It is always a nudge, never a block — turn it off with `localApiCheck.warnOnHardcodedSecrets`.

## Commands

| Command                                        | What it does                                          |
| ---------------------------------------------- | ----------------------------------------------------- |
| `Local API Check: Run All Checks in File`      | Runs every `expect:` block in the open file.           |
| `Local API Check: Run All Checks in Workspace` | Runs every `expect:` block in every `.api` file.       |
| `Local API Check: Select Environment`          | Switches the active `.api-env` file.                   |
| `Local API Check: Show Output`                 | Opens the output channel.                              |

## Settings

| Setting                                    | Default | What it does                                                      |
| ------------------------------------------ | ------- | ----------------------------------------------------------------- |
| `localApiCheck.requestTimeoutMs`           | `30000` | How long to wait for a response.                                   |
| `localApiCheck.createEnvFolderOnActivate`  | `true`  | Create a starter `.api-env/local.json` in projects without one.    |
| `localApiCheck.warnOnHardcodedSecrets`     | `true`  | Warn about credentials hardcoded into `.api` files.                |

## Privacy

There is no backend. The extension makes exactly the HTTP requests you write and run, using the Node runtime's built-in `fetch`. It collects no telemetry, has no account, and stores nothing outside your project folder.

## License

MIT

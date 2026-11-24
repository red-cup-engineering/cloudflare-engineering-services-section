# cloudflare-tunnel-config-checker-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Verify that a named tunnel's route binding and systemd unit conform to the fixed laptop-owned token-file ingress shape.

## Host parameters

A host's expectations are parameters, not code. Pass them as `--expect-tunnel-name`, `--expect-hostname`, `--expect-service` (and optionally `--expect-fallback`, `--expect-app-service`), or supply them once as a JSON file: `--parameters=PATH` with `tunnelName`, `hostname`, `service` and optionally `fallback` and `appService`. A flag overrides the file. Bare Cedar Fog's parameters live in `561-group/bare-cedar-fog.561.group` at `deployment/ingress/tunnel-parameters.json`.

## Opt-in host binary version qualification

The static route/unit verifier does **not** establish that an installed or running `cloudflared` binary is patched. For a bounded **installed-file** check, add both `--cloudflared-bin=/absolute/path/to/cloudflared` and `--min-cloudflared-version=YYYY.M.P` to the existing `verify-ingress` invocation. For the October 2026 eMudhra certificate compromise, Cloudflare's required floor is **2026.10.2** (or **2026.10.3** for non-Homebrew macOS). See [Cloudflare's 2026-10-20 incident bulletin](https://blog.cloudflare.com/emudhra-certificate-compromise/).

Example: after supplying this service's existing route and unit expectations, append:

```sh
--cloudflared-bin=/home/emsenn/.local/bin/cloudflared \
--min-cloudflared-version=2026.10.2
```

The two arguments must be paired. The verifier runs that exact **absolute** executable with `--version`, without shell or token access, and refuses missing/non-executable binaries, malformed/prerelease versions, old versions, and nonzero exits. Leaving both flags absent keeps the existing route/unit contract unchanged, without implying any binary was checked. Never pass a token value as an argument.

This proves only the tested file's self-reported version. It is **not** a proof that a service's current process executes that file, that every connector on the host was upgraded, or that the tunnel has reconnected and the application has passed its ingress, anonymous-protection and OAuth checks. Those require original host PID, service, route and independent consumer observations. A systemd unit with `--no-autoupdate` cannot be presumed upgraded just because this source was changed.

## Running-process receiving (Linux systemd; source v0.1.2)

The installed-file check above cannot determine whether an **active** service is running a replaced, vulnerable executable. The second opt-in method, `npm run verify-running --` (or `node src/verify-running-cloudflared.mjs`), runs **on the target host** under an account allowed to inspect the named service. It returns a JSON receipt and exits nonzero on refusal. It never modifies services or reads connector tokens.

For the known laptop-owned user unit, run on **Bare Cedar Fog**:

```sh
node src/verify-running-cloudflared.mjs \
  --min-version=2026.10.2 \
  --service=user:bare-cedar-fog-cloudflared.service:/home/emsenn/.local/bin/cloudflared
```

Additional units must be passed as **separate** `--service=user:UNIT.service:/absolute/path/cloudflared` or `--service=system:UNIT.service:/absolute/path/cloudflared` arguments, using their **observed actual systemd scope and executable path**. In particular, the historically documented workers tunnel at `/usr/bin/cloudflared` is a **distinct binary** and must be inspected if still active. Do not infer its current scope, existence or state from the historical repository. An all-green receipt only covers explicitly named units, not an inventory of all connectors.

### Requirement → observation → acceptance

- **CF-RUN-01 / process identity:** query the active systemd service's `MainPID`; obtain the corresponding `/proc/PID/exe` identity, on-disk executable device/inode, and kernel process start-ticks. Reject missing/failed units, unreadable observations, replaced/deleted executable images and mismatched installed/running inode.
- **CF-RUN-02 / patched version:** invoke `/proc/PID/exe --version` without a shell or secrets; require a strict stable `YYYY.M.P` `cloudflared version` output at or above the explicit release floor. A binary merely installed on disk never establishes a passing running version.
- **CF-RUN-03 / temporal stability:** re-read systemd state, PID, process start time, live executable identity and on-disk inode after version execution. Reject restarts, PID reuse and concurrent replacement rather than conferring false acceptance.
- **CF-RUN-04 / bounded, confidential evidence:** require 1–32 distinct exact services and a release floor; emit only a bounded typed JSON result with dated local host, scope, unit, expected binary, qualification/refusal reason and, on success, PID/version. Never serialize tokens, command-line contents, raw unit properties or stderr.
- **CF-RUN-05 / separate recipients:** this qualifies the *named running process only*. External Cloudflare provider route, tunnel reconnection, public `/healthz`, unauthenticated protection and Google OAuth redirect require **independent performed** receiving, not this receipt.

The schema is `cloudflared.running-systemd-qualification/v1`, with `status: qualified|refused`, per-service results, and explicit `coverage: only-explicitly-named-units-on-this-host`. Exit 0 means **only the named process qualifications passed**; exit 1 means at least one refused; exit 2 means invalid input. Permission failure means **unknown/refused**, not vulnerable or patched. A self-reported executable version and inode continuity are not supply-chain attestation. Host process version evidence must be combined with source provenance and independent route/security checks before the original [Bare Cedar Fog ingress security obligation](https://github.com/561-group/561-group-bare-cedar-fog-cloudflare-ingress-services-section/issues/2) can close.

### Qualification and installation gate

`npm run verify` requires both Node syntax checks and the full static/running negative-control suite, with no external dependencies. `.github/workflows/qualify.yml` runs this same command and does not use `continue-on-error`. The runtime suite uses an injected mock inspection adapter; **passing tests do not claim that Bare Cedar Fog was inspected**. The shared method must be built/published, installed by the existing host operator, invoked there, and accompanied by dated operational evidence. It does **not** introduce a scheduler, Office, credentials or alternate authoritative work owner.

## Discover candidate processes before choosing a systemd unit (v0.1.3)

An original host operator cannot qualify an **unknown fleet** by checking only two previously documented executable paths. Run the shared, read-only discovery method on the actual Linux host with `node src/observe-cloudflared-process-candidates.mjs` (or `npm run observe-process-candidates`) *before* selecting named systemd services for the existing runtime qualifier. This is not an upgrade command. Its output is a bounded `cloudflared.process-candidates/v1` receipt listing live `/proc` process candidates whose **kernel comm** equals `cloudflared`; each records PID, executable link, device/inode, and kernel start ticks, not argv, environment, socket, token or credentials. The source uses only Node built-ins.

The discovery refuses to assert completeness: any unreadable process, disappearing process, deleted executable, changing process identity or malformed witness yields `status: partial`. No matches yields `status: no-candidates`, **not** a proof that no connectors are running. Process renaming, process visibility restrictions, containers, other machines and tunnel-specific identity still need their own owner’s inventory; even `status: candidates-observed` means only a bounded observation, not host-wide security qualification. The hard ceiling is 65,536 enumerated PIDs. No separate schedule, Work/Office appointment, cloud account permission or remote command runner is introduced.

For each discovered real service, combine the candidate with **independent systemd unit/scope** identification, and invoke the existing `verify-running` program for that named unit. The original owner must still patch any vulnerable active connector, verify service restart/reconnection, and independently test the public hostname, unauthenticated access controls and OAuth. This operator path carries [the original Bare Cedar Fog security issue](https://github.com/561-group/561-group-bare-cedar-fog-cloudflare-ingress-services-section/issues/2), rather than replacing its Work identity. Never treat source tests, `no-candidates`, or a convenient historical unit list as a fulfilled receiving condition.

## Compose local discovery and running-process qualification (v0.1.4)

The original two tools deliberately stop at different edges: `observe-process-candidates` finds bounded local `/proc` candidates (not all processes/hosts), and `verify-running` requires the operator to supply a source-qualified systemd scope, unit and executable. The new **opt-in read-only** `assay-local` uses their exact existing exports and only the kernel's unified cgroup *candidate* membership to connect these observations.

On the **actual Linux systemd host**, with the permissions necessary to read local `/proc` and inspect the relevant user/system services:

```sh
node src/assay-local-cloudflared.mjs --min-version=2026.10.2
# or: npm run assay-local -- --min-version=2026.10.2
```

It enumerates the already bounded `comm=cloudflared` candidates, requires an unambiguous cgroup v2 service under `system.slice` or `user.slice/user@UID.service`, and treats that as an **untrusted hint**, never an authorization. It checks candidate PID/start ticks/executable inode, reads that service's actual systemd `MainPID`, executes the running image's `--version` through the existing verifier, and rechecks identity and cgroup membership. A wrong `MainPID`, changed image, insufficient version, disappeared process, ambiguous cgroup or unavailable user-systemd bus refuses qualification; it never calls a shell, executes a restart, reads a connector token, or invents a service or Office.

**Contract:** `cloudflared.local-process-systemd-assay/v1` emits a bounded dated host receipt, a source-observation coverage summary, and up to 32 candidate results (`pid`, `unit`, `scope`, `runningVersion` on success, or a stable non-secret refusal). Its only nominal success is `qualified-candidates`: *every currently visible `comm=cloudflared` candidate in this one local scan had a stable matching systemd MainPID and a sufficiently patched running binary*. This is **not** a proof of a fully inventoried fleet; hidden/renamed processes, containers, other hosts and extra replicas remain unknown. `partial` includes missing candidates, incomplete process reads, unsupported cgroup v1 or hybrid paths, malformed or changing observations, and missing permissions. `candidate-qualification-refused` includes known insufficient versions and mismatched running images. Exit 0 means only `qualified-candidates`; any other receipt exits nonzero. Invalid requests exit 2. Never treat `no-candidates` as absence of vulnerable connectors.

### Source-to-operating receiving

- **CF-ASSAY-01:** every candidate originates in the existing process-discovery producer and its bounded observation; output records that scope explicitly.
- **CF-ASSAY-02:** cgroup membership is only a *candidate* systemd attribution, confirmed or refused by the existing running-image verifier and exact PID comparison.
- **CF-ASSAY-03:** process birth identity, executable identity and cgroup membership remain stable before and after the qualification; races cannot become successful observations.
- **CF-ASSAY-04:** errors and receipts do not transmit raw cgroup contents, argv, environment, tokens, stderr or credential-file contents.
- **CF-ASSAY-05:** verified local source tests, package availability, installation on the owning host, actual process inspection, remediation and independent public-route/security/OAuth receiving are **different stages**.

This method serves the existing [Bare Cedar Fog ingress security owner](https://github.com/561-group/561-group-bare-cedar-fog-cloudflare-ingress-services-section/issues/2). The file is not installed merely because its source is on GitHub or GitHub Actions passes. The original host owner must still inventory any active instance outside observed local `/proc`, patch each applicable installation, then independently prove actual tunnel reconnection and protected application behavior before closing that security obligation. No new polling schedule, queue, authority, billing commitment or remote host execution capability is introduced.

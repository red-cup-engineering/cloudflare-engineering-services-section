# Existing Worker version effects

`@red-cup-engineering/cloudflare-services-section/worker-versions` exports a small adapter for one selected existing account and script. It reads the active deployment, immutable version resources, latest uploaded version, non-versioned settings, existing preview configuration, the existing account subdomain, and exact-version module bytes. Its only writes are strict version upload and a single-version 100% deployment. It does not create accounts, bindings, secret values, routes, domains, grants, or preview access.

The application owner must receive the artifact and choose the baseline, traffic policy and recovery conditions. This adapter does not provide a second publisher or a merchant policy engine. It uses the same Cloudflare version API that the owner's existing Wrangler-based release consumes. The static application release remains unchanged and continues to refuse non-assets bindings.

## Provider contracts

The following official contracts were checked on 2026-10-26:

- [Upload Version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/): uploading creates a version without deploying it. `bindings_inherit=strict` rejects unresolved inherited bindings. This script endpoint inherits from the latest uploaded version, which can differ from the deployed version; it rejects an explicit version UUID in an inherit binding.
- [Get Worker Script Version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/): version resources include bindings and runtime configuration; version number is sequential. The caller must select this record through an actual deployment UUID and independently selected version UUID.
- [Get Worker Script Content](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/): the retained legacy content endpoint has no documented version selector or latest-versus-active ownership contract. Surrounding latest-version observations do not establish which version that endpoint returned. Release receiving uses the exact-version operation below instead.
- [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/): a version can be received independently before assigning it production traffic. This adapter does not enable preview URLs when they are absent.

### Response shapes received at the original owner

| Operation | Documented route and consumed resource |
| --- | --- |
| `activeDeployment()` | [List Worker Deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/) returns `result.deployments`; the first entry serves current traffic. This consumer requires one version at 100 percent. |
| `latestVersion()` | [List Versions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/) returns `result.items` with version identity and sequential number. The adapter selects the highest received number. |
| `version(uuid)` | The immutable script-version GET returns `id`, `number` and `resources`, including bindings and runtime configuration. The response identity must equal the requested UUID. |
| `scriptSettings()` | [Get Worker Script Settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/) uses `/script-settings`. Its script-level settings are retained and compared without manufacturing version fields. |
| `subdomain()` | [Get Worker Script Subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/) returns `enabled` and `previews_enabled`. It does not supply `preview_url_suffix`. |
| `accountSubdomain()` | [Get a Workers Subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/) reads `/accounts/{account}/workers/subdomain` and receives its existing `subdomain` label. No creation or update route is called. |
| `versionModules(uuid)` | [Get Worker Version](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/) reads `/accounts/{account}/workers/workers/{existing-name}/versions/{uuid}?include=modules`. The documented Worker identifier accepts its existing name. The result UUID must agree; each module carries `name`, `content_type` and `content_base64`. |
| `uploadVersion()` | The existing strict-inherit version POST carries the module and metadata. An upload response can omit its optional sequential number; the consumer receives sequence from its already-required immutable version GET. |
| `deployVersion()` | [Create Worker Deployment](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/) uses the existing percentage strategy and selected version at 100 percent, with a bounded message. The returned deployment is received again through the active deployment read. |

`workerVersionPreviewOrigin` is pure URL derivation from the selected version UUID, original script name and separately received account subdomain. It uses the version's first eight characters and strict DNS labels. The script's `enabled` flag and version `previews_enabled` flag are distinct. Neither a fabricated suffix nor the beta Worker resource's differently located field substitutes for account metadata.

`versionModules` bounds decoded module bytes to 32 MiB in aggregate. Its JSON response limit allows the corresponding base64 expansion plus the existing 4 MiB metadata bound. It checks the version UUID, a bounded nonempty module set and unique module names, then decodes base64 with a canonical round-trip check. Whitespace, skipped characters, wrong padding and ambiguous encodings are refused. The application still compares the returned bytes to its selected artifact. Module labels are transport metadata rather than code identity.

The Market consumer receives this exact-version read capability on the already active baseline before any upload, without inventing a Git identity for those baseline bytes. It additionally checks that the selected active version is also latest before upload, and that the immutable staged version's number is exactly the following one. A concurrent upload cannot silently become the inheritance source and then pass that receiving check. Immutable bindings and runtime fields are compared again before promotion. Secrets are inherited within the provider; their values are never read into receipts or logs.

These API operations offer no compare-and-swap deployment lease. Applications must re-read immediately before each write, identify their own deployment, and refuse a rollback that would overwrite another deployment. Agreement between observations is bounded evidence, not an atomic concurrency guarantee.

## Failure behavior

Writes are never automatically retried. A transport or JSON failure can leave the effect unknown; the caller must observe the provider before choosing recovery. Errors retain only local classification, HTTP status and numeric provider codes. They never include tokens, request headers, raw provider bodies, or transport causes.

Direct receiving cases are in `test/worker-versions.test.mjs`. Run the file directly when a surrounding test harness reports only child-file counts, so the declared cases and assertions are visible.

## Source receiving, 2026-10-26

`node --test test/worker-versions.test.mjs` passed all 14 declared cases, with none skipped. The original Market receiver's focused source suite passed all 33 cases against this exact supplier candidate. These are injected local HTTP-envelope and release-state fixtures; they do not claim authenticated provider access or production deployment.

A separate local envelope assay returned the actual 18,811,507-byte Market Worker, SHA-256 `a376008fd24fea1153653cbdbc5651824084897eb6fea6e2f8f8513405defdcf`, through `versionModules`. Its canonical base64 response exceeded the ordinary 4 MiB JSON bound and decoded to the exact original bytes under the specialized module bound. It made one fixture call and zero external calls. That Worker remains the original `005c6c637acbac6b5076d1350c86861b9aa82e8d` artifact; this assay does not rebind it to the later supplier repair. The actual account capability and next release remain separate receiving obligations.

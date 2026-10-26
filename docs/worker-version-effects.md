# Existing Worker version effects

`@red-cup-engineering/cloudflare-services-section/worker-versions` exports a small adapter for one selected existing account and script. It reads the active deployment, immutable version resources, latest uploaded version, non-versioned settings, existing preview configuration, and current module content. Its only writes are strict version upload and a single-version 100% deployment. It does not create accounts, bindings, secret values, routes, domains, grants, or preview access.

The application owner must receive the artifact and choose the baseline, traffic policy and recovery conditions. This adapter does not provide a second publisher or a merchant policy engine. It uses the same Cloudflare version API that the owner's existing Wrangler-based release consumes. The static application release remains unchanged and continues to refuse non-assets bindings.

## Provider contracts

The following official contracts were checked on 2026-10-26:

- [Upload Version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/): uploading creates a version without deploying it. `bindings_inherit=strict` rejects unresolved inherited bindings. This script endpoint inherits from the latest uploaded version, which can differ from the deployed version; it rejects an explicit version UUID in an inherit binding.
- [Get Worker Script Version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/): version resources include bindings and runtime configuration; version number is sequential. The caller must select this record through an actual deployment UUID and independently selected version UUID.
- [Get Worker Script Content](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/): the content endpoint has no documented version parameter. A receiver must bracket a content read with latest-version observations, then compare the actual module bytes. Multipart field names do not identify code.
- [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/): a version can be received independently before assigning it production traffic. This adapter does not enable preview URLs when they are absent.

The Market consumer additionally checks that the selected active version is also latest before upload, and that its new version number is exactly the following one. A concurrent upload cannot silently become the inheritance source and then pass that receiving check. Immutable bindings and runtime fields are compared again before promotion. Secrets are inherited within the provider; their values are never read into receipts or logs.

These API operations offer no compare-and-swap deployment lease. Applications must re-read immediately before each write, identify their own deployment, and refuse a rollback that would overwrite another deployment. Agreement between observations is bounded evidence, not an atomic concurrency guarantee.

## Failure behavior

Writes are never automatically retried. A transport or JSON failure can leave the effect unknown; the caller must observe the provider before choosing recovery. Errors retain only local classification, HTTP status and numeric provider codes. They never include tokens, request headers, raw provider bodies, or transport causes.

Direct receiving cases are in `test/worker-versions.test.mjs`. Run the file directly when a surrounding test harness reports only child-file counts, so the declared cases and assertions are visible.

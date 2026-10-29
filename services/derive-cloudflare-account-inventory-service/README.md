# @red-cup-engineering/derive-cloudflare-account-inventory-service

Derives one CloudflareAccountInventory record -- zones, their DNS records, Workers scripts, and Workers custom domains -- for one Cloudflare account, reading the API token from the named environment variable and refusing rather than throwing on an unset token or a non-success API body.

## Operation

~~~js
export async function deriveCloudflareAccountInventory(request)
~~~

### Parameters

- request (@param {string} request.accountId The Cloudflare account id, exactly 32 hexadecimal characters.
 * @param {string} request.tokenEnvironmentVariable The name of the environment variable holding the Cloudflare API token (e.g. "CLOUDFLARE_API_TOKEN"); the token itself is read from `process.env`, never accepted directly.
 * @param {typeof fetch} [request.fetch] An injectable fetch implementation, defaulting to the global fetch, for deterministic tests.
 * ): A DeriveCloudflareAccountInventoryRequest.

### Returns

Promise<object>: A CloudflareAccountInventory record on success, or a CloudflareAccountInventoryRefusal datum carrying code `TOKEN_ENVIRONMENT_VARIABLE_UNSET` or `CLOUDFLARE_API_REFUSED`.

### Refusals

- TypeError: When `request` is not a JSON object, `request.accountId` is not 32 hexadecimal characters, or `request.tokenEnvironmentVariable` is not a non-empty string.

## Command

derive-cloudflare-account-inventory reads one JSON value per input line and writes one JSON value per output line.

## Examples

### refuses TOKEN_ENVIRONMENT_VARIABLE_UNSET when the named environment variable is unset

Input:

~~~json
{
  "accountId": "337e54ee6dc7d488933f473204a6d89e",
  "tokenEnvironmentVariable": "CLOUDFLARE_API_TOKEN_UNSET_EXAMPLE"
}
~~~

Output:

~~~json
{
  "type": "CloudflareAccountInventoryRefusal",
  "code": "TOKEN_ENVIRONMENT_VARIABLE_UNSET",
  "tokenEnvironmentVariable": "CLOUDFLARE_API_TOKEN_UNSET_EXAMPLE"
}
~~~

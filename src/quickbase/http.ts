/**
 * fetch() factory with corporate-proxy support.
 *
 * Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set
 * (and only on recent Node versions). Many corporate networks require a proxy,
 * so when a proxy variable is present we use undici's own fetch with
 * EnvHttpProxyAgent, which honors HTTPS_PROXY / HTTP_PROXY / NO_PROXY.
 * Corporate TLS inspection certificates are picked up via NODE_EXTRA_CA_CERTS.
 */

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function hasProxyEnv(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

export function createFetch(env: Record<string, string | undefined> = process.env): FetchLike {
  if (!hasProxyEnv(env) || env.NODE_USE_ENV_PROXY === '1') {
    return (input, init) => fetch(input, init);
  }
  const dispatcher = new EnvHttpProxyAgent();
  return (input, init) =>
    undiciFetch(input as string, { ...(init as Record<string, unknown>), dispatcher } as never) as unknown as Promise<Response>;
}

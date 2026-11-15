/** Loopback hosts, where plain HTTP is acceptable for local development and tests. */
export function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
}

export function publicWebUrl(publicBaseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  try {
    const url = new URL(publicBaseUrl);
    if (url.hostname.startsWith('api.')) {
      url.hostname = url.hostname.slice(4);
    }
    url.pathname = normalizedPath;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `https://deepmarks.org${normalizedPath}`;
  }
}

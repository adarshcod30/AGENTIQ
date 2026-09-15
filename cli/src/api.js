/**
 * The one place the CLI talks to the AGENTIQ API. Every server response is the
 * shape { success, data } (or { success:false, error }), so this unwraps `data`
 * and turns a non-2xx into an Error carrying the server's own message.
 */
export async function api(base, method, pathName, { token, body } = {}) {
  let res;
  try {
    res = await fetch(base + pathName, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Could not reach ${base} (${err.message}). Check the URL or your connection.`);
  }
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = json?.error?.code;
    throw err;
  }
  return json.data ?? json;
}

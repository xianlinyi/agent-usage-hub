async function post(config, token, endpoint, payload) {
  if (!token) throw new Error(`Push token is missing; set ${config.tokenEnv || 'AGENT_USAGE_PUSH_TOKEN'} or tokenFile`);
  const url = new URL(config.serverUrl);
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !config.allowInsecureHttp) {
    throw new Error('Remote push requires HTTPS (or explicit allowInsecureHttp)');
  }
  const response = await fetch(new URL(endpoint, config.serverUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Push failed (${response.status}): ${body.error || 'unknown error'}`);
  return body;
}

export function pushEvents(config, token, events) {
  return post(config, token, '/api/v1/events', { collectorId: config.collectorId, events });
}

export function beginFile(config, token, source, fileKey, generation) {
  return post(config, token, '/api/v1/files/begin', { collectorId: config.collectorId, source, fileKey, generation });
}

export function pushFileEvents(config, token, source, fileKey, generation, events) {
  return post(config, token, '/api/v1/files/events', { collectorId: config.collectorId, source, fileKey, generation, events });
}

export function finishFile(config, token, source, fileKey, generation) {
  return post(config, token, '/api/v1/files/finish', { collectorId: config.collectorId, source, fileKey, generation });
}

export function pushSnapshot(config, token, source, period, events) {
  return post(config, token, '/api/v1/snapshots', { collectorId: config.collectorId, source, period, events });
}

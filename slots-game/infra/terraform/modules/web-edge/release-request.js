import cf from 'cloudfront';

const store = cf.kvs();
const releasePattern = /^sha256:[0-9a-f]{64}$/;

async function handler(event) {
  const request = event.request;
  const cookie = request.cookies['slots-release'];
  let releaseId = cookie && releasePattern.test(cookie.value) ? cookie.value : '';

  if (!releaseId) {
    try {
      releaseId = await store.get('active-release');
    } catch (error) {
      return {
        statusCode: 503,
        statusDescription: 'Release Not Ready',
        headers: {
          'cache-control': { value: 'no-store' },
          'content-type': { value: 'text/plain; charset=utf-8' }
        },
        body: 'release is not ready'
      };
    }
  }

  if (!releasePattern.test(releaseId)) {
    return {
      statusCode: 503,
      statusDescription: 'Invalid Release',
      headers: {
        'cache-control': { value: 'no-store' },
        'content-type': { value: 'text/plain; charset=utf-8' }
      },
      body: 'release identity is invalid'
    };
  }

  if (request.uri.startsWith('/releases/')) {
    return request;
  }

  let path = request.uri;
  if (path === '/' || path.endsWith('/')) {
    path += 'index.html';
  }

  request.uri = `/releases/${releaseId}${path}`;
  request.headers['x-slots-release-id'] = { value: releaseId };
  return request;
}

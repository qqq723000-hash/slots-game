function handler(event) {
  const request = event.request;
  const response = event.response;
  const releaseHeader = request.headers['x-slots-release-id'];

  if (releaseHeader) {
    response.cookies['slots-release'] = {
      value: releaseHeader.value,
      attributes: 'Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=None; Partitioned'
    };
  }

  return response;
}

export function createTrustedDenoServeHandler(handler) {
  return (request, info) => {
    const hostname = typeof info?.remoteAddr?.hostname === "string"
      ? info.remoteAddr.hostname.trim()
      : "";
    return handler(request, {
      trustedNetworkIdentity: hostname,
    });
  };
}

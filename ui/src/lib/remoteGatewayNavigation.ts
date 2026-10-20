export function isRemoteGatewayNavigationPending(
  currentOrigin: string,
  remoteUrl: string | null | undefined
): boolean {
  if (!remoteUrl) return false;
  try {
    return currentOrigin !== new URL(remoteUrl).origin;
  } catch {
    return false;
  }
}

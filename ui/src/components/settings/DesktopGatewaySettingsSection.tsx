import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { RemoteGatewayForm } from "@/components/settings/RemoteGatewayForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { gatewayStartupPollInterval, readGatewayStartupStatus } from "@/lib/desktopGatewayStartup";
import { isTauriDesktopRuntime } from "@/lib/desktopHost";

export function DesktopGatewaySettingsSection() {
  const enabled = isTauriDesktopRuntime();
  const statusQuery = useQuery({
    queryKey: ["desktop", "gateway-startup"],
    queryFn: readGatewayStartupStatus,
    refetchInterval: gatewayStartupPollInterval(enabled),
    staleTime: 0,
  });

  if (!enabled) return null;
  const status = statusQuery.data;
  if (!status?.supportsRemote) return null;

  return (
    <Card variant="liquid">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="w-5 h-5 text-cyan-400" />
          Desktop gateway
        </CardTitle>
        <CardDescription>
          This desktop build is &ldquo;{status.variant}&rdquo;. Point it at a remote Cybara server,
          or keep using the bundled local gateway.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RemoteGatewayForm
          currentUrl={status.remoteUrl}
          supportsSidecar={status.supportsSidecar}
          connectLabel="Connect to server"
        />
        <p className="mt-3 text-xs text-gray-500">
          Current mode: <span className="font-mono">{status.ownership}</span>.
        </p>
      </CardContent>
    </Card>
  );
}

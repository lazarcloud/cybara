import { Server } from "lucide-react";
import { RemoteGatewayForm } from "@/components/settings/RemoteGatewayForm";

interface RemoteGatewayPromptProps {
  supportsSidecar?: boolean;
}

/**
 * First-run screen shown by a remote-only desktop build before a server URL has
 * been configured. Mirrors the layout of GatewayStartupFailure.
 */
export function RemoteGatewayPrompt({ supportsSidecar = false }: RemoteGatewayPromptProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-card-foreground shadow-xl">
        <div className="flex items-start gap-3">
          <Server className="mt-0.5 h-5 w-5 shrink-0 text-cyan-400" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold">Connect to your Cybara server</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              This build does not bundle a local gateway. Enter the URL of the Cybara server this
              app should use.
            </p>
          </div>
        </div>
        <div className="mt-5">
          <RemoteGatewayForm supportsSidecar={supportsSidecar} />
        </div>
      </div>
    </div>
  );
}

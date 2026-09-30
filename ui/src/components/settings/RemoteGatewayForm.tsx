import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { setRemoteGatewayUrl, switchToLocalServer } from "@/lib/desktopGatewayStartup";

interface RemoteGatewayFormProps {
  currentUrl?: string | null;
  supportsSidecar?: boolean;
  connectLabel?: string;
  onConnected?: () => void;
}

export function RemoteGatewayForm({
  currentUrl,
  supportsSidecar = false,
  connectLabel = "Connect to server",
  onConnected,
}: RemoteGatewayFormProps) {
  const [url, setUrl] = useState(currentUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await setRemoteGatewayUrl(url.trim());
    if (result) {
      setError(result);
      setBusy(false);
      return;
    }
    setBusy(false);
    onConnected?.();
  }

  async function goLocal(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await switchToLocalServer();
    if (result) {
      setError(result);
      setBusy(false);
      return;
    }
    setBusy(false);
    onConnected?.();
  }

  return (
    <div className="space-y-3">
      <Input
        label="Cybara server URL"
        placeholder="https://cybara.example.com"
        value={url}
        disabled={busy}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void connect();
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void connect()} disabled={busy || !url.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {connectLabel}
        </Button>
        {supportsSidecar ? (
          <Button variant="secondary" onClick={() => void goLocal()} disabled={busy}>
            Use local gateway
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

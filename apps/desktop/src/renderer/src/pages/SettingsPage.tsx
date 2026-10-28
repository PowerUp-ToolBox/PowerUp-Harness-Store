import { useEffect, useState } from 'react';

// Placeholder: language and diagnostics arrive in P0-04.2 and P0-04.3, the rest in P0-11. The
// version line already comes from the Runtime over IPC (`app.ping`).
export function SettingsPage() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void window.api.app.ping().then((result) => {
      if (current && result.ok) setVersion(result.data.version);
    });
    return () => {
      current = false;
    };
  }, []);
  return <p className="placeholder">{version === null ? null : `Version ${version}`}</p>;
}

import { useParams } from 'react-router';

// Placeholder: the Harness detail page arrives in P0-09. The splat holds the Harness ID
// (`publisher/slug`).
export function HarnessDetailPage() {
  const harnessId = useParams()['*'] ?? '';
  return (
    <p className="placeholder">
      Harness <code>{harnessId}</code>
    </p>
  );
}

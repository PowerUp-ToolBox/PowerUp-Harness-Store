import { useParams } from 'react-router';

// Placeholder: the Publisher page arrives in P0-09.
export function PublisherPage() {
  const login = useParams().login ?? '';
  return (
    <p className="placeholder">
      Publisher <code>{login}</code>
    </p>
  );
}

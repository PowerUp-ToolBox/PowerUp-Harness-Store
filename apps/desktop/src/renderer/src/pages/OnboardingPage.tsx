import { Link } from 'react-router';

// Placeholder: the first-run wizard arrives in P0-04.5. It fills the window, without the sidebar.
export function OnboardingPage() {
  return (
    <main className="onboarding">
      <h1>Welcome to Harness Store</h1>
      <Link to="/library">Skip setup</Link>
    </main>
  );
}

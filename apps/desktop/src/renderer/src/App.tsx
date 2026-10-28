import { Navigate, Route, Routes } from 'react-router';
import { HarnessDetailPage } from './pages/HarnessDetailPage.js';
import { LibraryPage } from './pages/LibraryPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
import { OnboardingPage } from './pages/OnboardingPage.js';
import { PublisherPage } from './pages/PublisherPage.js';
import { PublishPage } from './pages/PublishPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { StorePage } from './pages/StorePage.js';
import { UsagePage } from './pages/UsagePage.js';
import { Shell } from './shell/Shell.js';

/**
 * The route table. Routes live in the URL hash (`#/store`), so the renderer is one page that never
 * navigates. A Harness ID contains a slash (`publisher/slug`), so the detail route is a splat.
 * The first-run wizard fills the window without the sidebar.
 */
export function App() {
  return (
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route element={<Shell />}>
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/store" element={<StorePage />} />
        <Route path="/store/h/*" element={<HarnessDetailPage />} />
        <Route path="/store/p/:login" element={<PublisherPage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/publish" element={<PublishPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/library" replace />} />
    </Routes>
  );
}

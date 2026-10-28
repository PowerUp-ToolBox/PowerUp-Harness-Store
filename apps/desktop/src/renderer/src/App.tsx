import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router';
import { StoreGate } from './connectivity/StoreGate.js';
import { useSettings } from './i18n/I18nProvider.js';
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
 * The first-run wizard fills the window without the sidebar. Store routes show the offline panel
 * instead of their screen while the Store is unreachable. `/` and unknown routes go to the Library,
 * or to the wizard until it has been completed or skipped once; the last route is not kept, so
 * every launch starts there.
 */
export function App() {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const home = settings.onboardingDone ? '/library' : '/onboarding';
  // A Harness window's model indicator shows the Models page at its Harness's card.
  useEffect(
    () =>
      window.api.on('app.navigate', ({ path }) => {
        void navigate(path);
      }),
    [navigate],
  );
  return (
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route element={<Shell />}>
        <Route path="/library" element={<LibraryPage />} />
        <Route element={<StoreGate />}>
          <Route path="/store" element={<StorePage />} />
          <Route path="/store/h/*" element={<HarnessDetailPage />} />
          <Route path="/store/p/:login" element={<PublisherPage />} />
        </Route>
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/publish" element={<PublishPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}

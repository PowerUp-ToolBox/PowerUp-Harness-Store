import { HashRouter } from 'react-router';
import { App } from './App.js';
import { ConnectivityProvider } from './connectivity/ConnectivityProvider.js';
import { I18nProvider } from './i18n/I18nProvider.js';
import { StartupGate } from './startup/StartupGate.js';

/**
 * The renderer's root: the language comes first (even the startup error screen is localized),
 * then the Runtime's startup status, then the Store's connectivity and the hash-routed app.
 */
export function Root() {
  return (
    <I18nProvider>
      <StartupGate>
        <ConnectivityProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ConnectivityProvider>
      </StartupGate>
    </I18nProvider>
  );
}

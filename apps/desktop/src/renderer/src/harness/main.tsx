import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import '../styles.css';
import { HarnessWindowApp } from './HarnessWindowApp.js';

const root = document.getElementById('root');
if (root === null) throw new Error('harness.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <HarnessWindowApp />
  </StrictMode>,
);

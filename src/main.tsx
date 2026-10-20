import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initDb } from './store/db';
import { App } from './ui/App';
import { AppProvider } from './ui/state';
import './ui/theme.css';

initDb()
  .catch((e) => console.error('IndexedDB init failed', e))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <AppProvider>
          <App />
        </AppProvider>
      </StrictMode>,
    );
  });

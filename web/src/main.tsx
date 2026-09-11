import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';
import { ensureSessionId, setUnauthorizedHandler } from './services/api';
import { useAuthStore } from './store/auth';
import { useToastStore } from './store/toast';
import './index.css';

ensureSessionId();

// docs/03_App_Flow.md A2: a 401 from any API call clears auth, redirects to
// login, and toasts "Session expired".
setUnauthorizedHandler(() => {
  if (!useAuthStore.getState().token) return;
  useAuthStore.getState().signOut();
  useToastStore.getState().push('warning', 'Session expired. Please sign in again.');
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

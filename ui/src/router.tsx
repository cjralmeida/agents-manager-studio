import { createBrowserRouter } from 'react-router';
import { Layout } from './components/Layout';
import { PagePlaceholder } from './components/PagePlaceholder';
import { DashboardPage } from './pages/DashboardPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { WorkspacesPage } from './pages/WorkspacesPage';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'workspaces', element: <WorkspacesPage /> },
      { path: 'workspaces/:workspaceId', element: <WorkspacePage /> },
      {
        path: 'settings',
        element: <PagePlaceholder title="Configurações" description="Disponível na Fase 2." />,
      },
    ],
  },
]);

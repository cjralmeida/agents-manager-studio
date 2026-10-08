import { createBrowserRouter } from 'react-router';
import { Layout } from './components/Layout';
import { PagePlaceholder } from './components/PagePlaceholder';
import { DashboardPage } from './pages/DashboardPage';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <DashboardPage /> },
      {
        path: 'workspaces',
        element: <PagePlaceholder title="Workspaces" description="Disponível na Fase 1." />,
      },
      {
        path: 'settings',
        element: <PagePlaceholder title="Configurações" description="Disponível na Fase 2." />,
      },
    ],
  },
]);

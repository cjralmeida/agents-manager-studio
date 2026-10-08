import { createBrowserRouter } from 'react-router';
import { Layout } from './components/Layout';
import { AgentPage } from './pages/AgentPage';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { WorkspacesPage } from './pages/WorkspacesPage';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'workspaces', element: <WorkspacesPage /> },
      { path: 'workspaces/:workspaceId', element: <WorkspacePage /> },
      { path: 'agents/:agentId', element: <AgentPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

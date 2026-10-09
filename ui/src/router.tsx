import { createBrowserRouter } from 'react-router';
import { Layout } from './components/Layout';
import { AgentPage } from './pages/AgentPage';
import { AgentProfilePage } from './pages/AgentProfilePage';
import { BoardPage } from './pages/BoardPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
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
      { path: 'workspaces/:workspaceId/agents/:profileKey', element: <AgentProfilePage /> },
      { path: 'agents/:agentId', element: <AgentPage /> },
      { path: 'board', element: <BoardPage /> },
      { path: 'connectors', element: <ConnectorsPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

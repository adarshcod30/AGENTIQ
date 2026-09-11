/**
 * Routing: React Router 7, createBrowserRouter (docs/02_TRD.md §3).
 * Sitemap per docs/03_App_Flow.md A1.
 */
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Shell } from '@/components/layout/Shell';
import { RequireAuth } from '@/components/layout/RequireAuth';
import { ComponentGallery } from '@/pages/ComponentGallery';
import { DeployPage } from '@/pages/DeployPage';
import { GoogleSuccessPage } from '@/pages/GoogleSuccessPage';
import { VerifyEmailPage } from '@/pages/VerifyEmailPage';
import { LoginPage } from '@/pages/LoginPage';
import { TestRunnerPage } from '@/pages/TestRunnerPage';
import { RunDetailPage } from '@/pages/RunDetailPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { SpecsPage } from '@/pages/SpecsPage';
import { ToolRegistryPage } from '@/pages/ToolRegistryPage';
import { AuditLogPage } from '@/pages/AuditLogPage';
import { AboutPage } from '@/pages/AboutPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { SecurityPage } from '@/pages/SecurityPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ApiClientPage } from '@/pages/ApiClientPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { AssessmentDetailPage } from '@/pages/AssessmentDetailPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <LoginPage signup /> },
  // Both are PUBLIC on purpose: the Google redirect arrives before a session
  // exists, and a verification link is often opened on a different device.
  { path: '/google-success', element: <GoogleSuccessPage /> },
  { path: '/verify', element: <VerifyEmailPage /> },

  // Development route: renders the component library, no data.
  { path: '/dev/components', element: <ComponentGallery /> },

  {
    path: '/',
    element: <RequireAuth><Shell /></RequireAuth>,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'assessments/:id', element: <AssessmentDetailPage /> },
      { path: 'run', element: <TestRunnerPage /> },
      { path: 'run/:id', element: <RunDetailPage /> },
      { path: 'security', element: <SecurityPage /> },
      { path: 'specs', element: <SpecsPage /> },
      { path: 'client', element: <ApiClientPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'deploy', element: <DeployPage /> },
      { path: 'tools', element: <ToolRegistryPage /> },
      { path: 'audit', element: <AuditLogPage /> },
      { path: 'about', element: <AboutPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },

  { path: '*', element: <Navigate to="/dashboard" replace /> },
]);

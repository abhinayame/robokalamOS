import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './components/Layout';
import { Skeleton } from './components/ui';
import Account from './pages/Account';
import Audit from './pages/Audit';
import SystemStatus from './pages/SystemStatus';
import Fees from './pages/Fees';
import Branding from './pages/Branding';
import MyFees from './pages/MyFees';
import Reminders from './pages/Reminders';
import ImportLearners from './pages/ImportLearners';
import BatchDetail from './pages/BatchDetail';
import Batches from './pages/Batches';
import Catalog from './pages/Catalog';
import Dashboard from './pages/Dashboard';
import Learner360 from './pages/Learner360';
import Learners from './pages/Learners';
import Login from './pages/Login';
import Classrooms from './pages/Classrooms';
import Classroom from './pages/Classroom';
import Assignment from './pages/Assignment';
import Achievements from './pages/Achievements';
import Gamification from './pages/Gamification';
import Analytics from './pages/Analytics';
import Reports from './pages/Reports';
import Communication from './pages/Communication';
import CampaignDetail from './pages/CampaignDetail';
import Leads from './pages/Leads';
import FollowUps from './pages/FollowUps';
import Tags from './pages/Tags';
import Notifications from './pages/Notifications';
import Portal from './pages/Portal';
import QuizPage from './pages/QuizPage';
import MyAssignments from './pages/MyAssignments';
import MyClasses from './pages/MyClasses';
import Organizations from './pages/Organizations';
import Parents from './pages/Parents';
import Teachers from './pages/Teachers';
import Users from './pages/Users';
import Certificates from './pages/Certificates';
import MyCertificates from './pages/MyCertificates';
import VerifyCertificate from './pages/VerifyCertificate';
import { ForgotPassword, ResetPassword } from './pages/PasswordReset';
import { ErrorState } from './components/ui';
import { ApiError } from './api';
import type { ReactNode } from 'react';

function Guard({ perm, roles, children }: { perm?: string; roles?: string[]; children: ReactNode }) {
  const { can, hasRole } = useAuth();
  if ((perm && !can(perm)) || (roles && !hasRole(...roles))) return <ErrorState error={new ApiError(403, 'FORBIDDEN', 'Your role does not include this area.')} />;
  return <>{children}</>;
}

export default function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  // Pages that work without signing in (certificate check, password reset).
  if (loc.pathname === '/verify' || loc.pathname.startsWith('/verify/')) return <Routes><Route path="/verify/:code?" element={<VerifyCertificate />} /></Routes>;
  if (!me && !loading && loc.pathname === '/forgot-password') return <ForgotPassword />;
  if (!me && !loading && loc.pathname === '/reset-password') return <ResetPassword />;
  if (loading) return <div style={{ padding: 40 }}><Skeleton h={24} w={240} /></div>;
  if (!me) return loc.pathname === '/login' ? <Login /> : <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (loc.pathname === '/login') return <Navigate to="/" replace />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="learners" element={<Guard perm="learner:read"><Learners /></Guard>} />
        <Route path="learners/import" element={<Guard perm="learner:create"><ImportLearners /></Guard>} />
        <Route path="learners/:id" element={<Learner360 />} />
        <Route path="parents" element={<Guard perm="parent:read"><Parents /></Guard>} />
        <Route path="batches" element={<Guard perm="batch:read"><Batches /></Guard>} />
        <Route path="batches/:id" element={<BatchDetail />} />
        <Route path="classes" element={<MyClasses />} />
        <Route path="fees" element={<Guard perm="fee:read"><Fees /></Guard>} />
        <Route path="certificates" element={<Guard perm="cert:read"><Certificates /></Guard>} />
        <Route path="my-certificates" element={<Guard roles={['learner', 'parent']}><MyCertificates /></Guard>} />
        <Route path="my-fees" element={<Guard roles={['learner', 'parent']}><MyFees /></Guard>} />
        <Route path="settings/branding" element={<Guard perm="org:manage"><Branding /></Guard>} />
        <Route path="settings/reminders" element={<Guard perm="comms:read"><Reminders /></Guard>} />
        <Route path="classroom" element={<Guard perm="classroom:read"><Classrooms /></Guard>} />
        <Route path="classroom/:batchId" element={<Guard perm="classroom:read"><Classroom /></Guard>} />
        <Route path="assignments" element={<Guard roles={['learner', 'parent']}><MyAssignments /></Guard>} />
        <Route path="achievements" element={<Guard roles={['learner', 'parent']}><Achievements /></Guard>} />
        <Route path="gamification" element={<Guard perm="gamification:award"><Gamification /></Guard>} />
        <Route path="analytics" element={<Guard perm="report:read"><Analytics /></Guard>} />
        <Route path="reports" element={<Guard perm="report:read"><Reports /></Guard>} />
        <Route path="communication" element={<Guard perm="comms:announce"><Communication /></Guard>} />
        <Route path="communication/campaigns/:id" element={<Guard perm="comms:read"><CampaignDetail /></Guard>} />
        <Route path="crm" element={<Guard perm="crm:read"><Leads /></Guard>} />
        <Route path="crm/follow-ups" element={<Guard perm="crm:read"><FollowUps /></Guard>} />
        <Route path="settings/tags" element={<Guard perm="tag:read"><Tags /></Guard>} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="portal" element={<Guard roles={['parent', 'learner']}><Portal /></Guard>} />
        <Route path="quizzes/:id" element={<Guard perm="classroom:read"><QuizPage /></Guard>} />
        <Route path="assignments/:id" element={<Guard perm="classroom:read"><Assignment /></Guard>} />
        <Route path="teachers" element={<Guard perm="teacher:read"><Teachers /></Guard>} />
        <Route path="settings/catalog" element={<Guard perm="catalog:read"><Catalog /></Guard>} />
        <Route path="settings/users" element={<Guard perm="user:manage"><Users /></Guard>} />
        <Route path="settings/system" element={<Guard perm="system:read"><SystemStatus /></Guard>} />
        <Route path="settings/audit" element={<Guard perm="audit:read"><Audit /></Guard>} />
        <Route path="organizations" element={<Guard roles={['super_admin']}><Organizations /></Guard>} />
        <Route path="account" element={<Account />} />
        <Route path="*" element={<ErrorState error={new ApiError(404, 'NOT_FOUND', 'That page does not exist.')} />} />
      </Route>
    </Routes>
  );
}

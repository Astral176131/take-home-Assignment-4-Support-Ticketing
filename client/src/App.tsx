import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { AlertsProvider } from './context/AlertsContext';
import { UnassignedProvider } from './context/UnassignedContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { QueuePage } from './pages/QueuePage';
import { TicketDetailPage } from './pages/TicketDetailPage';
import { NewTicketPage } from './pages/NewTicketPage';
import { MyTicketsPage } from './pages/MyTicketsPage';
import { AlertsPage } from './pages/AlertsPage';
import { UnassignedPage } from './pages/UnassignedPage';
import { NotFoundPage } from './pages/NotFoundPage';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              // Inside ProtectedRoute: the provider fetches alerts on mount, and there is
              // nothing to fetch until someone is signed in.
              <ProtectedRoute>
                <AlertsProvider>
                  <UnassignedProvider>
                    <Layout />
                  </UnassignedProvider>
                </AlertsProvider>
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="tickets" element={<QueuePage />} />
            {/* A separate path, not /tickets/mine, which would match the :id route. */}
            <Route path="my-tickets" element={<MyTicketsPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="unassigned" element={<UnassignedPage />} />
            {/* Declared before the :id route so "new" isn't read as a ticket id. */}
            <Route path="tickets/new" element={<NewTicketPage />} />
            <Route path="tickets/:id" element={<TicketDetailPage />} />
            {/* Nested inside the layout so an unknown address still arrives with
                the nav, rather than dumping the user on a bare page. It used to
                redirect to the dashboard, which made a dead link and a working
                one indistinguishable. */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

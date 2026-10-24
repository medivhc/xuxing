import { NavLink, Route, Routes } from 'react-router-dom';
import { AuthGate } from './components/AuthGate';
import { ConnectionBadge } from './components/ConnectionBadge';
import { HomePage } from './pages/HomePage';
import { CapturePage } from './pages/CapturePage';
import { ProposalPage } from './pages/ProposalPage';
import { MyActionsPage } from './pages/MyActionsPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { NotFoundPage } from './pages/NotFoundPage';

const navItems = [
  { to: '/', label: '首页' },
  { to: '/capture', label: '快速捕获' },
  { to: '/actions', label: '待我处理' },
  { to: '/projects', label: '项目' },
];

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-sticky border-b border-border bg-surface">
        <div className="mx-auto flex max-w-content items-center gap-6 px-4 py-3 desktop:px-8">
          <span className="text-title-s font-semibold text-text-primary">续行</span>
          <nav className="flex gap-1" aria-label="主导航">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  [
                    'min-h-touch rounded-m px-3 py-2 text-body-s',
                    'transition-colors duration-[var(--motion-feedback)]',
                    isActive
                      ? 'bg-accent-subtle font-medium text-accent'
                      : 'text-text-secondary hover:bg-subtle hover:text-text-primary',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <ConnectionBadge />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-content px-4 py-6 desktop:px-8">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <AuthGate>
      <Layout>
        <div className="xux-anim-route">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/capture" element={<CapturePage />} />
            <Route path="/capture/:proposalId" element={<ProposalPage />} />
            <Route path="/actions" element={<MyActionsPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<ProjectPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
      </Layout>
    </AuthGate>
  );
}

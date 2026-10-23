import { NavLink, Route, Routes } from 'react-router-dom';

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
        </div>
      </header>
      <main className="mx-auto max-w-content px-4 py-6 desktop:px-8">{children}</main>
    </div>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <section className="rounded-m border border-border bg-surface p-5 shadow-1">
      <h1 className="text-title font-semibold text-text-primary">{title}</h1>
      <p className="mt-2 text-body-s text-text-secondary">脚手架占位，后续增量填充。</p>
    </section>
  );
}

export default function App() {
  return (
    <Layout>
      <div className="xux-anim-route">
        <Routes>
          <Route path="/" element={<Placeholder title="首页" />} />
          <Route path="/capture" element={<Placeholder title="快速捕获" />} />
          <Route path="/capture/:proposalId" element={<Placeholder title="提议" />} />
          <Route path="/actions" element={<Placeholder title="待我处理" />} />
          <Route path="/projects" element={<Placeholder title="项目" />} />
          <Route path="/projects/:projectId" element={<Placeholder title="项目" />} />
          <Route path="*" element={<Placeholder title="页面不存在" />} />
        </Routes>
      </div>
    </Layout>
  );
}

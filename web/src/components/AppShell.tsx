import type { ReactNode } from 'react';
import { routeHref, type Route } from '../router';
import { Icon, type IconName } from './Icon';

const items: Array<{ route: Route; label: string; icon: IconName; hint: string }> = [
  { route: 'home', label: 'Home', icon: 'home', hint: 'Projects and overview' },
  { route: 'new', label: 'New project', icon: 'plus', hint: 'Scaffold a new stack' },
  { route: 'entities', label: 'Entities', icon: 'database', hint: 'Model and generate' },
  { route: 'preview', label: 'Preview files', icon: 'eye', hint: 'Inspect generated output' },
];

interface AppShellProps {
  route: Route;
  children: ReactNode;
  workspacePath: string;
  projectCount: number;
  engineOnline: boolean;
  demo: boolean;
}

export function AppShell({
  route,
  children,
  workspacePath,
  projectCount,
  engineOnline,
  demo,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href={routeHref('home')} aria-label="CleanStack home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-text">
            <strong>CleanStack</strong>
            <small>Studio</small>
          </span>
        </a>

        <div className="sidebar-section-label">Workspace</div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {items.map((item) => (
            <a
              key={item.route}
              aria-current={route === item.route ? 'page' : undefined}
              className={route === item.route ? 'nav-item active' : 'nav-item'}
              href={routeHref(item.route)}
            >
              <Icon name={item.icon} size={19} />
              <span className="nav-copy">
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
              <Icon name="chevron-right" size={15} className="nav-chevron" />
            </a>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="engine-status">
            <span
              className={
                demo ? 'status-dot demo' : engineOnline ? 'status-dot online' : 'status-dot'
              }
            />
            <span>
              {demo
                ? 'Static demo data'
                : engineOnline
                  ? 'Local engine connected'
                  : 'Engine unavailable'}
            </span>
          </div>
          <code title={workspacePath}>
            {demo ? 'Bundled sample workspace' : workspacePath || 'loading workspace...'}
          </code>
          <span className="sidebar-count">
            {projectCount} {demo ? 'sample project' : 'project'}
            {projectCount === 1 ? '' : 's'} {demo ? 'included' : 'discovered'}
          </span>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-breadcrumb">
            <span className="topbar-kicker">CleanStack Studio</span>
            <span className="topbar-separator">/</span>
            <span>{items.find((item) => item.route === route)?.label ?? 'Home'}</span>
          </div>
          <div className="topbar-actions">
            <span className={demo ? 'local-pill demo' : 'local-pill'}>
              <span className={demo ? 'status-dot demo' : 'status-dot online'} />
              {demo ? 'Static demo' : 'Local only'}
            </span>
            <a className="button button-small button-ghost" href={routeHref('new')}>
              <Icon name="plus" size={16} />
              New project
            </a>
          </div>
        </header>
        <main className="page-shell">
          {demo && (
            <div className="demo-banner" role="status">
              <Icon name="sparkles" size={17} />
              <span>
                <strong>Static demo</strong> — this build uses bundled sample data. Start{' '}
                <code>cleanstack ui</code> locally to generate projects, entities, and files.
              </span>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}

import { routeHref } from '../router';
import { useWorkspace } from '../workspace';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/StatePanels';
import { authLabel, buildToolLabel, databaseLabel, stackLabel, titleCase } from '../format';

export function HomePage() {
  const { workspace, projects, selectedProject, selectProject, loading, refresh } = useWorkspace();
  const entityCount = projects.reduce((total, project) => total + project.entities.length, 0);
  const fullStackCount = projects.filter((project) => project.backend && project.frontend).length;

  return (
    <div className="page home-page">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <Icon name="sparkles" size={15} />
            The CleanStack generator, with a face
          </span>
          <h1>
            Build the stack.
            <br />
            <span>Keep the code clean.</span>
          </h1>
          <p>
            Create a Spring Boot + Angular project, shape its entities, and inspect every generated
            file. The studio calls the exact same engine as the <code>cleanstack</code> CLI.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={routeHref('new')}>
              <Icon name="plus" size={17} />
              Create a project
            </a>
            <a className="button button-secondary" href={routeHref('preview')}>
              <Icon name="eye" size={17} />
              Preview files
            </a>
          </div>
          <div className="engine-note">
            <span className="status-dot online" />
            Shared engine: <code>runNewCommand</code> · <code>runEntityCommand</code> · Handlebars
          </div>
        </div>

        <div className="hero-visual">
          <div className="terminal-card">
            <div className="terminal-bar">
              <span />
              <span />
              <span />
              <small>cleanstack</small>
            </div>
            <div className="terminal-body">
              <p>
                <span className="terminal-prompt">$</span> cleanstack new acme-shop --db h2
              </p>
              <p className="terminal-success">✓ Generated acme-shop in ./acme-shop</p>
              <p>
                <span className="terminal-prompt">$</span> cleanstack entity Product --field
                name:String:required
              </p>
              <p className="terminal-success">✓ Generated Product in acme-backend and acme-ui</p>
              <div className="terminal-tree">
                <span>acme-shop/</span>
                <span>├─ acme-backend/</span>
                <span>├─ acme-ui/</span>
                <span>└─ .cleanstack/project.json</span>
              </div>
            </div>
          </div>
          <div className="floating-chip chip-one">
            <Icon name="layers" size={15} />
            Backend + frontend
          </div>
          <div className="floating-chip chip-two">
            <Icon name="file" size={15} />
            Protected regions
          </div>
        </div>
      </section>

      <section className="stat-grid" aria-label="Workspace summary">
        <div className="stat-card">
          <span className="stat-icon lime">
            <Icon name="layers" size={20} />
          </span>
          <div>
            <strong>{loading ? '—' : projects.length}</strong>
            <span>Generated projects</span>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon violet">
            <Icon name="database" size={20} />
          </span>
          <div>
            <strong>{loading ? '—' : entityCount}</strong>
            <span>Entities modeled</span>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon blue">
            <Icon name="code" size={20} />
          </span>
          <div>
            <strong>{loading ? '—' : fullStackCount}</strong>
            <span>Full-stack projects</span>
          </div>
        </div>
        <div className="stat-card workspace-stat">
          <span className="stat-icon amber">
            <Icon name="folder" size={20} />
          </span>
          <div>
            <strong title={workspace?.workspacePath}>{workspace?.workspaceName ?? '—'}</strong>
            <span>Active workspace</span>
          </div>
        </div>
      </section>

      <section className="home-grid">
        <div className="card project-list-card">
          <div className="card-heading">
            <div>
              <span className="section-kicker">Workspace</span>
              <h2>Projects</h2>
            </div>
            <button className="button button-small button-ghost" onClick={() => void refresh()}>
              <Icon name="refresh" size={15} />
              Refresh
            </button>
          </div>

          {projects.length === 0 ? (
            <EmptyState
              icon="layers"
              title="Your workspace is empty"
              description="Start with a new project. CleanStack will generate the backend, the Angular app, or both."
              action={
                <a className="button button-primary" href={routeHref('new')}>
                  <Icon name="plus" size={17} />
                  Create your first project
                </a>
              }
            />
          ) : (
            <div className="project-list">
              {projects.map((project, index) => (
                <button
                  className={
                    selectedProject?.rootDir === project.rootDir
                      ? 'project-row active'
                      : 'project-row'
                  }
                  key={project.rootDir}
                  onClick={() => selectProject(project.rootDir)}
                >
                  <span className="project-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="project-row-main">
                    <span className="project-row-title">
                      {project.name}
                      <span className="mini-badge">{stackLabel(project)}</span>
                    </span>
                    <span className="project-row-path">{project.relativePath}</span>
                  </span>
                  <span className="project-row-meta">
                    <span>{project.entities.length} entities</span>
                    <span>{databaseLabel(project.options.database)}</span>
                  </span>
                  <Icon name="chevron-right" size={16} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card active-project-card">
          <div className="card-heading">
            <div>
              <span className="section-kicker">Selected</span>
              <h2>Active project</h2>
            </div>
            {selectedProject !== null && (
              <span className="status-badge">
                <span className="status-dot online" />
                Ready
              </span>
            )}
          </div>

          {selectedProject === null ? (
            <EmptyState
              icon="database"
              title="Nothing selected"
              description="Create a project or select one from the list to manage entities and preview generated files."
            />
          ) : (
            <>
              <div className="active-project-title">
                <span className="project-avatar">
                  {selectedProject.name.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <h3>{selectedProject.name}</h3>
                  <code>{selectedProject.rootDir}</code>
                </div>
              </div>

              <div className="stack-badges">
                <span>{selectedProject.packageName}</span>
                <span>{titleCase(selectedProject.options.buildTool)}</span>
                <span>{databaseLabel(selectedProject.options.database)}</span>
                <span>{authLabel(selectedProject.options.auth)}</span>
              </div>

              <div className="project-detail-grid">
                <div>
                  <span>Backend</span>
                  <strong>{selectedProject.backend ? 'Spring Boot' : 'Not generated'}</strong>
                </div>
                <div>
                  <span>Frontend</span>
                  <strong>{selectedProject.frontend ? 'Angular' : 'Not generated'}</strong>
                </div>
                <div>
                  <span>Build tool</span>
                  <strong>{buildToolLabel(selectedProject.options.buildTool)}</strong>
                </div>
                <div>
                  <span>Entities</span>
                  <strong>{selectedProject.entities.length}</strong>
                </div>
              </div>

              <div className="entity-cloud">
                {selectedProject.entities.length === 0 ? (
                  <p className="muted">No entities yet. Add one on the Entities page.</p>
                ) : (
                  selectedProject.entities.slice(0, 8).map((entity) => (
                    <span className="entity-chip" key={entity.name}>
                      <Icon name="database" size={13} />
                      {entity.name}
                    </span>
                  ))
                )}
                {selectedProject.entities.length > 8 && (
                  <span className="entity-chip more">+{selectedProject.entities.length - 8}</span>
                )}
              </div>

              <div className="active-project-actions">
                <a className="button button-primary button-small" href={routeHref('entities')}>
                  <Icon name="database" size={16} />
                  Manage entities
                </a>
                <a className="button button-secondary button-small" href={routeHref('preview')}>
                  <Icon name="eye" size={16} />
                  Preview files
                </a>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="steps-grid">
        <div className="step-card">
          <span className="step-number">01</span>
          <Icon name="plus" size={21} />
          <h3>Create</h3>
          <p>Choose a database, auth style, and build tool. The CLI does the actual scaffolding.</p>
        </div>
        <div className="step-card">
          <span className="step-number">02</span>
          <Icon name="database" size={21} />
          <h3>Model</h3>
          <p>Add entities with typed fields. Backend, frontend, and routes stay in sync.</p>
        </div>
        <div className="step-card">
          <span className="step-number">03</span>
          <Icon name="eye" size={21} />
          <h3>Inspect</h3>
          <p>Browse every generated file before opening your editor. No hidden magic.</p>
        </div>
      </section>
    </div>
  );
}

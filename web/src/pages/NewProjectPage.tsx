import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CommandResult, CreateProjectRequest, MetaResponse } from '../../../src/web/contracts';
import { api } from '../api';
import { ProblemAlert } from '../components/StatePanels';
import { CommandConsole } from '../components/CommandConsole';
import { Icon } from '../components/Icon';
import { authLabel, buildToolLabel, commandPreview, databaseLabel, stackLabel } from '../format';
import { navigate } from '../router';
import { errorDetails, useWorkspace } from '../workspace';

type ProjectDefaults = Pick<
  CreateProjectRequest,
  'database' | 'auth' | 'buildTool' | 'frontend' | 'docker' | 'outputDir'
> & { packageName: string };

const FALLBACK_DEFAULTS: ProjectDefaults = {
  database: 'postgresql',
  auth: 'jwt',
  buildTool: 'maven',
  frontend: true,
  docker: false,
  outputDir: '.',
  packageName: 'com.example',
};

export function NewProjectPage() {
  const { meta, refresh } = useWorkspace();
  const defaults = defaultsFromMeta(meta);
  const [form, setForm] = useState<CreateProjectRequest>({
    name: 'my-cleanstack-app',
    packageName: defaults.packageName,
    outputDir: defaults.outputDir,
    database: defaults.database,
    auth: defaults.auth,
    buildTool: defaults.buildTool,
    frontend: defaults.frontend,
    docker: defaults.docker,
  });
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<{ message: string; suggestions: string[] } | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const defaultsApplied = useRef(meta !== null);

  useEffect(() => {
    if (meta === null || defaultsApplied.current) return;
    defaultsApplied.current = true;
    setForm((current) => ({
      ...current,
      database: meta.defaults.database,
      auth: meta.defaults.auth,
      buildTool: meta.defaults.buildTool,
      frontend: meta.defaults.frontend,
      docker: meta.defaults.docker,
      outputDir: meta.defaults.outputDir,
    }));
  }, [meta]);

  const update = <Key extends keyof CreateProjectRequest>(
    key: Key,
    value: CreateProjectRequest[Key],
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setValidation(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = form.name.trim();
    if (name === '') {
      setValidation('Give your project a name first.');
      return;
    }
    if (/[\\/]/.test(name)) {
      setValidation('Project names cannot contain path separators.');
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(form.packageName.trim())) {
      setValidation('Enter a valid Java package, for example com.acme.shop.');
      return;
    }

    setSubmitting(true);
    setProblem(null);
    setResult(null);
    try {
      const response = await api.createProject({
        ...form,
        name,
        packageName: form.packageName.trim(),
        outputDir: form.outputDir.trim() || '.',
      });
      setResult(response);
      if (response.project !== undefined) {
        await refresh(response.project.rootDir);
      }
    } catch (caught) {
      setProblem(errorDetails(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const command = [
    'cleanstack',
    'new',
    form.name || '<name>',
    '--package',
    form.packageName || '<package>',
    '--db',
    form.database,
    '--auth',
    form.auth,
    '--build',
    form.buildTool,
    '--frontend',
    form.frontend ? 'angular' : 'none',
    '--output-dir',
    form.outputDir.trim() || '.',
    '--yes',
    '--no-entities',
    ...(form.docker ? ['--docker'] : []),
  ];

  return (
    <div className="page new-project-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            <Icon name="sparkles" size={15} />
            Scaffold from the engine
          </span>
          <h1>Create a new project</h1>
          <p>
            Pick the shape of your stack. CleanStack hands the options to the CLI engine and
            generates a clean, protected project skeleton.
          </p>
        </div>
        <div className="heading-note">
          <Icon name="terminal" size={18} />
          <span>
            Calls <code>runNewCommand</code>
          </span>
        </div>
      </div>

      {problem !== null && (
        <ProblemAlert
          message={problem.message}
          suggestions={problem.suggestions}
          onDismiss={() => setProblem(null)}
        />
      )}

      {result !== null && result.project !== undefined && (
        <div className="success-banner">
          <span className="success-icon">
            <Icon name="check" size={21} />
          </span>
          <div>
            <strong>{result.project.name} is ready.</strong>
            <p>
              Generated at <code>{result.project.rootDir}</code>
            </p>
          </div>
          <div className="success-actions">
            <button
              className="button button-small button-secondary"
              onClick={() => navigate('entities')}
            >
              Manage entities
              <Icon name="arrow-right" size={15} />
            </button>
            <button
              className="button button-small button-primary"
              onClick={() => navigate('preview')}
            >
              Preview files
              <Icon name="arrow-right" size={15} />
            </button>
          </div>
        </div>
      )}

      <div className="form-layout">
        <form className="card form-card" onSubmit={(event) => void submit(event)}>
          <div className="card-heading">
            <div>
              <span className="section-kicker">Project setup</span>
              <h2>What are we building?</h2>
            </div>
            <span className="form-step">Step 1 of 2</span>
          </div>

          <div className="form-grid">
            <label className="field field-wide">
              <span className="field-label">Project name</span>
              <input
                autoComplete="off"
                placeholder="acme-shop"
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
              />
              <span className="field-hint">
                Creates a folder with this name and matching <code>-backend</code> /{' '}
                <code>-ui</code> projects.
              </span>
            </label>

            <label className="field field-wide">
              <span className="field-label">Java package</span>
              <input
                autoComplete="off"
                placeholder="com.acme.shop"
                value={form.packageName}
                onChange={(event) => update('packageName', event.target.value)}
              />
              <span className="field-hint">Used for backend packages and class names.</span>
            </label>

            <label className="field">
              <span className="field-label">Database</span>
              <select
                value={form.database}
                onChange={(event) =>
                  update('database', event.target.value as CreateProjectRequest['database'])
                }
              >
                <option value="postgresql">PostgreSQL</option>
                <option value="h2">H2 in-memory</option>
                <option value="mysql">MySQL</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">Authentication</span>
              <select
                value={form.auth}
                onChange={(event) =>
                  update('auth', event.target.value as CreateProjectRequest['auth'])
                }
              >
                <option value="jwt">JWT resource server</option>
                <option value="none">No authentication</option>
                <option value="keycloak">Keycloak</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">Build tool</span>
              <select
                value={form.buildTool}
                onChange={(event) =>
                  update('buildTool', event.target.value as CreateProjectRequest['buildTool'])
                }
              >
                <option value="maven">Maven</option>
                <option value="gradle">Gradle</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">Output directory</span>
              <input
                autoComplete="off"
                placeholder="."
                value={form.outputDir}
                onChange={(event) => update('outputDir', event.target.value)}
              />
              <span className="field-hint">Relative to the active workspace.</span>
            </label>
          </div>

          <div className="switch-stack">
            <label className="switch-row">
              <span>
                <span className="field-label">Angular frontend</span>
                <span className="field-hint">Generate a standalone Angular app with routing.</span>
              </span>
              <input
                checked={form.frontend}
                type="checkbox"
                onChange={(event) => update('frontend', event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true">
                <span />
              </span>
            </label>

            <label className="switch-row">
              <span>
                <span className="field-label">Docker files</span>
                <span className="field-hint">
                  Add a Dockerfile and docker-compose service for the backend.
                </span>
              </span>
              <input
                checked={form.docker}
                type="checkbox"
                onChange={(event) => update('docker', event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true">
                <span />
              </span>
            </label>
          </div>

          {validation !== null && <p className="field-error">{validation}</p>}

          <div className="form-actions">
            <span className="form-footnote">
              <Icon name="layers" size={15} />
              Files are generated with the protected-region engine.
            </span>
            <button className="button button-primary" disabled={submitting} type="submit">
              {submitting ? (
                <>
                  <span className="spinner" />
                  Generating...
                </>
              ) : (
                <>
                  <Icon name="plus" size={17} />
                  Create project
                </>
              )}
            </button>
          </div>
        </form>

        <aside className="form-aside">
          <div className="card summary-card">
            <span className="section-kicker">The shape of it</span>
            <h2>{form.name.trim() || 'Your new project'}</h2>
            <p className="summary-path">
              {previewOutputDir(form.outputDir)}/{form.name.trim() || '<name>'}
            </p>

            <dl className="summary-list">
              <div>
                <dt>Package</dt>
                <dd>{form.packageName.trim() || '—'}</dd>
              </div>
              <div>
                <dt>Stack</dt>
                <dd>{stackLabel({ backend: true, frontend: form.frontend })}</dd>
              </div>
              <div>
                <dt>Database</dt>
                <dd>{databaseLabel(form.database)}</dd>
              </div>
              <div>
                <dt>Auth</dt>
                <dd>{authLabel(form.auth)}</dd>
              </div>
              <div>
                <dt>Build</dt>
                <dd>{buildToolLabel(form.buildTool)}</dd>
              </div>
              <div>
                <dt>Docker</dt>
                <dd>{form.docker ? 'Included' : 'Not included'}</dd>
              </div>
            </dl>

            <div className="aside-command">
              <span className="field-label">Equivalent command</span>
              <code>{commandPreview(command)}</code>
            </div>
          </div>

          <div className="info-card">
            <Icon name="sparkles" size={19} />
            <div>
              <strong>Same engine, no drift</strong>
              <p>
                The studio does not know how to render a template. It asks the CLI engine to do that
                work, then shows you the result.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {result !== null && (
        <CommandConsole
          title="Project engine output"
          command={result.command}
          messages={result.messages}
        />
      )}

      <div className="page-footnote">
        <span className="footnote-icon">
          <Icon name="warning" size={16} />
        </span>
        <span>
          Project generation writes to your local filesystem. The workspace is{' '}
          <strong>{meta === null ? 'loading...' : 'shown in the sidebar'}</strong>; set{' '}
          <code>CLEANSTACK_WEB_WORKSPACE</code> before starting the server to change it.
        </span>
      </div>
    </div>
  );
}

function previewOutputDir(outputDir: string): string {
  const cleaned = outputDir
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  return cleaned === '' || cleaned === '.' ? '.' : cleaned;
}

function defaultsFromMeta(meta: MetaResponse | null): ProjectDefaults {
  if (meta === null) return FALLBACK_DEFAULTS;
  return {
    database: meta.defaults.database,
    auth: meta.defaults.auth,
    buildTool: meta.defaults.buildTool,
    frontend: meta.defaults.frontend,
    docker: meta.defaults.docker,
    outputDir: meta.defaults.outputDir,
    packageName: 'com.example',
  };
}

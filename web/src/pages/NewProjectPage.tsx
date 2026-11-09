import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  CommandResult,
  CreateProjectRequest,
  DownloadProjectRequest,
  MetaResponse,
} from '../../../src/web/contracts';
import { api, type DownloadedArchive } from '../api';
import { CommandConsole } from '../components/CommandConsole';
import { Icon } from '../components/Icon';
import { ProblemAlert } from '../components/StatePanels';
import { authLabel, buildToolLabel, commandPreview, databaseLabel, stackLabel } from '../format';
import { navigate } from '../router';
import { errorDetails, useWorkspace } from '../workspace';

type WizardStep = 'project' | 'stack' | 'options' | 'review';
type Destination = 'local' | 'download';
type UpdateProjectForm = <Key extends keyof CreateProjectRequest>(
  key: Key,
  value: CreateProjectRequest[Key],
) => void;

type Outcome =
  { kind: 'local'; result: CommandResult } | { kind: 'download'; archive: DownloadedArchive };

interface StepDefinition {
  id: WizardStep;
  label: string;
  summary: string;
}

const STEPS: StepDefinition[] = [
  { id: 'project', label: 'Project', summary: 'Name and package' },
  { id: 'stack', label: 'Stack', summary: 'Database and UI' },
  { id: 'options', label: 'Options', summary: 'Entities and output' },
  { id: 'review', label: 'Review', summary: 'Choose destination' },
];

const HEADINGS: Record<WizardStep, { kicker: string; title: string; description: string }> = {
  project: {
    kicker: 'Project setup',
    title: 'What are we building?',
    description: 'Choose the folder name and Java package that anchor the generated projects.',
  },
  stack: {
    kicker: 'Stack choices',
    title: 'Shape the stack',
    description: 'The CLI engine uses these settings for the Spring Boot backend and Angular UI.',
  },
  options: {
    kicker: 'Generation options',
    title: 'Fine-tune the output',
    description: 'Decide how the workspace context and existing files should be handled.',
  },
  review: {
    kicker: 'Review and deliver',
    title: 'Ready to generate',
    description: 'Check the settings, then download a ZIP or write the project into the workspace.',
  },
};

const PROJECT_NAME_DEFAULT = 'my-cleanstack-app';
const PACKAGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

type ProjectDefaults = Pick<
  CreateProjectRequest,
  | 'database'
  | 'auth'
  | 'buildTool'
  | 'frontend'
  | 'docker'
  | 'outputDir'
  | 'includeEntities'
  | 'git'
  | 'force'
> & { packageName: string };

const FALLBACK_DEFAULTS: ProjectDefaults = {
  database: 'postgresql',
  auth: 'jwt',
  buildTool: 'maven',
  frontend: true,
  docker: false,
  outputDir: '.',
  includeEntities: false,
  git: false,
  force: false,
  packageName: 'com.example',
};

export function NewProjectPage() {
  const { meta, workspace, refresh, demo } = useWorkspace();
  const defaults = defaultsFromMeta(meta);
  const [form, setForm] = useState<CreateProjectRequest>(() => initialForm(defaults));
  const [step, setStep] = useState<WizardStep>('project');
  const [maxVisited, setMaxVisited] = useState(0);
  const [destination, setDestination] = useState<Destination>('download');
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<{ message: string; suggestions: string[] } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const defaultsApplied = useRef(meta !== null);
  const localAvailable = meta?.capabilities.localGeneration ?? false;
  const downloadAvailable = meta?.capabilities.archiveDownload ?? false;
  const currentIndex = Math.max(
    0,
    STEPS.findIndex((item) => item.id === step),
  );

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

  useEffect(() => {
    if (meta !== null && !meta.capabilities.localGeneration) {
      setDestination((current) => (current === 'local' ? 'download' : current));
    }
  }, [meta]);

  const update: UpdateProjectForm = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setValidation(null);
    setOutcome(null);
  };

  const goToStep = (target: WizardStep): void => {
    const targetIndex = STEPS.findIndex((item) => item.id === target);
    if (targetIndex < 0 || targetIndex > maxVisited || submitting) return;
    setStep(target);
    setValidation(null);
  };

  const next = (): void => {
    const issue = validateStep(step, form);
    if (issue !== null) {
      setValidation(issue);
      return;
    }
    const following = STEPS[currentIndex + 1];
    if (following === undefined) return;
    setStep(following.id);
    setMaxVisited((visited) => Math.max(visited, currentIndex + 1));
    setValidation(null);
  };

  const back = (): void => {
    const previous = STEPS[currentIndex - 1];
    if (previous === undefined) return;
    setStep(previous.id);
    setValidation(null);
  };

  const reset = (): void => {
    setForm(initialForm(defaults));
    setStep('project');
    setMaxVisited(0);
    setDestination('download');
    setOutcome(null);
    setProblem(null);
    setValidation(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    if (step !== 'review') {
      next();
      return;
    }

    const issue = firstValidationIssue(form);
    if (issue !== null) {
      const issueIndex = STEPS.findIndex((item) => item.id === issue.step);
      setMaxVisited((visited) => Math.max(visited, Math.max(0, issueIndex)));
      setStep(issue.step);
      setValidation(issue.message);
      return;
    }

    if (destination === 'local' && !localAvailable) {
      setDestination('download');
      setValidation(
        'Local generation is not available from this browser session. Choose ZIP download to continue.',
      );
      return;
    }
    if (destination === 'download' && !downloadAvailable) {
      setValidation(
        demo
          ? 'Generation is disabled in the static demo. Run "cleanstack ui" locally to create a project.'
          : 'ZIP downloads are not available from this session.',
      );
      return;
    }

    const request: CreateProjectRequest = {
      ...form,
      name: form.name.trim(),
      packageName: form.packageName.trim(),
      outputDir: form.outputDir.trim() || '.',
    };

    setSubmitting(true);
    setProblem(null);
    setOutcome(null);
    try {
      if (destination === 'download') {
        const download: DownloadProjectRequest = {
          name: request.name,
          packageName: request.packageName,
          database: request.database,
          auth: request.auth,
          buildTool: request.buildTool,
          frontend: request.frontend,
          docker: request.docker,
          includeEntities: request.includeEntities,
        };
        const archive = await api.downloadProject(download);
        saveArchive(archive);
        setOutcome({ kind: 'download', archive });
      } else {
        const response = await api.createProject(request);
        setOutcome({ kind: 'local', result: response });
        if (response.project !== undefined) {
          await refresh(response.project.rootDir);
        }
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
    form.name.trim() || '<name>',
    '--package',
    form.packageName.trim() || '<package>',
    '--db',
    form.database,
    '--auth',
    form.auth,
    '--build',
    form.buildTool,
    '--frontend',
    form.frontend ? 'angular' : 'none',
    '--output-dir',
    previewOutputDir(form.outputDir),
    form.includeEntities ? '--entities' : '--no-entities',
    form.docker ? '--docker' : '--no-docker',
    '--no-dry-run',
    '--yes',
    ...(destination === 'local' && form.git ? ['--git'] : []),
    ...(destination === 'local' && form.force ? ['--force'] : []),
  ];
  const heading = HEADINGS[step];

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
            Walk through the options exposed by the CLI, then download the result as a ZIP or write
            it straight into your workspace. Every path uses the same generator engine.
          </p>
        </div>
        <div className="heading-note">
          <Icon name="terminal" size={18} />
          <span>
            Calls <code>runNewCommand</code>
          </span>
        </div>
      </div>

      <nav className="wizard-stepper" aria-label="Project setup steps">
        {STEPS.map((item, index) => {
          const state =
            index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';
          return (
            <button
              key={item.id}
              aria-current={index === currentIndex ? 'step' : undefined}
              className="wizard-step"
              data-state={state}
              disabled={index > maxVisited || submitting}
              onClick={() => goToStep(item.id)}
              type="button"
            >
              <span className="wizard-step-index">
                {state === 'complete' ? <Icon name="check" size={13} /> : index + 1}
              </span>
              <span className="wizard-step-copy">
                <strong>{item.label}</strong>
                <small>{item.summary}</small>
              </span>
            </button>
          );
        })}
      </nav>

      {problem !== null && (
        <ProblemAlert
          message={problem.message}
          suggestions={problem.suggestions}
          onDismiss={() => setProblem(null)}
        />
      )}

      {outcome?.kind === 'local' && outcome.result.project !== undefined && (
        <div className="success-banner">
          <span className="success-icon">
            <Icon name="check" size={21} />
          </span>
          <div>
            <strong>{outcome.result.project.name} is ready.</strong>
            <p>
              Generated at <code>{outcome.result.project.rootDir}</code>
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
            <button className="button button-small button-ghost" onClick={reset}>
              Start another
            </button>
          </div>
        </div>
      )}

      {outcome?.kind === 'download' && (
        <div className="success-banner">
          <span className="success-icon">
            <Icon name="download" size={21} />
          </span>
          <div>
            <strong>{outcome.archive.filename} is ready.</strong>
            <p>The archive was built in a temporary folder and the workspace was left untouched.</p>
          </div>
          <div className="success-actions">
            <button
              className="button button-small button-secondary"
              onClick={() => saveArchive(outcome.archive)}
            >
              <Icon name="download" size={15} />
              Download again
            </button>
            <button className="button button-small button-ghost" onClick={reset}>
              Start another
            </button>
          </div>
        </div>
      )}

      <div className="form-layout">
        <form className="card form-card" onSubmit={(event) => void submit(event)}>
          <div className="card-heading">
            <div>
              <span className="section-kicker">{heading.kicker}</span>
              <h2>{heading.title}</h2>
              <p className="wizard-description">{heading.description}</p>
            </div>
            <span className="form-step">
              Step {currentIndex + 1} of {STEPS.length}
            </span>
          </div>

          {step === 'project' && <ProjectStep form={form} update={update} />}
          {step === 'stack' && <StackStep form={form} update={update} />}
          {step === 'options' && <OptionsStep form={form} update={update} />}
          {step === 'review' && (
            <ReviewStep
              demo={demo}
              destination={destination}
              downloadAvailable={downloadAvailable}
              form={form}
              localAvailable={localAvailable}
              onDestinationChange={setDestination}
              update={update}
              workspacePath={workspace?.workspacePath ?? ''}
            />
          )}

          {validation !== null && <p className="field-error">{validation}</p>}

          <div className="form-actions">
            <span className="form-footnote">
              <Icon name="layers" size={15} />
              {step === 'review'
                ? destination === 'download'
                  ? 'Built with the CLI engine, then streamed as a ZIP.'
                  : 'Writes through the CLI engine into your workspace.'
                : 'Files are generated with the protected-region engine.'}
            </span>
            <div className="wizard-action-buttons">
              {currentIndex > 0 && (
                <button
                  className="button button-ghost"
                  disabled={submitting}
                  onClick={back}
                  type="button"
                >
                  <Icon name="arrow-left" size={16} />
                  Back
                </button>
              )}
              {step !== 'review' ? (
                <button className="button button-primary" onClick={next} type="button">
                  Continue
                  <Icon name="arrow-right" size={16} />
                </button>
              ) : (
                <button
                  className="button button-primary"
                  disabled={
                    submitting || (destination === 'local' ? !localAvailable : !downloadAvailable)
                  }
                  type="submit"
                >
                  {submitting ? (
                    <>
                      <span className="spinner" />
                      {destination === 'download' ? 'Preparing ZIP...' : 'Generating...'}
                    </>
                  ) : destination === 'download' ? (
                    <>
                      <Icon name="download" size={17} />
                      Download ZIP
                    </>
                  ) : (
                    <>
                      <Icon name="plus" size={17} />
                      Generate project
                    </>
                  )}
                </button>
              )}
            </div>
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
              <div>
                <dt>Entities</dt>
                <dd>{form.includeEntities ? 'From workspace' : 'Skipped'}</dd>
              </div>
              <div>
                <dt>Delivery</dt>
                <dd>{destination === 'download' ? 'ZIP download' : 'Local folder'}</dd>
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
                work, then shows you the result. ZIP downloads use a hidden temporary folder that is
                removed after archiving.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {outcome?.kind === 'local' && (
        <CommandConsole
          title="Project engine output"
          command={outcome.result.command}
          messages={outcome.result.messages}
        />
      )}

      <div className="page-footnote">
        <span className="footnote-icon">
          <Icon name="warning" size={16} />
        </span>
        <span>
          Local generation writes to{' '}
          <strong>{meta === null ? 'the active workspace' : 'the workspace in the sidebar'}</strong>
          ; ZIP downloads never write a project into it. Set <code>CLEANSTACK_WEB_WORKSPACE</code>{' '}
          before starting the server to change the workspace.
        </span>
      </div>
    </div>
  );
}

interface StepProps {
  form: CreateProjectRequest;
  update: UpdateProjectForm;
}

function ProjectStep({ form, update }: StepProps) {
  return (
    <>
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
            Creates a folder with this name and matching <code>-backend</code> / <code>-ui</code>{' '}
            projects.
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
      </div>

      <div className="wizard-note">
        <Icon name="folder" size={18} />
        <p>
          Change the output directory in the Options step. Current project folder:{' '}
          <code>
            {previewOutputDir(form.outputDir)}/{form.name.trim() || '<name>'}
          </code>
        </p>
      </div>
    </>
  );
}

function StackStep({ form, update }: StepProps) {
  return (
    <>
      <div className="form-grid">
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
            onChange={(event) => update('auth', event.target.value as CreateProjectRequest['auth'])}
          >
            <option value="jwt">JWT resource server</option>
            <option value="session">Session login</option>
            <option value="keycloak">Keycloak OIDC</option>
            <option value="auth0">Auth0 OIDC</option>
            <option value="oidc">Generic OIDC</option>
            <option value="none">No authentication</option>
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

      <div className="wizard-note">
        <Icon name="layers" size={18} />
        <p>
          The backend is always generated. Turning off the frontend produces a backend-only project
          with the same protected-region layout.
        </p>
      </div>
    </>
  );
}

function OptionsStep({ form, update }: StepProps) {
  return (
    <>
      <div className="form-grid">
        <label className="field field-wide">
          <span className="field-label">Output directory</span>
          <input
            autoComplete="off"
            placeholder="."
            value={form.outputDir}
            onChange={(event) => update('outputDir', event.target.value)}
          />
          <span className="field-hint">
            Relative to the active workspace. ZIP downloads ignore this because the archive is built
            in a temporary folder.
          </span>
        </label>
      </div>

      <div className="switch-stack">
        <label className="switch-row">
          <span>
            <span className="field-label">Include project entities</span>
            <span className="field-hint">
              Use entities from <code>cleanstack.config</code> or the workspace{' '}
              <code>entities/</code> directory.
            </span>
          </span>
          <input
            checked={form.includeEntities}
            type="checkbox"
            onChange={(event) => update('includeEntities', event.target.checked)}
          />
          <span className="switch-track" aria-hidden="true">
            <span />
          </span>
        </label>

        <label className="switch-row">
          <span>
            <span className="field-label">Initialize git repository</span>
            <span className="field-hint">
              Run <code>git init</code> in the generated project. Local generation only; ZIP
              downloads never include Git history.
            </span>
          </span>
          <input
            checked={form.git}
            type="checkbox"
            onChange={(event) => update('git', event.target.checked)}
          />
          <span className="switch-track" aria-hidden="true">
            <span />
          </span>
        </label>

        <label className="switch-row">
          <span>
            <span className="field-label">Overwrite existing files</span>
            <span className="field-hint">
              Replace files, including protected regions. Only applies when generating into an
              existing local folder.
            </span>
          </span>
          <input
            checked={form.force}
            type="checkbox"
            onChange={(event) => update('force', event.target.checked)}
          />
          <span className="switch-track" aria-hidden="true">
            <span />
          </span>
        </label>
      </div>

      <div className="wizard-note wizard-note-warning">
        <Icon name="warning" size={18} />
        <p>
          Overwriting is permanent for the generated files it touches. Keep it off unless you
          intentionally want to replace an earlier generation.
        </p>
      </div>
    </>
  );
}

interface ReviewStepProps extends StepProps {
  destination: Destination;
  localAvailable: boolean;
  downloadAvailable: boolean;
  demo: boolean;
  workspacePath: string;
  onDestinationChange(destination: Destination): void;
}

function ReviewStep({
  destination,
  downloadAvailable,
  demo,
  form,
  localAvailable,
  onDestinationChange,
  workspacePath,
}: ReviewStepProps) {
  return (
    <>
      <div className="wizard-review">
        <section className="review-group">
          <h3>Project</h3>
          <dl className="summary-list">
            <div>
              <dt>Name</dt>
              <dd>{form.name.trim() || '—'}</dd>
            </div>
            <div>
              <dt>Java package</dt>
              <dd>{form.packageName.trim() || '—'}</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>{previewOutputDir(form.outputDir)}</dd>
            </div>
          </dl>
        </section>

        <section className="review-group">
          <h3>Stack</h3>
          <dl className="summary-list">
            <div>
              <dt>Shape</dt>
              <dd>{stackLabel({ backend: true, frontend: form.frontend })}</dd>
            </div>
            <div>
              <dt>Database</dt>
              <dd>{databaseLabel(form.database)}</dd>
            </div>
            <div>
              <dt>Authentication</dt>
              <dd>{authLabel(form.auth)}</dd>
            </div>
            <div>
              <dt>Build tool</dt>
              <dd>{buildToolLabel(form.buildTool)}</dd>
            </div>
            <div>
              <dt>Docker</dt>
              <dd>{form.docker ? 'Included' : 'Not included'}</dd>
            </div>
          </dl>
        </section>

        <section className="review-group">
          <h3>Generation</h3>
          <dl className="summary-list">
            <div>
              <dt>Entities</dt>
              <dd>{form.includeEntities ? 'From workspace' : 'Skipped'}</dd>
            </div>
            <div>
              <dt>Git repository</dt>
              <dd>{form.git ? 'Initialize locally' : 'Not included'}</dd>
            </div>
            <div>
              <dt>Existing files</dt>
              <dd>{form.force ? 'Overwrite' : 'Protected'}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div className="destination-heading">
        <span className="section-kicker">Destination</span>
        <h3>How should we deliver it?</h3>
      </div>

      <div className="destination-grid">
        <button
          aria-pressed={destination === 'download'}
          className="destination-card"
          data-selected={destination === 'download'}
          disabled={!downloadAvailable}
          onClick={() => onDestinationChange('download')}
          type="button"
        >
          <span className="destination-icon">
            <Icon name="archive" size={22} />
          </span>
          <span className="destination-copy">
            <strong>Download ZIP</strong>
            <span className="destination-description">
              Build the project in a temporary folder and download a ready-to-unzip archive. Nothing
              is left in the workspace.
            </span>
            <span className="destination-path">{form.name.trim() || '<name>'}.zip</span>
          </span>
          {!downloadAvailable && <span className="destination-badge">Unavailable</span>}
          {destination === 'download' && (
            <span className="destination-check">
              <Icon name="check" size={13} />
            </span>
          )}
        </button>

        <button
          aria-pressed={destination === 'local'}
          className="destination-card"
          data-selected={destination === 'local'}
          disabled={!localAvailable}
          onClick={() => onDestinationChange('local')}
          type="button"
        >
          <span className="destination-icon">
            <Icon name="folder" size={22} />
          </span>
          <span className="destination-copy">
            <strong>Generate into workspace</strong>
            <span className="destination-description">
              Let the engine write the project directly into the active workspace so you can manage
              entities and preview files.
            </span>
            <span className="destination-path">{localProjectPath(workspacePath, form)}</span>
          </span>
          {!localAvailable && <span className="destination-badge">Local only</span>}
          {destination === 'local' && (
            <span className="destination-check">
              <Icon name="check" size={13} />
            </span>
          )}
        </button>
      </div>

      {(!localAvailable || !downloadAvailable) && (
        <p className="destination-note">
          {demo
            ? 'Generation and downloads are disabled in the static demo. Run "cleanstack ui" locally to create a project.'
            : 'Local generation is available when the studio is opened on the machine running the server. The ZIP download works from any browser that can reach it.'}
        </p>
      )}
    </>
  );
}

function validateStep(step: WizardStep, form: CreateProjectRequest): string | null {
  if (step === 'project') {
    const name = form.name.trim();
    if (name === '') return 'Give your project a name first.';
    if (name === '.' || name === '..' || /[\\/]/.test(name)) {
      return 'Project names must be a single folder name without path separators.';
    }
    if (name.length > 100) return 'Keep the project name under 100 characters.';
    if (!PACKAGE_PATTERN.test(form.packageName.trim())) {
      return 'Enter a valid Java package, for example com.acme.shop.';
    }
  }

  if (step === 'options') {
    const outputDir = form.outputDir.trim();
    if (
      outputDir.startsWith('/') ||
      outputDir.startsWith('\\') ||
      /^[A-Za-z]:[\\/]/.test(outputDir)
    ) {
      return 'Use a directory relative to the workspace, for example apps.';
    }
    if (outputDir.split(/[\\/]+/).some((segment) => segment === '..')) {
      return 'The output directory cannot leave the workspace with "..".';
    }
  }

  return null;
}

function firstValidationIssue(
  form: CreateProjectRequest,
): { step: WizardStep; message: string } | null {
  const projectIssue = validateStep('project', form);
  if (projectIssue !== null) return { step: 'project', message: projectIssue };

  const optionsIssue = validateStep('options', form);
  if (optionsIssue !== null) return { step: 'options', message: optionsIssue };

  return null;
}

function initialForm(defaults: ProjectDefaults): CreateProjectRequest {
  return {
    name: PROJECT_NAME_DEFAULT,
    packageName: defaults.packageName,
    outputDir: defaults.outputDir,
    database: defaults.database,
    auth: defaults.auth,
    buildTool: defaults.buildTool,
    frontend: defaults.frontend,
    docker: defaults.docker,
    includeEntities: defaults.includeEntities,
    git: defaults.git,
    force: defaults.force,
  };
}

function saveArchive(archive: DownloadedArchive): void {
  const url = URL.createObjectURL(archive.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = archive.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function localProjectPath(workspacePath: string, form: CreateProjectRequest): string {
  const outputDir = previewOutputDir(form.outputDir);
  const name = form.name.trim() || '<name>';
  const relative = outputDir === '.' ? name : `${outputDir}/${name}`;
  const root = workspacePath.replace(/[\\/]+$/, '');
  return root === '' ? relative : `${root}/${relative}`;
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
    includeEntities: false,
    git: false,
    force: false,
    packageName: 'com.example',
  };
}
